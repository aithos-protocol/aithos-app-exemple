// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// URL → structured brand analysis (v16 — split into 4 independent calls).
//
// v15 packed business + formulaire + ui + logoUrl into a single
// invokeUrlFetch call. That call timed out on slow sites (Failed to
// fetch, > ~60s end-to-end). v16 splits the work into 4 focused calls
// the operator can fire one by one, in parallel, or sequentially:
//
//   - analyzeBusinessFromUrl(sdk, url)   → { business }
//   - analyzeFormulaireFromUrl(sdk, url) → { formulaire }
//   - analyzeUiFromUrl(sdk, url)         → { ui }
//   - extractLogoFromUrl(sdk, url)       → { logoUrl, logoDataUri }
//
// Each call uses a small system prompt focused on its single concern,
// modest maxTokens (~800-1500), and at most 1-2 sub-page fetches.
// The 4 results combine into the same UrlAnalysis shape used by v15
// for callers that want everything in one object.

import type { AithosSDK } from "@aithos/sdk";

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
  /** Wall-clock time (ms) the SDK call took. */
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
/*  SDK boundary                                                              */
/* -------------------------------------------------------------------------- */

interface UrlFetchArgs {
  prompt: string;
  system?: string;
  model?: "claude-haiku-4-5" | "claude-sonnet-4-6" | "claude-opus-4-6";
  maxTokens?: number;
  maxFetches?: number;
  maxContentTokens?: number;
  citations?: boolean;
  allowedDomains?: readonly string[];
  blockedDomains?: readonly string[];
}

interface UrlFetchResult {
  content: string;
  citations: ReadonlyArray<{
    url: string;
    citedText: string;
    documentTitle?: string;
  }>;
  urlsFetched: ReadonlyArray<{ url: string; title?: string }>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    webFetchInvocations: number;
  };
  creditsCharged: number;
}

function getInvokeUrlFetch(sdk: AithosSDK): (args: UrlFetchArgs) => Promise<UrlFetchResult> {
  // Cast at the boundary: invokeUrlFetch landed in @aithos/sdk
  // alpha.20. The example app's installed version may still be older.
  const compute = sdk.compute as unknown as {
    invokeUrlFetch(args: UrlFetchArgs): Promise<UrlFetchResult>;
  };
  return compute.invokeUrlFetch.bind(compute);
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

/** Heuristic: does this error look like an Anthropic rate-limit signal? */
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
 * Wrap an async fn with auto-retry on Anthropic rate-limit errors.
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

function assertHttpUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(trimmed)) {
    throw new Error("URL must start with http:// or https:// and look like a real URL");
  }
  return trimmed;
}

function metaFrom(r: UrlFetchResult, elapsedMs: number): AnalysisMeta {
  return {
    urlsFetched: r.urlsFetched,
    citations: r.citations.map((c) => ({ url: c.url, citedText: c.citedText })),
    creditsSpent: r.creditsCharged,
    webFetchInvocations: r.usage.webFetchInvocations,
    elapsedMs,
    rawContent: r.content,
  };
}

/* -------------------------------------------------------------------------- */
/*  System prompts (one per concern, deliberately small)                      */
/* -------------------------------------------------------------------------- */

const BUSINESS_SYSTEM_PROMPT = [
  "Tu es un assistant de brand-research.",
  "",
  "On va te donner UN URL. Ta mission UNIQUE :",
  "  1. Fetche cette page (et au plus 1 sous-page utile : /about,",
  "     /a-propos, /qui-sommes-nous) pour comprendre l'entreprise.",
  "  2. Rédige UN paragraphe de 6 à 10 phrases EN FRANÇAIS qui",
  "     décrit : ce que fait l'entreprise, son audience cible, son",
  "     ton (sérieux / playful / luxueux / industriel / technique /",
  "     accessible), et l'ambiance générale de la marque.",
  "",
  "Le paragraphe NE DOIT PAS contenir :",
  "  - d'instructions de cadrage ou de composition (centred, square,",
  "    halo, framing, crop) — gérées par un système séparé en aval.",
  "  - de mention du chest / sternum / pectoral / breastplate / torse —",
  "    un logo y sera composé en aval, toute description du torse",
  "    interférerait avec ce processus.",
  "",
  "Réponds UNIQUEMENT avec le paragraphe descriptif, pas",
  "d'introduction, pas de markdown, pas de bullet points. Du texte",
  "brut prêt à être collé dans un textarea.",
].join("\n");

