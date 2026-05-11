// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Branded-robot agent — end-to-end pipeline from BrandProfile to PNG.
//
// This module is the "agent" in the brand-mascot-generator sense: given
// a brand brief, it produces a finished branded mascot image with no
// further human input. The pipeline is hardcoded; the agent's
// "intelligence" lies entirely in the prompt composition step (which
// will eventually be supplemented by a Claude pass to refine wording
// from a free-form brief, but for now a deterministic template suffices).
//
// Steps:
//   1. composeFluxPrompt(brand) — assembles the FLUX prompt
//   2. sdk.compute.invokeImage — generates the raw robot
//   3. removeSolidBackground — flood-fill the FLUX background to alpha=0
//   4. detectSilhouetteBox + estimateTorsoCenter — find chest position
//   5. compositeLogoOnRobot — blend the logo using "multiply" / "screen"
//   6. canvasToBlob — final PNG export

import type { AithosSDK } from "@aithos/sdk";

import type { BrandProfile, BrandedRobotResult } from "./brand-types.js";
import {
  blobToDataUri,
  canvasToBlob,
  compositeLogoOnRobot,
  detectSilhouetteBox,
  estimateTorsoCenter,
  hexToRgb,
  imageToCanvas,
  loadImage,
  removeSolidBackground,
} from "./image-pipeline.js";

/* -------------------------------------------------------------------------- */
/*  Prompt composition                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Turn a brand profile into a FLUX prompt biased towards:
 *   - Clean cartoon-mascot style (so the logo can land on a flat
 *     chest later — photoreal robots have too much detail/glare).
 *   - Solid uniform background = the brand's chosen colour, so the
 *     client-side flood-fill removes it cleanly to transparency.
 *   - NO chest emblem / disc / badge — the prompt explicitly forbids
 *     them. We composite the logo afterwards instead.
 */
export function composeFluxPrompt(brand: BrandProfile): string {
  const keywords = brand.styleKeywords.join(", ");
  const bgRgb = hexToRgb(brand.backgroundColor);
  return [
    "A friendly minimal robot character mascot,",
    "upper body portrait,",
    "simple flat modern cartoon style,",
    "looking straight forward,",
    `body in ${brand.primaryColor} tones with ${brand.secondaryColor} accents,`,
    `${keywords} feel,`,
    brand.visualBrief,
    `on a flat pure solid uniform ${brand.backgroundColor} background color rgb(${bgRgb.r},${bgRgb.g},${bgRgb.b}),`,
    "no other elements,",
    "no logos, no text, no symbols,",
    "no chest emblem, no badge, no circle on the torso, no disc, no medallion,",
    "smooth uniform background, sharp clean silhouette edges",
  ].join(" ");
}

/* -------------------------------------------------------------------------- */
/*  Blend-mode choice                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Pick `multiply` for light-bodied robots, `screen` for dark-bodied
 * robots. Heuristic based on the brand's primary colour luminance:
 * if the primary is light (>50% luma) the robot body will be light
 * and `multiply` makes the logo darks pop.
 */
function pickBlendMode(brand: BrandProfile): "multiply" | "screen" {
  const { r, g, b } = hexToRgb(brand.primaryColor);
  // BT.709 luma
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma < 0.5 ? "screen" : "multiply";
}

/* -------------------------------------------------------------------------- */
/*  Logo bg auto-transparency                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Force-transparent a logo whose corners are solid colour. SVG +
 * already-alpha PNG bypass this step (logoHasAlpha=true).
 *
 * The corner-sampling heuristic: pick the average of the 4 corner
 * pixels and flood-fill from those. Same algorithm as the robot
 * background remover, just driven by the logo's actual corner colour
 * rather than a declared hex.
 */
