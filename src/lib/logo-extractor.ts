// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Logo lockup extraction.
//
// Some brand sites expose a "lockup" logo — a graphic MARK alongside a
// WORDMARK ("<icon> WebGuard Agency", a triangle next to "Vercel", an
// M above "McDonald's"). On a robot's chest disc, the wordmark is
// unreadable at any reasonable size, so we want JUST the graphic mark.
//
// Strategy:
//   1. Cheap aspect-ratio gate. Logos roughly square (ratio in
//      [1/GATE, GATE]) are assumed SYMBOL_ONLY and pass through.
//   2. Suspect logos go to Claude Sonnet 4.6 vision, which classifies
//      the layout (WORDMARK_ONLY / SYMBOL_ONLY / LOCKUP) and, for
//      LOCKUP, returns the tight bbox of the mark.
//   3. We crop the canvas to that bbox and pad to a transparent 1:1
//      square so the downstream chest compositor gets a clean input.
//
// Cost: 0 microcredits when the gate skips Sonnet; ~3-5k mc + ~2-3s
// when Sonnet is called. Trade-off mirrors vision-detection.ts.

import type { AithosSDK } from "@aithos/sdk";

import { canvasToDataUri, imageToCanvas, loadImage } from "./image-pipeline.js";

export type LogoLayout = "SYMBOL_ONLY" | "WORDMARK_ONLY" | "LOCKUP";

export interface LogoExtractResult {
  /**
   * Layout classification. "SKIPPED" when the aspect-ratio gate ruled
   * out a lockup without calling Sonnet — we assume SYMBOL_ONLY.
   */
  readonly layout: LogoLayout | "SKIPPED";
  /**
   * Logo data URI to use downstream. Same as the input for SYMBOL_ONLY,
   * WORDMARK_ONLY and SKIPPED cases. Cropped + 1:1-padded for LOCKUP.
   */
  readonly dataUri: string;
  /** True when we actually cropped the input. */
  readonly cropped: boolean;
  /** Sonnet's bbox in ORIGINAL-image coordinates, when LOCKUP. */
  readonly symbolBox: { x: number; y: number; w: number; h: number } | null;
  /**
   * Sonnet's reported confidence (0..1) when the model ran, or 1 when
   * the gate ruled out a call.
   */
  readonly confidence: number;
  /** One-sentence rationale (from Sonnet, or from the gate). */
  readonly reasoning: string;
  /** Microcredits spent on Sonnet (0 when the gate ruled out a call). */
  readonly creditsSpent: number;
}

/**
 * Aspect-ratio thresholds for the cheap gate.
 *
 * Tight square-ish logos (1/GATE ≤ w/h ≤ GATE) are assumed already
 * symbol-only and bypass Sonnet. Anything wider or taller is sent to
 * the vision model. GATE=1.4 catches both horizontal lockups
 * ("<icon> Brand") and stacked lockups (icon-above-name) while
 * leaving most genuine symbol marks untouched.
 */
const GATE_RATIO = 1.4;

const PROMPT_TEMPLATE = (w: number, h: number) =>
  [
    "You receive an image of a company's LOGO as fetched from their site.",
    "Logos come in three layouts:",
    "  - WORDMARK_ONLY: stylised text only, no separate graphic mark",
    "    (e.g., \"Coca-Cola\" script, \"FedEx\" wordmark).",
    "  - SYMBOL_ONLY: a graphic mark only, no text (e.g., Apple's apple,",
    "    Twitter's bird).",
    "  - LOCKUP: a graphic mark AND a wordmark together, side-by-side or",
    "    stacked (e.g., a leaf icon next to \"WebGuard Agency\", a",
    "    triangle next to \"Vercel\", an M above \"McDonald's\").",
    "",
    "We display this logo on a small circular surface (a robot's chest)",
    "where wordmark text is unreadable. For LOCKUP, we want the GRAPHIC",
    "MARK ALONE — the bounding box of the mark, excluding the wordmark.",
    "",
    `Image dimensions: ${w}×${h} px. Coordinate origin: TOP-LEFT, x→right, y→down.`,
    "",
    "Output JSON ONLY, no markdown, no commentary:",
    "{",
    '  "layout": "WORDMARK_ONLY" | "SYMBOL_ONLY" | "LOCKUP",',
    '  "symbolBox": null | { "x": <int>, "y": <int>, "w": <int>, "h": <int> },',
    '  "confidence": <0.0..1.0>,',
    '  "reasoning": "<one short sentence>"',
    "}",
    "",
    "Rules:",
    "- WORDMARK_ONLY → symbolBox: null. There is no mark to extract.",
    "- SYMBOL_ONLY → symbolBox: null. The full image is already the mark.",
    "- LOCKUP → symbolBox: tight bbox around the GRAPHIC MARK only.",
    "  Allow 2-5% padding around the mark, but exclude the wordmark and",
    "  the empty space bridging mark and text. The bbox must lie",
    "  strictly inside the image.",
    "- If your confidence is below 0.6, return SYMBOL_ONLY with",
    "  symbolBox: null — the caller will fall back to the original logo.",
  ].join("\n");

/**
 * Detect whether the logo is a lockup (graphic mark + wordmark) and,
 * if so, return a cropped data URI containing only the mark, padded
 * to a transparent 1:1 square.
 *
 * Cheap gate first: only logos with aspect ratio outside the
 * symmetric range around 1:1 trigger the Sonnet vision call.
 *
 * Pass `force: true` to skip the gate and always call Sonnet.
 */