const FORMULAIRE_SYSTEM_PROMPT = [
  "Tu es un assistant qui extrait les FORMULAIRES présents sur un",
  "site web.",
  "",
  "On va te donner UN URL. Ta mission UNIQUE :",
  "  1. Fetche cette page (et 1 à 2 sous-pages susceptibles d'avoir",
  "     un formulaire : /contact, /signup, /demo, /quote, /pricing,",
  "     /reservation, /book, /devis…).",
  "  2. Repère TOUS les formulaires visibles, et liste leurs champs.",
  "",
  "Réponds UNIQUEMENT avec un objet JSON, sans markdown, sans",
  "backticks, sans commentaire. Schéma exact :",
  "",
  "{",
  '  "forms": [',
  "    {",
  '      "name": "<slug court : signup | contact | newsletter | checkout | demo | quote | …>",',
  '      "purpose": "<1 phrase : à quoi sert ce formulaire>",',
  '      "fields": [',
  "        {",
  '          "name": "<nom programmatique snake_case ou camelCase>",',
  '          "label": "<label humain tel que vu sur le site>",',
  '          "type": "<text | email | tel | url | number | textarea | select | checkbox | radio | date>",',
  '          "required": <true|false>,',
  '          "options": ["…"],            // OBLIGATOIRE si type=select|radio, sinon omettre',
  '          "placeholder": "…"            // optionnel',
  "        }",
  "      ]",
  "    }",
  "  ]",
  "}",
  "",
  "RÈGLES :",
  '- Si tu ne trouves AUCUN formulaire, renvoie {"forms": []}.',
  "  Ne fabrique pas de form fictif.",
  "- Liste les champs dans l'ordre où ils apparaissent.",
  "- Si tu n'es pas sûr du label exact, mets ta meilleure",
  "  approximation.",
].join("\n");

const UI_SYSTEM_PROMPT = [
  "Tu es un assistant d'analyse UI / brand visual.",
  "",
  "On va te donner UN URL. Ta mission UNIQUE :",
  "  1. Fetche la page d'accueil (sous-pages facultatives, max 1).",
  "  2. Décris la DNA graphique du site.",
  "",
  "Réponds UNIQUEMENT avec un objet JSON, sans markdown, sans",
  "backticks, sans commentaire. Schéma exact :",
  "",
  "{",
  '  "primaryColor": "#rrggbb",            // couleur primaire de la marque (CTA principal)',
  '  "secondaryColor": "#rrggbb",          // couleur secondaire / accent',
  '  "backgroundColor": "#rrggbb",         // couleur dominante du fond de page',
  '  "buttonStyle": "<1 à 2 phrases : forme (pill / arrondi / rectangulaire), bordure, ombre, hover, fill / outline>",',
  '  "inputStyle": "<1 à 2 phrases : bordure, padding, fond, label position, états focus>",',
  '  "visualBrief": "<paragraphe FR de 4 à 8 phrases : identité visuelle, palette, typographies, niveau de polish, esprit (minimal / éditorial / corporate / brutaliste / fun…), ambiance générale>"',
  "}",
  "",
  "RÈGLES :",
  "- TOUTES les couleurs au format #rrggbb (6 chars, lowercase).",
  "- Si tu n'es pas sûr d'une teinte précise, donne ta meilleure",
  "  approximation hex.",
].join("\n");

