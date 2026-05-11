// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Pure-DOM image utilities for the branded-robot agent.
//
// All ops run on a hidden <canvas> via the 2D context — no external
// dependency, no native image library, no server round-trip. Browser
// canvas is fast enough for 1024×1024 single-pass operations.
//
// Functions:
//   - loadImage(srcOrBlob): HTMLImageElement decoder, handles SVG/data URIs
//   - removeSolidBackground(img, refColor, tolerance): flood-fill from
//     each corner pixel, sets matching pixels' alpha to 0
//   - detectSilhouetteBox(canvas): bounding box of non-transparent pixels
//   - compositeLogoOnRobot(robot, logo, position, opts): canvas blend
//     mode + soft shadow for the inlay effect

/* -------------------------------------------------------------------------- */
/*  Image loading                                                             */
/* -------------------------------------------------------------------------- */

export async function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  const url = src instanceof Blob ? URL.createObjectURL(src) : src;
  try {
    const img = new Image();
    // crossOrigin = "anonymous" so canvas.toDataURL doesn't taint on
    // CORS-friendly sources. Data URIs and same-origin sources are
    // unaffected; remote sources need proper CORS headers (out of
    // scope for our test companies which all ship inline SVG).
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
    return img;
  } finally {
    if (src instanceof Blob) {
      // Defer revocation so the caller has a chance to drawImage first.
      // Browsers keep the bitmap cached after first draw; revocation
      // only frees the URL itself.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Background removal — flood-fill from corners                              */
/* -------------------------------------------------------------------------- */

interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function hexToRgb(hex: string): RGB {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
  if (!m) throw new Error(`bad hex: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/**
 * Draw an image onto a canvas and return the canvas. Used as a
 * starting point for every pixel-level op.
 */
export function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(img, 0, 0);
  return c;
}

/**
 * Remove pixels close to the reference background color via a 4-way
 * flood-fill starting from each corner. Returns the canvas in-place
 * with alpha=0 on background pixels.
 *
 * Tolerance: max Euclidean RGB distance to consider a pixel as
 * "background". 30-50 is a good range for FLUX-generated flat
 * backgrounds (which have minimal noise). Bump up for camera shots.
 *
 * Why flood-fill and not a simple "everywhere matching" filter:
 * - The robot itself might have pixels matching the background colour
 *   (e.g. cream-colored chest accents on a cream background). A
 *   global filter would punch holes through the robot.
 * - Flood-fill only removes pixels CONNECTED to the corners, so
 *   internal matches survive. Standard photo-editing technique.
 */
export function removeSolidBackground(
  canvas: HTMLCanvasElement,
  refHex: string,
  tolerance = 36,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const w = canvas.width;
  const h = canvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const ref = hexToRgb(refHex);
  const tol2 = tolerance * tolerance;

  // Visited bitmap — bit-packed Uint8Array, one bit per pixel.
  const visited = new Uint8Array(Math.ceil((w * h) / 8));
  const isVisited = (i: number): boolean =>
    (visited[i >> 3]! & (1 << (i & 7))) !== 0;
  const markVisited = (i: number): void => {
    visited[i >> 3]! |= 1 << (i & 7);
  };

  // Iterative flood-fill with an array stack. Recursion would blow the
  // JS stack on a 1024×1024 image (~1M pixels).
  const stack: number[] = [];
  const seed = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    stack.push(y * w + x);
  };
  seed(0, 0);
  seed(w - 1, 0);
  seed(0, h - 1);
  seed(w - 1, h - 1);

  while (stack.length > 0) {
    const idx = stack.pop()!;
    if (isVisited(idx)) continue;
    markVisited(idx);
    const px = idx * 4;
    const r = data[px]!;
    const g = data[px + 1]!;
    const b = data[px + 2]!;
    const dr = r - ref.r;
    const dg = g - ref.g;
    const db = b - ref.b;
    if (dr * dr + dg * dg + db * db > tol2) continue;
    // Match: clear alpha
    data[px + 3] = 0;
    // Push 4-neighbours
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }

  // Edge softening: 1-pixel feather where alpha is 0 next to fully
  // opaque pixels. Without this the cutout silhouette has aliasing
  // and looks "cut out". One pass is enough for our use case.
  featherAlpha(imgData);
  ctx.putImageData(imgData, 0, 0);
}

/** Single-pass 1px alpha feather — softens the cutout edge. */
function featherAlpha(imgData: ImageData): void {
  const { data, width: w, height: h } = imgData;
  const copy = new Uint8ClampedArray(data); // snapshot before mutation
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      if (copy[i + 3] === 0) continue; // already transparent
      // Average alpha of 4-neighbours
      const a =
        copy[i + 3]! * 4 +
        copy[i - 4 + 3]! +
        copy[i + 4 + 3]! +
        copy[i - w * 4 + 3]! +
        copy[i + w * 4 + 3]!;
      data[i + 3] = Math.min(255, Math.round(a / 8));
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Silhouette bounding box detection                                         */
/* -------------------------------------------------------------------------- */

export interface SilhouetteBox {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Find the bounding box of all pixels with alpha > threshold. The
 * caller should have run removeSolidBackground() first so background
 * pixels have alpha=0.
 */
export function detectSilhouetteBox(
  canvas: HTMLCanvasElement,
  alphaThreshold = 32,
): SilhouetteBox {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);
  let top = h;
  let left = w;
  let right = 0;
  let bottom = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3]!;
      if (a < alphaThreshold) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (top > bottom) {
    // Empty silhouette — fall back to full image
    return { top: 0, left: 0, right: w - 1, bottom: h - 1, width: w, height: h };
  }
  return {
    top,
    left,
    right,
    bottom,
    width: right - left + 1,
    height: bottom - top + 1,
  };
}

/**
 * Estimate the torso center of a humanoid silhouette using a simple
 * heuristic: center-x of the silhouette, y at the chest height
 * (typically ~55-60% down from the top of the silhouette).
 */
export function estimateTorsoCenter(
  box: SilhouetteBox,
  ratio = 0.58,
): { centerX: number; centerY: number; diameter: number } {
  const cx = Math.round(box.left + box.width / 2);
  const cy = Math.round(box.top + box.height * ratio);
  const diameter = Math.round(box.width * 0.38);
  return { centerX: cx, centerY: cy, diameter };
}

/**
 * Better torso detector: find the centroid of pixels matching the
 * declared torso colour (the "t-shirt" color we asked FLUX to paint).
 *
 * Algorithm:
 *   1. Scan all opaque pixels and tag those whose RGB is within
 *      `tolerance` of the torso color.
 *   2. Take the largest connected component of tagged pixels.
 *   3. Centroid = mean(x), mean(y).
 *   4. Diameter = 1.8 * mean(distance from centroid) ≈ a tight disc
 *      that fits inside the t-shirt.
 *
 * Falls back to the silhouette-bbox heuristic when no significant
 * torso-colored region is found — that way the agent always
 * produces *some* center, even if the t-shirt detection fails.
 */
export function detectTorsoByColor(
  canvas: HTMLCanvasElement,
  torsoHex: string,
  opts: {
    readonly tolerance?: number;
    /**
     * Search only within these y bounds. CRITICAL for accuracy: if
     * left unset, the head's bright highlights (lens flares, antenna
     * tips, edge specular) can be brighter than the torso area and
     * skew the centroid up to the head. Callers should pass the
     * lower half of the silhouette bbox here.
     */
    readonly yMin?: number;
    readonly yMax?: number;
    /** Min pixel count to consider the detection trustworthy. */
    readonly minPixels?: number;
  } = {},
): { centerX: number; centerY: number; diameter: number; pixelCount: number } | null {
  const tolerance = opts.tolerance ?? 32;
  const minPixels = opts.minPixels ?? 200;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);
  const ref = hexToRgb(torsoHex);
  const tol2 = tolerance * tolerance;
  const xMin = Math.floor(w * 0.20);
  const xMax = Math.ceil(w * 0.80);
  const yMin = Math.max(0, Math.floor(opts.yMin ?? 0));
  const yMax = Math.min(h, Math.ceil(opts.yMax ?? h));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3]! < 200) continue; // not opaque
      const dr = data[i]! - ref.r;
      const dg = data[i + 1]! - ref.g;
      const db = data[i + 2]! - ref.b;
      if (dr * dr + dg * dg + db * db > tol2) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  if (xs.length < minPixels) return null;
  // Centroid
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < xs.length; k++) {
    sx += xs[k]!;
    sy += ys[k]!;
  }
  const cx = sx / xs.length;
  const cy = sy / ys.length;
  // Mean distance from centroid → disc radius
  let sumDist = 0;
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k]! - cx;
    const dy = ys[k]! - cy;
    sumDist += Math.sqrt(dx * dx + dy * dy);
  }
  const meanDist = sumDist / xs.length;
  // Diameter = 2 * (1.4 * meanDist) — gives a disc that comfortably
  // fits within the t-shirt panel without overflowing.
  const diameter = Math.round(2 * 1.4 * meanDist);
  return {
    centerX: Math.round(cx),
    centerY: Math.round(cy),
    diameter,
    pixelCount: xs.length,
  };
}

/**
 * Detect the torso center by scanning silhouette WIDTH per row.
 *
 * In the lower half of the silhouette, the row with the maximum
 * horizontal extent is overwhelmingly the chest (a t-shirt is the
 * widest visible body part). This is provider-agnostic — works even
 * if FLUX painted the t-shirt the wrong colour.
 *
 * Algorithm:
 *   1. For each row in the lower 65% of the bbox, find the leftmost
 *      and rightmost opaque pixels.
 *   2. Compute width = right - left for each row.
 *   3. Pick the row with max width as the torso center y.
 *   4. centerX = (left + right) / 2 at that row.
 *   5. diameter = ~70% of that max width (the disc fits inside the
 *      torso, not its full width which includes arms-meeting-body).
 */
export function detectTorsoBySilhouetteWidth(
  canvas: HTMLCanvasElement,
  bbox: SilhouetteBox,
  alphaThreshold = 200,
): { centerX: number; centerY: number; diameter: number } {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  const { data, width: w } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Search the lower 65% of the silhouette only (skip the head zone).
  const yStart = bbox.top + Math.floor(bbox.height * 0.35);
  const yEnd = bbox.top + Math.floor(bbox.height * 0.95);
  let bestY = yStart;
  let bestWidth = -1;
  let bestLeft = bbox.left;
  let bestRight = bbox.right;
  for (let y = yStart; y < yEnd; y++) {
    let left = -1;
    let right = -1;
    for (let x = bbox.left; x <= bbox.right; x++) {
      if (data[(y * w + x) * 4 + 3]! >= alphaThreshold) {
        if (left === -1) left = x;
        right = x;
      }
    }
    if (left === -1) continue;
    const width = right - left;
    if (width > bestWidth) {
      bestWidth = width;
      bestY = y;
      bestLeft = left;
      bestRight = right;
    }
  }
  return {
    centerX: Math.round((bestLeft + bestRight) / 2),
    centerY: bestY,
    diameter: Math.max(40, Math.round(bestWidth * 0.7)),
  };
}

/* -------------------------------------------------------------------------- */
/*  Debug overlay                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render a debug overlay on top of an image: silhouette bbox in
 * green, torso center crosshair + circle in red. Used in the
 * 3-step UI so the user can see exactly where the agent placed
 * the logo target.
 */
export function renderTorsoDebugOverlay(
  source: HTMLCanvasElement,
  bbox: SilhouetteBox,
  torso: { centerX: number; centerY: number; diameter: number },
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  // Checker background so transparent pixels are visible
  ctx.fillStyle = "#eaeaea";
  ctx.fillRect(0, 0, out.width, out.height);
  const checkerSize = 16;
  ctx.fillStyle = "#fafafa";
  for (let y = 0; y < out.height; y += checkerSize * 2) {
    for (let x = 0; x < out.width; x += checkerSize * 2) {
      ctx.fillRect(x, y, checkerSize, checkerSize);
      ctx.fillRect(x + checkerSize, y + checkerSize, checkerSize, checkerSize);
    }
  }
  ctx.drawImage(source, 0, 0);
  // Bbox (green)
  ctx.strokeStyle = "rgba(0, 180, 0, 0.9)";
  ctx.lineWidth = 4;
  ctx.strokeRect(bbox.left, bbox.top, bbox.width, bbox.height);
  // Torso center + circle (red)
  ctx.strokeStyle = "rgba(220, 30, 30, 0.95)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(torso.centerX, torso.centerY, torso.diameter / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  const half = torso.diameter / 2 + 20;
  ctx.moveTo(torso.centerX - half, torso.centerY);
  ctx.lineTo(torso.centerX + half, torso.centerY);
  ctx.moveTo(torso.centerX, torso.centerY - half);
  ctx.lineTo(torso.centerX, torso.centerY + half);
  ctx.stroke();
  return out;
}

export function canvasToDataUri(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/png");
}

/* -------------------------------------------------------------------------- */
/*  Logo compositing — "inlay" blend                                          */
/* -------------------------------------------------------------------------- */

export interface CompositeLogoOpts {
  /** Maximum logo size (within the torso disc). 0..1, default 0.95. */
  readonly fillRatio?: number;
  /** Canvas globalCompositeOperation for the logo. Default "multiply". */
  readonly blendMode?: GlobalCompositeOperation;
  /** Opacity 0..1, default 0.9. */
  readonly opacity?: number;
  /** Drop-shadow radius in pixels (subtle depth). Default 6. */
  readonly shadowBlur?: number;
  /** Drop-shadow color. Default rgba(0,0,0,0.25). */
  readonly shadowColor?: string;
}

/**
 * Composite a logo over a robot at a specified torso center using a
 * blend mode that simulates an "inlaid" / "printed-on" effect.
 *
 * Pipeline:
 *   1. Draw the robot at full opacity to a result canvas.
 *   2. Save the context state.
 *   3. Set globalCompositeOperation to the blend mode (default "multiply").
 *   4. Draw the logo at the torso center, fit-inside torso disc.
 *   5. Restore the state.
 *   6. Optional drop-shadow pass for depth.
 *
 * "multiply" works best when:
 *   - The robot's chest is light enough that the logo darks show
 *     through clearly.
 *   - The logo has clear dark-on-light or coloured-on-transparent
 *     contrast.
 *
 * For dark-bodied robots, swap to "screen" (logo lights show through).
 * The agent picks based on the brand's primary colour luminance.
 */
export function compositeLogoOnRobot(
  robot: HTMLCanvasElement,
  logo: HTMLImageElement,
  torso: { centerX: number; centerY: number; diameter: number },
  opts: CompositeLogoOpts = {},
): HTMLCanvasElement {
  const fillRatio = opts.fillRatio ?? 0.95;
  const blendMode = opts.blendMode ?? "multiply";
  const opacity = opts.opacity ?? 0.9;
  const shadowBlur = opts.shadowBlur ?? 6;
  const shadowColor = opts.shadowColor ?? "rgba(0,0,0,0.25)";

  const result = document.createElement("canvas");
  result.width = robot.width;
  result.height = robot.height;
  const ctx = result.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // 1. Robot
  ctx.drawImage(robot, 0, 0);

  // 2-5. Logo with blend
  const targetDiameter = torso.diameter * fillRatio;
  const aspect = logo.naturalWidth / logo.naturalHeight || 1;
  let drawW: number;
  let drawH: number;
  if (aspect >= 1) {
    drawW = targetDiameter;
    drawH = targetDiameter / aspect;
  } else {
    drawH = targetDiameter;
    drawW = targetDiameter * aspect;
  }
  const dx = torso.centerX - drawW / 2;
  const dy = torso.centerY - drawH / 2;

  ctx.save();
  ctx.globalCompositeOperation = blendMode;
  ctx.globalAlpha = opacity;
  // Soft drop-shadow gives the logo a slight "recessed in the
  // chest" depth illusion without warping the logo pixels.
  if (shadowBlur > 0) {
    ctx.shadowBlur = shadowBlur;
    ctx.shadowColor = shadowColor;
  }
  ctx.drawImage(logo, dx, dy, drawW, drawH);
  ctx.restore();

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Canvas → Blob helper                                                      */
/* -------------------------------------------------------------------------- */

export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("toBlob returned null"));
    }, type);
  });
}

export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result === "string") resolve(r.result);
      else reject(new Error("FileReader returned non-string"));
    };
    r.onerror = () => reject(r.error ?? new Error("FileReader error"));
    r.readAsDataURL(blob);
  });
}
