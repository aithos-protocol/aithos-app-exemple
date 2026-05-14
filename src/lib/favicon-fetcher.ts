// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Favicon-first logo discovery.
//
// Brand sites expose icon assets at well-known paths (apple-touch-icon,
// /favicon.ico, web manifest). These are SYMBOL-ONLY by construction —
// at 16-180px no designer ships a wordmark in them. So they're ideal
// for compositing on a robot's chest disc, and they bypass both the
// lockup-extraction problem and the cost of a Sonnet logo-discovery
// call.
//
// Strategy: try a small set of well-known paths in order of expected
// quality, return the first that resolves to a real image. We do NOT
// parse the page's HTML for `<link rel="icon">` declarations in this
// phase — keeps the implementation small. If the conventional paths
// fail (~10-20% of sites, typically older ones), we return null and
// the caller falls back to the existing Sonnet-based discovery.
//
// Phase 1 deliberately does NO upscaling: we accept whatever size the
// site exposes. Apple-touch-icon is typically 180x180 PNG (clean), the
// .ico fallback is typically 16/32px (pixelated on the chest). A
// follow-up phase can add canvas-side enhancement or AI upscale once
// we've seen the real-world size distribution.

import type { AithosSDK } from "@aithos/sdk";

import { fetchAsDataUri } from "./url-analyzer.js";

export interface FaviconResult {
  /** Logo as a data URI (image/png, image/svg+xml, image/x-icon, ...). */
  readonly dataUri: string;
  /** Absolute URL we actually fetched. */
  readonly sourceUrl: string;
  /**
   * Which conventional path produced the asset.
   *
   * `apple-touch-icon-180`     — best: opaque 180×180 PNG, iOS norm
   * `apple-touch-icon`         — best: same, default path
   * `apple-touch-icon-precomposed` — same family, legacy iOS suffix
   * `favicon-svg`              — vector, infinite resolution
   * `favicon-png-large`        — `/favicon-192.png`, `/favicon-512.png`
   * `favicon-ico`              — `/favicon.ico`, often 16-48px raster
   */
  readonly source:
    | "apple-touch-icon"
    | "apple-touch-icon-180"
    | "apple-touch-icon-precomposed"
    | "favicon-svg"
    | "favicon-png-large"
    | "favicon-ico";
  /**
   * Decoded image dimensions in CSS px. Hints downstream code about
   * upscale need (e.g., warn the UI when < 64px).
   */
  readonly width: number;
  readonly height: number;
}

/**
 * Try to fetch a favicon for the brand's homepage from the well-known
 * conventional paths, in order of expected quality.
 *
 * Returns null when none of the conventional paths yield a real image —
 * the caller should fall back to its previous logo-discovery flow.
 *
 * Cost: 0 credits when the client-side `fetch` works (most cases),
 * 1 mc per probe when the server-side proxy is needed (CORS-strict
 * sites). Latency: a few hundred ms total.
 */
export async function fetchFaviconForUrl(
  sdk: AithosSDK,
  homeUrl: string,
): Promise<FaviconResult | null> {
  let origin: string;
  try {
    origin = new URL(homeUrl).origin;
  } catch {
    console.warn("[favicon-fetcher] invalid homeUrl, skipping:", homeUrl);
    return null;
  }

  // Ordered list of (path, source-label) candidates. The order matters:
  // we stop at the FIRST one that resolves to a real image. Top of the
  // list = best expected quality / cleanest asset for our use case.
  const candidates: ReadonlyArray<{
    readonly path: string;
    readonly source: FaviconResult["source"];
  }> = [
    { path: "/apple-touch-icon-180x180.png", source: "apple-touch-icon-180" },
    { path: "/apple-touch-icon.png", source: "apple-touch-icon" },
    { path: "/apple-touch-icon-precomposed.png", source: "apple-touch-icon-precomposed" },
    { path: "/favicon.svg", source: "favicon-svg" },
    { path: "/favicon-512x512.png", source: "favicon-png-large" },
    { path: "/favicon-512.png", source: "favicon-png-large" },
    { path: "/favicon-256x256.png", source: "favicon-png-large" },
    { path: "/favicon-192x192.png", source: "favicon-png-large" },
    { path: "/favicon-192.png", source: "favicon-png-large" },
    { path: "/favicon-96x96.png", source: "favicon-png-large" },
    { path: "/favicon.ico", source: "favicon-ico" },
  ];

  for (const { path, source } of candidates) {
    const url = origin + path;
    try {
      console.log(`[favicon-fetcher] trying ${url}…`);
      const dataUri = await fetchAsDataUri(sdk, url);
      // Decode dimensions to surface them downstream.
      const { width, height } = await probeImageDims(dataUri);
      if (width === 0 || height === 0) {
        console.warn(`[favicon-fetcher] ${url} decoded to 0×0, skipping`);
        continue;
      }
      console.log(
        `[favicon-fetcher] OK ${source} → ${url} (${width}×${height})`,
      );
      return { dataUri, sourceUrl: url, source, width, height };
    } catch (e) {
      // 404 / non-image / CORS strict / etc. — quietly move on. We
      // expect most candidates to miss; only the first one to land
      // matters.
      console.log(
        `[favicon-fetcher] miss ${path}: ${(e as Error).message}`,
      );
      continue;
    }
  }
  console.log("[favicon-fetcher] no conventional favicon path worked");
  return null;
}

/**
 * Decode an image data URI just enough to read its naturalWidth /
 * naturalHeight. Used to surface a size hint to the UI and to skip
 * candidates that decoded to a zero-dimension blob (sometimes happens
 * with .ico when the server returns an HTML error page with the wrong
 * content-type).
 */
function probeImageDims(
  dataUri: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = dataUri;
  });
}