const LOGO_SYSTEM_PROMPT = [
  "Tu es un assistant qui retrouve l'URL du LOGO d'un site web.",
  "",
  "On va te donner UN URL. Ta mission UNIQUE :",
  "  1. Fetche cette page (pas de sous-page nécessaire).",
  "  2. Identifie l'URL ABSOLUE de l'image principale du logo trouvée",
  "     dans le header / nav. Si introuvable, fallback sur le favicon",
  "     (icon link tag).",
  "",
  "Réponds UNIQUEMENT avec un objet JSON, pas de markdown :",
  "",
  "{",
  '  "logoUrl": "<URL ABSOLUE https://…  ou chaîne vide si vraiment rien>"',
  "}",
  "",
  "RÈGLES :",
  "- logoUrl DOIT être une URL ABSOLUE (https://…). Si tu vois un src",
  "  relatif (ex: /assets/logo.svg), construis l'URL absolue à partir",
  '  de l\'origin du site donné.',
  '- Si rien ne ressemble à un logo, renvoie une chaîne vide ("").',
].join("\n");

/* -------------------------------------------------------------------------- */
/*  Public API — 4 small calls                                                */
/* -------------------------------------------------------------------------- */

/** Step 1 of 4 — paragraph describing the business. */
export async function analyzeBusinessFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<BusinessAnalysis> {
  const trimmed = assertHttpUrl(url);
  const invokeUrlFetch = getInvokeUrlFetch(sdk);

  console.log("[url-analyzer] business call on", trimmed);
  const t0 = performance.now();
  const r = await withRetryOnRateLimit(
    () =>
      invokeUrlFetch({
        prompt: `URL :\n${trimmed}\n\nFetche la page (et 1 sous-page about/à-propos si utile) puis rédige le paragraphe descriptif.`,
        system: BUSINESS_SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        maxTokens: 800,
        maxFetches: 2,
        maxContentTokens: 60_000,
        citations: true,
      }),
    retry,
  );
  const elapsedMs = performance.now() - t0;
  console.log(`[url-analyzer] business returned in ${elapsedMs.toFixed(0)}ms, credits=${r.creditsCharged}`);

  return {
    business: r.content.trim(),
    ...metaFrom(r, elapsedMs),
  };
}

/** Step 2 of 4 — JSON of detected forms. */
export async function analyzeFormulaireFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<FormulaireAnalysis> {
  const trimmed = assertHttpUrl(url);
  const invokeUrlFetch = getInvokeUrlFetch(sdk);

  console.log("[url-analyzer] formulaire call on", trimmed);
  const t0 = performance.now();
  const r = await withRetryOnRateLimit(
    () =>
      invokeUrlFetch({
        prompt: `URL :\n${trimmed}\n\nFetche la page (et 1 à 2 sous-pages susceptibles d'avoir un formulaire) puis renvoie le JSON {forms: [...]}.`,
        system: FORMULAIRE_SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        maxTokens: 1500,
        maxFetches: 3,
        maxContentTokens: 80_000,
        citations: false,
      }),
    retry,
  );
  const elapsedMs = performance.now() - t0;
  console.log(`[url-analyzer] formulaire returned in ${elapsedMs.toFixed(0)}ms, credits=${r.creditsCharged}`);

  const formulaire = parseFormulaire(parseJsonObject(r.content));
  return {
    formulaire,
    ...metaFrom(r, elapsedMs),
  };
}

