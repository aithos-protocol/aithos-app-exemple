// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Image prompt agent — produces the full FLUX / Imagen prompt for the
// branded-robot generation step.
//
// Why a dedicated agent (instead of just composeFluxPrompt with the
// brand UI fields)? The previous default prompt grafted the brand's
// `visualBrief` paragraph onto a fixed composition template. That
// worked for visually-distinct brands (clear primary colour, strong
// design DNA) but fell flat for B2B / generic-looking sites: the
// resulting robot looked like the default Aithos mascot with a tinted
// halo.
//
// This agent reads the FULL brand signal — business description,
// UI palette + component styles, formulaire structure — and writes a
// custom **creative brief** paragraph that captures personality,
// materials, mood, sector-specific accessories, and audience tone.
// We then concatenate that brief locally with the static
// COMPOSITION_TEMPLATE + COLOR PALETTE so the composition / framing
// invariants stay tamper-proof.
//
// Model: Opus 4.6 (top quality available — 4.7 is gated behind AWS
// Sales). Output JSON: { creativeBrief, reasoning }. Client validates
// the final concatenated prompt is < 8000 chars.

import type { AithosSDK } from "@aithos/sdk";

import { COMPOSITION_TEMPLATE } from "./brand-agent.js";
import type { FormulaireSchema } from "./url-analyzer.js";
import type { UiDescriptor } from "./url-analyzer.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ImagePromptArgs {
  readonly sdk: AithosSDK;
  readonly business: string;
  readonly ui: UiDescriptor;
  readonly formulaire: FormulaireSchema;
  /** Optional manual override of the model. Defaults to claude-opus-4-6. */
  readonly model?: "claude-opus-4-6" | "claude-sonnet-4-6" | "claude-haiku-4-5";
}

export interface ImagePromptResult {
  /** The full FLUX / Imagen prompt ready to feed to step1GenerateRobot.
   *  Guaranteed to be < 8000 chars (server-side cap). */
  readonly fullPrompt: string;
  /** Just the agent-written paragraph (no template, no colours). Useful
   *  for debugging / iterating the agent prompt. */
  readonly creativeBrief: string;
  /** Short explanation from the agent: why this design direction. */
  readonly reasoning: string;
  /** Raw agent JSON content for debugging. */
  readonly rawContent: string;
  /** Wallet debit for this call. */
  readonly creditsSpent: number;
  /** Wall time in ms. */
  readonly elapsedMs: number;
  /** True when the agent's brief was truncated to fit the 8000-char cap. */
  readonly briefTruncated: boolean;
}

/* -------------------------------------------------------------------------- */
/*  System prompt                                                             */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = [
  "You are an art-director writing the creative brief for a brand-mascot",
  "ROBOT illustration for a real company. The locked composition template",
  "(framing, blank chest, background, demeanor) is appended below for",
  "reference — do not echo it; only describe what varies per brand.",
  "",
  "Inputs:",
  "  - BUSINESS — what the company does and its tone.",
  "  - UI — primaryColor, secondaryColor, backgroundColor, button/input",
  "    styles, visualBrief.",
  "  - FORMULAIRE — JSON of the site's forms. Signals audience seriousness:",
  "    no forms → light; long multi-step required forms → high-stakes",
  "    sector (insurance, legal, finance).",
  "",
  "Write ONE English paragraph, 250-1500 characters, describing:",
  "  - Personality and mood, calibrated to the sector and the palette",
  "    (playful vs quietly competent, energetic vs understated). The",
  "    robot is ALWAYS friendly and trustworthy to a human visitor —",
  "    that baseline is fixed by the template; you only calibrate the",
  "    flavour around it.",
  "  - Materials and textures matching the brand (matte plastic, brushed",
  "    aluminium, soft fabric, glossy ceramic, clean rubber). Avoid",
  "    generic words like \"futuristic\".",
  "  - One subtle sector-specific accessory if relevant (a tiny clipboard",
  "    for insurance, a thin document for legal, a soft headset for",
  "    support, a stylised plant for wellness). Minimal, integrated.",
  "",
  "DO NOT mention chest, torso, framing, symmetry, background colour,",
  "halo, square crop — handled by the template. DO NOT put visible text,",
  "letters or logos on the robot (a logo is composited later). DO NOT",
  "describe a stern, cold, intimidating or military demeanor.",
  "",
  "REFERENCE — locked composition template (do not echo):",
  "<<<COMPOSITION_TEMPLATE_BEGIN>>>",
  COMPOSITION_TEMPLATE,
  "<<<COMPOSITION_TEMPLATE_END>>>",
  "",
  "OUTPUT — JSON only, no markdown:",
  "{",
  '  "creativeBrief": "<paragraph, English, 250-1500 chars>",',
  '  "reasoning": "<1-3 sentences explaining the design choices>"',
  "}",
].join("\n");

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

const MAX_FULL_PROMPT_CHARS = 7900; // 8000 server cap minus 100-char safety margin
const MAX_BRIEF_CHARS = 1500;

