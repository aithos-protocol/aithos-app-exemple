// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — 3-step interactive pipeline.
//
// Each step is independently re-runnable so we can debug the visual
// pipeline without paying the FLUX cost on every iteration. Step 3
// (composite) re-renders live as the user moves sliders — no extra
// API calls.
//
//   Step 1: Generate robot
//     - calls FLUX with the brand-derived prompt
//     - removes the background by flood-fill
//     - detects the torso (colour-match preferred, bbox fallback)
//     - shows the raw FLUX output AND the silhouette with a torso
//       crosshair overlay so the operator can sanity-check
//     - "Regenerate" bumps the seed for a fresh result
//
//   Step 2: Prepare logo
//     - loads the brand's logo from its data URI
//     - if no alpha, runs corner-flood-fill to force transparency
//     - shows original vs processed side by side
//
//   Step 3: Composite (live)
//     - canvas blend with controls: blend mode, opacity, fill ratio,
//       X/Y offset, shadow
//     - download the final PNG

import { useEffect, useRef, useState } from "react";

import {
  pickBlendMode,
  pickTorsoColor,
  step1GenerateRobot,
  step2PrepareLogo,
  step3Composite,
  type Step1Result,
  type Step2Result,
  type Step3Result,
  type Step3Settings,
} from "../lib/brand-agent.js";
import type { BrandProfile } from "../lib/brand-types.js";
import { TEST_COMPANIES } from "../lib/test-companies.js";
import { useSdk } from "../sdk-context.js";
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

const IMAGE_MODEL_CHOICES = [
  { id: "image:imagen-4", label: "Imagen 4 (default — premium brand mascot)" },
  { id: "image:imagen-3", label: "Imagen 3 (flat illustration)" },
  { id: "image:nano-banana", label: "Nano Banana (Gemini Flash Image)" },
  { id: "image:flux-pro-1.1", label: "FLUX Pro 1.1 (legacy)" },
] as const;
type ImageModelChoice = (typeof IMAGE_MODEL_CHOICES)[number]["id"];