/** Step 3 of 4 — graphic DNA of the site. */
export async function analyzeUiFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<UiAnalysis> {
  const trimmed = assertHttpUrl(url);
  const invokeUrlFetch = getInvokeUrlFetch(sdk);

  console.log("[url-analyzer] ui call on", trimmed);
  const t0 = performance.now();
  const r = await withRetryOnRateLimit(
    () =>
      invokeUrlFetch({
        prompt: `URL :\n${trimmed}\n\nFetche la page d'accueil puis renvoie le JSON {primaryColor, secondaryColor, backgroundColor, buttonStyle, inputStyle, visualBrief}.`,
        system: UI_SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        maxTokens: 1200,
        maxFetches: 2,
        maxContentTokens: 60_000,
        citations: false,
      }),
    retry,
  );
  const elapsedMs = performance.now() - t0;
  console.log(`[url-analyzer] ui returned in ${elapsedMs.toFixed(0)}ms, credits=${r.creditsCharged}`);

  const ui = parseUi(parseJsonObject(r.content));
  return {
    ui,
    ...metaFrom(r, elapsedMs),
  };
}

/** Step 4 of 4 — logo URL discovery + best-effort client-side fetch. */
export async function extractLogoFromUrl(
  sdk: AithosSDK,
  url: string,
  retry: RetryOptions = {},
): Promise<LogoExtraction> {
  const trimmed = assertHttpUrl(url);
  const invokeUrlFetch = getInvokeUrlFetch(sdk);

  console.log("[url-analyzer] logo call on", trimmed);
  const t0 = performance.now();
  const r = await withRetryOnRateLimit(
    () =>
      invokeUrlFetch({
        prompt: `URL :\n${trimmed}\n\nFetche la page puis renvoie le JSON {logoUrl}.`,
        system: LOGO_SYSTEM_PROMPT,
        model: "claude-sonnet-4-6",
        maxTokens: 400,
        maxFetches: 1,
        maxContentTokens: 40_000,
        citations: false,
      }),
    retry,
  );
  const elapsedMs = performance.now() - t0;
  console.log(`[url-analyzer] logo returned in ${elapsedMs.toFixed(0)}ms, credits=${r.creditsCharged}`);

  const obj = parseJsonObject(r.content);
  const logoUrl = typeof obj.logoUrl === "string" ? obj.logoUrl.trim() : "";

  let logoDataUri = "";
  let logoFetchError = "";
  if (logoUrl) {
    try {
      logoDataUri = await fetchAsDataUri(logoUrl);
    } catch (e) {
      logoFetchError = (e as Error).message;
      console.warn("[url-analyzer] logo fetch failed:", e);
    }
  }

  return {
    logoUrl,
    logoDataUri,
    logoFetchError,
    ...metaFrom(r, elapsedMs),
  };
}

/**
 * Run all four sub-analyses sequentially. Convenience wrapper for
 * callers that want a single call but accept the longer wall time.
 *
 * Adds a small inter-call delay to avoid the Anthropic per-minute rate
 * limit. Each sub-call retries with exponential backoff on rate-limit
 * errors (10s / 20s / 40s, max 3 retries).
 */
export async function analyzeUrl(
  sdk: AithosSDK,
  url: string,
): Promise<UrlAnalysis> {
  const business = await analyzeBusinessFromUrl(sdk, url);
  await sleep(3000);
  const formulaire = await analyzeFormulaireFromUrl(sdk, url);
  await sleep(3000);
  const ui = await analyzeUiFromUrl(sdk, url);
  await sleep(3000);
  const logo = await extractLogoFromUrl(sdk, url);

  return {
    business: business.business,
    formulaire: formulaire.formulaire,
    ui: ui.ui,
    logoUrl: logo.logoUrl,
    logoDataUri: logo.logoDataUri,
    logoFetchError: logo.logoFetchError,
    creditsSpent:
      business.creditsSpent + formulaire.creditsSpent + ui.creditsSpent + logo.creditsSpent,
    webFetchInvocations:
      business.webFetchInvocations +
      formulaire.webFetchInvocations +
      ui.webFetchInvocations +
      logo.webFetchInvocations,
    urlsFetched: [
      ...business.urlsFetched,
      ...formulaire.urlsFetched,
      ...ui.urlsFetched,
      ...logo.urlsFetched,
    ],
    citations: [
      ...business.citations,
      ...formulaire.citations,
      ...ui.citations,
      ...logo.citations,
    ],
  };
}

