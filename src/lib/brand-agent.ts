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
  extractLogoSymbol,
  type LogoExtractResult,
} from "./logo-extractor.js";
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
 * LOCKED composition template — appended verbatim to every brand
 * brief so the framing is IDENTICAL across all generated mascots.
 *
 * Locking the framing has two consequences:
 *
 *   1. Visual consistency across the brand-mascot library — every
 *      portrait has the same crop, head size, eye line, etc., so
 *      they can be presented together (eg. on a website "Choose
 *      your assistant" page) without one looking like a different
 *      product.
 *
 *   2. Predictable downstream geometry — the Sonnet vision detector
 *      sees the same anatomical anchors at roughly the same pixel
 *      coordinates regardless of brand, so logo placement is stable.
 *
 * Anything visual that varies brand-to-brand (body shape, colours,
 * mood, materials) belongs in the brand-specific brief. Anything
 * structural (crop, pose, lighting style, background gradient,
 * illustration style) belongs HERE.
 */
export const COMPOSITION_TEMPLATE = [
  "COMPOSITION (kept identical across all brand mascots):",
  "",
  "FRAMING & CROP:",
  "- Square 1:1 frame.",
  "- The robot is shown as a COMPLETE BUST: head + neck + shoulders + the",
  "  ENTIRE upper-body torso are ALL VISIBLE inside the frame.",
  "- The BUST IS COMPLETE — its LOWER TERMINATION is a CLEAN, NATURAL CUT",
  "  at the lower ribs / upper abdomen, like a half-body avatar floating in",
  "  empty space. The bust is FULLY VISIBLE inside the frame, with empty",
  "  background clearly visible BELOW it; you can see where the body ends",
  "  and there is nothing beneath it.",
  "- The bust is NEVER cut off by the bottom edge of the image: the body's",
  "  lower boundary is INSIDE the frame and surrounded by background pixels.",
  "- ZERO sculpted base, ZERO pedestal, ZERO stand, ZERO socle, ZERO",
  "  platform, ZERO polished terminal, ZERO ornamental cap, ZERO mount,",
  "  ZERO support of any kind beneath the bust. The bust simply ends and",
  "  the background takes over — nothing rests under the body.",
  "- ZERO pointed wedge, ZERO triangular tapering, ZERO V-shape narrowing",
  "  to a point. The lower boundary is a clean, natural, roughly horizontal",
  "  termination — soft and slightly curved is fine, sharply pointed is NOT.",
  "- The bust is DETACHED from any lower body: NO waist, NO hips, NO legs,",
  "  NO abdomen extending below the bust. The bust is the lowest part of the",
  "  body shown in the image. Think Greek sculpture bust freed from its",
  "  pedestal, half-body avatar floating in empty space — NOT a torso",
  "  flowing into a hidden lower body cropped by the frame, and NOT a bust",
  "  resting on a sculpted base.",
  "- ARMS follow ONE of these two options (the brand brief specifies which):",
  "  * 'arms-in-action': both arms FULLY VISIBLE inside the frame, performing",
  "    a small contained action — holding a tool, presenting an object, etc.",
  "    Hands and forearms stay INSIDE the frame.",
  "    CRITICAL — the action ALWAYS happens BELOW THE CHEST: hands, forearms,",
  "    held objects and any gesture are positioned at lower-abdomen / navel",
  "    height or lower, NEVER raised in front of the chest. The pectoral",
  "    panel between the two armpits remains 100% visible and unobstructed —",
  "    no hand, no finger, no arm, no held object, no cast shadow ever",
  "    crosses, covers or hovers in front of this area. The forearms angle",
  "    INWARD AND DOWNWARD toward the centre-bottom of the bust, not upward.",
  "  * 'arms-cut': arms cut at the FOREARM — upper arms and elbows visible,",
  "    lower forearms and hands exit the frame cleanly at the bottom-left",
  "    and bottom-right edges.",
  "- ABSOLUTE FRONT VIEW — the robot is shown in STRICT FRONTAL ORTHOGRAPHIC",
  "  PROJECTION, like a passport photo or an architect's elevation drawing.",
  "  The camera is aligned ON the body's central vertical axis at chest",
  "  height; the optical axis passes EXACTLY through the centre of the chest.",
  "- The robot's body, head and eyes ALL face the viewer DIRECTLY and",
  "  IDENTICALLY. Both eyes are equally visible and at the SAME size.",
  "  Both shoulders are equally visible, equally tall, equally wide.",
  "  Both sides of the chest are equally lit and equally exposed.",
  "- ZERO three-quarter view, ZERO 3/4 turn, ZERO profile, ZERO contrapposto,",
  "  ZERO twist of the spine, ZERO chest rotation, ZERO head tilt, ZERO head",
  "  rotation, ZERO chin lift or drop, ZERO dynamic camera angle.",
  "- The silhouette is BILATERALLY SYMMETRIC about the central vertical axis:",
  "  if you mirror-flipped the image left-to-right, the result would look",
  "  almost identical (apart from any held object). The left half and the",
  "  right half of the body are MIRROR IMAGES of each other.",
  "- The shoulder line is HORIZONTAL — strictly parallel to the bottom edge",
  "  of the frame. The eye line is also horizontal.",
  "- Comfortable horizontal margin: 10-15% empty background visible on EACH",
  "  SIDE beyond the outer body edges. The robot occupies APPROXIMATELY",
  "  70-80% of the frame width.",
  "- NEVER crop the head, the shoulders, or any part of the upper torso.",
  "  These three regions must NEVER touch or extend beyond the frame edges.",
  "",
  "CHEST ANATOMY (ABSOLUTE PRIORITY — a brand emblem will be composited",
  "on this surface afterwards; any existing detail there will RUIN the result):",
  "",
  "POSITIVE description (this is what the chest LOOKS like):",
  "- The robot's chest is a SINGLE SMOOTH UNIFORM PANEL spanning the entire",
  "  area from armpit to armpit, like a PLAIN T-SHIRT before printing, a",
  "  BLANK BILLBOARD, an UNPAINTED PIECE OF FABRIC.",
  "- The chest surface is ONE CONTINUOUS PIECE of material, treated as a",
  "  whole — same colour from left armpit to right armpit, same texture,",
  "  same shading gradient.",
  "- The chest surface is PRISTINE and EMPTY, like a freshly poured wall",
  "  before any painter has touched it.",
  "- Cel shading on the chest is SUBTLE and CONTINUOUS: a soft gradient from",
  "  light at the top to slightly darker at the bottom, with NO breaks, NO",
  "  sharp lines, NO geometric features drawn on top of the shading.",
  "",
  "EXPLICITLY ABSENT (what the chest MUST NOT contain):",
  "- ZERO logos. ZERO emblems. ZERO badges. ZERO printed symbols. ZERO icons.",
  "- ZERO armor plates. ZERO chest panels. ZERO breastplates. ZERO segments.",
  "- ZERO rivets, ZERO bolts, ZERO buttons, ZERO screws, ZERO LEDs,",
  "  ZERO gauges, ZERO dials, ZERO meters, ZERO ports, ZERO vents.",
  "- ZERO seams down the sternum. ZERO V-shape between the pectorals.",
  "  ZERO central vertical line. ZERO grooves. ZERO splits. ZERO division",
  "  between the left and right side of the chest. The chest is NOT TWO",
  "  PIECES JOINED IN THE MIDDLE — it is ONE PIECE.",
  "- ZERO printed text or letterforms. ZERO numerical markings.",
  "- ZERO decorative shading meant to suggest a chest plate or armor.",
  "- ZERO OCCLUSION OF THE CHEST. No hand, no finger, no arm, no forearm,",
  "  no elbow, no held object (key, tool, item, etc.), and no cast shadow",
  "  may cross IN FRONT OF, cover, overlap or hover over the pectoral panel",
  "  between the two armpits. The chest surface is entirely unobstructed",
  "  from armpit to armpit and from the collarbone down to the lower ribs.",
  "  If the robot is holding something, the hands and the object stay at",
  "  lower-abdomen / navel height or below — NEVER raised onto the chest.",
  "",
  "MENTAL MODEL — when generating this image, imagine an illustrator who",
  "drew the robot with a perfectly clean chest, then a brand designer who",
  "will later print a small logo there. If you draw ANYTHING on the chest,",
  "you are interfering with the brand designer's work. The chest is SACRED",
  "EMPTY SPACE reserved for a logo that will be added in a subsequent step.",
  "",
  "BACKGROUND:",
  "- A SINGLE FLAT SOLID COLOR (specified in the brand brief) filling the",
  "  entire frame, strictly uniform edge-to-edge.",
  "- ZERO halo, ZERO aura, ZERO radial glow, ZERO gradient, ZERO vignette,",
  "  ZERO atmospheric depth, ZERO texture, ZERO noise behind the robot.",
  "- The background pixels must all be EXACTLY THE SAME COLOR — no colour",
  "  drift, no subtle shading, no lighting falloff, no soft edge fade.",
  "  Imagine the robot stamped onto a perfectly flat coloured paper sheet.",
  "- Rationale (do not include in the image, just for the model's behaviour):",
  "  the background is flood-filled to alpha=0 in a post-processing step",
  "  so the robot can be placed on any page colour. Any halo, gradient or",
  "  glow would prevent that step from working cleanly.",
  "",
  "DEMEANOR (kept identical across all brand mascots):",
  "- ALWAYS friendly, warm, visibly trustworthy — a reassuring helper a",
  "  human would feel safe asking for guidance, whatever the brand's",
  "  sector. Kind eyes, gentle expression, relaxed open posture. No stern,",
  "  cold, intimidating or menacing variant exists.",
  "",
  "STYLE:",
  "- Clean modern flat 2D illustration with subtle cel shading.",
  "- NOT photorealistic, NOT 3D rendered, NOT industrial steampunk, NOT metallic photoreal.",
  "- Crisp clean vector-style lines, minimal visual noise, premium brand-mascot quality.",
].join("\n");

/**
 * Compose the full FLUX prompt: brand-specific visual brief
 * (editable by the operator in the UI) + the LOCKED composition
 * template + a final colour palette spec.
 *
 * The brand brief should describe the COMPANY + the desired robot
 * SHAPE (silhouette, proportions, mood, materials). The composition
 * template handles everything ELSE (framing, pose, lighting style,
 * 2D-illustration style, clean-chest constraint) and must NOT be
 * brand-customised — it's the contract that keeps the library
 * visually consistent.
 */
/**
 * Server-side cap on `params.prompt` for image generation (compute
 * proxy `aithos.compute_invoke_image`). Trying to send more raises
 * `-32602: params.prompt is too long (max 8000 chars)`.
 */
const IMAGE_PROMPT_MAX_CHARS = 8000;

export function composeFluxPrompt(brand: BrandProfile): string {
  const bgRgb = hexToRgb(brand.backgroundColor);
  const primaryRgb = hexToRgb(brand.primaryColor);

  // The composition template + color palette are the non-negotiable
  // visual instructions — they must reach the model verbatim or the
  // robot loses anatomy / chest centering. The visualBrief is
  // free-form descriptive prose: it's the only part we can compress
  // when the total bumps over the 8000-char server cap.
  const fixedTail = [
    COMPOSITION_TEMPLATE,
    "",
    "COLOR PALETTE:",
    `- Primary brand colour (eye glow + small accents): ${brand.primaryColor} rgb(${primaryRgb.r},${primaryRgb.g},${primaryRgb.b}).`,
    `- Background: ${brand.backgroundColor} rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}).`,
  ].join("\n");

  // Budget for the brief: total cap minus fixed tail minus 2 newlines
  // joining brief+tail, with a small margin so a stray newline edit
  // never pushes us back over.
  const briefBudget = IMAGE_PROMPT_MAX_CHARS - fixedTail.length - 4 /*"\n\n"*/ - 64;
  const briefRaw = brand.visualBrief.trim();
  const brief =
    briefRaw.length > briefBudget
      ? briefRaw.slice(0, Math.max(briefBudget - 1, 0)) + "…"
      : briefRaw;
  if (briefRaw.length > briefBudget) {
    console.warn(
      `[brand-agent] visualBrief truncated ${briefRaw.length} → ${brief.length} chars to fit the 8000-char image-prompt cap.`,
    );
  }

  return [brief, "", fixedTail].join("\n");
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
/*  Step 1.5 — Prepare robot bg (flood-fill the uniform bg to alpha=0)        */
/* -------------------------------------------------------------------------- */

/**
 * Mirror of `step3PrepareLogo` but for the robot itself.
 *
 * Image models don't reliably output an exact target hex for the
 * background — they drift toward more saturated / off-pitch colours
 * (we routinely see #e0e7f1 when asking for #f6f9fc). The v13
 * approach was to design a halo behind the head so the off-colour
 * background was visually intentional. v14 drops the halo (see
 * COMPOSITION_TEMPLATE) and instead flood-fills the uniform bg to
 * alpha=0, so the robot composites cleanly onto any page colour.
 *
 * Samples the average corner colour and flood-fills with the same
 * tolerance the legacy Step 2 internal silhouette extraction uses.
 * The tolerance is exposed so the operator can dial it up (more
 * aggressive — useful when the bg drifts into the body's shadow
 * range) or down (preserves more contour detail).
 */
export interface Step1_5Args {
  readonly rawCanvas: HTMLCanvasElement;
  /** Flood-fill tolerance in RGB distance. Default 38 (legacy Step 2 value). */
  readonly tolerance?: number;
}

export interface Step1_5Result {
  /** New canvas — same dimensions as input, with the bg flood-filled to alpha=0. */
  readonly processedCanvas: HTMLCanvasElement;
  readonly processedDataUri: string;
  /** Average corner colour used as the flood-fill reference (for trace). */
  readonly detectedCornerHex: string;
  /** Tolerance actually applied (so the UI can display it). */
  readonly tolerance: number;
}

export async function step1_5PrepareRobotBg(
  args: Step1_5Args,
): Promise<Step1_5Result> {
  const { rawCanvas } = args;
  const tolerance = args.tolerance ?? 38;
  const processedCanvas = document.createElement("canvas");
  processedCanvas.width = rawCanvas.width;
  processedCanvas.height = rawCanvas.height;
  const ctx = processedCanvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(rawCanvas, 0, 0);
  const detectedCornerHex = sampleCornerColor(processedCanvas);
  removeSolidBackground(processedCanvas, detectedCornerHex, tolerance);
  const processedDataUri = canvasToDataUri(processedCanvas);
  return { processedCanvas, processedDataUri, detectedCornerHex, tolerance };
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
  // Chest band — validation window for ALL detection strategies. Anything
  // landing OUTSIDE this band is rejected and the next fallback runs.
  //
  // We aim for the PLEXUS / UPPER-CHEST area, NOT the mid-torso. On a
  // bust crop the silhouette bbox spans head-to-bust-bottom; the plexus
  // sits at roughly 30-50% down that bbox (head ≈ 0-25%, neck ≈ 25-30%,
  // upper chest / plexus ≈ 30-55%, lower chest / abdomen ≈ 55-100%).
  //
  // Earlier values [0.45, 0.95] let the cascade place the logo in the
  // lower abdomen — visually too low for a brand emblem. Tightening to
  // [0.30, 0.60] forces every strategy to target the plexus region.
  const chestYMin = bbox.top + Math.floor(bbox.height * 0.30);
  const chestYMax = bbox.top + Math.floor(bbox.height * 0.60);
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
      // Target the upper chest / sternum area specifically. Asking for
      // "the torso" returned a polygon that spans armpit-to-navel, whose
      // bbox center lands on the abdomen — too low for a brand emblem.
      // The phrasing below biases Florence toward the upper half of the
      // torso (where a logo would actually be printed on a t-shirt).
      textInput:
        "the upper chest of the robot character — the area centred on the sternum and solar plexus, just below the collarbone and well above the navel, where a brand emblem would be printed on a t-shirt",
    });
    console.log(
      `[brand-agent] Florence-2 returned ${seg.polygons.length} polygon(s) in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    if (seg.polygons.length > 0 && seg.bbox) {
      florencePolygon = seg.polygons[0]!.points;
      const cx = Math.round((seg.bbox.left + seg.bbox.right) / 2);
      // Vertical bias — even with the upper-chest prompt, Florence
      // tends to return a polygon that includes the lower torso. Taking
      // the midpoint puts the logo on the abdomen. Biasing to the
      // upper third (~35% down from the polygon top) targets the plexus
      // region, which is what brand emblems actually look like on a
      // mascot's chest.
      const polyTop = seg.bbox.top;
      const polyBottom = seg.bbox.bottom;
      const cy = Math.round(polyTop + (polyBottom - polyTop) * 0.35);
      const w = seg.bbox.right - seg.bbox.left;
      const h = seg.bbox.bottom - seg.bbox.top;
      const diameter = Math.round(Math.min(w, h) * 0.5);
      torso = { centerX: cx, centerY: cy, diameter };
      torsoSource = "florence-2";
      console.log("[brand-agent] ✅ using florence-2", {
        torso,
        bbox: seg.bbox,
        cyBias: "polyTop + 0.35 × polyHeight (plexus-targeted)",
      });
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
          // Plexus heuristic: ~42% down the bbox lands on the upper
          // chest of a typical bust crop. Bumped up from 0.65 (which
          // was hitting the abdomen / lower torso).
          centerX: Math.round(bbox.left + bbox.width / 2),
          centerY: Math.round(bbox.top + bbox.height * 0.42),
          diameter: Math.round(bbox.width * 0.38),
        };
        torsoSource = "bbox-heuristic";
        console.log("[brand-agent] ⚠⚠ using bbox-42% LAST RESORT", torso);
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
  readonly sdk: AithosSDK;
  readonly brand: BrandProfile;
  /**
   * Force the lockup extractor to call Sonnet even when the
   * aspect-ratio gate would skip it. Default: false. Useful for
   * stacked lockups that happen to land in the square gate.
   */
  readonly forceLockupExtraction?: boolean;
}

export interface Step3LogoResult {
  /** Original logo as data URI (as fed by the operator / scraped). */
  readonly originalDataUri: string;
  /** Processed logo with guaranteed transparency. */
  readonly processedImg: HTMLImageElement;
  readonly processedDataUri: string;
  /** True if the corner-flood-fill removed a non-transparent background. */
  readonly bgWasRemoved: boolean;
  /** The detected corner colour (for trace). */
  readonly detectedCornerHex: string | null;
  /**
   * Result of the lockup-extraction sub-step. Surfaces the layout
   * Sonnet (or the gate) picked, the bbox when cropped, and the
   * credits spent — handy for the debug UI.
   */
  readonly extraction: LogoExtractResult;
}

export async function step3PrepareLogo(args: Step3LogoArgs): Promise<Step3LogoResult> {
  const { sdk, brand, forceLockupExtraction = false } = args;

  // Sub-step 3a — Lockup extraction. If the brand's logo is a graphic
  // mark + wordmark lockup (e.g., "<icon> WebGuard Agency"), crop it
  // to the mark alone before any background-removal work. Cheap
  // aspect-ratio gate skips Sonnet for square-ish logos.
  //
  // The extractor preserves the original logo's bg semantics — if the
  // input had transparency, the cropped output has transparency; if
  // the input had a solid bg colour, the extractor paints that colour
  // across the padding so the legacy corner-flood-fill below keeps
  // working unchanged.
  const extraction = await extractLogoSymbol({
    sdk,
    logoDataUri: brand.logoDataUri,
    force: forceLockupExtraction,
  });
  const sourceDataUri = extraction.dataUri;
  const originalImg = await loadImage(sourceDataUri);

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
      extraction,
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
    extraction,
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
  /**
   * Anything with a `processedImg` — accepts both `Step3LogoResult`
   * (transparent original logo) and `Step3_5RecolorResult` (silhouette
   * in brand colour). The v13 pipeline passes the recoloured version.
   */
  readonly logo: { readonly processedImg: HTMLImageElement };
  readonly settings: Step4Settings;
  /**
   * v14 — when Step 1.5 has run, the operator can pass its
   * transparent-bg canvas here so the final composite no longer
   * carries the original solid background. When omitted, falls back
   * to `robot.rawCanvas` (legacy v13 behaviour with the coloured bg
   * + halo intact).
   */
  readonly robotCanvasOverride?: HTMLCanvasElement;
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
  // v14 — composite onto the transparent-bg canvas if Step 1.5 ran;
  // otherwise fall back to the raw canvas (legacy v13 behaviour: keeps
  // the coloured background + halo). The override lets the operator
  // ship a robot that floats on any page colour without bg matching.
  const baseCanvas = args.robotCanvasOverride ?? robot.rawCanvas;
  const canvas = compositeLogoOnRobot(
    baseCanvas,
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
