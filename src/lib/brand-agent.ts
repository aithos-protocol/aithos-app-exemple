// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Branded-robot agent — broken into 3 standalone steps so the
// pipeline is interactively debuggable.
//
// Each step is a pure function (well, async — they read FLUX) that
// takes its inputs and returns its outputs. The 3-step UI can call
// them in order, re-run any of them in isolation, and tweak the
// composite step's parameters on the fly without re-generating the
// robot (the expensive FLUX call).

import type { AithosSDK } from "@aithos/sdk";

import type { BrandProfile } from "./brand-types.js";
import {
  blobToDataUri,
  canvasToBlob,
  canvasToDataUri,
  compositeLogoOnRobot,
  detectSilhouetteBox,
  detectTorsoByColor,
  detectTorsoBySilhouetteWidth,
  hexToRgb,
  imageToCanvas,
  loadImage,
  removeSolidBackground,
  renderTorsoDebugOverlay,
  type CompositeLogoOpts,
  type SilhouetteBox,
} from "./image-pipeline.js";

/* -------------------------------------------------------------------------- */
/*  Color helpers                                                             */
/* -------------------------------------------------------------------------- */

function luma(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Pick the lighter of primary/secondary as the t-shirt color.
 * The logo (in the OTHER color) will then show clearly with a
 * `multiply` blend on a light t-shirt, or `screen` on a dark t-shirt.
 */
export function pickTorsoColor(brand: BrandProfile): string {
  return luma(brand.primaryColor) > luma(brand.secondaryColor)
    ? brand.primaryColor
    : brand.secondaryColor;
}

export function pickBlendMode(brand: BrandProfile): "multiply" | "screen" {
  // Pick based on the t-shirt (= what the logo lands on)
  return luma(pickTorsoColor(brand)) < 0.5 ? "screen" : "multiply";
}

/* -------------------------------------------------------------------------- */
/*  Prompt composition                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Translate a brand profile into a FLUX prompt that produces a
 * CLASSIC METAL ROBOT MASCOT — upper-body portrait, polished metal
 * construction, with a clean uniform METALLIC CHEST PLATE in the
 * centre of the torso (the logo drop zone).
 *
 * Key insights from iteration:
 *
 * - Positive descriptions stick FAR better than negations. Describing
 *   the chest plate as "smooth polished plain metal panel" works;
 *   "no chest emblem" alone gets ignored.
 *
 * - Upper-body crop is essential for branding — gives a tight portrait
 *   with the chest unmistakably in frame. Whole-body shots place the
 *   chest too high in the silhouette and waste visual space on legs.
 *
 * - The chest plate colour is the LIGHTER of primary/secondary so the
 *   logo (in the darker brand colour) lands with contrast.
 *
 * - Strong colour qualifiers ("pristine bright pure", "rich vivid")
 *   help FLUX honour the requested colour against the brand's mood
 *   words ("cool", "warm") which otherwise hijack the palette.
 *
 * - Brand mood / visual brief comes LAST, as flavour — never first.
 */
export function composeFluxPrompt(brand: BrandProfile): string {
  const chestColor = pickTorsoColor(brand);
  const bodyColor =
    chestColor === brand.primaryColor ? brand.secondaryColor : brand.primaryColor;
  const bgRgb = hexToRgb(brand.backgroundColor);
  const chestRgb = hexToRgb(chestColor);
  const chestQualifier = colorQualifier(chestColor);
  const bodyQualifier = colorQualifier(bodyColor);
  const keywords = brand.styleKeywords.join(", ");
  return [
    // 1. SCENE — robot type, framing
    "A friendly minimal robot character mascot, simple modern cartoon style,",
    "smooth polished metal construction.",
    "Upper body portrait — head and torso only, cropped just below the chest.",
    "Looking straight forward.",
    // 2. CHEST PLATE — the logo drop zone, leads the description
    `The robot has a clearly visible smooth metallic chest plate in the center of its torso —`,
    `a polished plain panel of ${chestQualifier} ${chestColor} metal (color rgb(${chestRgb.r},${chestRgb.g},${chestRgb.b})),`,
    "like a single uniform piece, perfectly flat, completely empty.",
    "No logo, no symbol, no gauge, no button, no rivet, no engraving,",
    "no circle, no emblem, no decoration — just a plain blank metallic chest panel.",
    // 3. OTHER BODY PARTS — subordinate to the chest plate
    `Other body parts (head, neck, shoulders, arms, hands) in ${bodyQualifier} ${bodyColor} matte metal tones, simple and minimal.`,
    // 4. MOOD (comes last)
    `Overall mood: ${keywords}. ${brand.visualBrief}`,
    // 5. BACKGROUND
    `On a flat pure solid uniform ${brand.backgroundColor} background color rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}),`,
    "no gradients, no patterns, no shadow falloff, perfectly uniform colour edge-to-edge.",
    // 6. STYLE FINISH
    "Sharp clean silhouette. Cute friendly character.",
    "No glow effects, no lens flares, no rim light, no bright specular highlights on the chest plate.",
  ].join(" ");
}

/**
 * Pick an English qualifier that nudges FLUX towards the exact colour
 * we asked for. Without this, the model's interpretation drifts — a
 * "white" t-shirt becomes greyish, a "brown" becomes nearly black.
 */
function colorQualifier(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luma > 0.85) return "pristine bright pure";
  if (luma > 0.60) return "soft warm clean";
  if (luma > 0.35) return "rich vivid saturated";
  return "deep rich dark";
}