export function BrandedRobot() {
  const { sdk, state } = useSdk();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const brand: BrandProfile = TEST_COMPANIES[selectedIdx]!;

  // --- Step 1 state ---
  const [step1Running, setStep1Running] = useState(false);
  const [step1Result, setStep1Result] = useState<Step1Result | null>(null);
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [seedNonce, setSeedNonce] = useState(0);
  const [modelId, setModelId] = useState<ImageModelChoice>("image:imagen-4");

  // --- Step 2 state ---
  const [step2Running, setStep2Running] = useState(false);
  const [step2Result, setStep2Result] = useState<Step2Result | null>(null);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  // --- Step 3 state ---
  // fillRatio defaults to 0.95 — the detector now returns a diameter
  // that already has ~25% margin inside the chest plate (50% of the
  // chest plate's smaller dimension), so the logo fills 95% of THAT
  // already-margined disc. Net effect: logo occupies ~47% of the
  // chest plate, leaving comfortable breathing room on all sides.
  const [settings, setSettings] = useState<Step3Settings>({
    blendMode: "multiply",
    opacity: 1.0,
    fillRatio: 0.95,
    shadowBlur: 4,
    shadowColor: "rgba(0,0,0,0.15)",
    offsetX: 0,
    offsetY: 0,
  });
  const [step3Result, setStep3Result] = useState<Step3Result | null>(null);
  const step3DebounceRef = useRef<number | null>(null);

  // Reset all downstream state when the brand changes
  useEffect(() => {
    setStep1Result(null);
    setStep2Result(null);
    setStep3Result(null);
    setStep1Error(null);
    setStep2Error(null);
    // Default the blend mode to whatever the brand suggests
    setSettings((s) => ({ ...s, blendMode: pickBlendMode(brand) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.name]);

  const isAuthenticated =
    state.canSignAsOwner || state.delegates.length > 0;

  // Auto re-composite when step3 inputs change (debounced)
  useEffect(() => {
    if (!step1Result || !step2Result) return;
    if (step3DebounceRef.current !== null) {
      window.clearTimeout(step3DebounceRef.current);
    }
    step3DebounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await step3Composite({
            robot: step1Result,
            logo: step2Result,
            settings,
          });
          setStep3Result(r);
        } catch (e) {
          // composite errors are rare — keep quiet, the next change will retry
          console.warn("step3 composite failed", e);
        }
      })();
    }, 80);
  }, [step1Result, step2Result, settings]);

  if (!isAuthenticated) {
    return (
      <section>
        <h2>Branded robot — 3-step pipeline</h2>
        <p className="lede">
          Sign in as an owner first so the agent can spend your wallet
          on the FLUX call.
        </p>
      </section>
    );
  }

  const runStep1 = async () => {
    setStep1Running(true);
    setStep1Error(null);
    setStep3Result(null);
    try {
      const r = await step1GenerateRobot({
        brand,
        sdk,
        model: modelId,
        // Each "Regenerate" bumps the seed so the model gives a fresh result
        ...(seedNonce > 0 ? { seedOverride: (brand.seed ?? 0) + seedNonce } : {}),
      });
      setStep1Result(r);
    } catch (e) {
      setStep1Error(formatError(e));
    } finally {
      setStep1Running(false);
    }
  };

  const runStep2 = async () => {
    setStep2Running(true);
    setStep2Error(null);
    setStep3Result(null);
    try {
      const r = await step2PrepareLogo({ brand });
      setStep2Result(r);
    } catch (e) {
      setStep2Error(formatError(e));
    } finally {
      setStep2Running(false);
    }
  };

  return (
    <section>
      <h2>Branded robot — 3-step pipeline</h2>
      <p className="lede">
        Each step can be re-run independently for debugging. Step 3
        (composite) updates live as you move the sliders — no extra
        FLUX call.
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
                <div style={{ fontSize: "0.85em", marginTop: 4 }}>
                  {c.service}
                </div>
                <div
                  style={{
                    fontSize: "0.75em",
                    marginTop: 6,
                    fontFamily: "monospace",
                    opacity: 0.7,
                  }}
                >
                  primary {c.primaryColor} · torso {pickTorsoColor(c)} · bg{" "}
                  {c.backgroundColor}
                </div>
              </div>
            </div>
          </label>
        ))}
      </div>

      {/* ============= Step 1 ============= */}
      <section style={stepStyle}>
        <h3>Step 1 — Generate robot</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Calls the chosen image model with the brand-derived prompt,
          removes the background, and detects the torso center via
          MediaPipe Pose. Hit <strong>Regenerate</strong> to bump the
          seed and try a different result.
        </p>
        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
            Image model
          </span>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value as ImageModelChoice)}
            disabled={step1Running}
            style={{ minWidth: 320 }}
          >
            {IMAGE_MODEL_CHOICES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={() => void runStep1()}
            disabled={step1Running}
          >
            {step1Running
              ? "Generating…"
              : step1Result
                ? "Generate"
                : "Generate robot"}
          </button>
          {step1Result && (
            <button
              type="button"
              onClick={() => {
                setSeedNonce((n) => n + 1);
                setTimeout(() => void runStep1(), 0);
              }}
              disabled={step1Running}
            >
              Regenerate (new seed)
            </button>
          )}
        </div>
        {step1Error && <div className="error" style={{ marginTop: 8 }}>{step1Error}</div>}
        {step1Result && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginTop: 12,
            }}
          >
            <figure style={{ margin: 0 }}>
              <figcaption style={figcapStyle}>
                Raw FLUX output (original background)
              </figcaption>
              <img src={step1Result.rawDataUri} alt="raw flux" style={imgStyle} />
            </figure>
            <figure style={{ margin: 0 }}>
              <figcaption style={figcapStyle}>
                Pose + torso target ({step1Result.torsoSource}
                {step1Result.pose &&
                  ` — hipsVisible=${step1Result.pose.hipsVisible}`}
                )
              </figcaption>
              <img
                src={step1Result.debugOverlayDataUri}
                alt="pose debug"
                style={imgStyle}
              />
            </figure>
          </div>
        )}
        {step1Result && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
              View the FLUX prompt + detection details
            </summary>
            <pre
              style={{
                background: "#f7f7f7",
                padding: 8,
                borderRadius: 4,
                fontSize: "0.8em",
                whiteSpace: "pre-wrap",
              }}
            >
              {step1Result.prompt}
            </pre>
            <dl className="kvtable">
              <dt>Torso center</dt>
              <dd>
                ({step1Result.torso.centerX}, {step1Result.torso.centerY})
              </dd>
              <dt>Torso diameter</dt>
              <dd>{step1Result.torso.diameter}px</dd>
              <dt>Silhouette bbox</dt>
              <dd>
                ({step1Result.bbox.left}, {step1Result.bbox.top}) → (
                {step1Result.bbox.right}, {step1Result.bbox.bottom})
              </dd>
              <dt>Credits spent</dt>
              <dd>{step1Result.creditsSpent.toLocaleString()} mc</dd>
            </dl>
          </details>
        )}
      </section>

      {/* ============= Step 2 ============= */}
      <section style={stepStyle}>
        <h3>Step 2 — Prepare logo</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Loads the brand logo and forces it transparent if needed
          (PNG with a coloured background → flood-fill on the corner
          colour; SVG / already-alpha → pass-through).
        </p>
        <button
          type="button"
          onClick={() => void runStep2()}
          disabled={step2Running}
        >
          {step2Running ? "Processing…" : step2Result ? "Re-process" : "Process logo"}
        </button>
        {step2Error && <div className="error" style={{ marginTop: 8 }}>{step2Error}</div>}
        {step2Result && (
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
                src={step2Result.originalDataUri}
                alt="original logo"
                style={{ ...imgStyle, background: "#fff" }}
              />
            </figure>
            <figure style={{ margin: 0 }}>
              <figcaption style={figcapStyle}>
                Processed (transparent){" "}
                {step2Result.bgWasRemoved &&
                  `— removed ${step2Result.detectedCornerHex}`}
              </figcaption>
              <img
                src={step2Result.processedDataUri}
                alt="processed logo"
                style={{ ...imgStyle, ...checkerBgStyle }}
              />
            </figure>
          </div>
        )}
      </section>

      {/* ============= Step 3 ============= */}
      <section style={stepStyle}>
        <h3>Step 3 — Composite</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          {!step1Result || !step2Result
            ? "Run steps 1 and 2 first."
            : "Sliders re-render the composite live (no extra FLUX call)."}
        </p>
        {step1Result && step2Result && (
          <>
            <Step3Controls settings={settings} onChange={setSettings} />
            {step3Result && (
              <div style={{ marginTop: 12, maxWidth: 520 }}>
                <div style={checkerBgStyle}>
                  <img
                    src={step3Result.dataUri}
                    alt="final composite"
                    style={{ width: "100%", height: "auto", display: "block" }}
                  />
                </div>
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <a
                    href={step3Result.dataUri}
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

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

function Step3Controls({
  settings,
  onChange,
}: {
  readonly settings: Step3Settings;
  readonly onChange: (s: Step3Settings) => void;
}) {
  const update = <K extends keyof Step3Settings>(key: K, value: Step3Settings[K]) =>
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
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>
          Opacity — {((settings.opacity ?? 1) * 100).toFixed(0)}%
        </span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={settings.opacity ?? 1}
          onChange={(e) => update("opacity", Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>
      <label>
        <span>
          Fill ratio — {((settings.fillRatio ?? 1) * 100).toFixed(0)}% of disc
        </span>
        <input
          type="range"
          min={0.3}
          max={1.4}
          step={0.05}
          value={settings.fillRatio ?? 1}
          onChange={(e) => update("fillRatio", Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>
      <div className="row" style={{ gap: 12 }}>
        <label style={{ flex: 1 }}>
          <span>X offset — {settings.offsetX}px</span>
          <input
            type="range"
            min={-200}
            max={200}
            step={1}
            value={settings.offsetX}
            onChange={(e) => update("offsetX", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
        <label style={{ flex: 1 }}>
          <span>Y offset — {settings.offsetY}px</span>
          <input
            type="range"
            min={-200}
            max={200}
            step={1}
            value={settings.offsetY}
            onChange={(e) => update("offsetY", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </label>
      </div>
      <label>
        <span>Shadow blur — {settings.shadowBlur ?? 0}px</span>
        <input
          type="range"
          min={0}
          max={24}
          step={1}
          value={settings.shadowBlur ?? 0}
          onChange={(e) => update("shadowBlur", Number(e.target.value))}
          style={{ width: "100%" }}
        />
      </label>
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

/* -------------------------------------------------------------------------- */
/*  Inline styles                                                             */
/* -------------------------------------------------------------------------- */

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
  borderRadius: 4,
};

const checkerBgStyle: React.CSSProperties = {
  background:
    "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px",
  borderRadius: 4,
  padding: 4,
};
