// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — v13 pipeline (description-driven + logo overlay).
//
// Front-end flow:
//
//   1. Describe the brand:   free-text textarea + 'Generate design'
//                            → Sonnet 4.6 (text) proposes a robot
//                              visualBrief + 3-colour palette as JSON.
//   2. Design (editable):    visualBrief textarea + 3 colour pickers,
//                            seeded by the Sonnet proposal, overridable.
//   3. Logo upload:          PNG/SVG file input. Auto-detects whether
//                            the logo has alpha; the operator can flip
//                            the toggle to force flood-fill or skip it.
//   4. Step 1 — Generate:    visualBrief + locked COMPOSITION_TEMPLATE
//                            + palette → image model.
//   5. Step 2 — Vision:      Sonnet 4.6 (vision) returns logo center,
//                            diameter, and sampled chestColorHex.
//   6. Step 3 — Prepare:     background removal on the uploaded logo.
//   7. Step 3.5 — Recolor:   flatten to a brand-colour silhouette
//                            (primary by default; auto-swap to
//                            secondary if too close to chestColorHex).
//   8. Step 4 — Composite:   recoloured silhouette + multiply blend on
//                            the robot chest. Sliders re-render live.
//
// The locked COMPOSITION_TEMPLATE (in brand-agent.ts) is unchanged
// from v12.2 — it already forbids any chest decoration, leaving the
// chest as a single uniform panel for the logo to land on.

import { useEffect, useRef, useState } from "react";