/* -------------------------------------------------------------------------- */
/*  Step 1 — Generate robot (FLUX call + bg removal + torso detection)        */
/* -------------------------------------------------------------------------- */

export interface Step1Args {
  readonly brand: BrandProfile;
  readonly sdk: AithosSDK;
  readonly model?: "image:flux-schnell" | "image:flux-dev" | "image:flux-pro-1.1" | "image:flux-pro-1.1-ultra";
  /** Override the brand's seed (used for "regenerate" — bump for variety). */
  readonly seedOverride?: number;
}

export interface Step1Result {
  /** The exact prompt the agent fed to FLUX. */
  readonly prompt: string;
  /** Raw FLUX output, with its original FLUX background. */
  readonly rawBlob: Blob;
  readonly rawDataUri: string;
  /** Robot canvas after background removal (alpha=0 outside silhouette). */
  readonly robotCanvas: HTMLCanvasElement;
  /** Same canvas exported as data URI (on a checker background for preview). */
  readonly robotDataUri: string;
  /** Silhouette bounding box. */
  readonly bbox: SilhouetteBox;
  /** Detected torso geometry. */
  readonly torso: { centerX: number; centerY: number; diameter: number };
  /** Which detection strategy chose the final torso position. */
  readonly torsoSource: "color-match" | "silhouette-width" | "bbox-heuristic";
  /** Debug overlay (silhouette bbox + torso crosshair) for the UI. */
  readonly debugOverlayDataUri: string;
  /** Microcredits debited from the wallet. */
  readonly creditsSpent: number;
}

