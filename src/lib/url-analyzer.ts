// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// URL → structured brand analysis (single web.extract + 1 LLM call).
//
// Pipeline:
//
//   1. ONE `web.extract` call — deterministic server-side Playwright +
//      sanitize-html + computed visual signature. Returns a structured
//      snapshot (title, headings, links, forms, palette, primary colour,
//      typography, …) in ~5-15s for 1 mc. The lambda also resolves the
//      best logo asset (apple-touch-icon, declared <link rel="icon">,
//      conventional well-known paths) and ships its bytes base64-encoded
//      inside the response.
//   2. ONE `invokeBedrock` (Claude Sonnet 4.6) call that takes the
//      snapshot as JSON input and produces the UrlAnalysis shape callers
//      consume — business paragraph, formulaire schema, ui descriptor,
//      logo URL.
//
// Wall time: ~8-20s. Cost: ~5-15 mc (1 for the extract, the rest for
// ~5-10K input tokens to Sonnet). The four UI sub-step buttons
// (business / formulaire / ui / logo) share the same extraction +
// parse through a per-URL module-level cache, so clicking three of
// them sequentially still costs one extract + one LLM call.
//
// History: this module replaced a v16 implementation that fired four
// separate `compute.invokeUrlFetch` calls against the Anthropic API
// directly (~80-120 mc, 60-120s wall time). That code path is removed
// in alpha.24.

import type { AithosSDK } from "@aithos/sdk";
import type { ExtractData } from "@aithos/sdk";

import type { HexColor } from "./brand-types.js";

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface FormField {
  /** Programmatic name (e.g. "email", "company_size"). */
  readonly name: string;
  /** Human label as seen on the site (e.g. "Adresse email professionnelle"). */
  readonly label: string;
  /** HTML-ish type — text, email, tel, url, number, textarea, select, checkbox, radio, date. */
  readonly type: string;
  /** Whether the site marks the field as mandatory. */
  readonly required: boolean;
  /** For select / radio: the offered options. Empty otherwise. */
  readonly options?: readonly string[];
  /** Optional placeholder / helper text. */
  readonly placeholder?: string;
}

export interface DetectedForm {
  /** Short slug (e.g. "signup", "contact", "newsletter", "checkout"). */
  readonly name: string;
  /** What the form is for, in one sentence. */
  readonly purpose: string;
  /** The fields, in the order they appear. */
  readonly fields: readonly FormField[];
}

export interface FormulaireSchema {
  readonly forms: readonly DetectedForm[];
}

export interface UiDescriptor {
  /** Brand primary colour (most prominent CTA / accent on the site). */
  readonly primaryColor: HexColor;
  /** Brand secondary / accent colour. */
  readonly secondaryColor: HexColor;
  /** Dominant page background colour (the canvas the site sits on). */
  readonly backgroundColor: HexColor;
  /** Free-text description of the button style on the site. */
  readonly buttonStyle: string;
  /** Free-text description of the input / form-field style on the site. */
  readonly inputStyle: string;
  /** Paragraph: the brand visual identity, mood, and design spirit. */
  readonly visualBrief: string;
}

/** Provenance / cost metadata — produced by every analysis sub-call. */
export interface AnalysisMeta {
  readonly urlsFetched: ReadonlyArray<{ readonly url: string; readonly title?: string }>;
  readonly citations: ReadonlyArray<{ readonly url: string; readonly citedText: string }>;
  readonly creditsSpent: number;
  readonly webFetchInvocations: number;
  /** Wall-clock time (ms) the call took. */
  readonly elapsedMs: number;
  /** Raw assistant content for debugging. */
  readonly rawContent: string;
}

export interface BusinessAnalysis extends AnalysisMeta {
  readonly business: string;
}

export interface FormulaireAnalysis extends AnalysisMeta {
  readonly formulaire: FormulaireSchema;
}

export interface UiAnalysis extends AnalysisMeta {
  readonly ui: UiDescriptor;
}

