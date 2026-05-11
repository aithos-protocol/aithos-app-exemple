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
 * SMOOTH FLAT 2D BRAND MASCOT — clean isometric-illustration style
 * with a visible blank chest plate where the agent will paint the
 * logo. Style reference: Aithos Builder mascot — friendly, modern,
 * vector-clean, NOT photorealistic, NOT industrial.
 *
 * Key insights from iteration:
 *
 * - "Flat 2D cartoon illustration / isometric character art" is the
 *   sweet spot. Words like "metal construction" send FLUX into
 *   photorealistic territory; "flat / illustration / vector" keeps
 *   it in mascot territory.
 *
 * - "BUST PORTRAIT" cropping gives a tight head-and-chest frame —
 *   essentially the brand-profile shape. Full-body shots waste
 *   half the canvas on legs and place the chest too high.
 *
 * - The chest plate colour is the LIGHTER of primary/secondary so
 *   the logo (in the darker brand colour) has contrast.
 *
 * - Coloured background with a soft halo behind the robot reads as
 *   "modern brand mascot" rather than "cut-out sticker".
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
    // 1. SCENE — framing first, style second
    "A friendly minimal robot character mascot, BUST PORTRAIT — head, shoulders and upper torso only,",
    "tightly cropped close-up just below the chest, NO legs visible, NO arms below the elbow.",
    "Simple flat modern 2D cartoon illustration style, isometric character art look.",
    // 2. STYLE NEGATIONS (placed early so they bias the whole composition)
    "NOT photorealistic, NOT 3D rendered, NOT industrial steampunk, NOT metallic photoreal —",
    "just clean flat 2D illustration with subtle soft shading.",
    "Looking straight forward.",
    // 3. CHEST PLATE — the logo drop zone, leads the description
    `The robot has a clearly visible large centered chest plate area on its torso —`,
    `a smooth flat panel of ${chestQualifier} ${chestColor} (color rgb(${chestRgb.r},${chestRgb.g},${chestRgb.b})),`,
    "perfectly empty, completely blank: no buttons, no gauges, no symbols, no logo,",
    "no circle, no emblem, no decoration. Like a brand mascot's emblem spot, intentionally left clean.",
    // 4. OTHER BODY PARTS — subordinate
    `Body in flat ${chestQualifier} ${chestColor} smooth shapes; headphones and joint details in ${bodyQualifier} ${bodyColor}.`,
    // 5. BACKGROUND — colored + halo (kept in the final output)
    `On a flat solid ${brand.backgroundColor} background color rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}),`,
    `with a soft warm ambient halo glow behind the robot — atmospheric, modern brand-mascot framing.`,
    // 6. MOOD (last, as flavour)
    `Mood: ${keywords}. ${brand.visualBrief}`,
    // 7. STYLE FINISH
    "Style: friendly modern tech-startup mascot, simple geometric shapes, clean vector-style lines, minimal details.",
    "Cute approachable character.",
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
  /** Raw FLUX output (PNG blob + data URI). */
  readonly rawBlob: Blob;
  readonly rawDataUri: string;
  /**
   * Raw FLUX output as a canvas, with its colored background INTACT.
   * This is what the final composite is built on — we keep the FLUX
   * background so the output reads as a finished mascot illustration.
   */
  readonly rawCanvas: HTMLCanvasElement;
  /**
   * Background-removed version of the raw canvas. Used ONLY for
   * detection — without bg removal, colour-matching the chest plate
   * could accidentally match same-coloured background pixels (e.g.
   * Brewsmith with bg=#F5F0E6 and chest=#F5F0E6 — the same colour).
   * NOT used in the final composite.
   */
  readonly silhouetteCanvas: HTMLCanvasElement;
  /** Silhouette bounding box. */
  readonly bbox: SilhouetteBox;
  /** Detected chest plate geometry — center + suggested logo diameter. */
  readonly torso: { centerX: number; centerY: number; diameter: number };
  /** Which detection strategy chose the final position. */
  readonly torsoSource: "color-match" | "silhouette-width" | "bbox-heuristic";
  /** Debug overlay (chest plate bbox + crosshair) painted on the raw image. */
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

  // Two canvases:
  //   - rawCanvas: the original FLUX image WITH its background intact —
  //     this is what step3 composites onto.
  //   - silhouetteCanvas: the same content with the background flooded
  //     to alpha=0 — used ONLY for detection, so the chest-plate
  //     colour-match doesn't accidentally match same-colored bg pixels.
  const rawCanvas = imageToCanvas(rawImgEl);
  const silhouetteCanvas = imageToCanvas(rawImgEl);
  const sampledBgHex = sampleCornerColor(silhouetteCanvas);
  removeSolidBackground(silhouetteCanvas, sampledBgHex, 38);

  // Chest plate detection — multi-strategy with sanity checks.
  //
  // Order:
  //   1. Colour-match RESTRICTED TO THE CHEST BAND, returning the
  //      BBOX CENTRE of matched pixels (not centroid — centroid is
  //      density-biased; the geometric centre is the true visual
  //      centre of the chest plate).
  //   2. Silhouette-width fallback.
  //   3. Plain bbox-65% as last-resort.
  //
  // Diameter from colour-match = ~50% of the chest plate's SMALLER
  // dimension, giving the logo a healthy margin inside the plate.
  const torsoColor = pickTorsoColor(brand);
  const bbox = detectSilhouetteBox(silhouetteCanvas);
  const chestYMin = bbox.top + Math.floor(bbox.height * 0.50);
  const chestYMax = bbox.top + Math.floor(bbox.height * 0.90);
  const isInChestBand = (cy: number): boolean => cy >= chestYMin && cy <= chestYMax;

  let torso: { centerX: number; centerY: number; diameter: number };
  let torsoSource: "color-match" | "silhouette-width" | "bbox-heuristic";

  const colorMatched = detectTorsoByColor(silhouetteCanvas, torsoColor, {
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
    const widthBased = detectTorsoBySilhouetteWidth(silhouetteCanvas, bbox);
    if (isInChestBand(widthBased.centerY)) {
      torso = widthBased;
      torsoSource = "silhouette-width";
    } else {
      torso = {
        centerX: Math.round(bbox.left + bbox.width / 2),
        centerY: Math.round(bbox.top + bbox.height * 0.65),
        diameter: Math.round(bbox.width * 0.38),
      };
      torsoSource = "bbox-heuristic";
    }
  }

  // Debug overlay drawn over the RAW canvas (with bg intact) so the
  // user sees the marker on the actual final-output background, not
  // on a checkered void.
  const debugOverlay = renderTorsoDebugOverlay(rawCanvas, bbox, torso);
  const debugOverlayDataUri = canvasToDataUri(debugOverlay);

  return {
    prompt,
    rawBlob,
    rawDataUri,
    rawCanvas,
    silhouetteCanvas,
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
  // Composite onto the RAW canvas (FLUX bg intact) so the final
  // image keeps the colored background + halo, like a finished
  // brand mascot illustration.
  const canvas = compositeLogoOnRobot(
    robot.rawCanvas,
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
