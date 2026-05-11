// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Hardcoded test companies for the branded-robot agent. In production
// these would come from the calling app (the dev provides the brand
// profile; the agent runs the pipeline). For our demo we ship a couple
// of canonical brand briefs so the result is reproducible and the
// reviewer can eyeball the visual quality.

import type { BrandProfile } from "./brand-types.js";

/**
 * Inline SVG logo for the Brewsmith Coffee Co. test company.
 *
 * A stylized coffee cup wordmark — flat 2-colour, no gradient, no
 * raster artefacts. Acts as a sanity proof for the agent: a real
 * brand logo would also be SVG (transparent by construction) or a
 * properly-prepared PNG with alpha; the agent treats both the same.
 *
 * Encoded as a data URI so the test profile is self-contained
 * (no public/ asset to ship).
 */
const BREWSMITH_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <g fill="none" stroke="#3E2723" stroke-width="14" stroke-linecap="round" stroke-linejoin="round">
    <!-- Steam wisps -->
    <path d="M104 36 q-12 12 0 24 q12 12 0 24"/>
    <path d="M128 28 q-12 12 0 24 q12 12 0 24"/>
    <path d="M152 36 q-12 12 0 24 q12 12 0 24"/>
    <!-- Cup body -->
    <path d="M64 108 L80 196 a16 16 0 0 0 16 14 h64 a16 16 0 0 0 16-14 L192 108 Z" fill="#3E2723"/>
    <!-- Handle -->
    <path d="M192 132 q34 0 34 26 q0 26 -34 26" fill="none"/>
    <!-- Saucer line -->
    <line x1="56" y1="108" x2="200" y2="108"/>
  </g>
  <text x="128" y="244" text-anchor="middle" font-family="Georgia, serif"
        font-size="22" font-weight="700" fill="#3E2723">BREWSMITH</text>
</svg>`;

const BREWSMITH_LOGO_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(BREWSMITH_LOGO_SVG)}`;

export const BREWSMITH_COFFEE: BrandProfile = {
  name: "Brewsmith Coffee Co.",
  service: "Specialty coffee subscription — freshly-roasted beans delivered weekly",
  visualBrief:
    "Warm cosy coffeehouse atmosphere — hand-crafted artisanal feel " +
    "with a premium quality-obsessed mood.",
  styleKeywords: ["artisanal", "warm", "hand-crafted", "cosy", "premium"],
  primaryColor: "#3E2723",
  secondaryColor: "#F5F0E6",
  backgroundColor: "#F5F0E6",
  seed: 42,
  logoDataUri: BREWSMITH_LOGO_DATA_URI,
  logoHasAlpha: true,
};

/**
 * Second test company — a tech / SaaS feel, completely different
 * palette + mood from Brewsmith. Lets us validate that the same
 * pipeline handles cool minimal aesthetics, not just warm artisanal.
 */
const PULSE_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <g fill="none" stroke="#0F62FE" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="20,128 80,128 100,72 140,184 160,108 180,128 236,128"/>
  </g>
  <text x="128" y="220" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="34" font-weight="700" fill="#0F62FE">PULSE</text>
</svg>`;

const PULSE_LOGO_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(PULSE_LOGO_SVG)}`;

export const PULSE_ANALYTICS: BrandProfile = {
  name: "Pulse Analytics",
  service: "Real-time SaaS analytics dashboard for product teams",
  visualBrief:
    "Modern minimal SaaS feel — cool, technical, trustworthy and " +
    "data-forward. Clean geometry, professional.",
  styleKeywords: ["minimal", "modern", "clean", "tech", "professional"],
  primaryColor: "#0F62FE",
  secondaryColor: "#FFFFFF",
  backgroundColor: "#F4F7FB",
  seed: 42,
  logoDataUri: PULSE_LOGO_DATA_URI,
  logoHasAlpha: true,
};

export const TEST_COMPANIES: readonly BrandProfile[] = [
  BREWSMITH_COFFEE,
  PULSE_ANALYTICS,
];
