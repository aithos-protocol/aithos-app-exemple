// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Sonnet-vision-based torso localization for the branded-robot agent.
//
// Replaces the Florence-2 / MediaPipe / heuristic cascade with a
// single call to Claude Sonnet 4.6 in vision mode. Sonnet understands
// the image semantically (perspective, asymmetry, brand-mascot
// conventions) and returns structured JSON with the chest centre +
// max logo dimensions accounting for a margin.
//
// Trade-off vs Florence-2:
//   - Pro: handles perspective / 3-quarter views, semantic placement
//          ("where a designer WOULD put the logo"), returns explicit
//          width AND height (not just a bbox), gives a confidence
//          score we can sanity-check.
//   - Con: slightly higher per-call cost (~3-8k mc vs Florence's 5k),
//          ~3-5s latency, JSON output requires defensive parsing.

import type { AithosSDK } from "@aithos/sdk";

export interface VisionTorsoResult {
  readonly centerX: number;
  readonly centerY: number;
  readonly maxLogoWidth: number;
  readonly maxLogoHeight: number;
  readonly confidence: number;
  readonly notes: string;
  /** Raw assistant content (for debugging). */
  readonly rawContent: string;
  /** Microcredits spent on this detection. */
  readonly creditsSpent: number;
}

const PROMPT_TEMPLATE = (w: number, h: number) =>
  [
    "You are a brand-mascot graphic designer placing a CIRCULAR brand emblem on a robot mascot's chest.",
    'Think "Iron Man arc-reactor" — the logo goes dead-center on the visible chest panel, like a bold emblem on a uniform.',
    "",
    `Image dimensions: ${w}×${h} pixels. Coordinate origin: TOP-LEFT, x→right, y→down.`,
    "",
    "Reason through these steps SILENTLY, then output JSON:",
    "",
    "1. Locate the BOTTOM of the visible neck/collar — call this y_neckBottom.",
    "2. Locate the BOTTOM of the visible torso (or the frame edge if cropped) — call this y_torsoBottom.",
    "3. Logo y = y_neckBottom + 0.55 × (y_torsoBottom - y_neckBottom).",
    "   (Lower than \"chest center\" sounds — this lands on the mid-pec, where uniform logos and arc-reactors actually sit.)",
    "4. Identify the VISIBLE CHEST SURFACE — if the mascot is turned 3/4, this is the largest continuous chest area facing the viewer, NOT the silhouette midpoint.",
    "5. Logo x = horizontal midpoint of that visible chest surface.",
    "6. Estimate the visible chest width at logo y — call this chest_w.",
    "7. Logo diameter = round(chest_w × 0.50). The diameter already accounts for ~25% margin on each side.",
    "",
    "Output ONLY this JSON, no markdown fences, no commentary before or after:",
    "",
    "{",
    '  "logoCenter": { "x": <int>, "y": <int> },',
    '  "logoDiameter": <int>,',
    '  "confidence": <0.0..1.0>,',
    '  "reasoning": "<one short sentence summarizing the placement>"',
    "}",
    "",
    "If you cannot identify a chest with confidence > 0.6, return all numeric fields as 0 and explain in reasoning.",
  ].join("\n");

/**
 * Call Sonnet (vision) to locate the torso. Returns a parsed result
 * or throws an error with a clear cause for the caller to surface.
 */
export async function detectTorsoByVision(
  sdk: AithosSDK,
  rawCanvas: HTMLCanvasElement,
): Promise<VisionTorsoResult> {
  const blob = await canvasToBlob(rawCanvas);
  const prompt = PROMPT_TEMPLATE(rawCanvas.width, rawCanvas.height);

  // The Imagen/FLUX-trained eye for the proxy: Sonnet vision is a
  // separate method we just added. Cast at the boundary because the
  // installed SDK may still be alpha.18.
  const compute = sdk.compute as unknown as {
    invokeBedrockVision(args: {
      image: Blob;
      prompt: string;
      model?: string;
      maxTokens?: number;
    }): Promise<{
      content: string;
      creditsCharged: number;
    }>;
  };

  console.log("[vision] calling Sonnet 4.6 vision…");
  const t0 = performance.now();
  const r = await compute.invokeBedrockVision({
    image: blob,
    prompt,
    model: "claude-sonnet-4-6",
    maxTokens: 600,
  });
  console.log(
    `[vision] Sonnet returned in ${(performance.now() - t0).toFixed(0)}ms, credits=${r.creditsCharged}`,
  );
  console.log("[vision] raw content:", r.content);

  const parsed = parseSonnetJson(r.content);
  console.log("[vision] parsed:", parsed);
  return {
    centerX: parsed.chestCenter.x,
    centerY: parsed.chestCenter.y,
    maxLogoWidth: parsed.maxLogoWidth,
    maxLogoHeight: parsed.maxLogoHeight,
    confidence: parsed.confidence,
    notes: parsed.notes,
    rawContent: r.content,
    creditsSpent: r.creditsCharged,
  };
}

/**
 * Permissive JSON extractor accepting BOTH:
 *   - v11.1 shape: { logoCenter: {x,y}, logoDiameter, confidence, reasoning }
 *   - v11.0 shape: { chestCenter: {x,y}, maxLogoWidth, maxLogoHeight, confidence, notes }
 *
 * Normalises to the internal representation used by the caller. For
 * the v11.1 circular-logo path, maxLogoWidth = maxLogoHeight = diameter.
 */
function parseSonnetJson(content: string): {
  chestCenter: { x: number; y: number };
  maxLogoWidth: number;
  maxLogoHeight: number;
  confidence: number;
  notes: string;
} {
  // Strip ```json ... ``` fences if any
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  // Find the first balanced top-level { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Sonnet vision returned non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  const json = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Sonnet vision returned malformed JSON: ${(e as Error).message}. Content: ${json.slice(0, 200)}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Sonnet vision JSON is not an object");
  }
  const r = obj as Record<string, unknown>;

  // v11.1 shape — preferred
  const lc = r.logoCenter as Record<string, unknown> | undefined;
  if (
    lc &&
    typeof lc.x === "number" &&
    typeof lc.y === "number" &&
    typeof r.logoDiameter === "number"
  ) {
    const d = Math.round(r.logoDiameter);
    return {
      chestCenter: { x: Math.round(lc.x), y: Math.round(lc.y) },
      maxLogoWidth: d,
      maxLogoHeight: d,
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
      notes:
        typeof r.reasoning === "string"
          ? r.reasoning
          : typeof r.notes === "string"
            ? r.notes
            : "",
    };
  }

  // v11.0 legacy shape — fallback
  const cc = r.chestCenter as Record<string, unknown> | undefined;
  if (
    cc &&
    typeof cc.x === "number" &&
    typeof cc.y === "number" &&
    typeof r.maxLogoWidth === "number" &&
    typeof r.maxLogoHeight === "number"
  ) {
    return {
      chestCenter: { x: Math.round(cc.x), y: Math.round(cc.y) },
      maxLogoWidth: Math.round(r.maxLogoWidth),
      maxLogoHeight: Math.round(r.maxLogoHeight),
      confidence: typeof r.confidence === "number" ? r.confidence : 0,
      notes: typeof r.notes === "string" ? r.notes : "",
    };
  }

  throw new Error(
    `Sonnet vision JSON missing required fields. Got: ${JSON.stringify(r).slice(0, 200)}`,
  );
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
