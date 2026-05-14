// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Site builder — produces a single-file static HTML demo of the
// branded agent for the target company.
//
// Architecture:
//   1. A fixed HTML template (src/assets/agent-template.html) lays out
//      the page exactly like switchia-draft/UI/agent.html: floating
//      glass header, robot column on the left, conversation feed on
//      the right, composer pinned to row 2, full mobile intro
//      animation. The composition is locked.
//   2. Opus 4.6 reads BUSINESS + UI + FORMULAIRE + the site URL and
//      produces a small JSON of brand-tailored TEXTS (title, brand,
//      brandSub, introMessage, ctaLabel, ctaHref, placeholder,
//      sendLabel, replies[]).
//   3. The client substitutes {{TOKENS}} in the template with the
//      Opus output + the extracted UI palette + the inlined robot
//      data URI + the logo data URI.
//
// Why split LLM/client work this way? Asking Opus to regenerate a
// 20 KB HTML file each time wastes ~250 mc per build and risks
// transcription mistakes. The split keeps Opus focused on the
// brand-tone copy (cheap, ~20 mc) and gives us a tamper-proof
// composition the user can rely on.

import type { AithosSDK } from "@aithos/sdk";

import type { FormulaireSchema, UiDescriptor } from "./url-analyzer.js";

import templateRaw from "../assets/agent-template.html?raw";

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

export interface SiteBuilderArgs {
  readonly sdk: AithosSDK;
  /** Extracted business paragraph (from url-analyzer). */
  readonly business: string;
  /** Extracted UI descriptor (palette + styles). */
  readonly ui: UiDescriptor;
  /** Detected formulaire schema. Optional — used by Opus for sector signals. */
  readonly formulaire?: FormulaireSchema;
  /** Original site URL (used as the "Aller sur le site" link). */
  readonly siteUrl: string;
  /** Final composited robot (step 4 dataUri, transparent bg, logo on chest). */
  readonly robotDataUri: string;
  /** Brand logo data URI for the header (uploaded or fetched via proxy). */
  readonly logoDataUri: string;
  /** Optional manual company name override. If omitted, Opus picks one
   *  from the business paragraph. */
  readonly companyNameOverride?: string;
  /** Model — defaults to claude-opus-4-6. */
  readonly model?: "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-haiku-4-5";
}

export interface SiteBuilderResult {
  /** The full HTML, ready to download / preview / serve. */
  readonly html: string;
  /** The Opus-generated brand JSON used as the substitution source. */
  readonly brandJson: BrandSiteJson;
  /** Microcredits debited by the Opus call. */
  readonly creditsSpent: number;
  /** Wall-clock time of the Opus call (ms). */
  readonly elapsedMs: number;
}

