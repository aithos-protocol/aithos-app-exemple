// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Description → robot-design proposal.
//
// Given a free-text description of a website or business, ask Claude
// Opus 4.7 (text mode) to act as a brand-mascot art director and propose
// a robot design that respects a fixed BUST framing spec:
//
//   - a paragraph-length `visualBrief` describing the robot's
//     appearance (silhouette, materials, mood, accents) PLUS the
//     pose-specific framing details (how the bust terminates, what
//     the arms are doing) — the visualBrief is now FRAMING-AWARE.
//   - a tight 3-colour palette: primary, secondary, background. Hex.
//
// Absolute composition rules (square 1:1, halo, lighting style, 2D
// illustration style, chest cleanliness) still live in the locked
// COMPOSITION_TEMPLATE in brand-agent.ts; the design-agent must not
// touch those. The FRAMING_GUIDE below is the design-agent's slice
// of framing knowledge — the parts that VARY with the design (bust
// termination shape, arm choice + arm action).
//
// Model: claude-opus-4-7 (best reasoning, single shot, no streaming).

import type { AithosSDK } from "@aithos/sdk";

import type { HexColor } from "./brand-types.js";

export interface DesignProposal {
  readonly visualBrief: string;
  readonly primaryColor: HexColor;
  readonly secondaryColor: HexColor;
  readonly backgroundColor: HexColor;
  readonly reasoning: string;
  /** Raw assistant content (for debugging). */
  readonly rawContent: string;
  /** Microcredits spent on the call. */
  readonly creditsSpent: number;
}

/**
 * Static framing brief — pose / bust / arms rules that ALL robot
 * designs must respect, regardless of brand. Exposed so the operator
 * can see what the design-agent is being told.
 *
 * Goal: produce a consistent visual library where every brand-mascot
 * looks like the same SCULPTED BUST CONVENTION — head, neck, shoulders,
 * and the entire torso are visible inside the frame, and the bust ends
 * in a clean lower boundary (a sculpted base, a flat cut, a tapered
 * terminal). The bust is NOT cropped by the image edge. No lower body
 * shows beneath the bust.
 *
 * Arms get two acceptable poses: visible-and-busy (Option A) or
 * cropped at the forearm (Option B).
 */
export const FRAMING_GUIDE = [
  "BUST FRAMING — every robot you design MUST be compatible with this.",
  "",
  "1) The image shows the robot as a COMPLETE BUST: head + neck + shoulders",
  "   + entire upper-body torso are ALL VISIBLE inside the frame.",
  "",
  "2) The bust ends in a CLEAN LOWER BOUNDARY — a sculpted base, a flat",
  "   cut, a tapered terminal, an elegant termination of the torso. The",
  "   bust is NOT cut off by the bottom edge of the image; the entire bust",
  "   is visible.",
  "",
  "3) The bust is DETACHED from any lower body — no waist, no hips, no",
  "   legs, no abdomen extending below the bust. The bust is the lowest",
  "   part of the body shown. Think Greek sculpture bust, action-figure",
  "   torso, half-body avatar — never a torso flowing into a hidden lower",
  "   body cut by the frame.",
  "",
  "4) ARMS — choose exactly ONE of these two poses, then describe it in",
  "   the visualBrief:",
  "",
  "   • Option A (arms-in-action): both arms FULLY VISIBLE inside the",
  "     frame, the robot is performing a small CONTAINED ACTION relevant",
  "     to the brand — holding a tool, presenting a product, gesturing,",
  "     pointing, manipulating something tied to the trade. Hands and",
  "     forearms must stay inside the frame; the action fits the frame",
  "     comfortably with no extension beyond the bust silhouette.",
  "",
  "   • Option B (arms-cut): arms cut at the FOREARM — upper arms and",
  "     elbows are visible, lower forearms and hands exit the frame",
  "     cleanly. This is the safer default when no action springs to",
  "     mind from the brand or when the trade has no obvious prop.",
  "",
  "5) The visualBrief MUST describe BOTH the bust termination (what the",
  "   lower boundary of the bust looks like) AND the arm choice (A or B),",
  "   AND if Option A, the specific small action / object the arms hold.",
  "   These framing elements MUST harmonise with the brand mood and the",
  "   robot's materials.",
  "",
  "6) Vocabulary scope — in the visualBrief, you are ALLOWED to mention:",
  "   the bust, the lower termination of the bust, the shoulders, the",
  "   arms, the forearms, the hands, the action / object being held.",
  "   You are NOT allowed to mention: 'crop', 'frame', 'image edge',",
  "   'square', '1:1', 'portrait', 'centred', 'facing camera', 'halo',",
  "   'lighting', 'background gradient'. Those global concepts are owned",
  "   by a separate composition template appended downstream.",
].join("\n");

