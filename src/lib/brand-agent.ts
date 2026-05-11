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
import {
  detectTorsoByPose,
  renderPoseOverlay,
  type PoseTorsoResult,
} from "./pose-detection.js";

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
 * SMOOTH FLAT 2D BRAND MASCOT — clean isometric-illustration style,
 * uniform body with NO chest plate / panel / emblem area. The logo
 * is composited afterwards using pose-based torso detection, so the
 * prompt no longer needs to coax FLUX into leaving a coloured zone
 * on the chest (which kept producing structural panels with bolts).
 *
 * Style reference: Aithos Builder mascot — friendly, modern,
 * vector-clean, NOT photorealistic, NOT industrial.
 */
export function composeFluxPrompt(brand: BrandProfile): string {
  const bodyColor = pickTorsoColor(brand); // the lighter of primary/secondary
  const accentColor =
    bodyColor === brand.primaryColor ? brand.secondaryColor : brand.primaryColor;
  const bgRgb = hexToRgb(brand.backgroundColor);
  const bodyRgb = hexToRgb(bodyColor);
  const bodyQualifier = colorQualifier(bodyColor);
  const accentQualifier = colorQualifier(accentColor);
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
    // 3. BODY — uniform, smooth, no structural details on the chest
    `The robot body is rendered in flat ${bodyQualifier} ${bodyColor} (color rgb(${bodyRgb.r},${bodyRgb.g},${bodyRgb.b})),`,
    "smooth uniform surface, single piece — NO chest plate, NO panel, NO bolts, NO rivets,",
    "NO seams, NO buttons, NO gauges, NO chest emblem, NO circle on the chest, NO decoration.",
    "The torso is a CLEAN UNINTERRUPTED smooth surface, like a featureless mascot body.",
    // 4. ACCENTS — headphones, joints, eyes (the only allowed visual interest)
    `Headphones, eye sockets, and joint accents in ${accentQualifier} ${accentColor}.`,
    // 5. BACKGROUND — colored + halo (kept in the final output)
    `On a flat solid ${brand.backgroundColor} background color rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}),`,
    "with a soft warm ambient halo glow behind the robot — atmospheric, modern brand-mascot framing.",
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
  /** Defaults to "image:imagen-4" — closest match to the Aithos reference style. */
  readonly model?:
    | "image:flux-schnell"
    | "image:flux-dev"
    | "image:flux-pro-1.1"
    | "image:flux-pro-1.1-ultra"
    | "image:imagen-3"
    | "image:imagen-4"
    | "image:nano-banana";
  /** Override the brand's seed (used for "regenerate" — bump for variety). */
  readonly seedOverride?: number;
  /**
   * Override the agent-composed FLUX prompt. When provided, the agent
   * sends this EXACT string instead of running composeFluxPrompt on
   * the brand profile. The UI uses this to let the operator edit the
   * prompt live in a textarea before sending to the model.
   */
  readonly promptOverride?: string;
}

export interface Step1Result {
  /** The exact prompt the agent fed to the image model. */
  readonly prompt: string;
  /** Raw model output (PNG blob + data URI). */
  readonly rawBlob: Blob;
  readonly rawDataUri: string;
  /**
   * Raw output as a canvas, with its colored background INTACT.
   * This is what the final composite is built on.
   */
  readonly rawCanvas: HTMLCanvasElement;
  /** Microcredits debited from the wallet. */
  readonly creditsSpent: number;
}

/**
 * Step 1 — Call the image model. ONLY generates the image; detection
 * is now Step 2 (manually triggered) so the operator can iterate on
 * the prompt without re-running pose detection.
 */
