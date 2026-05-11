// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Description → robot-design proposal.
//
// Given a free-text description of a website or business, ask Claude
// Sonnet (text mode) to act as a brand-mascot art director and propose
// a robot design:
//
//   - a paragraph-length `visualBrief` describing ONLY the robot's
//     appearance (silhouette, materials, mood, accents) — never
//     framing, never composition, since those are owned by the
//     downstream COMPOSITION_TEMPLATE that gets appended in brand-agent.
//   - a tight 3-colour palette: primary, secondary, background. Hex.
//
// The output JSON feeds directly into the existing image-generation
// pipeline. The operator can edit any field before sending to FLUX.

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

const SYSTEM_PROMPT = [
  "You are a brand-mascot art director.",
  "",
  "Given a free-text description of a website, product, or business,",
  "you propose:",
  "  1. A robot mascot DESIGN — silhouette, proportions, materials,",
  "     colour scheme, mood — that visually represents the brand's",
  "     category, audience, and tone.",
  "  2. A tight 3-colour palette (primary, secondary, background)",
  "     drawn from typical conventions of that brand category.",
  "",
  "STRICT RULES on the `visualBrief` you produce:",
  "- Write it as ONE paragraph, 4-8 sentences.",
  "- Describe ONLY the robot's APPEARANCE: silhouette (chunky, sleek,",
  "  rounded, angular, humanoid, more abstract), proportions (head/body",
  "  ratio, limb thickness), surface materials (matte plastic, brushed",
  "  metal, ceramic, fabric — pick what fits the brand mood), main body",
  "  colour notes, eye colour and shape, any small ACCENT element the",
  "  robot might wear or hold that hints at the trade (a chef's whisk,",
  "  a wrench, a stethoscope, etc. — keep it tiny and OFF the chest).",
  "- CHEST IS OFF-LIMITS: the visualBrief MUST NOT mention the chest,",
  "  sternum, pectoral, breastplate, chest plate, chest panel, chest",
  "  emblem, chest icon, breast pocket, badge on the chest, armor plate,",
  "  or anything that lives in the chest area. A brand logo will be",
  "  composited there in a later step; any description of the chest in",
  "  the visualBrief WILL cause the image model to draw something there,",
  "  which RUINS the final composite. The chest is SACRED EMPTY SPACE.",
  "  If you absolutely need to refer to the torso, the ONLY allowed",
  "  phrasing is 'clean uniform torso surface' or equivalent.",
  "- DO NOT include framing or composition instructions. Forbidden",
  "  words/concepts in the visualBrief: 'centred', 'centered', 'facing",
  "  the camera', 'square', '1:1', 'portrait', 'crop', 'background gradient',",
  "  'halo', 'lighting'. Those are owned by a separate composition template",
  "  appended downstream. If you mention any, you have made a mistake.",
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
  '  "reasoning": "<one or two sentences: what kind of robot you chose and why, and the palette logic you applied>"',
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

  console.log("[design-agent] calling Sonnet 4.6 (text)…");
  const t0 = performance.now();
  const r = await sdk.compute.invokeBedrock({
    model: "claude-sonnet-4-6",
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: USER_PROMPT_PREFIX + description.trim() }],
    maxTokens: 1200,
  });
  console.log(
    `[design-agent] Sonnet returned in ${(performance.now() - t0).toFixed(0)}ms, credits=${r.creditsCharged}`,
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
