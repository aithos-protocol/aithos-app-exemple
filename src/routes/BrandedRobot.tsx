// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — v11 simplified pipeline.
//
//   Step 1 — UPLOAD image  (no FLUX generation; reuse an existing PNG)
//   Step 2 — Sonnet vision (single call, returns JSON with chest geometry)
//   Step 3 — Prepare logo
//   Step 4 — Composite
//
// Compared to v10:
//   - Step 1 is now upload-only — no FLUX call, no FLUX cost. Lets us
//     iterate on detection logic with a single fixed image.
//   - Step 2 is just `detectTorsoByVision` — Sonnet 4.6 in vision mode.
//     No Florence-2, no MediaPipe, no cascade. Sonnet understands
//     perspective + brand-mascot conventions semantically, so the
//     output naturally accounts for 3/4 turns and asymmetric framing.
//   - Steps 3 and 4 are unchanged.

import { useEffect, useRef, useState } from "react";

import {
  step3PrepareLogo,
  step4Composite,
  type Step3LogoResult,
  type Step4CompositeResult,
  type Step4Settings,
} from "../lib/brand-agent.js";
import type { BrandProfile } from "../lib/brand-types.js";
import { TEST_COMPANIES } from "../lib/test-companies.js";
import { useSdk } from "../sdk-context.js";
import {
  detectTorsoByVision,
  type VisionTorsoResult,
} from "../lib/vision-detection.js";
import { formatError } from "./Home.js";

const BLEND_MODES: GlobalCompositeOperation[] = [
  "multiply",
  "screen",
  "overlay",
  "soft-light",
  "hard-light",
  "darken",
  "color-burn",
  "source-over",
];

interface UploadedImage {
  readonly canvas: HTMLCanvasElement;
  readonly dataUri: string;
  readonly width: number;
  readonly height: number;
}

