// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — pick a robot template, drop your logo on its torso,
// download a branded-character poster.
//
// Architecture: pure client-side compositing on an HTML canvas.
//
//   - Robot templates are pre-rendered PNGs shipped under /public/robots/
//     with a manifest.json that carries the torso disc coordinates
//     (centerX, centerY, radius) measured at generation time.
//   - The user uploads a logo (PNG / JPEG / SVG). It's loaded as an
//     HTMLImageElement and composited over the disc.
//   - All processing is local — the logo never touches the network.
//
// Why not have FLUX paint the logo: diffusion models can't reproduce a
// specific brand mark pixel-accurately. They invent "logo-shaped stuff"
// at best. Two-step (FLUX template + canvas overlay) gives 100%
// fidelity on the brand mark.

import { useEffect, useMemo, useRef, useState } from "react";

interface TemplateMeta {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly torso: {
    readonly centerX: number;
    readonly centerY: number;
    readonly radius: number;
  };
}

interface Manifest {
  readonly schema: string;
  readonly templates: readonly TemplateMeta[];
}

/**
 * Inter-tick redraw helper — load an image lazily and keep a single
 * cached HTMLImageElement per source.
 */
function useImage(src: string | null): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const el = new Image();
    // We don't set crossOrigin: both the robot template and the user-
    // uploaded logo are same-origin / data-URI respectively — no CORS.
    let cancelled = false;
    el.onload = () => {
      if (!cancelled) setImg(el);
    };
    el.onerror = () => {
      if (!cancelled) setImg(null);
    };
    el.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return img;
}