export interface LogoExtraction extends AnalysisMeta {
  /** Absolute URL of the main logo (or favicon fallback). Empty if not found. */
  readonly logoUrl: string;
  /** Logo as a data URI (best-effort client-side fetch). Empty on failure. */
  readonly logoDataUri: string;
  /** Last error from the logo-fetch attempt. Empty on success. */
  readonly logoFetchError: string;
  /**
   * Where the asset came from.
   *   "lambda:<source>"  — the web-extractor lambda resolved the asset
   *     server-side (apple-touch-icon, declared icon link, well-known
   *     path). Preferred: 0 extra Sonnet credits, no CORS dance.
   *   "sonnet"           — Sonnet identified the logo inside the page HTML
   *     and the client fetched it. Fallback when the lambda found nothing.
   *   null               — nothing found at all.
   */
  readonly logoSource: string | null;
  /** Decoded image width in px, when we managed to fetch it. */
  readonly logoWidth: number;
  /** Decoded image height in px, when we managed to fetch it. */
  readonly logoHeight: number;
}

/** Combined shape — kept for callers that want everything in one object. */
export interface UrlAnalysis {
  readonly business: string;
  readonly formulaire: FormulaireSchema;
  readonly ui: UiDescriptor;
  readonly logoUrl: string;
  readonly logoDataUri: string;
  readonly logoFetchError: string;
  readonly creditsSpent: number;
  readonly webFetchInvocations: number;
  readonly urlsFetched: ReadonlyArray<{ readonly url: string; readonly title?: string }>;
  readonly citations: ReadonlyArray<{ readonly url: string; readonly citedText: string }>;
}

/* -------------------------------------------------------------------------- */
/*  Rate-limit retry wrapper                                                  */
/* -------------------------------------------------------------------------- */

/** Optional progress hook so UIs can show "retrying in 20s (attempt 2/3)". */
export interface RetryProgress {
  /** 1-based attempt number AFTER the initial failure (so 1 = first retry). */
  readonly attempt: number;
  /** How many retries we'll attempt in total. */
  readonly maxAttempts: number;
  /** How long we'll wait before this retry, in milliseconds. */
  readonly waitMs: number;
  /** The error message that triggered the retry. */
  readonly reason: string;
}

export interface RetryOptions {
  /** Called BEFORE each retry sleep so the UI can show countdown info. */
  readonly onRetry?: (info: RetryProgress) => void;
}

/** Heuristic: does this error look like a backend rate-limit signal? */
function isRateLimitError(e: unknown): boolean {
  const msg =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : "";
  const m = msg.toLowerCase();
  return (
    m.includes("rate limit") ||
    m.includes("rate-limit") ||
    m.includes("ratelimit") ||
    m.includes("429") ||
    m.includes("too many requests") ||
    m.includes("-32050") // JSON-RPC code returned by the Aithos compute proxy
  );
}

const DEFAULT_RETRY_DELAYS_MS = [10_000, 20_000, 40_000];

/**
 * Wrap an async fn with auto-retry on rate-limit errors.
 *
 * Backoff schedule: 10s, 20s, 40s (3 retries max). Non rate-limit
 * errors propagate immediately. The optional `onRetry` callback fires
 * BEFORE each sleep so the UI can show a countdown.
 */
export async function withRetryOnRateLimit<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DEFAULT_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isRateLimitError(e) || attempt === DEFAULT_RETRY_DELAYS_MS.length) {
        throw e;
      }
      const waitMs = DEFAULT_RETRY_DELAYS_MS[attempt]!;
      const reason = e instanceof Error ? e.message : String(e);
      console.warn(
        `[url-analyzer] rate limit hit (attempt ${attempt + 1}/${DEFAULT_RETRY_DELAYS_MS.length}), ` +
        `waiting ${(waitMs / 1000).toFixed(0)}s before retry. Reason: ${reason}`,
      );
      opts.onRetry?.({
        attempt: attempt + 1,
        maxAttempts: DEFAULT_RETRY_DELAYS_MS.length,
        waitMs,
        reason,
      });
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function delay(ms: number): Promise<void> {
  return sleep(ms);
}

/* -------------------------------------------------------------------------- */
/*  LLM system prompt                                                         */
/* -------------------------------------------------------------------------- */