/* -------------------------------------------------------------------------- */
/*  JSON parsing helpers                                                      */
/* -------------------------------------------------------------------------- */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function parseJsonObject(content: string): Record<string, unknown> {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Sonnet returned non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  const json = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Sonnet returned malformed JSON: ${(e as Error).message}. Content: ${json.slice(0, 200)}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Sonnet JSON is not an object");
  }
  return obj as Record<string, unknown>;
}

function parseFormulaire(raw: Record<string, unknown>): FormulaireSchema {
  const formsRaw = raw.forms;
  if (!Array.isArray(formsRaw)) {
    return { forms: [] };
  }
  const forms: DetectedForm[] = [];
  for (const fr of formsRaw) {
    if (!fr || typeof fr !== "object") continue;
    const form = fr as Record<string, unknown>;
    const name = typeof form.name === "string" ? form.name : "form";
    const purpose = typeof form.purpose === "string" ? form.purpose : "";
    const fieldsRaw = Array.isArray(form.fields) ? form.fields : [];
    const fields: FormField[] = [];
    for (const fld of fieldsRaw) {
      if (!fld || typeof fld !== "object") continue;
      const ff = fld as Record<string, unknown>;
      const fieldName = typeof ff.name === "string" ? ff.name : "field";
      const label = typeof ff.label === "string" ? ff.label : fieldName;
      const type = typeof ff.type === "string" ? ff.type : "text";
      const required = ff.required === true;
      const optionsRaw = Array.isArray(ff.options) ? ff.options : null;
      const placeholderRaw = typeof ff.placeholder === "string" ? ff.placeholder : "";
      const fieldOut: FormField = {
        name: fieldName,
        label,
        type,
        required,
        ...(optionsRaw
          ? { options: optionsRaw.filter((o): o is string => typeof o === "string") }
          : {}),
        ...(placeholderRaw ? { placeholder: placeholderRaw } : {}),
      };
      fields.push(fieldOut);
    }
    forms.push({ name, purpose, fields });
  }
  return { forms };
}

function parseUi(raw: Record<string, unknown>): UiDescriptor {
  for (const key of ["primaryColor", "secondaryColor", "backgroundColor"] as const) {
    const v = raw[key];
    if (typeof v !== "string" || !HEX_RE.test(v)) {
      throw new Error(
        `Sonnet JSON: ${key} missing or not a valid #rrggbb hex (got ${JSON.stringify(v)})`,
      );
    }
  }
  const buttonStyle = typeof raw.buttonStyle === "string" ? raw.buttonStyle.trim() : "";
  const inputStyle = typeof raw.inputStyle === "string" ? raw.inputStyle.trim() : "";
  const visualBrief = typeof raw.visualBrief === "string" ? raw.visualBrief.trim() : "";
  if (visualBrief.length === 0) {
    throw new Error("Sonnet JSON: visualBrief missing or empty");
  }
  return {
    primaryColor: (raw.primaryColor as string).toLowerCase() as HexColor,
    secondaryColor: (raw.secondaryColor as string).toLowerCase() as HexColor,
    backgroundColor: (raw.backgroundColor as string).toLowerCase() as HexColor,
    buttonStyle,
    inputStyle,
    visualBrief,
  };
}

/* -------------------------------------------------------------------------- */
/*  Logo fetch helper                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort client-side fetch of an absolute URL → base64 data URI.
 * Throws on network / CORS errors so the caller can surface a hint.
 */
async function fetchAsDataUri(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`logoUrl is not an absolute http(s) URL: ${url}`);
  }
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(`fetched resource is not an image (got ${blob.type})`);
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("FileReader returned non-string"));
    };
    reader.onerror = () => reject(new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}