export function BrandedRobot() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  // Scale relative to torso disc diameter — 1.0 = fits exactly inside the
  // disc, < 1.0 = leaves padding around the logo, > 1.0 = overflows the
  // disc (allowed, in case the logo benefits from a tighter framing).
  const [scale, setScale] = useState(0.85);
  // Fine-tune offset (pixels in template coordinate space)
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load manifest once
  useEffect(() => {
    let cancelled = false;
    fetch("/robots/manifest.json")
      .then((r) => r.json() as Promise<Manifest>)
      .then((m) => {
        if (cancelled) return;
        setManifest(m);
        if (m.templates[0] && !selectedId) {
          setSelectedId(m.templates[0].id);
        }
      })
      .catch(() => {
        /* manifest missing — user sees the empty state */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected: TemplateMeta | null = useMemo(() => {
    if (!manifest) return null;
    return manifest.templates.find((t) => t.id === selectedId) ?? null;
  }, [manifest, selectedId]);

  const robotImg = useImage(selected ? selected.file : null);
  const logoImg = useImage(logoSrc);

  // Composite into canvas whenever inputs change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !selected || !robotImg) return;
    canvas.width = selected.width;
    canvas.height = selected.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 1. Draw the robot template
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(robotImg, 0, 0, canvas.width, canvas.height);
    // 2. Draw the logo over the torso disc, scaled to fit
    if (logoImg && logoImg.width > 0 && logoImg.height > 0) {
      const targetDiameter = selected.torso.radius * 2 * scale;
      // Preserve logo aspect ratio: fit-INSIDE a square of side targetDiameter
      const logoAspect = logoImg.width / logoImg.height;
      let drawW: number;
      let drawH: number;
      if (logoAspect >= 1) {
        // wider than tall
        drawW = targetDiameter;
        drawH = targetDiameter / logoAspect;
      } else {
        drawH = targetDiameter;
        drawW = targetDiameter * logoAspect;
      }
      const cx = selected.torso.centerX + offsetX;
      const cy = selected.torso.centerY + offsetY;
      // Optional: clip to the disc so logos never overflow visually.
      // We make this opt-in via a checkbox later if useful — for now,
      // keep it free so wider logos can hang outside the disc (a la
      // logo-on-T-shirt).
      ctx.drawImage(logoImg, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    }
    // Reset cached download URL — user must hit Export again
    setDownloadUrl(null);
  }, [selected, robotImg, logoImg, scale, offsetX, offsetY]);

  const onLogoFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setLogoSrc(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const exportPng = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
    }, "image/png");
  };

  return (
    <section>
      <h2>Branded robot</h2>
      <p className="lede">
        Pick a robot template, drop your logo on its torso, download the
        composite as PNG. The logo stays on-device — never sent to any
        server. Templates were generated once with FLUX Pro and ship
        with the app.
      </p>

      {!manifest && (
        <div className="error">
          Robot manifest missing — make sure{" "}
          <code>/public/robots/manifest.json</code> is present.
        </div>
      )}

      {manifest && (
        <>
          <h3 style={{ marginTop: 16 }}>1. Choose a template</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
              marginBottom: 16,
            }}
          >
            {manifest.templates.map((t) => (
              <label
                key={t.id}
                style={{
                  display: "block",
                  border:
                    t.id === selectedId
                      ? "2px solid var(--accent, #4a8)"
                      : "2px solid transparent",
                  borderRadius: 8,
                  padding: 8,
                  cursor: "pointer",
                  margin: 0,
                }}
              >
                <input
                  type="radio"
                  name="robot-template"
                  value={t.id}
                  checked={t.id === selectedId}
                  onChange={() => setSelectedId(t.id)}
                  style={{ position: "absolute", opacity: 0 }}
                />
                <img
                  src={t.file}
                  alt={t.label}
                  style={{
                    width: "100%",
                    height: "auto",
                    borderRadius: 4,
                    display: "block",
                  }}
                />
                <div style={{ marginTop: 6, fontSize: "0.9em" }}>
                  <strong>{t.label}</strong>
                  <div style={{ color: "#666", fontSize: "0.85em" }}>
                    {t.description}
                  </div>
                </div>
              </label>
            ))}
          </div>

          <h3>2. Upload your logo</h3>
          <label
            className="row"
            style={{
              border: "1px dashed #888",
              borderRadius: 8,
              padding: 16,
              display: "flex",
              gap: 12,
              alignItems: "center",
              cursor: "pointer",
              marginBottom: 16,
            }}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onLogoFile(f);
              }}
              style={{ display: "none" }}
            />
            {logoImg ? (
              <>
                <img
                  src={logoSrc!}
                  alt="logo preview"
                  style={{
                    width: 64,
                    height: 64,
                    objectFit: "contain",
                    background: "#f0f0f0",
                    borderRadius: 4,
                  }}
                />
                <span>
                  <strong>Logo loaded</strong> ({logoImg.width} × {logoImg.height}{" "}
                  px) — click to replace
                </span>
              </>
            ) : (
              <span style={{ color: "#666" }}>
                Click to pick a logo (PNG, JPEG, SVG, or WebP). Stays on your
                device.
              </span>
            )}
          </label>

          <h3>3. Position</h3>
          <div className="stack" style={{ gap: 8, marginBottom: 16 }}>
            <label>
              <span>
                Logo size — {(scale * 100).toFixed(0)}% of torso disc
              </span>
              <input
                type="range"
                min={0.3}
                max={1.6}
                step={0.05}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </label>
            <div className="row" style={{ gap: 12 }}>
              <label style={{ flex: 1 }}>
                <span>Horizontal offset — {offsetX}px</span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={offsetX}
                  onChange={(e) => setOffsetX(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>
              <label style={{ flex: 1 }}>
                <span>Vertical offset — {offsetY}px</span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={1}
                  value={offsetY}
                  onChange={(e) => setOffsetY(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => {
                setScale(0.85);
                setOffsetX(0);
                setOffsetY(0);
              }}
              style={{ alignSelf: "flex-start" }}
            >
              Reset position
            </button>
          </div>

          <h3>4. Preview</h3>
          <div
            style={{
              maxWidth: 480,
              background:
                "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px",
              borderRadius: 8,
              padding: 8,
              marginBottom: 12,
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: "auto",
                display: "block",
                borderRadius: 4,
              }}
            />
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button type="button" onClick={() => void exportPng()}>
              Export PNG
            </button>
            {downloadUrl && selected && (
              <a
                href={downloadUrl}
                download={`${selected.id}-branded.png`}
                style={{ alignSelf: "center" }}
              >
                Download
              </a>
            )}
          </div>
          <p
            className="lede"
            style={{ fontSize: "0.85em", marginTop: 8, color: "#666" }}
          >
            Tip — for the cleanest result, use a square-ish logo with a
            transparent background. SVG is fine. Very wide or very tall logos
            will fit inside a square framed by the torso disc.
          </p>
        </>
      )}
    </section>
  );
}