async function ensureLogoTransparent(
  brand: BrandProfile,
): Promise<HTMLImageElement> {
  const img = await loadImage(brand.logoDataUri);
  if (brand.logoHasAlpha) return img;
  // No declared alpha → run corner-sampled bg removal
  const canvas = imageToCanvas(img);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  // Sample one corner (skip 2px to avoid potential aliasing) — for the
  // logos we care about (clean SVGs and flat PNGs), the four corners
  // are the same colour. We pick top-left arbitrarily.
  const px = ctx.getImageData(2, 2, 1, 1).data;
  const cornerHex = `#${[px[0], px[1], px[2]]
    .map((v) => v!.toString(16).padStart(2, "0"))
    .join("")}`;
  removeSolidBackground(canvas, cornerHex, 48);
  // Convert canvas back to an HTMLImageElement so the downstream
  // composite function (which takes Image) can drawImage it cleanly.
  const blob = await canvasToBlob(canvas);
  return await loadImage(blob);
}

/* -------------------------------------------------------------------------- */
/*  Main orchestrator                                                         */
/* -------------------------------------------------------------------------- */

export interface GenerateBrandedRobotDeps {
  /** Aithos SDK instance (for the compute.invokeImage call). */
  readonly sdk: AithosSDK;
  /**
   * Image model id. Default `image:flux-pro-1.1` — keeps the cost
   * predictable. The agent could escalate to `flux-pro-1.1-ultra`
   * for premium-tier customers in a future iteration.
   */
  readonly model?: "image:flux-schnell" | "image:flux-dev" | "image:flux-pro-1.1" | "image:flux-pro-1.1-ultra";
  /** Optional progress callback (UI hook). */
  readonly onProgress?: (phase: AgentPhase, detail?: string) => void;
}

export type AgentPhase =
  | "composing-prompt"
  | "calling-flux"
  | "removing-bg"
  | "detecting-torso"
  | "preparing-logo"
  | "compositing"
  | "encoding"
  | "done";

export async function generateBrandedRobot(
  brand: BrandProfile,
  deps: GenerateBrandedRobotDeps,
): Promise<BrandedRobotResult> {
  const { sdk, onProgress } = deps;
  const model = deps.model ?? "image:flux-pro-1.1";
  const tick = (phase: AgentPhase, detail?: string): void => onProgress?.(phase, detail);

  // 1. Prompt
  tick("composing-prompt");
  const prompt = composeFluxPrompt(brand);

  // 2. FLUX
  tick("calling-flux", `model=${model}`);
  const r = await sdk.compute.invokeImage({
    model,
    prompt,
    aspectRatio: "1:1",
    numberOfImages: 1,
    ...(brand.seed !== undefined ? { seed: brand.seed } : {}),
  });
  if (r.images.length === 0) {
    throw new Error("FLUX returned no images");
  }
  const rawImg = r.images[0]!;
  // Decode base64 → Blob → HTMLImageElement
  const rawBlob = base64ToBlob(rawImg.base64, rawImg.contentType);
  const rawImgEl = await loadImage(rawBlob);

  // 3. BG removal
  tick("removing-bg", brand.backgroundColor);
  const robotCanvas = imageToCanvas(rawImgEl);
  removeSolidBackground(robotCanvas, brand.backgroundColor, 38);

  // 4. Torso detection
  tick("detecting-torso");
  const bbox = detectSilhouetteBox(robotCanvas);
  const torso = estimateTorsoCenter(bbox, 0.58);

  // 5. Logo prep
  tick("preparing-logo");
  const logoImg = await ensureLogoTransparent(brand);

  // 6. Composite
  tick("compositing");
  const blendMode = pickBlendMode(brand);
  const finalCanvas = compositeLogoOnRobot(robotCanvas, logoImg, torso, {
    blendMode,
    opacity: 0.92,
    fillRatio: 0.88,
    shadowBlur: 8,
    shadowColor: "rgba(0,0,0,0.20)",
  });

  // 7. Encode
  tick("encoding");
  const resultBlob = await canvasToBlob(finalCanvas);
  const resultDataUri = await blobToDataUri(resultBlob);

  tick("done");
  return {
    resultBlob,
    resultDataUri,
    rawRobotBlob: rawBlob,
    prompt,
    creditsSpent: r.creditsCharged,
    torso,
  };
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
