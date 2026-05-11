// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Four contrasting test companies for the branded-robot agent.
//
// Each `visualBrief` is the FULL per-brand prompt fed to the image
// model. It MUST describe both the company + the expected robot
// design (silhouette, colors, mood, materials). The agent then
// appends a hardcoded COMPOSITION_TEMPLATE so every robot is framed
// identically (bust portrait, cropped at bottom-of-pectoral).
//
// The 4 brands are chosen to span maximum stylistic distance:
//   - Glamour Nail Studio   — feminine, soft, luxury beauty
//   - TitanWorks            — masculine, rugged, heavy construction
//   - Apex Cyber            — sharp, edgy, technical cybersecurity
//   - Sunbeam Pediatrics    — soft, warm, friendly children's clinic

import type { BrandProfile } from "./brand-types.js";

/* -------------------------------------------------------------------------- */
/*  Inline SVG logos (no public/ asset needed)                                */
/* -------------------------------------------------------------------------- */

const GLAMOUR_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <g fill="#B76E79">
    <circle cx="128" cy="90" r="22"/>
    <circle cx="92" cy="120" r="22"/>
    <circle cx="164" cy="120" r="22"/>
    <circle cx="108" cy="160" r="22"/>
    <circle cx="148" cy="160" r="22"/>
  </g>
  <circle cx="128" cy="130" r="14" fill="#E8B4B8"/>
  <text x="128" y="225" text-anchor="middle" font-family="Georgia, serif"
        font-size="22" font-style="italic" fill="#B76E79">Glamour</text>
</svg>`;

const TITAN_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <g stroke="#1C1F22" stroke-width="8" stroke-linejoin="round">
    <path d="M 56 160 Q 56 80 128 80 Q 200 80 200 160 L 204 174 L 52 174 Z" fill="#FFA500"/>
    <rect x="50" y="160" width="156" height="16" fill="#FFA500" rx="2"/>
    <line x1="128" y1="86" x2="128" y2="160" stroke-width="6"/>
  </g>
  <text x="128" y="222" text-anchor="middle" font-family="Arial Black, Arial, sans-serif"
        font-size="28" font-weight="900" fill="#1C1F22">TITAN</text>
</svg>`;

const APEX_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <g fill="none" stroke="#00E5FF" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 128 36 L 206 70 L 206 140 Q 206 200 128 222 Q 50 200 50 140 L 50 70 Z"/>
  </g>
  <path d="M 128 86 L 174 168 L 82 168 Z" fill="#00E5FF"/>
  <text x="128" y="244" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="22" font-weight="700" letter-spacing="4" fill="#00E5FF">APEX</text>
</svg>`;

const SUNBEAM_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <g stroke="#F5A623" stroke-width="10" stroke-linecap="round" fill="none">
    <line x1="128" y1="14" x2="128" y2="44"/>
    <line x1="128" y1="164" x2="128" y2="194"/>
    <line x1="18" y1="104" x2="48" y2="104"/>
    <line x1="208" y1="104" x2="238" y2="104"/>
    <line x1="49" y1="27" x2="71" y2="49"/>
    <line x1="185" y1="159" x2="207" y2="181"/>
    <line x1="207" y1="27" x2="185" y2="49"/>
    <line x1="71" y1="159" x2="49" y2="181"/>
  </g>
  <circle cx="128" cy="104" r="46" fill="#FFDB58" stroke="#F5A623" stroke-width="10"/>
  <path d="M 108 100 Q 128 124 148 100" fill="none" stroke="#F5A623" stroke-width="8" stroke-linecap="round"/>
  <circle cx="113" cy="93" r="4" fill="#F5A623"/>
  <circle cx="143" cy="93" r="4" fill="#F5A623"/>
  <text x="128" y="232" text-anchor="middle" font-family="Verdana, sans-serif"
        font-size="22" font-weight="700" fill="#F5A623">SUNBEAM</text>
</svg>`;

