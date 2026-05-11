// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Smart logo-treatment planner.
//
// Once the robot is generated (Step 1), the chest is located (Step 2),
// and the logo's background is stripped (Step 3), we still face three
// orthogonal decisions before compositing:
//
//   - RECOLOR ACTION : do we flatten the logo to a brand-colour
//     silhouette, keep its original colours, or pick a custom contrast
//     colour ourselves?
//   - BLEND MODE     : multiply / screen / source-over / overlay /
//     soft-light / hard-light — each gives a very different result
//     depending on the chest's colour and the logo's own palette.
//   - OPACITY        : usually 0.9–1.0, but can be softened.
//
// The previous heuristic (a single Euclidean-distance threshold +
// fixed `multiply` default) is too brittle: a dark logo on a dark
// chest with `multiply` disappears; a light multi-colour logo on a
// light chest with naive flattening kills the design. We replace the
// heuristic with a single Sonnet 4.6 vision call: Sonnet sees the
// prepared logo, receives the sampled chest colour and the brand
// palette in text, and returns a structured treatment plan.
//
// The plan is then APPLIED by `applyTreatmentToLogo`, which either
// passes the prepared logo through unchanged (keep-original) or
// recolours it to a flat silhouette in the chosen colour.

import type { AithosSDK } from "@aithos/sdk";

import {
  canvasToDataUri,
  imageToCanvas,
  loadImage,
  recolorLogoToSilhouette,
} from "./image-pipeline.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type RecolorAction =
  | "keep_original"
  | "flatten_to_primary"
  | "flatten_to_secondary"
  | "flatten_to_custom";

export type SupportedBlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "soft-light"
  | "hard-light";

export interface TreatmentPlan {
  readonly recolorAction: RecolorAction;
  /** Hex value when recolorAction === 'flatten_to_custom'. */
  readonly recolorCustomHex: string | null;
  readonly blendMode: SupportedBlendMode;
  readonly opacity: number;
  readonly reasoning: string;
  readonly confidence: number;
  /** Raw model content for debugging. */
  readonly rawContent: string;
  /** Microcredits debited. */
  readonly creditsSpent: number;
}

