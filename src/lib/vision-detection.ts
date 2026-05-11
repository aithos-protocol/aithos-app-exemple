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
    "You are a precise vision assistant locating the optimal logo placement on a brand mascot.",
    "",
    `Image dimensions: ${w}×${h} pixels.`,
    "Source pixel coordinate system: (0,0) at TOP-LEFT, x→right, y→down.",
    "",
    "Task — locate the VISUAL center of the mascot's chest area (where a graphic designer would naturally place a brand logo). Account for perspective if the figure is turned (the visual center may differ from the silhouette's geometric center). Then compute the maximum logo dimensions that fit inside the chest area with AT LEAST 15% margin on all sides.",
    "",
    "Return ONLY valid JSON, no markdown fences, no commentary before or after. Exactly this shape:",
    "",
    "{",
    '  "chestCenter": { "x": <int>, "y": <int> },',
    '  "maxLogoWidth": <int>,',
    '  "maxLogoHeight": <int>,',
    '  "confidence": <0.0..1.0>,',
    '  "notes": "<one short sentence describing the placement>"',
    "}",
    "",
    "Constraints:",
    "- x, y are absolute pixel coordinates in the source image.",
    "- maxLogoWidth and maxLogoHeight are the MAX sizes for the logo, with 15% margin INSIDE the chest already accounted for.",
    "- If you cannot identify a chest with confidence > 0.6, return all numeric fields as 0 and explain in notes.",
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

/** Permissive JSON extractor — strips markdown fences, finds the first { ... } block. */
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
  const cc = r.chestCenter as Record<string, unknown> | undefined;
  if (!cc || typeof cc.x !== "number" || typeof cc.y !== "number") {
    throw new Error("missing or invalid chestCenter.x/y in Sonnet JSON");
  }
  if (typeof r.maxLogoWidth !== "number" || typeof r.maxLogoHeight !== "number") {
    throw new Error("missing or invalid maxLogoWidth/Height in Sonnet JSON");
  }
  return {
    chestCenter: { x: Math.round(cc.x), y: Math.round(cc.y) },
    maxLogoWidth: Math.round(r.maxLogoWidth),
    maxLogoHeight: Math.round(r.maxLogoHeight),
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    notes: typeof r.notes === "string" ? r.notes : "",
  };
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}