const dataUri = (svg: string): string =>
  `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

/* -------------------------------------------------------------------------- */
/*  Brand profiles                                                            */
/* -------------------------------------------------------------------------- */

export const GLAMOUR_NAIL_STUDIO: BrandProfile = {
  name: "Glamour Nail Studio",
  service:
    "Luxury Parisian nail salon for women — premium manicures, hand-painted designs, gel extensions",
  visualBrief: [
    "BRAND BRIEF:",
    "Glamour Nail Studio is a high-end Parisian nail salon dedicated to refined feminine beauty. The vibe is boudoir-meets-modern-spa: rose, gold, mirrors, slow indulgence.",
    "",
    "ROBOT DESIGN:",
    "A softly-rounded humanoid robot with a SLENDER feminine silhouette, narrow delicate shoulders, and a smooth pearlescent off-white shell with subtle rose-gold reflective hints. The chest is a SINGLE uninterrupted curved surface — no panels, no seams, no rivets. The head is a perfectly smooth glossy dome with a sleek black visor face. Two warm rose-pink glowing dot-eyes inside the visor (color #E8B4B8). Small minimalist rose-gold accents around the visor edge and where the slender neck meets the shoulders. Overall mood: elegant, feminine, refined, premium.",
  ].join("\n"),
  primaryColor: "#E8B4B8",
  secondaryColor: "#B76E79",
  backgroundColor: "#2A1820",
  seed: 42,
  logoDataUri: dataUri(GLAMOUR_LOGO_SVG),
  logoHasAlpha: true,
};

export const TITANWORKS_CONSTRUCTION: BrandProfile = {
  name: "TitanWorks Construction",
  service:
    "Heavy construction and civil engineering — bridges, highways, industrial facilities",
  visualBrief: [
    "BRAND BRIEF:",
    "TitanWorks is a heavy-construction and civil-engineering firm — the kind that builds bridges, highways, and industrial sites. The vibe is solid, masculine, no-nonsense, dependable: hard hats and steel beams.",
    "",
    "ROBOT DESIGN:",
    "A BROAD-SHOULDERED humanoid robot with a wide SQUARE torso and chunky reinforced shoulder plates. The body is matte safety-orange with dark gunmetal-grey trim and visible (but minimal) bolted-armor-plate aesthetics on the shoulders. The CHEST itself is a CLEAN uninterrupted matte safety-orange panel — no rivets, no decals on the chest area specifically. The head is a wide rectangular hard-hat-style helmet with a thick black horizontal visor. Two amber-orange glowing dot-eyes inside the visor (color #FFA500). Overall mood: strong, broad, geometric, masculine, industrial.",
  ].join("\n"),
  primaryColor: "#FFA500",
  secondaryColor: "#1C1F22",
  backgroundColor: "#2B2E33",
  seed: 42,
  logoDataUri: dataUri(TITAN_LOGO_SVG),
  logoHasAlpha: true,
};

export const APEX_CYBER: BrandProfile = {
  name: "Apex Cyber",
  service:
    "Cybersecurity firm protecting enterprise networks from advanced threats",
  visualBrief: [
    "BRAND BRIEF:",
    "Apex Cyber is a cybersecurity firm that protects Fortune-500 networks from advanced threats. The vibe is sharp, edgy, technical, vigilant — like a digital sentinel that never sleeps.",
    "",
    "ROBOT DESIGN:",
    "A LEAN ANGULAR humanoid robot with sharp geometric shoulder plates and an angular faceted chest panel. The body is glossy deep-black with subtle neon-cyan panel-line accents running along the edges and joints. The CHEST panel itself is a CLEAN flat angular surface — no engravings, no decals. The head is a sleek angular helmet with a wide horizontal black visor that wraps the front. Two intense cyan glowing dot-eyes inside the visor (color #00E5FF). Overall mood: sharp, edgy, vigilant, slightly threatening but trustworthy.",
  ].join("\n"),
  primaryColor: "#00E5FF",
  secondaryColor: "#0A0E1A",
  backgroundColor: "#0A0E1A",
  seed: 42,
  logoDataUri: dataUri(APEX_LOGO_SVG),
  logoHasAlpha: true,
};

export const SUNBEAM_PEDIATRICS: BrandProfile = {
  name: "Sunbeam Pediatrics",
  service: "Friendly pediatric clinic for children aged 0-12",
  visualBrief: [
    "BRAND BRIEF:",
    "Sunbeam Pediatrics is a warm friendly pediatric clinic for young children. The vibe is reassuring, soft, comforting, child-safe — the place where a frightened toddler relaxes within five minutes.",
    "",
    "ROBOT DESIGN:",
    "A SOFTLY-ROUNDED humanoid robot with a CHUBBY CUTE silhouette — small rounded shoulders, no sharp edges anywhere, all curves and gentle radii. The body is a soft creamy butter-yellow with NO panels, NO seams, NO rivets — a single smooth uninterrupted curve from neck to chest. The head is a perfectly round dome (slightly oversized like a baby's head proportions) with a wide rounded black visor. Two warm sunny-yellow glowing dot-eyes inside the visor (color #FFDB58). Tiny round headphone-like ear-pieces on each side. Overall mood: cute, friendly, child-safe, comforting, warm.",
  ].join("\n"),
  primaryColor: "#FFDB58",
  secondaryColor: "#F5A623",
  backgroundColor: "#FFF8E7",
  seed: 42,
  logoDataUri: dataUri(SUNBEAM_LOGO_SVG),
  logoHasAlpha: true,
};

export const TEST_COMPANIES: readonly BrandProfile[] = [
  GLAMOUR_NAIL_STUDIO,
  TITANWORKS_CONSTRUCTION,
  APEX_CYBER,
  SUNBEAM_PEDIATRICS,
];
