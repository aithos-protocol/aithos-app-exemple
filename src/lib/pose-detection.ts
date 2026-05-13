// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Pose-landmark-based torso detection for the branded-robot agent.
//
// Why MediaPipe Pose vs the pixel-colour approach:
// - The colour-match strategy required the FLUX prompt to paint a
//   distinctly-coloured chest panel ("plaque"), which the user wants
//   to drop (too structural / industrial). Without a colour cue, the
//   pixel detector has no signal.
// - Pose detection uses ANATOMY: it knows where shoulders and hips
//   are even on a perfectly uniform body. Works on stylized humanoid
//   robots because they share human silhouette structure.
//
// Runtime: MediaPipe Tasks Vision (WASM). The model (~3MB) is
// fetched once from Google's CDN, cached in the browser. First
// detection takes ~1-2s (model warmup); subsequent calls are ~50ms.
//
// Landmark indices used (per MediaPipe Pose Landmarker spec):
//   11 = LEFT_SHOULDER         12 = RIGHT_SHOULDER
//   23 = LEFT_HIP              24 = RIGHT_HIP
//
// Bust-portrait crops (head + chest only) usually have hips
// CROPPED OUT of the frame — landmarks 23/24 then have low
// visibility scores. We detect that case and estimate the torso
// centre from shoulders alone, projecting downward by a fixed
// fraction of shoulder width (human anatomical proportion).

import {
  FilesetResolver,
  PoseLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";

/* -------------------------------------------------------------------------- */
/*  Singleton — load the model once per session                               */
/* -------------------------------------------------------------------------- */

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/**
 * Lazily construct the PoseLandmarker. The first caller pays the
 * model-fetch cost (~1-2s on warm CDN); subsequent callers share
 * the same instance via the cached promise.
 */
async function getLandmarker(): Promise<PoseLandmarker> {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    console.log("[pose] loading MediaPipe Pose Landmarker (lite, ~3MB)…");
    const t0 = performance.now();
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm",
    );
    const lm = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numPoses: 1,
      minPoseDetectionConfidence: 0.3,
      minPosePresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
    console.log(
      `[pose] MediaPipe loaded in ${(performance.now() - t0).toFixed(0)}ms`,
    );
    return lm;
  })();
  return landmarkerPromise;
}

/* -------------------------------------------------------------------------- */
/*  Detection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Subset of MediaPipe's 33 landmarks we care about for torso
 * detection. Keeping the full list (`allLandmarks`) in the return
 * value so the debug overlay can draw the whole skeleton.
 */
export interface PoseTorsoResult {
  readonly centerX: number;
  readonly centerY: number;
  readonly diameter: number;
  /** Shoulder-to-shoulder distance in pixels (the canonical scale). */
  readonly shoulderWidth: number;
  /** True when MediaPipe returned high-confidence hip landmarks. */
  readonly hipsVisible: boolean;
  /** Raw landmarks for the debug overlay (33 points in canvas-pixel coords). */
  readonly landmarksPx: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly visibility: number;
  }>;
}

/**
 * Run MediaPipe Pose on an image/canvas and return the torso centre.
 * Returns `null` if no pose was detected or if the shoulders are
 * below the confidence threshold (in which case callers should fall
 * back to the geometric heuristics).
 */