import {
  COMPOSITION_TEMPLATE,
  DEFAULT_CONTRAST_THRESHOLD,
  step1GenerateRobot,
  step3PrepareLogo,
  step3_5RecolorLogo,
  step4Composite,
  type Step1Result,
  type Step3LogoResult,
  type Step3_5RecolorResult,
  type Step4CompositeResult,
  type Step4Settings,
} from "../lib/brand-agent.js";
import type { HexColor } from "../lib/brand-types.js";
import {
  designRobotFromDescription,
  type DesignProposal,
} from "../lib/design-agent.js";
import {
  detectTorsoByVision,
  type VisionTorsoResult,
} from "../lib/vision-detection.js";
import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const IMAGE_MODEL_CHOICES = [
  { id: "image:imagen-4", label: "Imagen 4 (default)" },
  { id: "image:imagen-3", label: "Imagen 3" },
  { id: "image:nano-banana", label: "Nano Banana" },
  { id: "image:flux-pro-1.1", label: "FLUX Pro 1.1" },
  { id: "image:flux-pro-1.1-ultra", label: "FLUX Pro 1.1 Ultra" },
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

interface UploadedLogo {
  readonly dataUri: string;
  readonly filename: string;
  readonly hasAlpha: boolean;
  readonly width: number;
  readonly height: number;
}

/** Build an ad-hoc BrandProfile from the editable UI state so the
 *  library functions (which still expect a BrandProfile) can be reused
 *  as-is. */
function buildAdHocBrand(args: {
  visualBrief: string;
  primaryColor: HexColor;
  secondaryColor: HexColor;
  backgroundColor: HexColor;
  seed?: number;
  logoDataUri?: string;
  logoHasAlpha?: boolean;
}) {
  return {
    name: "ad-hoc",
    service: "ad-hoc",
    visualBrief: args.visualBrief,
    primaryColor: args.primaryColor,
    secondaryColor: args.secondaryColor,
    backgroundColor: args.backgroundColor,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    logoDataUri: args.logoDataUri ?? "",
    logoHasAlpha: args.logoHasAlpha ?? true,
  };
}

/** Auto-detect transparent corners in a logo to seed the hasAlpha
 *  toggle. Returns true if ANY of the 4 corners has alpha < 250 (i.e.
 *  the logo already has a transparent background). */
async function detectAlphaInCorners(dataUri: string): Promise<{
  hasAlpha: boolean;
  width: number;
  height: number;
}> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) {
        reject(new Error("2d context unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const samples = [
        ctx.getImageData(0, 0, 1, 1).data,
        ctx.getImageData(c.width - 1, 0, 1, 1).data,
        ctx.getImageData(0, c.height - 1, 1, 1).data,
        ctx.getImageData(c.width - 1, c.height - 1, 1, 1).data,
      ];
      const hasAlpha = samples.some((px) => (px[3] ?? 255) < 250);
      resolve({ hasAlpha, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => reject(new Error("logo decode failed"));
    img.src = dataUri;
  });
}

const DEFAULT_DESCRIPTION_PLACEHOLDER =
  "Paste a paragraph describing the website / product / brand here.\n\n" +
  "Example: 'Brewsmith is a specialty coffee subscription that sources " +
  "single-origin beans from small farms in Ethiopia, Colombia, and " +
  "Indonesia. We roast in small batches and ship within 48 hours of " +
  "roasting. Our customers are coffee enthusiasts in their late 20s to " +
  "40s who want better-than-supermarket beans without the hassle of " +
  "visiting a roastery. Tone: warm, knowledgeable, a bit nerdy about " +
  "extraction technique.'";

const DEFAULT_PRIMARY: HexColor = "#3e2723";
const DEFAULT_SECONDARY: HexColor = "#d7a86e";
const DEFAULT_BACKGROUND: HexColor = "#fefaf5";

export function BrandedRobot() {
  const { sdk, state } = useSdk();

  // --- Design state ---
  const [description, setDescription] = useState<string>("");
  const [designRunning, setDesignRunning] = useState(false);
  const [designProposal, setDesignProposal] = useState<DesignProposal | null>(null);
  const [designError, setDesignError] = useState<string | null>(null);

  const [visualBrief, setVisualBrief] = useState<string>("");
  const [primaryColor, setPrimaryColor] = useState<HexColor>(DEFAULT_PRIMARY);
  const [secondaryColor, setSecondaryColor] = useState<HexColor>(DEFAULT_SECONDARY);
  const [backgroundColor, setBackgroundColor] = useState<HexColor>(DEFAULT_BACKGROUND);
  const [briefEdited, setBriefEdited] = useState(false);
  const [colorsEdited, setColorsEdited] = useState(false);

  // --- Logo upload state ---
  const [logo, setLogo] = useState<UploadedLogo | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  // --- Step 1 (generate) state ---
  const [generated, setGenerated] = useState<Step1Result | null>(null);
  const [generating, setGenerating] = useState(false);
  const [modelId, setModelId] = useState<ImageModelChoice>("image:imagen-4");
  const [seedNonce, setSeedNonce] = useState(0);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // --- Step 2 (vision) state ---
  const [step2Running, setStep2Running] = useState(false);
  const [vision, setVision] = useState<VisionTorsoResult | null>(null);
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const [debugOverlay, setDebugOverlay] = useState<string | null>(null);

  // --- Step 3 (prepare logo) state ---
  const [step3Running, setStep3Running] = useState(false);
  const [step3Result, setStep3Result] = useState<Step3LogoResult | null>(null);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  // --- Step 3.5 (recolor) state ---
  const [step3_5Running, setStep3_5Running] = useState(false);
  const [step3_5Result, setStep3_5Result] = useState<Step3_5RecolorResult | null>(null);
  const [step3_5Error, setStep3_5Error] = useState<string | null>(null);
  const [contrastThreshold, setContrastThreshold] = useState<number>(
    DEFAULT_CONTRAST_THRESHOLD,
  );

  // --- Step 4 (composite) state ---
  const [settings, setSettings] = useState<Step4Settings>({
    blendMode: "multiply",
    opacity: 0.9,
    fillRatio: 0.95,
    shadowBlur: 4,
    shadowColor: "rgba(0,0,0,0.15)",
    offsetX: 0,
    offsetY: 0,
  });
  const [step4Result, setStep4Result] = useState<Step4CompositeResult | null>(null);
  const step4DebounceRef = useRef<number | null>(null);

  // Populate editable fields when a fresh proposal arrives.
  useEffect(() => {
    if (designProposal === null) return;
    if (!briefEdited) setVisualBrief(designProposal.visualBrief);
    if (!colorsEdited) {
      setPrimaryColor(designProposal.primaryColor);
      setSecondaryColor(designProposal.secondaryColor);
      setBackgroundColor(designProposal.backgroundColor);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designProposal]);

  // Reset downstream when the robot image (or logo) changes.
  useEffect(() => {
    setVision(null);
    setDebugOverlay(null);
    setStep2Error(null);
    setStep3Result(null);
    setStep3Error(null);
    setStep3_5Result(null);
    setStep3_5Error(null);
    setStep4Result(null);
  }, [generated, logo]);

  // Auto-recomposite (Step 4) when its inputs settle.
  useEffect(() => {
    if (!generated || !vision || !step3_5Result) return;
    if (step4DebounceRef.current !== null) {
      window.clearTimeout(step4DebounceRef.current);
    }
    step4DebounceRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await step4Composite({
            robot: generated,
            detection: {
              silhouetteCanvas: generated.rawCanvas,
              bbox: {
                left: 0, top: 0,
                right: generated.rawCanvas.width - 1,
                bottom: generated.rawCanvas.height - 1,
                width: generated.rawCanvas.width,
                height: generated.rawCanvas.height,
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
            logo: step3_5Result,
            settings,
          });
          setStep4Result(r);
        } catch (e) {
          console.warn("step4 composite failed", e);
        }
      })();
    }, 80);
  }, [generated, vision, step3_5Result, settings, debugOverlay]);

  const isAuthenticated = state.canSignAsOwner || state.delegates.length > 0;
  if (!isAuthenticated) {
    return (
      <section>
        <h2>Branded robot — v13</h2>
        <p className="lede">
          Sign in as an owner first so the agent can spend your wallet on
          the Sonnet + image-generation calls.
        </p>
      </section>
    );
  }

  // -------- handlers -----------------------------------------------------

  const runDesign = async () => {
    setDesignRunning(true);
    setDesignError(null);
    setDesignProposal(null);
    try {
      const r = await designRobotFromDescription(sdk, description);
      setDesignProposal(r);
    } catch (e) {
      setDesignError(formatError(e));
    } finally {
      setDesignRunning(false);
    }
  };

  const applyProposalToEditors = () => {
    if (!designProposal) return;
    setVisualBrief(designProposal.visualBrief);
    setPrimaryColor(designProposal.primaryColor);
    setSecondaryColor(designProposal.secondaryColor);
    setBackgroundColor(designProposal.backgroundColor);
    setBriefEdited(false);
    setColorsEdited(false);
  };

  const onLogoUpload = (file: File) => {
    setLogoError(null);
    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") {
        setLogoError("FileReader returned non-string");
        return;
      }
      try {
        const { hasAlpha, width, height } = await detectAlphaInCorners(reader.result);
        setLogo({
          dataUri: reader.result,
          filename: file.name,
          hasAlpha,
          width,
          height,
        });
      } catch (e) {
        setLogoError(formatError(e));
      }
    };
    reader.onerror = () => setLogoError("failed to read file");
    reader.readAsDataURL(file);
  };

  const runStep1Generate = async () => {
    setGenerating(true);
    setStep1Error(null);
    setGenerated(null);
    try {
      const r = await step1GenerateRobot({
        brand: buildAdHocBrand({
          visualBrief,
          primaryColor,
          secondaryColor,
          backgroundColor,
          ...(seedNonce > 0 ? { seed: seedNonce } : {}),
        }),
        sdk,
        model: modelId,
      });
      setGenerated(r);
    } catch (e) {
      setStep1Error(formatError(e));
    } finally {
      setGenerating(false);
    }
  };

  const runStep2 = async () => {
    if (!generated) return;
    setStep2Running(true);
    setStep2Error(null);
    setStep3_5Result(null);
    setStep3_5Error(null);
    setStep4Result(null);
    try {
      const r = await detectTorsoByVision(sdk, generated.rawCanvas);
      setVision(r);
      // Debug overlay: source image + chest center + logo disc
      const overlay = document.createElement("canvas");
      overlay.width = generated.rawCanvas.width;
      overlay.height = generated.rawCanvas.height;
      const ctx = overlay.getContext("2d");
      if (ctx) {
        ctx.drawImage(generated.rawCanvas, 0, 0);
        ctx.strokeStyle = "rgba(0, 220, 255, 0.95)";
        ctx.lineWidth = 4;
        ctx.strokeRect(
          r.centerX - r.maxLogoWidth / 2,
          r.centerY - r.maxLogoHeight / 2,
          r.maxLogoWidth,
          r.maxLogoHeight,
        );
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
    if (!logo) return;
    setStep3Running(true);
    setStep3Error(null);
    setStep3_5Result(null);
    setStep3_5Error(null);
    setStep4Result(null);
    try {
      const r = await step3PrepareLogo({
        brand: buildAdHocBrand({
          visualBrief,
          primaryColor,
          secondaryColor,
          backgroundColor,
          logoDataUri: logo.dataUri,
          logoHasAlpha: logo.hasAlpha,
        }),
      });
      setStep3Result(r);
    } catch (e) {
      setStep3Error(formatError(e));
    } finally {
      setStep3Running(false);
    }
  };

  const runStep3_5 = async () => {
    if (!step3Result) return;
    setStep3_5Running(true);
    setStep3_5Error(null);
    setStep4Result(null);
    try {
      const r = await step3_5RecolorLogo({
        brand: buildAdHocBrand({
          visualBrief,
          primaryColor,
          secondaryColor,
          backgroundColor,
        }),
        logo: step3Result,
        chestColorHex: vision?.chestColorHex ?? null,
        contrastThreshold,
      });
      setStep3_5Result(r);
    } catch (e) {
      setStep3_5Error(formatError(e));
    } finally {
      setStep3_5Running(false);
    }
  };

  return (
    <section>
      <h2>Branded robot — v13 (description-driven, with logo)</h2>
      <p className="lede">
        Describe the brand → Sonnet proposes a visualBrief + palette →
        upload a logo → generate the robot → Sonnet locates the chest →
        the logo is background-removed, flattened to a brand-colour
        silhouette (auto-contrast vs the chest), and composited with a
        multiply blend.
      </p>

      {/* ===================== Describe the brand ===================== */}
      <section style={stepStyle}>
        <h3>Describe the brand</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Free text. Anything that helps Sonnet picture the robot: what
          the company does, who the customers are, the tone you'd want on
          the homepage, any visual references you already have in mind.
          Don't write framing instructions — those are owned by the
          locked composition template downstream.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={DEFAULT_DESCRIPTION_PLACEHOLDER}
          rows={10}
          style={textareaStyle}
          disabled={designRunning}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75em", color: "#888", marginTop: 4 }}>
          <span>{description.length} chars</span>
          <span>min ~10 chars to enable Sonnet</span>
        </div>

        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <button
            type="button"
            onClick={() => void runDesign()}
            disabled={designRunning || description.trim().length < 10}
          >
            {designRunning
              ? "Asking Sonnet…"
              : designProposal
                ? "Re-generate design"
                : "Generate design"}
          </button>
          {designProposal && (briefEdited || colorsEdited) && (
            <button type="button" onClick={applyProposalToEditors}>
              Reset editors to last proposal
            </button>
          )}
        </div>

        {designError && (
          <div className="error" style={{ marginTop: 8 }}>{designError}</div>
        )}

        {designProposal && (
          <dl className="kvtable" style={{ marginTop: 12, fontSize: "0.85em" }}>
            <dt>Sonnet reasoning</dt>
            <dd style={{ fontStyle: "italic" }}>{designProposal.reasoning}</dd>
            <dt>Cost</dt>
            <dd>{designProposal.creditsSpent.toLocaleString()} mc</dd>
          </dl>
        )}
      </section>

      {/* ===================== Design — editable ===================== */}
      <section style={stepStyle}>
        <h3>Design (editable)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sonnet's proposal lands here. Tweak anything before generation
          — the locked composition template (crop, pose, lighting style)
          is appended automatically.
        </p>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
            visualBrief
            {briefEdited && designProposal && (
              <em style={{ color: "#a60", marginLeft: 8 }}>(edited)</em>
            )}
          </span>
          <textarea
            value={visualBrief}
            onChange={(e) => {
              setVisualBrief(e.target.value);
              setBriefEdited(true);
            }}
            rows={10}
            placeholder="Sonnet will populate this — or write a robot brief yourself."
            style={{
              ...textareaStyle,
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.82em",
            }}
            disabled={generating}
          />
          <div style={{ fontSize: "0.75em", color: "#888", marginTop: 4 }}>
            {visualBrief.length} chars
          </div>
        </label>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
          }}
        >
          <ColorField
            label="Primary"
            value={primaryColor}
            onChange={(v) => { setPrimaryColor(v); setColorsEdited(true); }}
            edited={colorsEdited && designProposal !== null}
            disabled={generating}
          />
          <ColorField
            label="Secondary"
            value={secondaryColor}
            onChange={(v) => { setSecondaryColor(v); setColorsEdited(true); }}
            edited={colorsEdited && designProposal !== null}
            disabled={generating}
          />
          <ColorField
            label="Background"
            value={backgroundColor}
            onChange={(v) => { setBackgroundColor(v); setColorsEdited(true); }}
            edited={colorsEdited && designProposal !== null}
            disabled={generating}
          />
        </div>

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
            View the locked composition template (appended automatically at Step 1)
          </summary>
          <pre style={{ background: "#f7f7f7", padding: 8, borderRadius: 4, fontSize: "0.75em", whiteSpace: "pre-wrap", marginTop: 6 }}>
            {COMPOSITION_TEMPLATE}
          </pre>
        </details>
      </section>

      {/* ===================== Logo upload ===================== */}
      <section style={stepStyle}>
        <h3>Logo upload</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          PNG, JPEG, SVG, or WebP. Transparent-background logos are
          detected automatically (you can override with the toggle).
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
          }}
        >
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLogoUpload(f);
            }}
            style={{ display: "none" }}
          />
          {logo ? (
            <>
              <img
                src={logo.dataUri}
                alt="logo"
                style={{ width: 64, height: 64, objectFit: "contain", background: "#f0f0f0", borderRadius: 4 }}
              />
              <span>
                <strong>{logo.filename}</strong> ({logo.width}×{logo.height} px)
                — click to replace
              </span>
            </>
          ) : (
            <span style={{ color: "#666" }}>Click to pick a logo file</span>
          )}
        </label>

        {logo && (
          <label style={{ display: "block", marginTop: 10, fontSize: "0.85em" }}>
            <input
              type="checkbox"
              checked={logo.hasAlpha}
              onChange={(e) => setLogo({ ...logo, hasAlpha: e.target.checked })}
              style={{ marginRight: 6 }}
            />
            Logo already has a transparent background — skip flood-fill at Step 3.
            <em style={{ color: "#888", marginLeft: 6 }}>
              (auto-detected: {logo.hasAlpha ? "yes" : "no"})
            </em>
          </label>
        )}

        {logoError && (
          <div className="error" style={{ marginTop: 8 }}>{logoError}</div>
        )}
      </section>

      {/* ===================== Step 1 — Generate ===================== */}
      <section style={stepStyle}>
        <h3>Step 1 — Generate robot image</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sends <code>visualBrief</code> + locked composition template +
          colour palette to the selected image model.
        </p>

        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>Image model</span>
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

        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            onClick={() => void runStep1Generate()}
            disabled={generating || visualBrief.trim().length === 0}
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

        {step1Error && <div className="error" style={{ marginTop: 8 }}>{step1Error}</div>}

        {generated && (
          <div style={{ marginTop: 12, maxWidth: 520 }}>
            <img src={generated.rawDataUri} alt="generated robot" style={{ ...imgStyle, borderRadius: 6 }} />
            <div className="row" style={{ gap: 8, marginTop: 8, alignItems: "center" }}>
              <a href={generated.rawDataUri} download="robot.png">Download PNG</a>
              <span style={{ fontSize: "0.75em", color: "#666" }}>
                {generated.creditsSpent.toLocaleString()} mc spent
              </span>
            </div>
          </div>
        )}
      </section>

      {/* ===================== Step 2 — Vision ===================== */}
      <section style={stepStyle}>
        <h3>Step 2 — Locate chest (Sonnet vision)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sonnet 4.6 vision returns the logo center, max diameter, and
          samples a chest surface colour used downstream for auto-contrast.
        </p>
        <button
          type="button"
          onClick={() => void runStep2()}
          disabled={!generated || step2Running}
        >
          {step2Running ? "Asking Sonnet…" : vision ? "Re-detect" : "Detect chest"}
        </button>
        {step2Error && <div className="error" style={{ marginTop: 8 }}>{step2Error}</div>}
        {vision && debugOverlay && (
          <>
            <div style={{ marginTop: 12, maxWidth: 480 }}>
              <img src={debugOverlay} alt="vision debug" style={{ ...imgStyle, borderRadius: 6 }} />
            </div>
            <dl className="kvtable" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <dt>Logo center</dt>
              <dd>({vision.centerX}, {vision.centerY}) px</dd>
              <dt>Logo diameter</dt>
              <dd>{Math.min(vision.maxLogoWidth, vision.maxLogoHeight)} px</dd>
              <dt>Chest colour</dt>
              <dd>
                {vision.chestColorHex ? (
                  <>
                    <span style={{
                      display: "inline-block",
                      width: 16, height: 16,
                      background: vision.chestColorHex,
                      border: "1px solid #888",
                      verticalAlign: "middle",
                      marginRight: 6,
                    }} />
                    <code>{vision.chestColorHex}</code>
                  </>
                ) : <em style={{ color: "#a60" }}>not returned</em>}
              </dd>
              <dt>Confidence</dt>
              <dd>{(vision.confidence * 100).toFixed(0)}%</dd>
              <dt>Reasoning</dt>
              <dd style={{ fontStyle: "italic" }}>{vision.notes}</dd>
              <dt>Cost</dt>
              <dd>{vision.creditsSpent.toLocaleString()} mc</dd>
            </dl>
          </>
        )}
      </section>

      {/* ===================== Step 3 — Prepare logo ===================== */}
      <section style={stepStyle}>
        <h3>Step 3 — Prepare logo (transparency)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Removes the logo's solid background by flood-filling from the
          4 corners. Skipped if the upload already has alpha.
        </p>
        <button
          type="button"
          onClick={() => void runStep3()}
          disabled={!logo || step3Running}
        >
          {step3Running ? "Processing…" : step3Result ? "Re-process" : "Process logo"}
        </button>
        {!logo && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Upload a logo first.
          </em>
        )}
        {step3Error && <div className="error" style={{ marginTop: 8 }}>{step3Error}</div>}
        {step3Result && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
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

      {/* ===================== Step 3.5 — Recolor silhouette ===================== */}
      <section style={stepStyle}>
        <h3>Step 3.5 — Recolour to brand-colour silhouette</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Flattens the logo to a monochrome silhouette in the primary
          colour. If the primary clashes with the chest surface colour
          sampled by Sonnet, auto-swaps to the secondary so the logo
          stays legible.
        </p>

        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ display: "block", fontSize: "0.85em" }}>
            Contrast threshold (RGB distance) — {contrastThreshold}
            <em style={{ marginLeft: 8, color: "#888" }}>
              (default {DEFAULT_CONTRAST_THRESHOLD}; below this, swap to secondary)
            </em>
          </span>
          <input
            type="range" min={0} max={200} step={5}
            value={contrastThreshold}
            onChange={(e) => setContrastThreshold(Number(e.target.value))}
            style={{ width: "100%", maxWidth: 360 }}
          />
        </label>

        <button
          type="button"
          onClick={() => void runStep3_5()}
          disabled={!step3Result || step3_5Running}
        >
          {step3_5Running
            ? "Recolouring…"
            : step3_5Result
              ? "Re-apply recolour"
              : "Recolour logo"}
        </button>
        {!step3Result && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Run Step 3 first.
          </em>
        )}
        {step3_5Error && <div className="error" style={{ marginTop: 8 }}>{step3_5Error}</div>}

        {step3_5Result && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <figure style={{ margin: 0 }}>
                <figcaption style={figcapStyle}>Input (transparent logo)</figcaption>
                <img
                  src={step3Result?.processedDataUri ?? ""}
                  alt="input"
                  style={{ ...imgStyle, ...checkerBgStyle }}
                />
              </figure>
              <figure style={{ margin: 0 }}>
                <figcaption style={figcapStyle}>
                  Silhouette ({step3_5Result.colorUsed} = <code>{step3_5Result.colorHex}</code>)
                  {step3_5Result.contrastTriggered && (
                    <em style={{ color: "#a60", marginLeft: 6 }}>auto-swapped</em>
                  )}
                </figcaption>
                <img
                  src={step3_5Result.processedDataUri}
                  alt="recoloured logo"
                  style={{ ...imgStyle, ...checkerBgStyle }}
                />
              </figure>
            </div>

            <dl className="kvtable" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <dt>Distance(primary, chest)</dt>
              <dd>
                {step3_5Result.distanceToPrimary === null
                  ? <em>no chest colour from Sonnet</em>
                  : step3_5Result.distanceToPrimary.toFixed(0)}
                {step3_5Result.distanceToPrimary !== null && (
                  <em style={{ marginLeft: 8, color: "#888" }}>
                    {step3_5Result.distanceToPrimary < step3_5Result.thresholdUsed
                      ? "(below threshold → too close)"
                      : "(above threshold → ok)"}
                  </em>
                )}
              </dd>
              <dt>Distance(secondary, chest)</dt>
              <dd>
                {step3_5Result.distanceToSecondary === null
                  ? "—"
                  : step3_5Result.distanceToSecondary.toFixed(0)}
              </dd>
              <dt>Decision</dt>
              <dd>
                Using <strong>{step3_5Result.colorUsed}</strong> ({step3_5Result.colorHex})
                {step3_5Result.contrastTriggered && " — auto-swapped from primary"}
              </dd>
            </dl>
          </>
        )}
      </section>

      {/* ===================== Step 4 — Composite ===================== */}
      <section style={stepStyle}>
        <h3>Step 4 — Composite</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          {!generated || !vision || !step3_5Result
            ? "Run Steps 1, 2, 3 and 3.5 first."
            : "Sliders re-render the composite live (multiply by default)."}
        </p>
        {generated && vision && step3_5Result && (
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
                    download={`mascot-${Date.now()}.png`}
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
/*  Step 4 controls                                                           */
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

/* -------------------------------------------------------------------------- */
/*  Inputs                                                                    */
/* -------------------------------------------------------------------------- */

function ColorField({
  label,
  value,
  onChange,
  edited,
  disabled,
}: {
  readonly label: string;
  readonly value: HexColor;
  readonly onChange: (v: HexColor) => void;
  readonly edited: boolean;
  readonly disabled: boolean;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
        {label}
        {edited && <em style={{ color: "#a60", marginLeft: 8 }}>(edited)</em>}
      </span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value as HexColor)}
          disabled={disabled}
          style={{ width: 44, height: 32, padding: 0, border: "1px solid #ccc", borderRadius: 4, cursor: disabled ? "not-allowed" : "pointer" }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toLowerCase() as HexColor);
          }}
          disabled={disabled}
          spellCheck={false}
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.85em",
            padding: "4px 6px",
            border: "1px solid #ccc",
            borderRadius: 4,
            width: 100,
          }}
        />
      </div>
    </label>
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
const textareaStyle: React.CSSProperties = {
  width: "100%",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSize: "0.9em",
  padding: 10,
  border: "1px solid #ccc",
  borderRadius: 4,
  resize: "vertical",
};