const PARSE_SNAPSHOT_SYSTEM = [
  "Tu es un assistant qui transforme un SNAPSHOT structuré d'un site",
  "web en une description brand-research réutilisable. Le snapshot a",
  "déjà été extrait et nettoyé par un système séparé : tu n'as pas à",
  "faire de fetch, juste à lire et synthétiser.",
  "",
  "Tu reçois un objet JSON avec ces champs :",
  "  - meta : { title, description, lang, og:* }",
  "  - structure : { headings: [{level, text}], sections, nav_links,",
  "      forms: [{ action, method, fields: [{type, name, required}] }] }",
  "  - content : { main_text, main_html (extrait), links }",
  "  - styles  : { css (purgé, minifié), inline_styles_count }",
  "  - visual_signature : {",
  "      colors: { palette[], background, text, primary, link },",
  "      typography: { heading_font, body_font, size_scale, base_size_px },",
  "      radii: { button, input, card },",
  "      spacing: { base_unit_px, common_gaps_px },",
  "      layout: { max_content_width_px, mode },",
  "      components: { buttons, inputs, cards }",
  "    }",
  "",
  "Réponds UNIQUEMENT avec un objet JSON, sans markdown, sans",
  "backticks, sans commentaire. Schéma exact :",
  "",
  "{",
  '  "business": "<paragraphe FR de 6-10 phrases décrivant l\'entreprise, son audience, son ton, l\'ambiance générale de la marque. NE PAS parler de cadrage/composition/torse/chest>",',
  '  "formulaire": {',
  '    "forms": [',
  "      {",
  '        "name": "<slug court : signup | contact | newsletter | quote | demo | …>",',
  '        "purpose": "<1 phrase, à quoi sert le formulaire>",',
  '        "fields": [',
  "          {",
  '            "name": "<snake_case ou camelCase>",',
  '            "label": "<label humain tel que vu sur le site>",',
  '            "type": "<text | email | tel | url | number | textarea | select | checkbox | radio | date>",',
  '            "required": <true|false>,',
  '            "options": ["…"],   // requis si type=select|radio',
  '            "placeholder": "…"  // optionnel',
  "          }",
  "        ]",
  "      }",
  "    ]",
  "  },",
  '  "ui": {',
  '    "primaryColor": "#rrggbb",       // si visual_signature.colors.primary est valide, utilise-le',
  '    "secondaryColor": "#rrggbb",     // déduis depuis la palette',
  '    "backgroundColor": "#rrggbb",    // depuis visual_signature.colors.background',
  '    "buttonStyle": "<1-2 phrases : forme, bordure, ombre, fill/outline>",',
  '    "inputStyle": "<1-2 phrases : bordure, padding, fond, focus>",',
  '    "visualBrief": "<paragraphe FR de 4-8 phrases : identité visuelle, palette, typographie, polish, esprit>"',
  "  },",
  '  "logoUrl": "<URL ABSOLUE https://… du logo principal vu dans les images ou nav_links ; chaîne vide si introuvable>"',
  "}",
  "",
  "RÈGLES :",
  "- TOUTES les couleurs au format #rrggbb (6 chars lowercase).",
  "- Si visual_signature.colors.primary est null/manquant, choisis la",
  "  couleur la plus saturée non-grise de la palette (avec weight élevé).",
  "- Si aucun formulaire n'est détecté, renvoie {\"forms\": []}. Ne fabrique",
  "  pas de form fictif.",
  "- Pour logoUrl, cherche dans content.images et structure.nav_links un",
  "  src/href qui contient 'logo', 'brand', ou le nom du site. Sinon",
  "  fallback sur un favicon. URL DOIT être absolue (https://...).",
  "- Pour buttonStyle/inputStyle : lis visual_signature.components.buttons[0]",
  "  et inputs[0] (radius, padding, bg, fg) et écris une description courte.",
].join("\n");

/* -------------------------------------------------------------------------- */
/*  Snapshot compaction — keep the LLM payload small                          */
/* -------------------------------------------------------------------------- */