export function BrandedRobot() {
  const { sdk, state } = useSdk();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const brand: BrandProfile = TEST_COMPANIES[selectedIdx]!;

  // --- Step 1 state (UPLOAD only — no generation) ---
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // --- Step 2 state (Sonnet vision) ---
  const [step2Running, setStep2Running] = useState(false);
  const [vision, setVision] = useState<VisionTorsoResult | null>(null);
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const [debugOverlay, setDebugOverlay] = useState<string | null>(null);

  // --- Step 3 state (logo) ---
  const [step3Running, setStep3Running] = useState(false);
  const [step3Result, setStep3Result] = useState<Step3LogoResult | null>(null);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  // --- Step 4 state (composite — live) ---
  const [settings, setSettings] = useState<Step4Settings>({
    blendMode: "multiply",
    opacity: 1.0,
    fillRatio: 0.95,
    shadowBlur: 4,
    shadowColor: "rgba(0,0,0,0.15)",
    offsetX: 0,
    offsetY: 0,
  });
  const [step4Result, setStep4Result] = useState<Step4CompositeResult | null>(null);
  const step4DebounceRef = useRef<number | null>(null);

  // Reset downstream when brand or upload changes.
  useEffect(() => {
    setVision(null);
    setStep3Result(null);
    setStep4Result(null);
    setStep2Error(null);
    setStep3Error(null);
    setDebugOverlay(null);
  }, [brand.name, uploaded]);

  // Auto-recomposite when inputs change.
  useEffect(() => {
    if (!uploaded || !vision || !step3Result) return;
    if (step4DebounceRef.current !== null) {
      window.clearTimeout(step4DebounceRef.current);
    }
    step4DebounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          // Synthesize the "robot" + "detection" shapes step4Composite expects.
          const r = await step4Composite({
            robot: {
              prompt: "<uploaded>",
              rawBlob: new Blob(),
              rawDataUri: uploaded.dataUri,
              rawCanvas: uploaded.canvas,
              creditsSpent: 0,
            },
            detection: {
              silhouetteCanvas: uploaded.canvas,
              bbox: {
                left: 0, top: 0,
                right: uploaded.width - 1, bottom: uploaded.height - 1,
                width: uploaded.width, height: uploaded.height,
              },
              torso: {
                centerX: vision.centerX,
                centerY: vision.centerY,
                // Use the smaller of width/height as the disc diameter.
                diameter: Math.min(vision.maxLogoWidth, vision.maxLogoHeight),
              },
              torsoSource: "vision-sonnet" as never,
              pose: null,
              florencePolygon: null,
              debugOverlayDataUri: debugOverlay ?? "",
            },
            logo: step3Result,
            settings,
          });
          setStep4Result(r);
        } catch (e) {
          console.warn("step4 composite failed", e);
        }
      })();
    }, 80);
  }, [uploaded, vision, step3Result, settings, debugOverlay]);

  const isAuthenticated = state.canSignAsOwner || state.delegates.length > 0;
  if (!isAuthenticated) {
    return (
      <section>
        <h2>Branded robot — v11 (Sonnet vision)</h2>
        <p className="lede">
          Sign in as an owner first so the agent can spend your wallet on
          the Sonnet vision call.
        </p>
      </section>
    );
  }

  const onUpload = (file: File) => {
    setStep1Error(null);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setStep1Error("FileReader returned non-string");
        return;
      }
      const dataUri = reader.result;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        if (!ctx) {
          setStep1Error("canvas 2d context unavailable");
          return;
        }
        ctx.drawImage(img, 0, 0);
        setUploaded({
          canvas: c,
          dataUri,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      };
      img.onerror = () => setStep1Error("failed to decode image");
      img.src = dataUri;
    };
    reader.onerror = () => setStep1Error("failed to read file");
    reader.readAsDataURL(file);
  };

  const runStep2 = async () => {
    if (!uploaded) return;
    setStep2Running(true);
    setStep2Error(null);
    setStep4Result(null);
    try {
      const r = await detectTorsoByVision(sdk, uploaded.canvas);
      setVision(r);
      // Render the debug overlay: source image + chest center + max-logo rect
      const overlay = document.createElement("canvas");
      overlay.width = uploaded.width;
      overlay.height = uploaded.height;
      const ctx = overlay.getContext("2d");
      if (ctx) {
        ctx.drawImage(uploaded.canvas, 0, 0);
        // Max-logo rectangle (cyan, dashed-ish)
        ctx.strokeStyle = "rgba(0, 220, 255, 0.95)";
        ctx.lineWidth = 4;
        ctx.strokeRect(
          r.centerX - r.maxLogoWidth / 2,
          r.centerY - r.maxLogoHeight / 2,
          r.maxLogoWidth,
          r.maxLogoHeight,
        );
        // Center crosshair + tight disc (red)
        ctx.strokeStyle = "rgba(255, 50, 50, 1)";
        ctx.lineWidth = 5;
        const disc = Math.min(r.maxLogoWidth, r.maxLogoHeight) / 2;
        ctx.beginPath();
        ctx.arc(r.centerX, r.centerY, disc, 0, Math.PI * 2);
        ctx.stroke();
        const half = disc + 20;
        ctx.beginPath();
        ctx.moveTo(r.centerX - half, r.centerY);
        ctx.lineTo(r.centerX + half, r.centerY);
        ctx.moveTo(r.centerX, r.centerY - half);
        ctx.lineTo(r.centerX, r.centerY + half);
        ctx.stroke();
      }
      setDebugOverlay(overlay.toDataURL("image/png"));
    } catch (e) {
      setStep2Error(formatError(e));
    } finally {
      setStep2Running(false);
    }
  };

  const runStep3 = async () => {
    setStep3Running(true);
    setStep3Error(null);
    setStep4Result(null);
    try {
      const r = await step3PrepareLogo({ brand });
      setStep3Result(r);
    } catch (e) {
      setStep3Error(formatError(e));
    } finally {
      setStep3Running(false);
    }
  };

  return (
    <section>
      <h2>Branded robot — v11 (Sonnet vision)</h2>
      <p className="lede">
        Simplified 4-step pipeline for testing. Step 1 is now upload-only
        (no FLUX cost). Step 2 uses Sonnet 4.6 in vision mode to locate
        the chest center and compute the max logo dimensions, returning
        JSON.
      </p>

      <h3 style={{ marginTop: 16 }}>Brand brief</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 12,
          marginBottom: 16,
        }}
      >
        {TEST_COMPANIES.map((c, i) => (
          <label
            key={c.name}
            style={{
              display: "block",
              border:
                i === selectedIdx
                  ? "2px solid var(--accent, #4a8)"
                  : "2px solid #ddd",
              borderRadius: 8,
              padding: 12,
              cursor: "pointer",
              margin: 0,
              background: c.backgroundColor,
              color: c.primaryColor,
            }}
          >
            <input
              type="radio"
              name="brand-pick"
              checked={i === selectedIdx}
              onChange={() => setSelectedIdx(i)}
              style={{ position: "absolute", opacity: 0 }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img
                src={c.logoDataUri}
                alt={`${c.name} logo`}
                style={{ width: 56, height: 56, flex: "0 0 auto" }}
              />
              <div>
                <strong style={{ fontSize: "1em" }}>{c.name}</strong>
                <div style={{ fontSize: "0.85em", marginTop: 4 }}>{c.service}</div>
              </div>
            </div>
          </label>
        ))}
      </div>

      {/* ============= Step 1 — UPLOAD ============= */}
      <section style={stepStyle}>
        <h3>Step 1 — Upload an existing image</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Drop a PNG / JPEG you've already generated. No FLUX call, no
          credit cost.
        </p>
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
            marginBottom: 8,
          }}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
            style={{ display: "none" }}
          />
          {uploaded ? (
            <>
              <img
                src={uploaded.dataUri}
                alt="uploaded"
                style={{
                  width: 80,
                  height: 80,
                  objectFit: "contain",
                  background: "#f0f0f0",
                  borderRadius: 4,
                }}
              />
              <span>
                <strong>Loaded</strong> ({uploaded.width} × {uploaded.height}{" "}
                px) — click to replace
              </span>
            </>
          ) : (
            <span style={{ color: "#666" }}>
              Click to pick an image (PNG, JPEG, or WebP)
            </span>
          )}
        </label>
        {step1Error && <div className="error">{step1Error}</div>}
      </section>

      {/* ============= Step 2 — Sonnet vision ============= */}
      <section style={stepStyle}>
        <h3>Step 2 — Locate chest center (Sonnet vision)</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Calls Claude Sonnet 4.6 in vision mode. The model returns
          JSON with the chest center and max logo dimensions
          (15% margin already accounted for).
        </p>
        <button
          type="button"
          onClick={() => void runStep2()}
          disabled={!uploaded || step2Running}
        >
          {step2Running
            ? "Asking Sonnet…"
            : vision
              ? "Re-detect"
              : "Detect chest"}
        </button>
        {step2Error && (
          <div className="error" style={{ marginTop: 8 }}>{step2Error}</div>
        )}
        {vision && debugOverlay && (
          <>
            <div style={{ marginTop: 12, maxWidth: 480 }}>
              <img
                src={debugOverlay}
                alt="vision debug"
                style={{ ...imgStyle, borderRadius: 6 }}
              />
            </div>
            <dl className="kvtable" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <dt>Chest center</dt>
              <dd>
                ({vision.centerX}, {vision.centerY}) px
              </dd>
              <dt>Max logo size</dt>
              <dd>
                {vision.maxLogoWidth} × {vision.maxLogoHeight} px (15% margin inside the chest)
              </dd>
              <dt>Confidence</dt>
              <dd>{(vision.confidence * 100).toFixed(0)}%</dd>
              <dt>Notes</dt>
              <dd style={{ fontStyle: "italic" }}>{vision.notes}</dd>
              <dt>Cost</dt>
              <dd>{vision.creditsSpent.toLocaleString()} mc</dd>
            </dl>
          </>
        )}
      </section>

      {/* ============= Step 3 — Prepare logo ============= */}
      <section style={stepStyle}>
        <h3>Step 3 — Prepare logo</h3>
        <button
          type="button"
          onClick={() => void runStep3()}
          disabled={step3Running}
        >
          {step3Running ? "Processing…" : step3Result ? "Re-process" : "Process logo"}
        </button>
        {step3Error && (
          <div className="error" style={{ marginTop: 8 }}>{step3Error}</div>
        )}
        {step3Result && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginTop: 12,
            }}
          >
            <figure style={{ margin: 0 }}>
              <figcaption style={figcapStyle}>Original</figcaption>
              <img
                src={step3Result.originalDataUri}
                alt="original logo"
                style={{ ...imgStyle, background: "#fff" }}
              />
            </figure>
            <figure style={{ margin: 0 }}>
              <figcaption style={figcapStyle}>
                Processed{" "}
                {step3Result.bgWasRemoved &&
                  `(removed ${step3Result.detectedCornerHex})`}
              </figcaption>
              <img
                src={step3Result.processedDataUri}
                alt="processed logo"
                style={{ ...imgStyle, ...checkerBgStyle }}
              />
            </figure>
          </div>
        )}
      </section>

      {/* ============= Step 4 — Composite ============= */}
      <section style={stepStyle}>
        <h3>Step 4 — Composite</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          {!uploaded || !vision || !step3Result
            ? "Run steps 1, 2 and 3 first."
            : "Sliders re-render the composite live."}
        </p>
        {uploaded && vision && step3Result && (
          <>
            <Step4Controls settings={settings} onChange={setSettings} />
            {step4Result && (
              <div style={{ marginTop: 12, maxWidth: 520 }}>
                <img
                  src={step4Result.dataUri}
                  alt="final composite"
                  style={{ width: "100%", height: "auto", display: "block", borderRadius: 6 }}
                />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <a
                    href={step4Result.dataUri}
                    download={`${brand.name.toLowerCase().replace(/\W+/g, "-")}-mascot.png`}
                  >
                    Download PNG
                  </a>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}

function Step4Controls({
  settings,
  onChange,
}: {
  readonly settings: Step4Settings;
  readonly onChange: (s: Step4Settings) => void;
}) {
  const update = <K extends keyof Step4Settings>(key: K, value: Step4Settings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="stack" style={{ gap: 6 }}>
      <label>
        <span>Blend mode</span>
        <select
          value={settings.blendMode}
          onChange={(e) => update("blendMode", e.target.value as GlobalCompositeOperation)}
        >
          {BLEND_MODES.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Opacity — {((settings.opacity ?? 1) * 100).toFixed(0)}%</span>
        <input
          type="range" min={0.1} max={1} step={0.05}
          value={settings.opacity ?? 1}
          onChange={(e) => update("opacity", Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>
      <label>
        <span>Fill ratio — {((settings.fillRatio ?? 1) * 100).toFixed(0)}%</span>
        <input
          type="range" min={0.3} max={1.4} step={0.05}
          value={settings.fillRatio ?? 1}
          onChange={(e) => update("fillRatio", Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>
      <div className="row" style={{ gap: 12 }}>
        <label style={{ flex: 1 }}>
          <span>X offset — {settings.offsetX}px</span>
          <input
            type="range" min={-200} max={200} step={1}
            value={settings.offsetX}
            onChange={(e) => update("offsetX", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ flex: 1 }}>
          <span>Y offset — {settings.offsetY}px</span>
          <input
            type="range" min={-200} max={200} step={1}
            value={settings.offsetY}
            onChange={(e) => update("offsetY", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
      </div>
      <button
        type="button"
        onClick={() => onChange({ ...settings, offsetX: 0, offsetY: 0 })}
        style={{ alignSelf: "flex-start" }}
      >
        Reset offsets
      </button>
    </div>
  );
}

const stepStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 14,
  border: "1px solid #e5e5e5",
  borderRadius: 8,
};
const figcapStyle: React.CSSProperties = {
  fontSize: "0.8em",
  marginBottom: 6,
  color: "#555",
  fontWeight: 600,
};
const imgStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  display: "block",
};
const checkerBgStyle: React.CSSProperties = {
  background:
    "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px",
  borderRadius: 4,
  padding: 4,
};