export async function detectTorsoByPose(
  source: HTMLImageElement | HTMLCanvasElement,
): Promise<PoseTorsoResult | null> {
  const lm = await getLandmarker();
  const t0 = performance.now();
  const result = lm.detect(source);
  const detectMs = (performance.now() - t0).toFixed(0);

  if (!result.landmarks || result.landmarks.length === 0) {
    console.warn(
      `[pose] MediaPipe returned NO poses (${detectMs}ms). Image likely too stylized / non-humanoid for the model.`,
    );
    return null;
  }
  const pose = result.landmarks[0]!;
  console.log(
    `[pose] MediaPipe found ${result.landmarks.length} pose(s), ${pose.length} landmarks (${detectMs}ms)`,
  );
  if (pose.length < 25) {
    console.warn(`[pose] only ${pose.length} landmarks — need ≥25 (shoulders+hips)`);
    return null;
  }

  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;

  // Pixelise the whole skeleton (caller uses this for the overlay).
  const landmarksPx = pose.map((lm) => ({
    x: Math.round(lm.x * w),
    y: Math.round(lm.y * h),
    visibility: lm.visibility ?? 0,
  }));

  const ls = landmarksPx[11]!; // left shoulder
  const rs = landmarksPx[12]!; // right shoulder
  const lh = landmarksPx[23]!; // left hip
  const rh = landmarksPx[24]!; // right hip

  // Surface every key landmark so we can see in DevTools what
  // MediaPipe actually thinks it found. Visibility ranges 0..1 —
  // anything under 0.5 is unreliable; under 0.3 is essentially
  // "the model is guessing".
  console.log("[pose] key landmarks:", {
    nose: landmarksPx[0],
    leftShoulder: ls,
    rightShoulder: rs,
    leftElbow: landmarksPx[13],
    rightElbow: landmarksPx[14],
    leftHip: lh,
    rightHip: rh,
    imageSize: { w, h },
  });

  // Shoulders MUST be confidently detected — they're the anchor.
  const minShoulderVis = 0.5;
  if (ls.visibility < minShoulderVis && rs.visibility < minShoulderVis) {
    console.warn(
      `[pose] shoulders below confidence threshold (left=${ls.visibility.toFixed(2)}, right=${rs.visibility.toFixed(2)}, need ≥${minShoulderVis}). Discarding pose.`,
    );
    return null;
  }

  const shoulderMidX = (ls.x + rs.x) / 2;
  const shoulderMidY = (ls.y + rs.y) / 2;
  const shoulderWidth = Math.hypot(ls.x - rs.x, ls.y - rs.y);

  // Target = the PLEXUS / upper chest, not the geometric mid-torso.
  // For a brand emblem we want the disc to sit right under the
  // pectoral line, where a t-shirt logo would be printed. That's
  // roughly 30-35% of the way down from the shoulder line toward the
  // hips (i.e. close to the shoulders, NOT halfway to the hips).
  const SHOULDER_TO_PLEXUS_RATIO = 0.30;
  const hipsVisible = lh.visibility > 0.5 && rh.visibility > 0.5;
  let torsoCenterX: number;
  let torsoCenterY: number;
  if (hipsVisible) {
    const hipMidX = (lh.x + rh.x) / 2;
    const hipMidY = (lh.y + rh.y) / 2;
    // Mostly-shoulder-weighted blend instead of the symmetric midpoint
    // — earlier code used (shoulders+hips)/2 which sat on the navel.
    torsoCenterX =
      shoulderMidX * (1 - SHOULDER_TO_PLEXUS_RATIO) + hipMidX * SHOULDER_TO_PLEXUS_RATIO;
    torsoCenterY =
      shoulderMidY * (1 - SHOULDER_TO_PLEXUS_RATIO) + hipMidY * SHOULDER_TO_PLEXUS_RATIO;
    console.log(
      `[pose] hips visible → shoulder-biased blend (${(1 - SHOULDER_TO_PLEXUS_RATIO).toFixed(2)}×shoulders + ${SHOULDER_TO_PLEXUS_RATIO.toFixed(2)}×hips): ` +
        `(${torsoCenterX.toFixed(0)}, ${torsoCenterY.toFixed(0)})`,
    );
  } else {
    // Anatomical estimation when hips are cropped out.
    // Ratio dropped from 0.6 (mid-torso) to ~0.3 (plexus level).
    torsoCenterX = shoulderMidX;
    torsoCenterY = shoulderMidY + shoulderWidth * SHOULDER_TO_PLEXUS_RATIO;
    console.log(
      `[pose] hips cropped/invisible → shoulder midpoint + ${SHOULDER_TO_PLEXUS_RATIO}×shoulderWidth (plexus): ` +
        `shoulderMid=(${shoulderMidX.toFixed(0)},${shoulderMidY.toFixed(0)}), ` +
        `width=${shoulderWidth.toFixed(0)}, ` +
        `anatomical offset=${(shoulderWidth * SHOULDER_TO_PLEXUS_RATIO).toFixed(0)}, ` +
        `final torsoY=${torsoCenterY.toFixed(0)}`,
    );
  }

  const diameter = Math.round(shoulderWidth * 0.35);
  const result_ = {
    centerX: Math.round(torsoCenterX),
    centerY: Math.round(torsoCenterY),
    diameter,
    shoulderWidth: Math.round(shoulderWidth),
    hipsVisible,
    landmarksPx,
  };
  console.log("[pose] returning torso:", {
    center: `(${result_.centerX}, ${result_.centerY})`,
    diameter: result_.diameter,
    shoulderWidth: result_.shoulderWidth,
    hipsVisible: result_.hipsVisible,
  });
  return result_;
}