/**
 * Strip the fattest fields (full main_html, full css) from the snapshot
 * before sending to the LLM. We keep:
 *   - meta (titles, og)
 *   - the first 8000 chars of main_text (typical Sonnet 4.6 input window
 *     is huge, but we want fast / cheap calls)
 *   - structure (headings, forms, nav_links)
 *   - content.images (just src/alt — logo discovery hint)
 *   - styles.inline_styles_count (signal only, not the full CSS string)
 *   - the full visual_signature (small, deterministic)
 *
 * This keeps the prompt around 5-15 KB → ~2-5K tokens.
 */
function compactSnapshot(data: ExtractData): Record<string, unknown> {
  const truncate = (s: string, n: number) =>
    s.length > n ? s.slice(0, n) + "…[truncated]" : s;
  return {
    url: data.url,
    final_url: data.final_url,
    meta: data.meta,
    structure: {
      headings: data.structure.headings.slice(0, 40),
      nav_links: data.structure.nav_links.slice(0, 30),
      forms: data.structure.forms,
    },
    content: {
      main_text: truncate(data.content.main_text, 8000),
      images: data.content.images.slice(0, 20).map((i) => ({
        src: i.src,
        alt: i.alt,
      })),
      links: {
        internal_count: data.content.links.internal.length,
        external_count: data.content.links.external.length,
      },
    },
    styles: {
      inline_styles_count: data.styles.inline_styles_count,
      css_bytes: data.styles.css.length,
    },
    visual_signature: data.visual_signature,
  };
}

/* -------------------------------------------------------------------------- */
/*  SDK boundary — invokeBedrock cast (text-only)                             */
/* -------------------------------------------------------------------------- */

