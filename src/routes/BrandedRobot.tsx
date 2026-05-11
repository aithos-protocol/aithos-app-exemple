// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — 4-step interactive pipeline (v8).
//
//   Step 1 — Generate robot
//     - Editable prompt textarea (pre-filled from the brand profile)
//     - Image model picker (Imagen 4 default, others available)
//     - Output: raw model image only — no detection runs here
//
//   Step 2 — Detect torso  (NEW manual trigger)
//     - Bg removal + MediaPipe Pose + debug overlay
//     - Output: silhouette bbox, torso center, suggested diameter
//
//   Step 3 — Prepare logo
//   Step 4 — Composite (live)
//
// Each step is independently re-runnable so the operator can iterate
// on the prompt (Step 1) without re-paying the FLUX cost, and tweak
// the composite (Step 4) without re-running detection.

import { useEffect, useRef, useState } from "react";

import {
  composeFluxPrompt,
  pickBlendMode,
  pickTorsoColor,
  step1GenerateRobot,
  step2DetectTorso,
  step3PrepareLogo,
  step4Composite,
  type Step1Result,
  type Step2DetectResult,
  type Step3LogoResult,
  type Step4CompositeResult,
  type Step4Settings,
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
  // Editable prompt textarea — initialised from composeFluxPrompt(brand),
  // resync'd when the brand changes UNLESS the user has been editing.
  const [promptDraft, setPromptDraft] = useState<string>(() => composeFluxPrompt(brand));
  const [promptEdited, setPromptEdited] = useState(false);

  // --- Step 2 state (NEW — manual detection) ---
  const [step2Running, setStep2Running] = useState(false);
  const [step2Result, setStep2Result] = useState<Step2DetectResult | null>(null);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  // --- Step 3 state (logo) ---
  const [step3Running, setStep3Running] = useState(false);
  const [step3Result, setStep3Result] = useState<Step3LogoResult | null>(null);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  // --- Step 4 state (composite — live re-renders on slider change) ---
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

  // Reset downstream state + reset the prompt textarea when the brand
  // changes — unless the user has edited the prompt in which case
  // we preserve their text (they'll reset manually if they want).
  useEffect(() => {
    setStep1Result(null);
    setStep2Result(null);
    setStep3Result(null);
    setStep4Result(null);
    setStep1Error(null);
    setStep2Error(null);
    setStep3Error(null);
    if (!promptEdited) {
      setPromptDraft(composeFluxPrompt(brand));
    }
    setSettings((s) => ({ ...s, blendMode: pickBlendMode(brand) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand.name]);

  // Auto re-composite Step 4 when any input changes (debounced).
  useEffect(() => {
    if (!step1Result || !step2Result || !step3Result) return;
    if (step4DebounceRef.current !== null) {
      window.clearTimeout(step4DebounceRef.current);
    }
    step4DebounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await step4Composite({
            robot: step1Result,
            detection: step2Result,
            logo: step3Result,
            settings,
          });
          setStep4Result(r);
        } catch (e) {
          console.warn("step4 composite failed", e);
        }
      })();
    }, 80);
  }, [step1Result, step2Result, step3Result, settings]);

  const isAuthenticated = state.canSignAsOwner || state.delegates.length > 0;
  if (!isAuthenticated) {
    return (
      <section>
        <h2>Branded robot — 4-step pipeline</h2>
        <p className="lede">
          Sign in as an owner first so the agent can spend your wallet on
          the image-model call.
        </p>
      </section>
    );
  }

  const runStep1 = async () => {
    setStep1Running(true);
    setStep1Error(null);
    // Step 1 invalidates downstream steps
    setStep2Result(null);
    setStep4Result(null);
    try {
      const r = await step1GenerateRobot({
        brand,
        sdk,
        model: modelId,
        promptOverride: promptDraft,
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
    if (!step1Result) return;
    setStep2Running(true);
    setStep2Error(null);
    setStep4Result(null);
    try {
      const r = await step2DetectTorso({
        brand,
        rawCanvas: step1Result.rawCanvas,
        sdk,
      });
      setStep2Result(r);
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

  const resetPrompt = () => {
    setPromptDraft(composeFluxPrompt(brand));
    setPromptEdited(false);
  };

  return (
    <section>
      <h2>Branded robot — 4-step pipeline</h2>
      <p className="lede">
        Each step is independently re-runnable. Edit the prompt in
        Step 1 to iterate on the visual style without re-running pose
        detection — Step 2 is now a separate manual trigger.
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

      {/* ============= Step 1 — Generate robot ============= */}
      <section style={stepStyle}>
        <h3>Step 1 — Generate robot</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Calls the image model with the prompt below. Edit the prompt
          to iterate on the style — each call costs ~40 000 mc.
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

        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
            Prompt {promptEdited && <em style={{ color: "#a60" }}>(edited)</em>}
          </span>
          <textarea
            value={promptDraft}
            onChange={(e) => {
              setPromptDraft(e.target.value);
              setPromptEdited(true);
            }}
            rows={10}
            style={{
              width: "100%",
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.85em",
              padding: 8,
              border: "1px solid #ccc",
              borderRadius: 4,
              resize: "vertical",
            }}
            disabled={step1Running}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "0.75em",
              color: "#888",
              marginTop: 4,
            }}
          >
            <span>{promptDraft.length} chars</span>
            {promptEdited && (
              <button
                type="button"
                onClick={resetPrompt}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#06a",
                  cursor: "pointer",
                  fontSize: "0.75em",
                  padding: 0,
                }}
              >
                Reset to brand-derived prompt
              </button>
            )}
          </div>
        </label>

        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={() => void runStep1()}
            disabled={step1Running || !promptDraft.trim()}
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
          <div style={{ marginTop: 12, maxWidth: 480 }}>
            <img
              src={step1Result.rawDataUri}
              alt="raw robot"
              style={{ ...imgStyle, borderRadius: 6 }}
            />
            <p style={{ fontSize: "0.75em", color: "#666", marginTop: 4 }}>
              Credits spent: {step1Result.creditsSpent.toLocaleString()} mc
            </p>
          </div>
        )}
      </section>

      {/* ============= Step 2 — Detect torso (NEW) ============= */}
      <section style={stepStyle}>
        <h3>Step 2 — Detect torso</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Removes the background, runs MediaPipe Pose, and computes the
          logo target position + size. {step1Result ? "" : "Run Step 1 first."}
        </p>
        <button
          type="button"
          onClick={() => void runStep2()}
          disabled={!step1Result || step2Running}
        >
          {step2Running
            ? "Detecting…"
            : step2Result
              ? "Re-detect"
              : "Detect torso"}
        </button>
        {step2Error && <div className="error" style={{ marginTop: 8 }}>{step2Error}</div>}
        {step2Result && (
          <>
            <div style={{ marginTop: 12, maxWidth: 480 }}>
              <img
                src={step2Result.debugOverlayDataUri}
                alt="pose debug"
                style={{ ...imgStyle, borderRadius: 6 }}
              />
            </div>
            <dl className="kvtable" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <dt>Strategy</dt>
              <dd>
                {step2Result.torsoSource}
                {step2Result.pose && ` (hipsVisible=${step2Result.pose.hipsVisible})`}
              </dd>
              <dt>Robot bbox</dt>
              <dd>
                ({step2Result.bbox.left}, {step2Result.bbox.top}) →{" "}
                ({step2Result.bbox.right}, {step2Result.bbox.bottom}) —{" "}
                {step2Result.bbox.width}×{step2Result.bbox.height}px
              </dd>
              <dt>Logo target</dt>
              <dd>
                center ({step2Result.torso.centerX}, {step2Result.torso.centerY}),
                diameter {step2Result.torso.diameter}px
              </dd>
            </dl>
          </>
        )}
      </section>

      {/* ============= Step 3 — Prepare logo ============= */}
      <section style={stepStyle}>
        <h3>Step 3 — Prepare logo</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          Loads the brand's logo and forces transparency if needed.
        </p>
        <button
          type="button"
          onClick={() => void runStep3()}
          disabled={step3Running}
        >
          {step3Running ? "Processing…" : step3Result ? "Re-process" : "Process logo"}
        </button>
        {step3Error && <div className="error" style={{ marginTop: 8 }}>{step3Error}</div>}
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
                Processed (transparent){" "}
                {step3Result.bgWasRemoved &&
                  `— removed ${step3Result.detectedCornerHex}`}
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

      {/* ============= Step 4 — Composite (live) ============= */}
      <section style={stepStyle}>
        <h3>Step 4 — Composite</h3>
        <p style={{ fontSize: "0.9em", color: "#555" }}>
          {!step1Result || !step2Result || !step3Result
            ? "Run steps 1, 2 and 3 first."
            : "Sliders re-render the composite live."}
        </p>
        {step1Result && step2Result && step3Result && (
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

/* -------------------------------------------------------------------------- */
/*  Sub-components                                                            */
/* -------------------------------------------------------------------------- */

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
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Opacity — {((settings.opacity ?? 1) * 100).toFixed(0)}%</span>
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
        <span>Fill ratio — {((settings.fillRatio ?? 1) * 100).toFixed(0)}%</span>
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
};

const checkerBgStyle: React.CSSProperties = {
  background:
    "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px",
  borderRadius: 4,
  padding: 4,
};