export interface AppliedTreatmentResult {
  /** Final logo image ready to feed into Step 4. */
  readonly processedImg: HTMLImageElement;
  readonly processedDataUri: string;
  /** What the application did. */
  readonly action: "kept_original" | "recolored";
  /** Hex actually painted on, when recolored. */
  readonly colorApplied: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Sonnet vision call                                                        */
/* -------------------------------------------------------------------------- */

const SUPPORTED_BLEND_MODES: readonly SupportedBlendMode[] = [
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
];

const SUPPORTED_RECOLOR_ACTIONS: readonly RecolorAction[] = [
  "keep_original",
  "flatten_to_primary",
  "flatten_to_secondary",
  "flatten_to_custom",
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function buildPrompt(args: {
  chestColorHex: string;
  primaryColor: string;
  secondaryColor: string;
}): string {
  return [
    "You are a brand-mascot designer deciding how to apply a brand emblem",
    "(logo) onto a robot mascot's chest so that the logo READS CLEARLY",
    "against the chest surface.",
    "",
    "You will see ONE image: the brand's logo, on a transparent /",
    "checkered background, at its ORIGINAL colours. Study it carefully —",
    "its dominant colour(s), whether it is a single solid shape or a",
    "multi-colour design, whether the colours are bright/dark, and",
    "whether they would naturally contrast with the chest colour given",
    "below.",
    "",
    "CONTEXT (provided as text — there is no second image):",
    `  - The chest surface colour where the logo will land:   ${args.chestColorHex}`,
    `  - The brand's PRIMARY colour:                          ${args.primaryColor}`,
    `  - The brand's SECONDARY colour:                        ${args.secondaryColor}`,
    "",
    "Pretend you can preview different combinations on the chest. Pick",
    "the combination that produces the CLEAREST, MOST LEGIBLE logo on",
    "the chest, while staying ON-BRAND (don't invent colours unrelated",
    "to the palette unless absolutely necessary for contrast).",
    "",
    "Decide THREE things:",
    "",
    "1. recolorAction — should the logo be recoloured before compositing?",
    "   - 'keep_original': keep the logo's existing colours. Pick this when",
    "     the logo's own colours already contrast clearly with the chest,",
    "     OR when the logo's multi-colour design carries meaning that must",
    "     not be flattened (e.g. a multicolour brand mark, a flag, a typeface",
    "     where every colour matters).",
    "   - 'flatten_to_primary': replace all visible pixels with the brand's",
    "     PRIMARY colour, producing a flat silhouette. Pick this when the",
    "     logo is essentially a shape/icon (no critical multi-colour content)",
    "     AND the primary contrasts well against the chest.",
    "   - 'flatten_to_secondary': same but with the SECONDARY colour. Pick",
    "     this when the primary clashes with the chest (low contrast) but",
    "     the secondary does not.",
    "   - 'flatten_to_custom': flatten to a hex you pick yourself. Pick this",
    "     ONLY if neither primary nor secondary contrasts well; you must",
    "     supply 'recolorCustomHex' (#rrggbb) and the colour you pick should",
    "     still feel on-brand (a slightly adjusted variant of the palette,",
    "     a deeper / lighter version, etc.).",
    "",
    "2. blendMode — how the logo mixes into the chest pixels:",
    "   - 'source-over': pure overlay, the logo is exactly its colour. Best",
    "     for SOLID SILHOUETTES that need to POP. Lose chest texture under",
    "     the logo.",
    "   - 'multiply': darkens the logo over the chest. Good for DARK or",
    "     COLOURED logos on LIGHTER chests; preserves chest shading.",
    "   - 'screen': lightens. Good for LIGHT logos on DARKER chests.",
    "   - 'overlay' / 'soft-light' / 'hard-light': progressively stronger",
    "     bake-in effects; useful when you want the logo to feel printed",
    "     or moulded into the chest rather than stuck on top.",
    "",
    "3. opacity (0.0 to 1.0). Default 0.9–1.0 for crisp reads. Lower to",
    "   soften the logo's prominence (rare; use only for subtle baked-in",
    "   effects with overlay/soft-light blends).",
    "",
    "OUTPUT FORMAT — output ONLY this JSON, no markdown fences, no",
    "commentary before or after. recolorCustomHex MUST be a #rrggbb",
    "string when recolorAction is 'flatten_to_custom', and null otherwise.",
    "",
    "{",
    '  "recolorAction": "<keep_original|flatten_to_primary|flatten_to_secondary|flatten_to_custom>",',
    '  "recolorCustomHex": "#rrggbb" | null,',
    '  "blendMode": "<source-over|multiply|screen|overlay|soft-light|hard-light>",',
    '  "opacity": <0.0..1.0>,',
    '  "reasoning": "<one to two sentences explaining (a) what you saw in the logo, (b) why this combination produces a clear read on the chest>",',
    '  "confidence": <0.0..1.0>',
    "}",
  ].join("\n");
}

/**
 * Ask Sonnet 4.6 (vision) to plan how to treat the logo before
 * compositing. Throws with a clear error if the response is missing
 * fields or has malformed values.
 */
export async function planLogoTreatment(args: {
  readonly sdk: AithosSDK;
  /** The PREPARED (background-removed) logo, as a PNG blob. */
  readonly logoBlob: Blob;
  readonly chestColorHex: string;
  readonly primaryColor: string;
  readonly secondaryColor: string;
}): Promise<TreatmentPlan> {
  const prompt = buildPrompt({
    chestColorHex: args.chestColorHex,
    primaryColor: args.primaryColor,
    secondaryColor: args.secondaryColor,
  });

  // Cast: invokeBedrockVision shape is the same as in vision-detection.ts.
  const compute = args.sdk.compute as unknown as {
    invokeBedrockVision(a: {
      image: Blob;
      prompt: string;
      model?: string;
      maxTokens?: number;
    }): Promise<{ content: string; creditsCharged: number }>;
  };

  console.log("[treatment-agent] calling Sonnet 4.6 vision…");
  const t0 = performance.now();
  const r = await compute.invokeBedrockVision({
    image: args.logoBlob,
    prompt,
    model: "claude-sonnet-4-6",
    maxTokens: 800,
  });
  console.log(
    `[treatment-agent] Sonnet returned in ${(performance.now() - t0).toFixed(0)}ms, credits=${r.creditsCharged}`,
  );
  console.log("[treatment-agent] raw content:", r.content);

  const parsed = parsePlan(r.content);
  return {
    recolorAction: parsed.recolorAction,
    recolorCustomHex: parsed.recolorCustomHex,
    blendMode: parsed.blendMode,
    opacity: parsed.opacity,
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
    rawContent: r.content,
    creditsSpent: r.creditsCharged,
  };
}

function parsePlan(content: string): {
  recolorAction: RecolorAction;
  recolorCustomHex: string | null;
  blendMode: SupportedBlendMode;
  opacity: number;
  reasoning: string;
  confidence: number;
} {
  // Strip ```json ... ``` fences if any
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Sonnet treatment plan: non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(
      `Sonnet treatment plan: malformed JSON: ${(e as Error).message}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Sonnet treatment plan: JSON is not an object");
  }
  const r = obj as Record<string, unknown>;

  const action = typeof r.recolorAction === "string" ? r.recolorAction : "";
  if (!(SUPPORTED_RECOLOR_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(
      `Sonnet treatment plan: recolorAction must be one of ${SUPPORTED_RECOLOR_ACTIONS.join("|")}; got ${JSON.stringify(r.recolorAction)}`,
    );
  }
  const recolorAction = action as RecolorAction;

  let recolorCustomHex: string | null = null;
  if (recolorAction === "flatten_to_custom") {
    if (typeof r.recolorCustomHex !== "string" || !HEX_RE.test(r.recolorCustomHex)) {
      throw new Error(
        `Sonnet treatment plan: flatten_to_custom requires recolorCustomHex as #rrggbb; got ${JSON.stringify(r.recolorCustomHex)}`,
      );
    }
    recolorCustomHex = r.recolorCustomHex.toLowerCase();
  }