export interface BrandSiteJson {
  /** Tab title in the browser ("<Brand> — Agent"). */
  readonly title: string;
  /** Short brand label shown in the header. */
  readonly brand: string;
  /** All-caps subtitle under the brand (think "Stripe — payments online"). */
  readonly brandSub: string;
  /** First message the agent sends to the visitor. */
  readonly introMessage: string;
  /**
   * Header CTA label. Hard-coded to "Aller sur le site" by the
   * substitution layer — kept in the type so consumers can read it
   * back, but Opus does NOT generate it (we want a consistent label
   * across all generated sites).
   */
  readonly ctaLabel: string;
  /**
   * Header CTA href. Hard-coded to `siteUrl` (the target company's
   * site) — same rationale as ctaLabel.
   */
  readonly ctaHref: string;
  /** Composer input placeholder. */
  readonly placeholder: string;
  /** Send-button label. */
  readonly sendLabel: string;
  /** 10-14 canned replies the demo rotates through. */
  readonly replies: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*  System prompt                                                             */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  "You are writing the brand-tailored COPY for a single-page demo of an",
  "AI-powered customer-facing agent. The page composition is locked: a",
  "glass header with the company logo + brand name + tag-line + a small",
  "CTA to the real site, a conversation pane with a branded mascot robot",
  "on the left, a composer (textarea + send button) at the bottom. Your",
  "ONLY job is to produce the COPY: titles, the agent's intro message,",
  "labels, and a list of canned chat replies that match the brand's tone",
  "and sector.",
  "",
  "You receive THREE inputs:",
  "  - BUSINESS — paragraph describing the company, its audience, tone.",
  "  - UI — palette + visual-identity summary of the company's site.",
  "  - FORMULAIRE — JSON of detected forms on the site (signals the kind",
  "    of conversation the agent will likely handle — quote requests,",
  "    contact-me forms, etc.).",
  "  - SITE_URL — absolute URL of the company's site (used verbatim as",
  "    the CTA destination).",
  "",
  "Reply ONLY with a JSON object — no markdown, no backticks, no prose",
  "outside the JSON. Schema (all strings unless noted):",
  "",
  "{",
  '  "title":        "<browser tab title — e.g.  \\"Akena Vérandas — Agent\\". ≤ 60 chars>",',
  '  "brand":        "<short brand label as shown on the company site — typical 1-3 words, ≤ 28 chars>",',
  '  "brandSub":     "<one-line tag-line in FR, ≤ 60 chars, will be uppercased via CSS — keep it short and on-tone>",',
  '  "introMessage": "<first message the agent sends — FR, 1-2 sentences, friendly + brand-coherent, ≤ 240 chars>",',
  '  "placeholder":  "<textarea placeholder — FR, ≤ 60 chars, conversational>",',
  '  "sendLabel":    "<send button label — FR, ≤ 14 chars, e.g.  \\"Envoyer\\",  \\"OK\\",  \\"Discuter\\">",',
  '  "replies":      ["<short FR reply 1>", "<2>", ...]',
  "                  10 to 14 entries, ≤ 140 chars each. Mix of",
  "                  acknowledgements, follow-up questions, and",
  "                  sector-relevant micro-responses. The demo picks",
  "                  one at random per user message, so they should",
  "                  sound natural regardless of what the visitor types.",
  "}",
  "",
  "DO NOT emit `ctaLabel` or `ctaHref` — those are fixed by the substitution",
  "layer (label = \"Aller sur le site\", href = SITE_URL).",
  "",
  "RULES",
  "",
  "- Write everything in French (except the title which can stay French).",
  "- Match the business sector's tone (insurance / legal / wellness /",
  "  hospitality / tech / etc.). For very-serious B2B sectors keep replies",
  "  concise + neutral; for friendlier consumer brands you can warm up.",
  "- Replies must be SECTOR-AGNOSTIC enough that they fit any user input",
  "  (since the demo picks one at random). Avoid replies that make sense",
  "  only for one specific question.",
  "- Do NOT mention the words \"Switchia\", \"Aithos\", \"Claude\", \"AI\",",
  "  \"agent IA\", or any internal jargon — the demo is a white-label",
  "  experience for the company.",
  "- All free strings must be valid JSON — escape quotes correctly.",
].join("\n");

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

export async function generateAgentSiteHtml(
  args: SiteBuilderArgs,
): Promise<SiteBuilderResult> {
  const {
    sdk,
    business,
    ui,
    formulaire,
    siteUrl,
    robotDataUri,
    logoDataUri,
    companyNameOverride,
    model = "claude-opus-4-6",
  } = args;

  const userPrompt = buildUserPrompt({
    business,
    ui,
    siteUrl,
    ...(formulaire !== undefined ? { formulaire } : {}),
    ...(companyNameOverride !== undefined ? { companyNameOverride } : {}),
  });

  console.log("[site-builder] calling Opus 4.6…");
  const t0 = performance.now();
  const r = await sdk.compute.invokeBedrock({
    model,
    system: SYSTEM_PROMPT,
    maxTokens: 4000,
    messages: [{ role: "user", content: userPrompt }],
  });
  const elapsedMs = performance.now() - t0;
  console.log(
    `[site-builder] Opus returned in ${elapsedMs.toFixed(0)}ms, ` +
    `tokens=${r.usage.inputTokens}/${r.usage.outputTokens}, ` +
    `credits=${r.creditsCharged}`,
  );

  const brandJson = parseBrandJson(r.content, siteUrl);

  const html = substituteTemplate({
    template: templateRaw,
    brand: brandJson,
    ui,
    robotDataUri,
    logoDataUri,
  });

  return {
    html,
    brandJson,
    creditsSpent: r.creditsCharged,
    elapsedMs,
  };
}

/* -------------------------------------------------------------------------- */
/*  User prompt + JSON parsing                                                */
/* -------------------------------------------------------------------------- */

function buildUserPrompt(args: {
  business: string;
  ui: UiDescriptor;
  formulaire?: FormulaireSchema;
  siteUrl: string;
  companyNameOverride?: string;
}): string {
  const formSummary = args.formulaire ? summariseFormulaire(args.formulaire) : "(no forms detected)";
  const companyHint = args.companyNameOverride
    ? `\n\nCOMPANY_NAME_HINT: ${args.companyNameOverride}\n(use this verbatim as the "brand" field unless it would look wrong on the header.)`
    : "";
  return [
    "BUSINESS:",
    args.business.trim(),
    "",
    "UI:",
    `- primaryColor:    ${args.ui.primaryColor}`,
    `- backgroundColor: ${args.ui.backgroundColor}`,
    `- buttonStyle:     ${args.ui.buttonStyle}`,
    `- visualBrief:     ${args.ui.visualBrief}`,
    "",
    "FORMULAIRE:",
    formSummary,
    "",
    `SITE_URL: ${args.siteUrl}${companyHint}`,
    "",
    "Produce the JSON now.",
  ].join("\n");
}