export async function step1GenerateRobot(args: Step1Args): Promise<Step1Result> {
  const { brand, sdk } = args;
  // Imagen 4 is the closest match to the Aithos reference style.
  const model = args.model ?? "image:imagen-4";
  // Operator-edited prompt > agent-composed default.
  const prompt = args.promptOverride ?? composeFluxPrompt(brand);
  const seed = args.seedOverride ?? brand.seed;

  // Cast: the new Imagen / Nano Banana ids landed in @aithos/sdk
  // alpha.17. The example app's installed version may still be alpha.16
  // until `pnpm install` picks up the new release; the server-side
  // allowlist is what matters for security.
  const r = await sdk.compute.invokeImage({
    model: model as "image:flux-pro-1.1",
    prompt,
    aspectRatio: "1:1",
    numberOfImages: 1,
    ...(seed !== undefined ? { seed } : {}),
  });
  if (r.images.length === 0) throw new Error("image model returned no images");
  const rawImg = r.images[0]!;
  const rawBlob = base64ToBlob(rawImg.base64, rawImg.contentType);
  const rawDataUri = await blobToDataUri(rawBlob);
  const rawImgEl = await loadImage(rawBlob);
  const rawCanvas = imageToCanvas(rawImgEl);

  return {
    prompt,
    rawBlob,
    rawDataUri,
    rawCanvas,
    creditsSpent: r.creditsCharged,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 2 — Detect torso (bg removal + pose detection + debug overlay)       */
/* -------------------------------------------------------------------------- */

export interface Step2DetectArgs {
  readonly brand: BrandProfile;
  /** The canvas returned by Step 1. */
  readonly rawCanvas: HTMLCanvasElement;
  /** SDK instance — needed for the Florence-2 segmentation call. */
  readonly sdk: AithosSDK;
}

export interface Step2DetectResult {
  /**
   * Background-removed version of the raw canvas. Used for detection
   * ONLY — the final composite still uses Step 1's rawCanvas (with bg
   * intact) so the output reads as a finished mascot illustration.
   */
  readonly silhouetteCanvas: HTMLCanvasElement;
  /** Silhouette bounding box (= "robot location and size"). */
  readonly bbox: SilhouetteBox;
  /** Torso center + suggested logo diameter. */
  readonly torso: { centerX: number; centerY: number; diameter: number };
  /** Which detection strategy chose the final position. */
  readonly torsoSource:
    | "florence-2"
    | "pose-landmarker"
    | "color-match"
    | "silhouette-width"
    | "bbox-heuristic";
  /** Full pose result if MediaPipe ran successfully. */
  readonly pose: PoseTorsoResult | null;
  /** Florence-2 polygon if the API call succeeded (for the debug overlay). */
  readonly florencePolygon: ReadonlyArray<{ readonly x: number; readonly y: number }> | null;
  /** Debug overlay (Florence polygon / skeleton / bbox + crosshair) painted on the raw image. */
  readonly debugOverlayDataUri: string;
}

/**
 * Step 2 — Run bg removal + pose detection + debug overlay on the
 * image returned by Step 1. Manually triggered so the operator can
 * tweak the Step 1 prompt and regenerate without losing the time
 * spent on MediaPipe model warmup.
 */
export async function step2DetectTorso(
  args: Step2DetectArgs,
): Promise<Step2DetectResult> {
  const { brand, rawCanvas, sdk } = args;

  // Silhouette canvas = rawCanvas with bg flooded to alpha=0. Used
  // for detection only — composite still uses rawCanvas.
  const silhouetteCanvas = document.createElement("canvas");
  silhouetteCanvas.width = rawCanvas.width;
  silhouetteCanvas.height = rawCanvas.height;
  const ctx = silhouetteCanvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(rawCanvas, 0, 0);
  const sampledBgHex = sampleCornerColor(silhouetteCanvas);
  removeSolidBackground(silhouetteCanvas, sampledBgHex, 38);

  // 4-tier cascade. Order:
  //   1. MediaPipe Pose (preferred) — runs on the RAW canvas (with bg)
  //      because the model was trained on natural photos with bg, and
  //      gets confused by transparency.
  //   2. Colour-match on the silhouette (legacy)
  //   3. Silhouette-width (legacy)
  //   4. Bbox-65% (last resort)
  const torsoColor = pickTorsoColor(brand);
  const bbox = detectSilhouetteBox(silhouetteCanvas);
  const chestYMin = bbox.top + Math.floor(bbox.height * 0.45);
  const chestYMax = bbox.top + Math.floor(bbox.height * 0.95);
  const isInChestBand = (cy: number): boolean => cy >= chestYMin && cy <= chestYMax;

  console.log("[brand-agent] bg removal + detection start:", {
    canvas: `${rawCanvas.width}×${rawCanvas.height}`,
    sampledBgHex,
    silhouetteBbox: bbox,
    chestBand: `[${chestYMin}, ${chestYMax}]`,
  });
  // Sanity check: if the bbox spans the entire image, bg removal
  // almost certainly failed (gradient bg or noisy edges). The
  // chest band will be too wide and downstream strategies will
  // mis-place the target.
  if (bbox.width >= rawCanvas.width - 2 && bbox.height >= rawCanvas.height - 2) {
    console.warn(
      "[brand-agent] silhouette bbox spans the entire image — bg removal failed. " +
        "Most likely cause: radial-gradient background that flood-fill can't handle. " +
        "Downstream detection will be unreliable.",
    );
  }

  let torso: { centerX: number; centerY: number; diameter: number };
  let torsoSource: Step2DetectResult["torsoSource"];
  let pose: PoseTorsoResult | null = null;
  let florencePolygon: ReadonlyArray<{ x: number; y: number }> | null = null;

  // 1. Florence-2 (PRIMARY) — text-prompted segmentation, works on cartoons + photos.
  try {
    console.log("[brand-agent] calling Florence-2 segmentation…");
    const blob = await canvasToBlob(rawCanvas);
    const t0 = performance.now();
    // Cast: invokeSegmentation landed in @aithos/sdk alpha.18.
    // Installed @aithos/sdk may still be alpha.17 until `pnpm install`.
    const computeNs = sdk.compute as unknown as {
      invokeSegmentation(args: {
        image: Blob;
        textInput: string;
      }): Promise<{
        polygons: ReadonlyArray<{ points: ReadonlyArray<{ x: number; y: number }> }>;
        bbox: { left: number; top: number; right: number; bottom: number } | null;
      }>;
    };
    const seg = await computeNs.invokeSegmentation({
      image: blob,
      textInput: "the torso and chest of the robot character",
    });
    console.log(
      `[brand-agent] Florence-2 returned ${seg.polygons.length} polygon(s) in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    if (seg.polygons.length > 0 && seg.bbox) {
      florencePolygon = seg.polygons[0]!.points;
      const cx = Math.round((seg.bbox.left + seg.bbox.right) / 2);
      const cy = Math.round((seg.bbox.top + seg.bbox.bottom) / 2);
      const w = seg.bbox.right - seg.bbox.left;
      const h = seg.bbox.bottom - seg.bbox.top;
      const diameter = Math.round(Math.min(w, h) * 0.5);
      torso = { centerX: cx, centerY: cy, diameter };
      torsoSource = "florence-2";
      console.log("[brand-agent] ✅ using florence-2", { torso, bbox: seg.bbox });
      // Skip remaining cascade — Florence-2 is reliable.
      // florencePolygon is guaranteed non-null here (we just set it).
      const debugOverlay = renderTorsoDebugOverlay(rawCanvas, bbox, torso, {
        florencePolygon: florencePolygon ?? undefined,
      });
      const debugOverlayDataUri = canvasToDataUri(debugOverlay);
      return {
        silhouetteCanvas,
        bbox,
        torso,
        torsoSource,
        pose: null,
        florencePolygon,
        debugOverlayDataUri,
      };
    }
    console.warn("[brand-agent] Florence-2 returned no polygons, falling through");
  } catch (e) {
    console.warn("[brand-agent] Florence-2 call failed, falling through", e);
  }

  // 2. MediaPipe Pose (fallback for human photos where Florence isn't great)
  try {
    pose = await detectTorsoByPose(rawCanvas);
  } catch (e) {
    console.warn("[brand-agent] pose detection threw, falling back", e);
    pose = null;
  }
  if (pose && isInChestBand(pose.centerY)) {
    torso = {
      centerX: pose.centerX,
      centerY: pose.centerY,
      diameter: pose.diameter,
    };
    torsoSource = "pose-landmarker";
    console.log("[brand-agent] ✅ using pose-landmarker", torso);
  } else {
    if (pose) {
      console.warn(
        `[brand-agent] pose returned centerY=${pose.centerY} OUTSIDE chest band ` +
          `[${chestYMin}, ${chestYMax}] — rejecting pose, falling through to legacy cascade.`,
      );
    } else {
      console.warn(
        "[brand-agent] pose returned null — falling through to legacy cascade.",
      );
    }
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
      console.log("[brand-agent] ⚠ using color-match fallback", torso);
    } else {
      const widthBased = detectTorsoBySilhouetteWidth(silhouetteCanvas, bbox);
      if (isInChestBand(widthBased.centerY)) {
        torso = widthBased;
        torsoSource = "silhouette-width";
        console.log("[brand-agent] ⚠ using silhouette-width fallback", torso);
      } else {
        torso = {
          centerX: Math.round(bbox.left + bbox.width / 2),
          centerY: Math.round(bbox.top + bbox.height * 0.65),
          diameter: Math.round(bbox.width * 0.38),
        };
        torsoSource = "bbox-heuristic";
        console.log("[brand-agent] ⚠⚠ using bbox-65% LAST RESORT", torso);
      }
    }
  }

  const debugOverlay =
    pose !== null
      ? renderPoseOverlay(rawCanvas, pose, { logoTarget: torso })
      : renderTorsoDebugOverlay(rawCanvas, bbox, torso);
  const debugOverlayDataUri = canvasToDataUri(debugOverlay);

  return {
    silhouetteCanvas,
    bbox,
    torso,
    torsoSource,
    pose,
    florencePolygon,
    debugOverlayDataUri,
  };
}

/* -------------------------------------------------------------------------- */
/*  Step 3 — Prepare logo (force transparency if needed)                      */
/* -------------------------------------------------------------------------- */

export interface Step3LogoArgs {
  readonly brand: BrandProfile;
}

export interface Step3LogoResult {
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

export async function step3PrepareLogo(args: Step3LogoArgs): Promise<Step3LogoResult> {
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
/*  Step 4 — Composite                                                        */
/* -------------------------------------------------------------------------- */

export interface Step4Settings extends CompositeLogoOpts {
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface Step4CompositeArgs {
  readonly robot: Step1Result;
  readonly detection: Step2DetectResult;
  readonly logo: Step3LogoResult;
  readonly settings: Step4Settings;
}

export interface Step4CompositeResult {
  readonly canvas: HTMLCanvasElement;
  readonly blob: Blob;
  readonly dataUri: string;
}

export async function step4Composite(
  args: Step4CompositeArgs,
): Promise<Step4CompositeResult> {
  const { robot, detection, logo, settings } = args;
  const torso = {
    centerX: detection.torso.centerX + settings.offsetX,
    centerY: detection.torso.centerY + settings.offsetY,
    diameter: detection.torso.diameter,
  };
  // Build the composite opts incrementally — `exactOptionalPropertyTypes`
  // means we can't pass `undefined` for a missing optional.
  const compositeOpts: CompositeLogoOpts = {
    ...(settings.blendMode !== undefined ? { blendMode: settings.blendMode } : {}),
    ...(settings.opacity !== undefined ? { opacity: settings.opacity } : {}),
    ...(settings.fillRatio !== undefined ? { fillRatio: settings.fillRatio } : {}),
    ...(settings.shadowBlur !== undefined ? { shadowBlur: settings.shadowBlur } : {}),
    ...(settings.shadowColor !== undefined ? { shadowColor: settings.shadowColor } : {}),
  };
  // Composite onto the RAW canvas (bg intact) so the final image
  // keeps the colored background + halo.
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