  const blend = typeof r.blendMode === "string" ? r.blendMode : "";
  if (!(SUPPORTED_BLEND_MODES as readonly string[]).includes(blend)) {
    throw new Error(
      `Sonnet treatment plan: blendMode must be one of ${SUPPORTED_BLEND_MODES.join("|")}; got ${JSON.stringify(r.blendMode)}`,
    );
  }
  const blendMode = blend as SupportedBlendMode;

  const opacityRaw = typeof r.opacity === "number" ? r.opacity : NaN;
  if (!Number.isFinite(opacityRaw) || opacityRaw < 0 || opacityRaw > 1) {
    throw new Error(
      `Sonnet treatment plan: opacity must be 0..1; got ${JSON.stringify(r.opacity)}`,
    );
  }
  const opacity = Math.max(0.1, Math.min(1, opacityRaw));

  return {
    recolorAction,
    recolorCustomHex,
    blendMode,
    opacity,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
    confidence:
      typeof r.confidence === "number" && r.confidence >= 0 && r.confidence <= 1
        ? r.confidence
        : 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Plan application                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Apply a treatment plan to a prepared logo (Step 3 output).
 *
 *   - keep_original: pass the prepared logo through unchanged.
 *   - flatten_to_primary: recolour silhouette to brand primaryColor.
 *   - flatten_to_secondary: recolour silhouette to brand secondaryColor.
 *   - flatten_to_custom: recolour silhouette to plan.recolorCustomHex.
 *
 * In all cases the result is ready to feed into step4Composite as the
 * `logo` argument (it has a `processedImg` field).
 */
export async function applyTreatmentToLogo(args: {
  readonly preparedImg: HTMLImageElement;
  readonly preparedDataUri: string;
  readonly plan: TreatmentPlan;
  readonly primaryColor: string;
  readonly secondaryColor: string;
}): Promise<AppliedTreatmentResult> {
  const { preparedImg, preparedDataUri, plan, primaryColor, secondaryColor } = args;

  if (plan.recolorAction === "keep_original") {
    // Re-encode through canvas to normalise — but cheap, single draw.
    const c = imageToCanvas(preparedImg);
    const dataUri = canvasToDataUri(c);
    const img = await loadImage(dataUri);
    return {
      processedImg: img,
      processedDataUri: dataUri,
      action: "kept_original",
      colorApplied: null,
    };
  }

  let targetHex: string;
  switch (plan.recolorAction) {
    case "flatten_to_primary":
      targetHex = primaryColor;
      break;
    case "flatten_to_secondary":
      targetHex = secondaryColor;
      break;
    case "flatten_to_custom":
      // parsePlan guarantees a valid #rrggbb here
      if (!plan.recolorCustomHex) throw new Error("flatten_to_custom missing recolorCustomHex");
      targetHex = plan.recolorCustomHex;
      break;
  }

  // Workaround: fall back to the prepared logo data URI if HTMLImageElement
  // recolor reads have issues (e.g. tainted canvas). preparedDataUri is
  // a data URI so it is always safe to reload.
  let src: HTMLImageElement | HTMLCanvasElement = preparedImg;
  try {
    // Try direct recolor first
    const recoloredCanvas = recolorLogoToSilhouette(src, targetHex);
    const dataUri = canvasToDataUri(recoloredCanvas);
    const img = await loadImage(dataUri);
    return {
      processedImg: img,
      processedDataUri: dataUri,
      action: "recolored",
      colorApplied: targetHex,
    };
  } catch (e) {
    // If canvas was tainted (cross-origin), reload from data URI and retry
    console.warn("[treatment-agent] recolor via img failed, reloading from data URI", e);
    const reloaded = await loadImage(preparedDataUri);
    const recoloredCanvas = recolorLogoToSilhouette(reloaded, targetHex);
    const dataUri = canvasToDataUri(recoloredCanvas);
    const img = await loadImage(dataUri);
    return {
      processedImg: img,
      processedDataUri: dataUri,
      action: "recolored",
      colorApplied: targetHex,
    };
  }
}