function summariseFormulaire(f: FormulaireSchema): string {
  if (f.forms.length === 0) return "(no forms detected — browse-only product)";
  const lines: string[] = [];
  for (const form of f.forms) {
    const nbFields = form.fields.length;
    const required = form.fields.filter((fld) => fld.required).length;
    lines.push(
      `- ${form.name || "(unnamed)"} — ${form.purpose} (${nbFields} fields, ${required} required)`,
    );
  }
  return lines.join("\n");
}

function parseBrandJson(content: string, siteUrl: string): BrandSiteJson {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Opus returned non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;

  const getString = (key: string, max: number, fallback?: string): string => {
    const v = obj[key];
    if (typeof v !== "string" || v.trim().length === 0) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Opus JSON: ${key} missing or empty`);
    }
    const trimmed = v.trim();
    return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
  };

  const repliesRaw = obj.replies;
  if (!Array.isArray(repliesRaw) || repliesRaw.length === 0) {
    throw new Error("Opus JSON: replies missing or empty");
  }
  const replies = repliesRaw
    .filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    .map((r) => r.trim().slice(0, 140));
  if (replies.length === 0) {
    throw new Error("Opus JSON: replies has no valid string entries");
  }

  return {
    title: getString("title", 80),
    brand: getString("brand", 32),
    brandSub: getString("brandSub", 80),
    introMessage: getString("introMessage", 320),
    // Hard-coded — Opus does not generate these. The label is always
    // "Aller sur le site" and the href is the target site URL we
    // received as input. Keeping them in the returned JSON for
    // consumers / debugging.
    ctaLabel: "Aller sur le site",
    ctaHref: siteUrl,
    placeholder: getString("placeholder", 80),
    sendLabel: getString("sendLabel", 20, "Envoyer"),
    replies,
  };
}

/* -------------------------------------------------------------------------- */
/*  Template substitution                                                     */
/* -------------------------------------------------------------------------- */

function substituteTemplate(args: {
  template: string;
  brand: BrandSiteJson;
  ui: UiDescriptor;
  robotDataUri: string;
  logoDataUri: string;
}): string {
  const { template, brand, ui, robotDataUri, logoDataUri } = args;

  const primaryLight = mixHex(ui.primaryColor, "#ffffff", 0.4);
  const primaryDark = mixHex(ui.primaryColor, "#000000", 0.2);

  const replacements: Record<string, string> = {
    "{{TITLE}}": escapeHtmlAttr(brand.title),
    "{{BRAND}}": escapeHtml(brand.brand),
    "{{BRAND_SUB}}": escapeHtml(brand.brandSub),
    "{{INTRO_MESSAGE}}": escapeHtml(brand.introMessage),
    "{{CTA_LABEL}}": escapeHtml(brand.ctaLabel),
    "{{CTA_HREF}}": escapeHtmlAttr(brand.ctaHref),
    "{{PLACEHOLDER}}": escapeHtmlAttr(brand.placeholder),
    "{{SEND_LABEL}}": escapeHtml(brand.sendLabel),
    "{{REPLIES_JSON}}": JSON.stringify(brand.replies),
    "{{BG}}": ui.backgroundColor,
    "{{PRIMARY}}": ui.primaryColor,
    "{{PRIMARY_LIGHT}}": primaryLight,
    "{{PRIMARY_DARK}}": primaryDark,
    "{{ROBOT_URI}}": robotDataUri,
    "{{LOGO_URI}}": logoDataUri,
    // Favicon — reuse the brand logo so the generated page shows the
    // company icon in the browser tab without requiring a separate
    // upload or fetch. Same data URI as the header logo.
    "{{FAVICON_URI}}": logoDataUri,
  };

  let out = template;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.split(token).join(value);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Colour helpers                                                            */
/* -------------------------------------------------------------------------- */

function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(ca.r * (1 - k) + cb.r * k);
  const g = Math.round(ca.g * (1 - k) + cb.g * k);
  const bl = Math.round(ca.b * (1 - k) + cb.b * k);
  return "#" + [r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/* -------------------------------------------------------------------------- */
/*  HTML escaping                                                             */
/* -------------------------------------------------------------------------- */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