interface InvokeBedrockArgsLite {
  mandateId?: string;
  model: "claude-sonnet-4-6" | "claude-haiku-4-5" | "claude-opus-4-6";
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

interface InvokeBedrockResultLite {
  content: string;
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  creditsCharged: number;
  walletBalance: number;
  auditId: string;
}

function getInvokeBedrock(
  sdk: AithosSDK,
): (args: InvokeBedrockArgsLite) => Promise<InvokeBedrockResultLite> {
  return (sdk.compute as unknown as {
    invokeBedrock(args: InvokeBedrockArgsLite): Promise<InvokeBedrockResultLite>;
  }).invokeBedrock.bind(sdk.compute);
}

/* -------------------------------------------------------------------------- */
/*  Snapshot + parsed types                                                   */
/* -------------------------------------------------------------------------- */

export interface AnalyzerSnapshot extends AnalysisMeta {
  readonly data: ExtractData;
  /** Extraction credits (always 1 from the web extractor proxy). */
  readonly extractCreditsSpent: number;
}

export interface ParsedAnalysis extends AnalysisMeta {
  readonly business: string;
  readonly formulaire: FormulaireSchema;
  readonly ui: UiDescriptor;
  readonly logoUrl: string;
  /** Wall time + tokens for the LLM parse step only. */
  readonly llmCreditsSpent: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Step 1 of 2 — call the web-extractor proxy to produce a structured
 * snapshot of the target URL. Costs 1 mc on success.
 */
export async function extractSnapshot(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<AnalyzerSnapshot> {
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(trimmed)) {
    throw new Error("URL must start with http:// or https:// and look like a real URL");
  }

  console.log("[url-analyzer] extract call on", trimmed);
  const t0 = performance.now();
  const r = await withRetryOnRateLimit(
    () =>
      sdk.web.extract({
        url: trimmed,
        // The Lambda hard-caps at 60s; pass 30s default for snappy
        // failure on slow sites.
        timeoutMs: 30_000,
      }),
    retry,
  );
  const elapsedMs = performance.now() - t0;
  console.log(
    `[url-analyzer] extract returned in ${elapsedMs.toFixed(0)}ms, ` +
    `credits=${r.creditsCharged}, balance=${r.walletBalance}`,
  );

  return {
    data: r.data,
    extractCreditsSpent: r.creditsCharged,
    elapsedMs,
    urlsFetched: [
      r.data.meta.title !== null
        ? { url: r.data.final_url, title: r.data.meta.title }
        : { url: r.data.final_url },
    ],
    citations: [],
    creditsSpent: r.creditsCharged,
    webFetchInvocations: 0,
    rawContent: "",
  };
}

/**
 * Step 2 of 2 — pass the compacted snapshot to Claude Sonnet to produce
 * the UrlAnalysis shape callers consume.
 */
export async function parseSnapshot(
  sdk: AithosSDK,
  snapshot: AnalyzerSnapshot,
  retry: RetryOptions = {},
): Promise<ParsedAnalysis> {
  const invokeBedrock = getInvokeBedrock(sdk);
  const compact = compactSnapshot(snapshot.data);
  const promptJson = JSON.stringify(compact, null, 2);

  console.log(
    `[url-analyzer] parse call (${(promptJson.length / 1024).toFixed(1)} KB payload)`,
  );
  const t0 = performance.now();
  const r = await withRetryOnRateLimit(
    () =>
      invokeBedrock({
        model: "claude-sonnet-4-6",
        system: PARSE_SNAPSHOT_SYSTEM,
        messages: [
          {
            role: "user",
            content: `SNAPSHOT du site :\n\n${promptJson}\n\nRenvoie le JSON {business, formulaire, ui, logoUrl} comme spécifié dans le system prompt.`,
          },
        ],
        maxTokens: 2500,
      }),
    retry,
  );
  const elapsedMs = performance.now() - t0;
  console.log(
    `[url-analyzer] parse returned in ${elapsedMs.toFixed(0)}ms, ` +
    `tokens=${r.usage.inputTokens}/${r.usage.outputTokens}, credits=${r.creditsCharged}`,
  );

  const parsed = parseLlmJson(r.content);
  return {
    business: parsed.business,
    formulaire: parsed.formulaire,
    ui: parsed.ui,
    logoUrl: parsed.logoUrl,
    llmCreditsSpent: r.creditsCharged,
    inputTokens: r.usage.inputTokens,
    outputTokens: r.usage.outputTokens,
    elapsedMs,
    urlsFetched: snapshot.urlsFetched,
    citations: [],
    creditsSpent: r.creditsCharged,
    webFetchInvocations: 0,
    rawContent: r.content,
  };
}

/**
 * Full pipeline: extract → parse. Returns the `UrlAnalysis` shape
 * downstream code (design-agent, image generation) consumes.
 *
 * Best-effort client-side fetch of the logo URL into a data: URI is
 * provided for callers that need to embed the logo in downstream
 * image-gen prompts.
 */
export async function analyzeUrl(
  sdk: AithosSDK,
  url: string,
): Promise<
  UrlAnalysis & {
    readonly stats: {
      readonly extractMs: number;
      readonly parseMs: number;
      readonly totalMs: number;
      readonly extractCredits: number;
      readonly llmCredits: number;
      readonly totalCredits: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
    };
  }
> {
  const tStart = performance.now();
  const snapshot = await extractSnapshot(sdk, url);
  const parsed = await parseSnapshot(sdk, snapshot);

  let logoDataUri = "";
  let logoFetchError = "";
  if (parsed.logoUrl) {
    try {
      logoDataUri = await fetchAsDataUri(sdk, parsed.logoUrl);
    } catch (e) {
      logoFetchError = (e as Error).message;
      console.warn("[url-analyzer] logo fetch failed:", e);
    }
  }

  const totalMs = performance.now() - tStart;

  return {
    business: parsed.business,
    formulaire: parsed.formulaire,
    ui: parsed.ui,
    logoUrl: parsed.logoUrl,
    logoDataUri,
    logoFetchError,
    creditsSpent: snapshot.extractCreditsSpent + parsed.llmCreditsSpent,
    webFetchInvocations: 0,
    urlsFetched: [
      snapshot.data.meta.title !== null
        ? { url: snapshot.data.final_url, title: snapshot.data.meta.title }
        : { url: snapshot.data.final_url },
    ],
    citations: [],
    stats: {
      extractMs: snapshot.elapsedMs,
      parseMs: parsed.elapsedMs,
      totalMs,
      extractCredits: snapshot.extractCreditsSpent,
      llmCredits: parsed.llmCreditsSpent,
      totalCredits: snapshot.extractCreditsSpent + parsed.llmCreditsSpent,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Sub-step wrappers — drop-in for BrandedRobot.tsx                          */
/*                                                                            */
/*  Module-level cache keyed by URL so the four UI buttons (business,        */
/*  formulaire, ui, logo) re-use one extraction and one parse.                */
/* -------------------------------------------------------------------------- */

const snapshotCache = new Map<string, Promise<AnalyzerSnapshot>>();
const parsedCache = new Map<string, Promise<ParsedAnalysis>>();

function getSnapshot(sdk: AithosSDK, url: string, retry: RetryOptions) {
  const key = url.trim();
  let p = snapshotCache.get(key);
  if (!p) {
    p = extractSnapshot(sdk, key, retry);
    snapshotCache.set(key, p);
  }
  return p;
}

function getParsed(sdk: AithosSDK, url: string, retry: RetryOptions) {
  const key = url.trim();
  let p = parsedCache.get(key);
  if (!p) {
    p = (async () => parseSnapshot(sdk, await getSnapshot(sdk, key, retry), retry))();
    parsedCache.set(key, p);
  }
  return p;
}

/** Clear the per-URL cache. Call when the user types a new URL. */
export function resetAnalyzerCache(url?: string): void {
  if (url === undefined) {
    snapshotCache.clear();
    parsedCache.clear();
  } else {
    snapshotCache.delete(url.trim());
    parsedCache.delete(url.trim());
  }
}

export async function analyzeBusinessFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<BusinessAnalysis> {
  const parsed = await getParsed(sdk, url, retry);
  return {
    business: parsed.business,
    elapsedMs: parsed.elapsedMs,
    urlsFetched: parsed.urlsFetched,
    citations: parsed.citations,
    creditsSpent: parsed.creditsSpent,
    webFetchInvocations: parsed.webFetchInvocations,
    rawContent: parsed.rawContent,
  };
}

export async function analyzeFormulaireFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<FormulaireAnalysis> {
  const parsed = await getParsed(sdk, url, retry);
  return {
    formulaire: parsed.formulaire,
    elapsedMs: parsed.elapsedMs,
    urlsFetched: parsed.urlsFetched,
    citations: parsed.citations,
    creditsSpent: parsed.creditsSpent,
    webFetchInvocations: parsed.webFetchInvocations,
    rawContent: parsed.rawContent,
  };
}

export async function analyzeUiFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<UiAnalysis> {
  const parsed = await getParsed(sdk, url, retry);
  return {
    ui: parsed.ui,
    elapsedMs: parsed.elapsedMs,
    urlsFetched: parsed.urlsFetched,
    citations: parsed.citations,
    creditsSpent: parsed.creditsSpent,
    webFetchInvocations: parsed.webFetchInvocations,
    rawContent: parsed.rawContent,
  };
}

export async function extractLogoFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<LogoExtraction> {
  // The lambda resolves the best logo asset server-side as part of
  // `aithos.web_extract` — apple-touch-icon, declared <link rel="icon">,
  // conventional well-known paths. We just consume what it returns.
  // No client-side CORS dance, no separate fetch.
  //
  // Both `getSnapshot` and `getParsed` are cached per-URL, so reading
  // both here costs nothing extra when the user has already (or will
  // later) run the other sub-steps (business / UI / formulaire).
  //
  // Backward-compat: an older deployed lambda predates the logo field.
  // In that case `snapshot.data.logo` is undefined and we fall back to
  // the legacy path (Sonnet-identified logoUrl + client-side
  // fetchAsDataUri with CORS bypass).
  const snapshot = await getSnapshot(sdk, url, retry);
  const lambdaLogo = snapshot.data.logo;

  if (lambdaLogo) {
    const dataUri = `data:${lambdaLogo.content_type};base64,${lambdaLogo.base64}`;
    let logoWidth = 0;
    let logoHeight = 0;
    try {
      const dims = await probeDataUriDims(dataUri);
      logoWidth = dims.width;
      logoHeight = dims.height;
    } catch {
      // decode failure is non-fatal — caller still has the data URI
    }
    console.log(
      `[url-analyzer] lambda-resolved logo: ${lambdaLogo.source}, ${lambdaLogo.size_bytes} bytes, ${logoWidth}×${logoHeight}`,
    );
    return {
      logoUrl: lambdaLogo.url,
      logoDataUri: dataUri,
      logoFetchError: "",
      logoSource: `lambda:${lambdaLogo.source}`,
      logoWidth,
      logoHeight,
      // Logo is delivered as part of the existing 1mc snapshot — no
      // extra LLM cost. We surface the snapshot's wall-time + meta so
      // the UI can still attribute credits / elapsed properly.
      elapsedMs: snapshot.elapsedMs,
      urlsFetched: snapshot.urlsFetched,
      citations: snapshot.citations,
      creditsSpent: 0,
      webFetchInvocations: 0,
      rawContent: `[lambda-logo ${lambdaLogo.source} ${lambdaLogo.size_bytes}b]`,
    };
  }

  // Either the deployed lambda predates the logo field OR it ran but
  // didn't find any usable asset (`logo: null`). Fall back to the
  // legacy behaviour: use the Sonnet-identified logoUrl + client-side
  // fetch with CORS bypass.
  console.log(
    "[url-analyzer] lambda did not provide a logo; falling back to Sonnet-identified logoUrl + client fetch",
  );
  const parsed = await getParsed(sdk, url, retry);
  let logoDataUri = "";
  let logoFetchError = "";
  let logoWidth = 0;
  let logoHeight = 0;
  if (parsed.logoUrl) {
    try {
      logoDataUri = await fetchAsDataUri(sdk, parsed.logoUrl);
      try {
        const dims = await probeDataUriDims(logoDataUri);
        logoWidth = dims.width;
        logoHeight = dims.height;
      } catch {
        // dimensions are nice-to-have, not fatal
      }
    } catch (e) {
      logoFetchError = (e as Error).message;
    }
  }
  return {
    logoUrl: parsed.logoUrl,
    logoDataUri,
    logoFetchError,
    logoSource: parsed.logoUrl ? "sonnet" : null,
    logoWidth,
    logoHeight,
    elapsedMs: parsed.elapsedMs,
    urlsFetched: parsed.urlsFetched,
    citations: parsed.citations,
    creditsSpent: parsed.creditsSpent,
    webFetchInvocations: parsed.webFetchInvocations,
    rawContent: parsed.rawContent,
  };
}

function probeDataUriDims(
  dataUri: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUri;
  });
}

/* -------------------------------------------------------------------------- */
/*  JSON parsing                                                              */
/* -------------------------------------------------------------------------- */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

interface LlmParsed {
  business: string;
  formulaire: FormulaireSchema;
  ui: UiDescriptor;
  logoUrl: string;
}

function parseLlmJson(content: string): LlmParsed {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `LLM returned non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;

  const business = typeof obj.business === "string" ? obj.business.trim() : "";
  if (!business) {
    throw new Error("LLM JSON: business missing or empty");
  }
  const formulaire = parseFormulaire(obj.formulaire);
  const ui = parseUi(obj.ui);
  const logoUrl = typeof obj.logoUrl === "string" ? obj.logoUrl.trim() : "";
  return { business, formulaire, ui, logoUrl };
}

function parseFormulaire(raw: unknown): FormulaireSchema {
  if (!raw || typeof raw !== "object") return { forms: [] };
  const formsRaw = (raw as { forms?: unknown }).forms;
  if (!Array.isArray(formsRaw)) return { forms: [] };
  const forms: DetectedForm[] = [];
  for (const fr of formsRaw) {
    if (!fr || typeof fr !== "object") continue;
    const f = fr as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name : "form";
    const purpose = typeof f.purpose === "string" ? f.purpose : "";
    const fieldsRaw = Array.isArray(f.fields) ? f.fields : [];
    const fields: FormField[] = [];
    for (const fld of fieldsRaw) {
      if (!fld || typeof fld !== "object") continue;
      const ff = fld as Record<string, unknown>;
      const opts = Array.isArray(ff.options) ? ff.options : null;
      fields.push({
        name: typeof ff.name === "string" ? ff.name : "field",
        label: typeof ff.label === "string" ? ff.label : "",
        type: typeof ff.type === "string" ? ff.type : "text",
        required: ff.required === true,
        ...(opts
          ? { options: opts.filter((o): o is string => typeof o === "string") }
          : {}),
        ...(typeof ff.placeholder === "string"
          ? { placeholder: ff.placeholder }
          : {}),
      });
    }
    forms.push({ name, purpose, fields });
  }
  return { forms };
}

function parseUi(raw: unknown): UiDescriptor {
  if (!raw || typeof raw !== "object") {
    throw new Error("LLM JSON: ui missing or not an object");
  }
  const r = raw as Record<string, unknown>;
  for (const k of ["primaryColor", "secondaryColor", "backgroundColor"] as const) {
    const v = r[k];
    if (typeof v !== "string" || !HEX_RE.test(v)) {
      throw new Error(
        `LLM JSON: ui.${k} missing or not a valid #rrggbb hex (got ${JSON.stringify(v)})`,
      );
    }
  }
  const visualBrief = typeof r.visualBrief === "string" ? r.visualBrief.trim() : "";
  if (!visualBrief) throw new Error("LLM JSON: ui.visualBrief missing or empty");
  return {
    primaryColor: (r.primaryColor as string).toLowerCase() as HexColor,
    secondaryColor: (r.secondaryColor as string).toLowerCase() as HexColor,
    backgroundColor: (r.backgroundColor as string).toLowerCase() as HexColor,
    buttonStyle: typeof r.buttonStyle === "string" ? r.buttonStyle.trim() : "",
    inputStyle: typeof r.inputStyle === "string" ? r.inputStyle.trim() : "",
    visualBrief,
  };
}

