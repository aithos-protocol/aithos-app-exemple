// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

/**
 * Brand-agent type contracts.
 *
 * This module is intentionally provider-agnostic: the same BrandProfile
 * could feed a FLUX-Pro pipeline (current), a hypothetical Nova Canvas
 * v2 pipeline (future), or a hybrid 3D-render+overlay pipeline. The
 * agent's input/output contract doesn't change.
 */

/** Hex colour string like `#3E2723`. */
export type HexColor = `#${string}`;

export interface BrandProfile {
  /** Display name. Used in audit / UI only, not in the FLUX prompt. */
  readonly name: string;
  /** One-sentence service description (e.g. "Specialty coffee subscription"). */
  readonly service: string;
  /**
   * Two-to-five-sentence brief of the brand's visual + emotional
   * identity. Goes straight into the FLUX prompt — the more vivid the
   * better. Avoid jargon, prefer mood words ("cozy", "premium",
   * "artisanal", "playful", "minimal").
   */
  readonly visualBrief: string;
  /** Style keywords (used as prompt amplifiers). */
  readonly styleKeywords: readonly string[];
  /** Primary brand colour (the dominant body / accent colour). */
  readonly primaryColor: HexColor;
  /** Secondary brand colour. */
  readonly secondaryColor: HexColor;
  /**
   * Solid background colour the FLUX prompt should produce. Used both
   * in the prompt ("on a flat pure solid <bg> background") AND as the
   * removal target for the client-side flood-fill. Pick a clean,
   * uniform colour with no gradient or texture (e.g. the website's
   * primary background hex).
   */
  readonly backgroundColor: HexColor;
  /** Optional FLUX seed for reproducibility. Omit for fresh each call. */
  readonly seed?: number;
  /** Logo as a data URI (PNG / SVG). The agent reads it client-side. */
  readonly logoDataUri: string;
  /**
   * Hint: does the logo already have a transparent background? When
   * false, the agent runs a flood-fill on the logo's corners. When
   * true (e.g. SVG, or PNG with proper alpha), the agent passes the
   * logo through unchanged.
   */
  readonly logoHasAlpha: boolean;
}

export interface BrandedRobotResult {
  /** PNG blob with the final composited image (transparent background). */
  readonly resultBlob: Blob;
  /** Same payload as a data URI for easy preview. */
  readonly resultDataUri: string;
  /** PNG blob of the raw FLUX output, kept for debugging / re-rolls. */
  readonly rawRobotBlob: Blob;
  /** The exact prompt the agent fed to FLUX. */
  readonly prompt: string;
  /** Microcredits the agent spent (FLUX call + future ops). */
  readonly creditsSpent: number;
  /** Detected torso geometry (center + diameter) in raw-robot pixels. */
  readonly torso: {
    readonly centerX: number;
    readonly centerY: number;
    readonly diameter: number;
  };
}