const SYSTEM_PROMPT = [
  "You are a brand-mascot art director.",
  "",
  "Given a free-text description of a website, product, or business,",
  "you propose:",
  "  1. A robot mascot DESIGN — silhouette, proportions, materials,",
  "     colour scheme, mood — that visually represents the brand's",
  "     category, audience, and tone, AND that respects the BUST",
  "     FRAMING brief below.",
  "  2. A tight 3-colour palette (primary, secondary, background)",
  "     drawn from typical conventions of that brand category.",
  "",
  "=============================================================",
  FRAMING_GUIDE,
  "=============================================================",
  "",
  "STRICT RULES on the `visualBrief` you produce:",
  "- Write it as ONE paragraph, 6-10 sentences.",
  "- Describe the robot's APPEARANCE: silhouette (chunky, sleek, rounded,",
  "  angular, humanoid, more abstract), proportions (head/body ratio,",
  "  limb thickness), surface materials (matte plastic, brushed metal,",
  "  ceramic, fabric — pick what fits the brand mood), main body colour",
  "  notes, eye colour and shape.",
  "- Describe the BUST TERMINATION explicitly — what does the lower",
  "  boundary of the bust look like? (e.g. 'the bust ends in a smooth",
  "  rounded base', 'the torso tapers into a polished metal stand', 'the",
  "  bust closes off with a clean horizontal cut at the lower ribs').",
  "- Describe the ARM POSE explicitly — state which option you chose",
  "  ('arms-in-action' or 'arms-cut') and, if arms-in-action, what the",
  "  arms / hands are doing and what they hold or present.",
  "- CHEST IS OFF-LIMITS: the visualBrief MUST NOT mention the chest,",
  "  sternum, pectoral, breastplate, chest plate, chest panel, chest",
  "  emblem, chest icon, breast pocket, badge on the chest, armor plate,",
  "  or anything that lives in the chest area. A brand logo will be",
  "  composited there in a later step; any description of the chest in",
  "  the visualBrief WILL cause the image model to draw something there,",
  "  which RUINS the final composite. The chest is SACRED EMPTY SPACE.",
  "  If you absolutely need to refer to the torso, the ONLY allowed",
  "  phrasing is 'clean uniform torso surface' or equivalent.",
  "- DO NOT include the global framing words listed in section 6 of the",
  "  FRAMING brief above. Those belong to the composition template.",
  "- Match the MOOD to the brand: playful for kids' products, serious",
  "  for B2B / professional services, rugged for industrial, polished",
  "  for luxury, etc.",
  "",
  "STRICT RULES on the palette:",
  "- All three values must be `#rrggbb` (lowercase hex, 6 chars).",
  "- primaryColor: the brand's dominant colour — used for the robot's",
  "  body or main accent.",
  "- secondaryColor: a complementary accent — used for eye glow, joints,",
  "  small details. Must visibly contrast with primary.",
  "- backgroundColor: a clean flat colour the robot stands against.",
  "  Pick something that holds the robot's silhouette clearly (good",
  "  contrast with primary) — typically a neutral or soft tinted tone.",
  "- All three must work together aesthetically: think of a designer",
  "  picking a brand palette, not a random colour wheel sample.",
  "",
  "OUTPUT FORMAT — output ONLY this JSON, no markdown fences, no",
  "commentary before or after:",
  "",
  "{",
  '  "visualBrief": "<paragraph>",',
  '  "primaryColor": "#rrggbb",',
  '  "secondaryColor": "#rrggbb",',
  '  "backgroundColor": "#rrggbb",',
  '  "reasoning": "<2-3 sentences: the robot you chose and why, the bust termination + arm option you picked, and the palette logic>"',
  "}",
].join("\n");

const USER_PROMPT_PREFIX =
  "Here is the description of the website / product / business. Read it carefully, then output the JSON design proposal.\n\nDESCRIPTION:\n\n";

/**
 * Call Sonnet (text mode) to propose a robot-mascot design from a
 * free-text description. Returns the parsed proposal, or throws with a
 * clear error for the caller to surface.
 */
export async function designRobotFromDescription(
  sdk: AithosSDK,
  description: string,
): Promise<DesignProposal> {
  if (description.trim().length < 10) {
    throw new Error("description is too short — please write at least one sentence about the brand");
  }

  console.log("[design-agent] calling Opus 4.7 (text)…");
  const t0 = performance.now();
  // Cast: claude-opus-4-7 landed in @aithos/sdk alpha.18; the installed
  // version may be older. The server-side allowlist is what matters
  // for security.
  const r = await sdk.compute.invokeBedrock({
    model: "claude-opus-4-7" as "claude-sonnet-4-6",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT_PREFIX + description.trim() }],
    maxTokens: 1600,
  });
  console.log(
    `[design-agent] Opus returned in ${(performance.now() - t0).toFixed(0)}ms, credits=${r.creditsCharged}`,
  );
  console.log("[design-agent] raw content:", r.content);

  const parsed = parseDesignJson(r.content);
  return {
    visualBrief: parsed.visualBrief,
    primaryColor: parsed.primaryColor,
    secondaryColor: parsed.secondaryColor,
    backgroundColor: parsed.backgroundColor,
    reasoning: parsed.reasoning,
    rawContent: r.content,
    creditsSpent: r.creditsCharged,
  };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function parseDesignJson(content: string): {
  visualBrief: string;
  primaryColor: HexColor;
  secondaryColor: HexColor;
  backgroundColor: HexColor;
  reasoning: string;
} {
  // Strip ```json ... ``` fences if any
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  // Find the first balanced top-level { ... }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Sonnet returned non-JSON content (first 200 chars): ${content.slice(0, 200)}`,
    );
  }
  const json = text.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `Sonnet returned malformed JSON: ${(e as Error).message}. Content: ${json.slice(0, 200)}`,
    );
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("Sonnet JSON is not an object");
  }
  const r = obj as Record<string, unknown>;

  if (typeof r.visualBrief !== "string" || r.visualBrief.trim().length === 0) {
    throw new Error("Sonnet JSON: visualBrief missing or empty");
  }
  for (const key of ["primaryColor", "secondaryColor", "backgroundColor"] as const) {
    const v = r[key];
    if (typeof v !== "string" || !HEX_RE.test(v)) {
      throw new Error(
        `Sonnet JSON: ${key} missing or not a valid #rrggbb hex (got ${JSON.stringify(v)})`,
      );
    }
  }
  return {
    visualBrief: r.visualBrief.trim(),
    primaryColor: (r.primaryColor as string).toLowerCase() as HexColor,
    secondaryColor: (r.secondaryColor as string).toLowerCase() as HexColor,
    backgroundColor: (r.backgroundColor as string).toLowerCase() as HexColor,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
  };
}