export async function extractLogoSymbol(args: {
  readonly sdk: AithosSDK;
  readonly logoDataUri: string;
  readonly force?: boolean;
}): Promise<LogoExtractResult> {
  const { sdk, logoDataUri, force = false } = args;

  const img = await loadImage(logoDataUri);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const ratio = w / Math.max(h, 1);

  const suspect = force || ratio > GATE_RATIO || ratio < 1 / GATE_RATIO;
  if (!suspect) {
    console.log(
      `[logo-extractor] gate skipped Sonnet — ratio=${ratio.toFixed(2)} is roughly square.`,
    );
    return {
      layout: "SKIPPED",
      dataUri: logoDataUri,
      cropped: false,
      symbolBox: null,
      confidence: 1,
      reasoning: `Aspect ratio ${ratio.toFixed(2)} ≈ 1; gate skipped Sonnet and assumed SYMBOL_ONLY.`,
      creditsSpent: 0,
    };
  }

  // Convert to a PNG Blob for the vision call (same pattern as
  // vision-detection.ts: PNG keeps alpha and Sonnet handles it fine).
  const canvas = imageToCanvas(img);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });

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

  console.log(
    `[logo-extractor] gate triggered (ratio=${ratio.toFixed(2)}), calling Sonnet 4.6…`,
  );
  const t0 = performance.now();
  const r = await compute.invokeBedrockVision({
    image: blob,
    prompt: PROMPT_TEMPLATE(w, h),
    model: "claude-sonnet-4-6",
    maxTokens: 400,
  });
  console.log(
    `[logo-extractor] Sonnet returned in ${(performance.now() - t0).toFixed(0)}ms, credits=${r.creditsCharged}`,
  );
  console.log("[logo-extractor] raw content:", r.content);

  const parsed = parseExtractionJson(r.content);

  // SYMBOL_ONLY / WORDMARK_ONLY → pass the original logo through.
  // For WORDMARK_ONLY there is no mark to extract; the downstream
  // composite will end up with text on the chest (small + unreadable),
  // but at least the brand asset is honoured. A future fallback could
  // try the site's favicon here.
  if (parsed.layout !== "LOCKUP" || !parsed.symbolBox) {
    return {
      layout: parsed.layout,
      dataUri: logoDataUri,
      cropped: false,
      symbolBox: null,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      creditsSpent: r.creditsCharged,
    };
  }

  // LOCKUP — crop to the symbol bbox, padded to a 1:1 square.
  //
  // Padding colour: we MIRROR the original logo's background semantics
  // so downstream bg-removal keeps working. Concretely we sample (2,2)
  // of the original logo (its corner — almost always background pixel,
  // even on bleed-to-edge logos this is the same fallback the legacy
  // step3PrepareLogo path already relies on) and fill the padding with
  // that colour. If the original had transparency at (2,2), the
  // padding stays transparent and the alpha pass-through downstream
  // works as before.
  const clamped = clampBox(parsed.symbolBox, w, h);
  const side = Math.max(clamped.w, clamped.h);
  const out = document.createElement("canvas");
  out.width = side;
  out.height = side;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable for symbol crop");

  // Sample original logo's corner before drawing anything.
  const srcCtx = canvas.getContext("2d");
  if (!srcCtx) throw new Error("2d context unavailable on source canvas");
  const corner = srcCtx.getImageData(2, 2, 1, 1).data;
  const cornerAlpha = corner[3] ?? 0;
  if (cornerAlpha > 0) {
    // Opaque original bg — paint it across the whole square first so
    // the bbox sits on a uniform background that the legacy
    // flood-fill in step3 can detect from (2,2) of THIS canvas too.
    const r = corner[0] ?? 0;
    const g = corner[1] ?? 0;
    const b = corner[2] ?? 0;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, side, side);
  }
  // (If cornerAlpha === 0 the canvas stays fully transparent — exactly
  // what we want for alpha logos.)

  const dx = Math.floor((side - clamped.w) / 2);
  const dy = Math.floor((side - clamped.h) / 2);
  ctx.drawImage(img, clamped.x, clamped.y, clamped.w, clamped.h, dx, dy, clamped.w, clamped.h);
  const croppedDataUri = canvasToDataUri(out);

  return {
    layout: "LOCKUP",
    dataUri: croppedDataUri,
    cropped: true,
    symbolBox: clamped,
    confidence: parsed.confidence,
    reasoning: parsed.reasoning,
    creditsSpent: r.creditsCharged,
  };
}

function clampBox(
  box: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number,
): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, Math.min(Math.round(box.x), imgW - 1));
  const y = Math.max(0, Math.min(Math.round(box.y), imgH - 1));
  const w = Math.max(1, Math.min(Math.round(box.w), imgW - x));
  const h = Math.max(1, Math.min(Math.round(box.h), imgH - y));
  return { x, y, w, h };
}

function parseExtractionJson(content: string): {
  layout: LogoLayout;
  symbolBox: { x: number; y: number; w: number; h: number } | null;
  confidence: number;
  reasoning: string;
} {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Sonnet logo-extract returned non-JSON (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Sonnet logo-extract malformed JSON: ${(e as Error).message}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Sonnet logo-extract JSON is not an object");
  }
  const r = obj as Record<string, unknown>;
  const layout = r.layout;
  if (layout !== "WORDMARK_ONLY" && layout !== "SYMBOL_ONLY" && layout !== "LOCKUP") {
    throw new Error(`Sonnet logo-extract: invalid layout "${String(layout)}"`);
  }
  const raw = r.symbolBox as Record<string, unknown> | null | undefined;
  const symbolBox =
    raw &&
    typeof raw.x === "number" &&
    typeof raw.y === "number" &&
    typeof raw.w === "number" &&
    typeof raw.h === "number"
      ? { x: raw.x, y: raw.y, w: raw.w, h: raw.h }
      : null;
  return {
    layout,
    symbolBox,
    confidence: typeof r.confidence === "number" ? r.confidence : 0,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
  };
}