export async function generateRobotImagePrompt(
  args: ImagePromptArgs,
): Promise<ImagePromptResult> {
  const { sdk, business, ui, formulaire } = args;
  const model = args.model ?? "claude-opus-4-6";

  const userPrompt = buildUserPrompt({ business, ui, formulaire });

  console.log("[image-prompt-agent] calling Opus 4.6...");
  const t0 = performance.now();
  const r = await sdk.compute.invokeBedrock({
    model,
    system: SYSTEM_PROMPT,
    // Opus output is JSON with the brief + reasoning. Worst case ~2-3K
    // chars total ≈ 1000 tokens. 4000 token cap is comfortable.
    maxTokens: 4000,
    messages: [{ role: "user", content: userPrompt }],
  });
  const elapsedMs = performance.now() - t0;
  console.log(
    `[image-prompt-agent] Opus returned in ${elapsedMs.toFixed(0)}ms, ` +
    `tokens=${r.usage.inputTokens}/${r.usage.outputTokens}, ` +
    `credits=${r.creditsCharged}`,
  );

  const parsed = parseAgentJson(r.content);
  const briefRaw = parsed.creativeBrief.trim();
  const briefCapped =
    briefRaw.length > MAX_BRIEF_CHARS
      ? briefRaw.slice(0, MAX_BRIEF_CHARS - 1) + "…"
      : briefRaw;

  // Concatenate creative brief + static composition template + colour
  // palette so the final prompt is ready to feed step1GenerateRobot.
  const primaryRgb = hexToRgb(ui.primaryColor);
  const bgRgb = hexToRgb(ui.backgroundColor);
  const fullPromptRaw = [
    briefCapped,
    "",
    COMPOSITION_TEMPLATE,
    "",
    "COLOR PALETTE:",
    `- Primary brand colour (eye glow + small accents): ${ui.primaryColor} rgb(${primaryRgb.r},${primaryRgb.g},${primaryRgb.b}).`,
    `- Secondary brand colour: ${ui.secondaryColor}.`,
    `- Background: ${ui.backgroundColor} rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}).`,
  ].join("\n");

  // Final safety net: if somehow we're over 8000 chars (e.g., a future
  // template bump), trim the creative brief further.
  let fullPrompt = fullPromptRaw;
  let briefTruncated = briefRaw.length !== briefCapped.length;
  if (fullPrompt.length > MAX_FULL_PROMPT_CHARS) {
    const overshoot = fullPrompt.length - MAX_FULL_PROMPT_CHARS;
    const briefTrimmed = briefCapped.slice(0, Math.max(briefCapped.length - overshoot - 1, 0)) + "…";
    fullPrompt = [
      briefTrimmed,
      "",
      COMPOSITION_TEMPLATE,
      "",
      "COLOR PALETTE:",
      `- Primary brand colour (eye glow + small accents): ${ui.primaryColor} rgb(${primaryRgb.r},${primaryRgb.g},${primaryRgb.b}).`,
      `- Secondary brand colour: ${ui.secondaryColor}.`,
      `- Background: ${ui.backgroundColor} rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}).`,
    ].join("\n");
    briefTruncated = true;
    console.warn(
      `[image-prompt-agent] full prompt was ${fullPromptRaw.length} chars, trimmed brief to land at ${fullPrompt.length}.`,
    );
  }

  return {
    fullPrompt,
    creativeBrief: briefCapped,
    reasoning: parsed.reasoning,
    rawContent: r.content,
    creditsSpent: r.creditsCharged,
    elapsedMs,
    briefTruncated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Local hex → rgb (brand-agent's helper is not exported)                    */
/* -------------------------------------------------------------------------- */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/* -------------------------------------------------------------------------- */
/*  User prompt builder                                                       */
/* -------------------------------------------------------------------------- */

interface BuildUserPromptArgs {
  business: string;
  ui: UiDescriptor;
  formulaire: FormulaireSchema;
}

function buildUserPrompt(args: BuildUserPromptArgs): string {
  const formSummary = summariseFormulaire(args.formulaire);
  return [
    "BUSINESS:",
    args.business.trim(),
    "",
    "UI:",
    `- primaryColor: ${args.ui.primaryColor}`,
    `- secondaryColor: ${args.ui.secondaryColor}`,
    `- backgroundColor: ${args.ui.backgroundColor}`,
    `- buttonStyle: ${args.ui.buttonStyle}`,
    `- inputStyle: ${args.ui.inputStyle}`,
    `- visualBrief: ${args.ui.visualBrief}`,
    "",
    "FORMULAIRE:",
    formSummary,
    "",
    "Produce the JSON `{creativeBrief, reasoning}` as specified. Remember:",
    "300-1500 chars, English, NO composition rules, NO chest/torso talk,",
    "NO visible text on the robot.",
  ].join("\n");
}

function summariseFormulaire(f: FormulaireSchema): string {
  if (f.forms.length === 0) {
    return "(no forms detected on the site — light / browse-only product)";
  }
  const lines: string[] = [];
  for (const form of f.forms) {
    const nbFields = form.fields.length;
    const required = form.fields.filter((fld) => fld.required).length;
    lines.push(
      `- ${form.name || "(unnamed)"} — ${form.purpose} (${nbFields} fields, ${required} required)`,
    );
    // Include first 5 field labels as flavour
    const labels = form.fields
      .slice(0, 5)
      .map((fld) => fld.label || fld.name)
      .filter(Boolean);
    if (labels.length > 0) {
      lines.push(`    sample fields: ${labels.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  JSON parsing                                                              */
/* -------------------------------------------------------------------------- */

interface AgentJson {
  creativeBrief: string;
  reasoning: string;
}

function parseAgentJson(content: string): AgentJson {
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
  if (typeof obj.creativeBrief !== "string" || obj.creativeBrief.trim().length === 0) {
    throw new Error("Opus JSON: creativeBrief missing or empty");
  }
  const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.trim() : "";
  return {
    creativeBrief: obj.creativeBrief,
    reasoning,
  };
}