export async function step1GenerateRobot(args: Step1Args): Promise<Step1Result> {
  const { brand, sdk } = args;
  const model = args.model ?? "image:flux-pro-1.1";
  const prompt = composeFluxPrompt(brand);
  const seed = args.seedOverride ?? brand.seed;

  const r = await sdk.compute.invokeImage({
    model,
    prompt,
    aspectRatio: "1:1",
    numberOfImages: 1,
    ...(seed !== undefined ? { seed } : {}),
  });
  if (r.images.length === 0) throw new Error("FLUX returned no images");
  const rawImg = r.images[0]!;
  const rawBlob = base64ToBlob(rawImg.base64, rawImg.contentType);
  const rawDataUri = await blobToDataUri(rawBlob);
  const rawImgEl = await loadImage(rawBlob);

  // BG removal — sample the ACTUAL corner colour rather than trusting
  // brand.backgroundColor. FLUX often paints a slightly different
  // background colour than asked for (the brand mood drifts it). The
  // sampled-corner approach is robust to that drift: whatever colour
  // FLUX actually put in the corners IS the background, by definition.
  const robotCanvas = imageToCanvas(rawImgEl);
  const sampledBgHex = sampleCornerColor(robotCanvas);
  removeSolidBackground(robotCanvas, sampledBgHex, 38);

  // Torso detection — multi-strategy with sanity checks.
  //
  // For UPPER-BODY crops (metal robot prompt, head + torso only), the
  // chest plate sits in the 50-85% band of the silhouette bbox. The
  // earlier 35-90% band was for full-body shots where the chest was
  // higher up the legs-included silhouette. Tighter bounds = better
  // rejection of false matches.
  //
  // Order:
  //   1. Colour-match RESTRICTED TO THE CHEST BAND (so head highlights
  //      — antenna tips, lens flares, edge specular — can't be
  //      confused for the chest plate).
  //   2. Silhouette-width fallback: find the widest row within the
  //      chest band. Provider-agnostic — works even if FLUX painted
  //      the chest plate the wrong colour.
  //   3. Plain bbox-65% as the last-resort fallback (chest sits ~65%
  //      down an upper-body silhouette).
  const torsoColor = pickTorsoColor(brand);
  const bbox = detectSilhouetteBox(robotCanvas);
  const chestYMin = bbox.top + Math.floor(bbox.height * 0.50);
  const chestYMax = bbox.top + Math.floor(bbox.height * 0.90);
  const isInChestBand = (cy: number): boolean => cy >= chestYMin && cy <= chestYMax;

  let torso: { centerX: number; centerY: number; diameter: number };
  let torsoSource: "color-match" | "silhouette-width" | "bbox-heuristic";

  const colorMatched = detectTorsoByColor(robotCanvas, torsoColor, {
    tolerance: 50,
    yMin: chestYMin,
    yMax: chestYMax,
    minPixels: 5000,
  });
  if (colorMatched && isInChestBand(colorMatched.centerY)) {
    torso = {
      centerX: colorMatched.centerX,
      centerY: colorMatched.centerY,
      diameter: colorMatched.diameter,
    };
    torsoSource = "color-match";
  } else {
    const widthBased = detectTorsoBySilhouetteWidth(robotCanvas, bbox);
    if (isInChestBand(widthBased.centerY)) {
      torso = widthBased;
      torsoSource = "silhouette-width";
    } else {
      torso = {
        centerX: Math.round(bbox.left + bbox.width / 2),
        // Upper-body crop: the chest plate is around 65% down the
        // silhouette (vs ~55% on a full-body crop with legs).
        centerY: Math.round(bbox.top + bbox.height * 0.65),
        diameter: Math.round(bbox.width * 0.38),
      };
      torsoSource = "bbox-heuristic";
    }
  }

  const robotDataUri = canvasToDataUri(robotCanvas);
  const debugOverlay = renderTorsoDebugOverlay(robotCanvas, bbox, torso);
  const debugOverlayDataUri = canvasToDataUri(debugOverlay);

  return {
    prompt,
    rawBlob,
    rawDataUri,
    robotCanvas,
    robotDataUri,
    bbox,
    torso,
    torsoSource,
    debugOverlayDataUri,
    creditsSpent: r.creditsCharged,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — Prepare logo (force transparency if needed)                      */
/* -------------------------------------------------------------------------- */

export interface Step2Args {
  readonly brand: BrandProfile;
}

export interface Step2Result {
  /** Original logo as data URI. */
  readonly originalDataUri: string;
  /** Processed logo with guaranteed transparency. */
  readonly processedImg: HTMLImageElement;
  readonly processedDataUri: string;
  /** True if the corner-flood-fill removed a non-transparent background. */
  readonly bgWasRemoved: boolean;
  /** The detected corner colour (for trace). */
  readonly detectedCornerHex: string | null;
}

export async function step2PrepareLogo(args: Step2Args): Promise<Step2Result> {
  const { brand } = args;
  const originalImg = await loadImage(brand.logoDataUri);

  if (brand.logoHasAlpha) {
    // No background to remove — pass through. Still re-encode as PNG
    // so the downstream composite step always works with a clean
    // raster (SVGs have unpredictable rasterization at small sizes).
    const c = imageToCanvas(originalImg);
    const processedDataUri = canvasToDataUri(c);
    return {
      originalDataUri: brand.logoDataUri,
      processedImg: await loadImage(processedDataUri),
      processedDataUri,
      bgWasRemoved: false,
      detectedCornerHex: null,
    };
  }

  // Sample one corner — for clean logos all four are the same colour
  const c = imageToCanvas(originalImg);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const px = ctx.getImageData(2, 2, 1, 1).data;
  const cornerHex = `#${[px[0], px[1], px[2]]
    .map((v) => v!.toString(16).padStart(2, "0"))
    .join("")}`;
  removeSolidBackground(c, cornerHex, 48);
  const processedDataUri = canvasToDataUri(c);
  return {
    originalDataUri: brand.logoDataUri,
    processedImg: await loadImage(processedDataUri),
    processedDataUri,
    bgWasRemoved: true,
    detectedCornerHex: cornerHex,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 3 — Composite                                                        */
/* -------------------------------------------------------------------------- */

export interface Step3Settings extends CompositeLogoOpts {
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface Step3Args {
  readonly robot: Step1Result;
  readonly logo: Step2Result;
  readonly settings: Step3Settings;
}

export interface Step3Result {
  readonly canvas: HTMLCanvasElement;
  readonly blob: Blob;
  readonly dataUri: string;
}

export async function step3Composite(args: Step3Args): Promise<Step3Result> {
  const { robot, logo, settings } = args;
  const torso = {
    centerX: robot.torso.centerX + settings.offsetX,
    centerY: robot.torso.centerY + settings.offsetY,
    diameter: robot.torso.diameter,
  };
  // Build the composite opts incrementally — `exactOptionalPropertyTypes`
  // means we can't pass `undefined` for a missing optional, so we spread
  // only the keys that are defined.
  const compositeOpts: CompositeLogoOpts = {
    ...(settings.blendMode !== undefined ? { blendMode: settings.blendMode } : {}),
    ...(settings.opacity !== undefined ? { opacity: settings.opacity } : {}),
    ...(settings.fillRatio !== undefined ? { fillRatio: settings.fillRatio } : {}),
    ...(settings.shadowBlur !== undefined ? { shadowBlur: settings.shadowBlur } : {}),
    ...(settings.shadowColor !== undefined ? { shadowColor: settings.shadowColor } : {}),
  };
  const canvas = compositeLogoOnRobot(
    robot.robotCanvas,
    logo.processedImg,
    torso,
    compositeOpts,
  );
  const blob = await canvasToBlob(canvas);
  const dataUri = canvasToDataUri(canvas);
  return { canvas, blob, dataUri };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function base64ToBlob(base64: string, contentType: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: contentType });
}

/**
 * Average the four corner pixels of a canvas (with a small inset to
 * avoid edge anti-aliasing) and return the resulting colour as a
 * `#rrggbb` hex string. Used as the actual flood-fill reference for
 * background removal — robust to FLUX colour drift on the brand's
 * declared backgroundColor.
 */
function sampleCornerColor(canvas: HTMLCanvasElement): string {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const { width: w, height: h } = canvas;
  const inset = 4;
  const samples = [
    ctx.getImageData(inset, inset, 1, 1).data,
    ctx.getImageData(w - 1 - inset, inset, 1, 1).data,
    ctx.getImageData(inset, h - 1 - inset, 1, 1).data,
    ctx.getImageData(w - 1 - inset, h - 1 - inset, 1, 1).data,
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const px of samples) {
    r += px[0]!;
    g += px[1]!;
    b += px[2]!;
  }
  const avg = [r / samples.length, g / samples.length, b / samples.length].map(
    (v) => Math.round(v).toString(16).padStart(2, "0"),
  );
  return `#${avg.join("")}`;
}
