// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — v12 pipeline.
//
//   Step 1 — GENERATE (brand-prompt + locked composition) OR UPLOAD
//   Step 2 — Sonnet vision (single call, returns JSON with chest geometry)
//   Step 3 — Prepare logo
//   Step 4 — Composite
//
// Step 1 v12 brings back FLUX/Imagen generation alongside upload, but
// with a NEW prompt architecture: the brand-specific brief (editable
// per test) is concatenated with a LOCKED COMPOSITION_TEMPLATE so the
// crop is identical across all 4 brands. That gives us a brand-mascot
// library where every portrait sits in the same frame, the Sonnet
// vision detector sees the same anatomical anchors in roughly the
// same pixel coordinates, and the logo lands consistently.

import { useEffect, useRef, useState } from "react";

import {
  COMPOSITION_TEMPLATE,
  step1GenerateRobot,
  step3PrepareLogo,
  step4Composite,
  type Step1Result,
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

const IMAGE_MODEL_CHOICES = [
  { id: "image:imagen-4", label: "Imagen 4 (default)" },
  { id: "image:imagen-3", label: "Imagen 3" },
  { id: "image:nano-banana", label: "Nano Banana" },
  { id: "image:flux-pro-1.1", label: "FLUX Pro 1.1" },
] as const;
type ImageModelChoice = (typeof IMAGE_MODEL_CHOICES)[number]["id"];

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

  // --- Step 1 state (Generate OR Upload) ---
  const [step1Mode, setStep1Mode] = useState<"generate" | "upload">("generate");
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);
  const [generated, setGenerated] = useState<Step1Result | null>(null);
  const [generating, setGenerating] = useState(false);
  const [modelId, setModelId] = useState<ImageModelChoice>("image:imagen-4");
  const [promptDraft, setPromptDraft] = useState<string>(brand.visualBrief);
  const [promptEdited, setPromptEdited] = useState(false);
  const [seedNonce, setSeedNonce] = useState(0);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // The "active" canvas — comes from upload OR generate, whichever was
  // the latest action.
  const activeCanvas: HTMLCanvasElement | null =
    step1Mode === "generate"
      ? (generated?.rawCanvas ?? null)
      : (uploaded?.canvas ?? null);
  const activeDataUri: string | null =
    step1Mode === "generate"
      ? (generated?.rawDataUri ?? null)
      : (uploaded?.dataUri ?? null);
  const activeSize =
    step1Mode === "generate" && generated
      ? { width: generated.rawCanvas.width, height: generated.rawCanvas.height }
      : uploaded
        ? { width: uploaded.width, height: uploaded.height }
        : null;

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

  // Reset downstream when the active image (or brand) changes.
  useEffect(() => {
    setVision(null);
    setStep3Result(null);
    setStep4Result(null);
    setStep2Error(null);
    setStep3Error(null);
    setDebugOverlay(null);
  }, [brand.name, uploaded, generated]);

  // Reset the editable prompt textarea when brand changes (unless edited).
  useEffect(() => {
    if (!promptEdited) {
      setPromptDraft(brand.visualBrief);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.name]);

  // Auto-recomposite when inputs change.
  useEffect(() => {
    if (!activeCanvas || !activeSize || !activeDataUri || !vision || !step3Result) return;
    if (step4DebounceRef.current !== null) {
      window.clearTimeout(step4DebounceRef.current);
    }
    step4DebounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await step4Composite({
            robot: {
              prompt: "<source>",
              rawBlob: new Blob(),
              rawDataUri: activeDataUri,
              rawCanvas: activeCanvas,
              creditsSpent: 0,
            },
            detection: {
              silhouetteCanvas: activeCanvas,
              bbox: {
                left: 0, top: 0,
                right: activeSize.width - 1, bottom: activeSize.height - 1,
                width: activeSize.width, height: activeSize.height,
              },
              torso: {
                centerX: vision.centerX,
                centerY: vision.centerY,
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
  }, [activeCanvas, activeSize, activeDataUri, vision, step3Result, settings, debugOverlay]);

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

  const runStep1Generate = async () => {
    setGenerating(true);
    setStep1Error(null);
    setGenerated(null);
    try {
      // We use a tiny shim brand override so the operator-edited textarea
      // becomes the brand brief that composeFluxPrompt picks up.
      const r = await step1GenerateRobot({
        brand: { ...brand, visualBrief: promptDraft },
        sdk,
        model: modelId,
        ...(seedNonce > 0 ? { seedOverride: (brand.seed ?? 0) + seedNonce } : {}),
      });
      setGenerated(r);
    } catch (e) {
      setStep1Error(formatError(e));
    } finally {
      setGenerating(false);
    }
  };

  const resetPrompt = () => {
    setPromptDraft(brand.visualBrief);
    setPromptEdited(false);
  };

  const runStep2 = async () => {
    if (!activeCanvas || !activeSize) return;
    setStep2Running(true);
    setStep2Error(null);
    setStep4Result(null);
    try {
      const r = await detectTorsoByVision(sdk, activeCanvas);
      setVision(r);
      // Render the debug overlay: source image + chest center + max-logo rect
      const overlay = document.createElement("canvas");
      overlay.width = activeSize.width;
      overlay.height = activeSize.height;
      const ctx = overlay.getContext("2d");
      if (ctx) {
        ctx.drawImage(activeCanvas, 0, 0);
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

      {/* ============= Step 1 — Generate OR Upload ============= */}
      <section style={stepStyle}>
        <h3>Step 1 — Source image</h3>

        <div className="row" style={{ gap: 16, marginBottom: 12 }}>
          <label>
            <input
              type="radio"
              checked={step1Mode === "generate"}
              onChange={() => setStep1Mode("generate")}
            />{" "}
            <strong>Generate</strong> (brand prompt + locked composition)
          </label>
          <label>
            <input
              type="radio"
              checked={step1Mode === "upload"}
              onChange={() => setStep1Mode("upload")}
            />{" "}
            <strong>Upload</strong> (re-use a PNG, no FLUX cost)
          </label>
        </div>

        {step1Mode === "generate" && (
          <>
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
                Image model
              </span>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value as ImageModelChoice)}
                disabled={generating}
                style={{ minWidth: 280 }}
              >
                {IMAGE_MODEL_CHOICES.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
                Brand brief (per-brand, editable)
                {promptEdited && <em style={{ color: "#a60", marginLeft: 8 }}>(edited)</em>}
              </span>
              <textarea
                value={promptDraft}
                onChange={(e) => {
                  setPromptDraft(e.target.value);
                  setPromptEdited(true);
                }}
                rows={12}
                style={{
                  width: "100%",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.82em",
                  padding: 8,
                  border: "1px solid #ccc",
                  borderRadius: 4,
                  resize: "vertical",
                }}
                disabled={generating}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75em", color: "#888", marginTop: 4 }}>
                <span>{promptDraft.length} chars</span>
                {promptEdited && (
                  <button
                    type="button"
                    onClick={resetPrompt}
                    style={{ background: "transparent", border: "none", color: "#06a", cursor: "pointer", fontSize: "0.75em", padding: 0 }}
                  >
                    Reset to brand default
                  </button>
                )}
              </div>
            </label>

            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
                View the locked composition template (appended automatically)
              </summary>
              <pre style={{ background: "#f7f7f7", padding: 8, borderRadius: 4, fontSize: "0.75em", whiteSpace: "pre-wrap", marginTop: 6 }}>
                {COMPOSITION_TEMPLATE}
              </pre>
            </details>

            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                onClick={() => void runStep1Generate()}
                disabled={generating || !promptDraft.trim()}
              >
                {generating ? "Generating…" : generated ? "Generate" : "Generate robot"}
              </button>
              {generated && (
                <button
                  type="button"
                  onClick={() => {
                    setSeedNonce((n) => n + 1);
                    setTimeout(() => void runStep1Generate(), 0);
                  }}
                  disabled={generating}
                >
                  Regenerate (new seed)
                </button>
              )}
            </div>
          </>
        )}

        {step1Mode === "upload" && (
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
                  style={{ width: 80, height: 80, objectFit: "contain", background: "#f0f0f0", borderRadius: 4 }}
                />
                <span>
                  <strong>Loaded</strong> ({uploaded.width} × {uploaded.height} px) — click to replace
                </span>
              </>
            ) : (
              <span style={{ color: "#666" }}>Click to pick an image (PNG, JPEG, or WebP)</span>
            )}
          </label>
        )}

        {step1Error && <div className="error" style={{ marginTop: 8 }}>{step1Error}</div>}

        {activeDataUri && (
          <div style={{ marginTop: 12, maxWidth: 480 }}>
            <img src={activeDataUri} alt="source" style={{ ...imgStyle, borderRadius: 6 }} />
            {step1Mode === "generate" && generated && (
              <p style={{ fontSize: "0.75em", color: "#666", marginTop: 4 }}>
                {generated.creditsSpent.toLocaleString()} mc spent on this generation.
              </p>
            )}
          </div>
        )}
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