/* -------------------------------------------------------------------------- */
/*  Debug overlay — draw the full skeleton for visual sanity-check            */
/* -------------------------------------------------------------------------- */

/**
 * Pose Landmarker's official skeleton connections. Used to render
 * the bone graph in the debug overlay so the user can see WHY the
 * agent placed the logo where it did.
 */
const POSE_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  // Face contour — keep light, just the outline
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  // Shoulders
  [11, 12],
  // Arms
  [11, 13], [13, 15], [12, 14], [14, 16],
  // Torso
  [11, 23], [12, 24], [23, 24],
  // Legs (drawn but usually cropped in bust portrait)
  [23, 25], [25, 27], [24, 26], [26, 28],
];

/**
 * Render an overlay showing the pose skeleton on top of a source
 * image, plus the chosen torso target. Caller composites this on
 * top of the raw FLUX output for the operator's eyeball test.
 */
export function renderPoseOverlay(
  source: HTMLCanvasElement,
  torso: PoseTorsoResult,
  options: { readonly logoTarget?: { readonly centerX: number; readonly centerY: number; readonly diameter: number } } = {},
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // Source first
  ctx.drawImage(source, 0, 0);

  const lms = torso.landmarksPx;

  // Bones (semi-transparent cyan)
  ctx.strokeStyle = "rgba(0, 220, 255, 0.7)";
  ctx.lineWidth = 4;
  for (const [a, b] of POSE_CONNECTIONS) {
    const pa = lms[a];
    const pb = lms[b];
    if (!pa || !pb) continue;
    if (pa.visibility < 0.3 || pb.visibility < 0.3) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // Joints (yellow dots, scaled by visibility)
  for (let i = 0; i < lms.length; i++) {
    const lm = lms[i]!;
    if (lm.visibility < 0.3) continue;
    ctx.fillStyle = "rgba(255, 220, 0, 0.95)";
    ctx.beginPath();
    ctx.arc(lm.x, lm.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // Highlight shoulders + hips in green (the torso-defining landmarks)
  for (const i of [11, 12, 23, 24] as const) {
    const lm = lms[i]!;
    if (lm.visibility < 0.3) continue;
    ctx.strokeStyle = "rgba(0, 255, 0, 1)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(lm.x, lm.y, 12, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Logo target (red crosshair + circle) — what the agent chose
  const target = options.logoTarget ?? torso;
  ctx.strokeStyle = "rgba(255, 50, 50, 1)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(target.centerX, target.centerY, target.diameter / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  const half = target.diameter / 2 + 24;
  ctx.moveTo(target.centerX - half, target.centerY);
  ctx.lineTo(target.centerX + half, target.centerY);
  ctx.moveTo(target.centerX, target.centerY - half);
  ctx.lineTo(target.centerX, target.centerY + half);
  ctx.stroke();

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Re-export the landmark type for callers that want to type their own loops */
/* -------------------------------------------------------------------------- */
export type { NormalizedLandmark };