/* -------------------------------------------------------------------------- */
/*  Logo fetch helper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort fetch of an absolute URL → base64 data URI. Three
 * strategies in order:
 *
 *   1. `fetch(url, {mode:"cors"})` + blob — cheapest; succeeds when
 *      the server returns `Access-Control-Allow-Origin: *`. Rare in
 *      production.
 *   2. `<img crossOrigin="anonymous">` + canvas readback — succeeds
 *      when the IMG GET returns CORS headers (common for CDN-hosted
 *      logos: jsdelivr, jimcdn, cloudfront).
 *   3. Server-side proxy via `aithos.web_fetch_asset` on the
 *      web-extractor lambda. Costs 1 mc; bypasses CORS by fetching
 *      the asset from the server. Last resort.
 */
export async function fetchAsDataUri(sdk: AithosSDK, url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`logoUrl is not an absolute http(s) URL: ${url}`);
  }
  // Strategy 1 — fetch + blob
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) {
      throw new Error(`not an image (got ${blob.type})`);
    }
    return await blobToDataUri(blob);
  } catch (e1) {
    console.warn(
      `[url-analyzer] fetch CORS failed for ${url}: ${(e1 as Error).message}. trying <img> + canvas.`,
    );
  }
  // Strategy 2 — <img crossOrigin> + canvas
  try {
    return await imgElementToDataUri(url);
  } catch (e2) {
    console.warn(
      `[url-analyzer] <img> + canvas failed for ${url}: ${(e2 as Error).message}. trying server-side proxy.`,
    );
  }
  // Strategy 3 — server-side proxy via aithos.web_fetch_asset
  const r = await sdk.web.fetchAsset({ url });
  console.log(
    `[url-analyzer] server-side fetch OK: ${r.data.size_bytes} bytes, ${r.data.content_type}, ${r.creditsCharged} mc`,
  );
  return `data:${r.data.content_type};base64,${r.data.base64}`;
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("FileReader returned non-string"));
    };
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

function imgElementToDataUri(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (w === 0 || h === 0) throw new Error("zero-dimension image");
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas 2d context");
        ctx.drawImage(img, 0, 0);
        // toDataURL throws SecurityError if the canvas is tainted
        // (server didn't send CORS headers on the IMG GET).
        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(new Error(`canvas readback failed: ${(e as Error).message}`));
      }
    };
    img.onerror = () => reject(new Error("img load failed (probably CORS or network)"));
    img.src = url;
  });
}
