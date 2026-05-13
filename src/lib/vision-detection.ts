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
  /**
   * Dominant surface colour at the logo center, sampled by Sonnet.
   * Used downstream by step3_5RecolorLogo for auto-contrast — if the
   * brand's primaryColor is too close to this, we flip to secondaryColor.
   * Format: `#rrggbb`. Null if Sonnet didn't return it.
   */
  readonly chestColorHex: string | null;
  readonly confidence: number;
  readonly notes: string;
  /** Raw assistant content (for debugging). */
  readonly rawContent: string;
  /** Microcredits spent on this detection. */
  readonly creditsSpent: number;
}

const PROMPT_TEMPLATE = (w: number, h: number) =>
  [
    "You are a brand-mascot graphic designer placing a CIRCULAR brand emblem",
    "ON THE PECTORALS of a robot mascot — directly over the pectoral muscles,",
    "at heart level.",
    "",
    "Think Iron Man's arc-reactor, Superman's S, Captain America's star:",
    "every one of these sits AT THE MIDDLE OF THE PECTORALS, between the two",
    "pec plates, at the height of the heart. They do NOT sit below the pecs",
    "on the abdomen, and they do NOT sit up at the collarbone.",
    "",
    "Anatomical landmarks for a humanoid mascot (front view):",
    "  - The TORSO runs roughly from the bottom of the neck down to the hips/belt.",
    "  - The PECTORAL REGION is the UPPER HALF of the torso — the rounded muscle",
    "    plates immediately below the collarbone, ending at nipple/heart level.",
    "  - Below the pectorals comes the abdomen / belt / waist — that is NOT",
    "    where the logo goes.",
    "",
    `Image dimensions: ${w}×${h} pixels. Coordinate origin: TOP-LEFT, x→right, y→down.`,
    "",
    "Reason through these steps SILENTLY, then output JSON:",
    "",
    "1. Locate y_neckBottom = the bottom of the visible neck/collar",
    "   (where the head/neck meets the shoulders/chest).",
    "2. Locate y_pecTop = the TOP EDGE of the pectoral plates,",
    "   just below the collarbone — where the rounded chest muscle begins.",
    "   This is normally only slightly below y_neckBottom.",
    "3. Locate y_pecBottom = the BOTTOM EDGE of the pectoral muscles —",
    "   the horizontal line where the rounded chest curves transition into",
    "   the abdomen / belt. On a human this is roughly nipple-level.",
    "4. Logo y = (y_pecTop + y_pecBottom) / 2.",
    "   This lands AT THE MIDDLE OF THE PECTORALS — the heart-emblem position.",
    "   SANITY CHECK: logo y MUST be ABOVE y_pecBottom. If your computed logo y",
    "   is at or below y_pecBottom, or anywhere in the lower half of the torso,",
    "   you've picked the wrong landmarks — recompute. The logo belongs on the",
    "   muscle, NOT below it.",
    "5. Logo x = horizontal midpoint of the chest panel at logo y.",
    "   For a front-facing mascot this is simply the silhouette midpoint",
    "   (right between the two pec plates).",
    "6. Estimate the chest width at logo y — call this chest_w. Measure across",
    "   the pectorals, NOT shoulder-to-shoulder (which is wider).",
    "7. Logo diameter = round(chest_w × 0.55). The emblem should sit cleanly",
    "   between the two pec plates with a comfortable margin — large enough to",
    "   read at a glance, small enough that it does not spill onto the shoulders",
    "   or run past y_pecBottom into the abdomen.",
    "8. SAMPLE the dominant SURFACE COLOUR of the chest panel right at",
    "   (logo_x, logo_y). Pretend you have a colour picker. Return it as",
    "   '#rrggbb'. This is the colour of the CHEST itself at that spot —",
    "   NOT a logo (the chest should be blank), NOT the background,",
    "   NOT a highlight or shadow tone. If the chest has cel-shaded",
    "   gradients, pick the dominant mid-tone.",
    "",
    "Output ONLY this JSON, no markdown fences, no commentary before or after:",
    "",
    "{",
    '  "logoCenter": { "x": <int>, "y": <int> },',
    '  "logoDiameter": <int>,',
    '  "chestColorHex": "<#rrggbb>",',
    '  "confidence": <0.0..1.0>,',
    '  "reasoning": "<sentence reporting y_neckBottom, y_pecTop, y_pecBottom, final logo y (confirm it is ABOVE y_pecBottom), and the chest colour you sampled>"',
    "}",
    "",
    "If you cannot identify a chest with confidence > 0.6, return all",
    "numeric fields as 0, chestColorHex as \"#000000\", and explain in reasoning.",
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
    chestColorHex: parsed.chestColorHex,
    confidence: parsed.confidence,
    notes: parsed.notes,
    rawContent: r.content,
    creditsSpent: r.creditsCharged,
  };
}

/**
 * Permissive JSON extractor accepting THREE shapes:
 *   - v13 shape:    { logoCenter, logoDiameter, chestColorHex, confidence, reasoning }
 *   - v11.1 legacy: { logoCenter, logoDiameter, confidence, reasoning } (no chestColorHex)
 *   - v11.0 legacy: { chestCenter, maxLogoWidth, maxLogoHeight, confidence, notes }
 *
 * Normalises to the internal representation used by the caller. For
 * the circular-logo paths, maxLogoWidth = maxLogoHeight = diameter.
 * chestColorHex is `null` when not present (legacy) or malformed.
 */
function parseSonnetJson(content: string): {
  chestCenter: { x: number; y: number };
  maxLogoWidth: number;
  maxLogoHeight: number;
  chestColorHex: string | null;
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

  // Optional chestColorHex (v13+). Validate hex format; null if absent/bad.
  const rawHex = typeof r.chestColorHex === "string" ? r.chestColorHex : null;
  const chestColorHex = rawHex && /^#[0-9a-fA-F]{6}$/.test(rawHex)
    ? rawHex.toLowerCase()
    : null;

  // v13 / v11.1 shape — { logoCenter, logoDiameter } (chestColorHex optional)
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
      chestColorHex,
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
      chestColorHex,
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
