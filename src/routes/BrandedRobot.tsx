// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — v13 pipeline.
//
// v13 reorients the front-end around a REAL site description instead
// of a hardcoded brand picker. The 4 test companies are gone. The
// operator types (or pastes) a free-text description of a website /
// product / business; Sonnet (text mode) is asked to ACT AS A BRAND-
// MASCOT ART DIRECTOR and propose:
//
//   - a paragraph-length visualBrief describing the robot mascot's
//     appearance (silhouette, materials, mood, small accent), WITHOUT
//     touching framing/composition (which the locked COMPOSITION_TEMPLATE
//     in brand-agent.ts still owns).
//   - a tight 3-colour palette (primary, secondary, background).
//
// Both outputs flow into editable controls — the operator can tweak
// the brief in a textarea and override any colour via colour pickers
// — before clicking "Generate robot" (Step 1, same code path as v11/v12).
//
// Logo overlay (Steps 2-4 in v11/v12 — chest detection, logo prep,
// composite) is OUT OF SCOPE for v13. The image-pipeline code still
// exists in src/lib and we'll wire it back in v14 once we decide how
// the user provides their logo.

import { useEffect, useState } from "react";

import {
  COMPOSITION_TEMPLATE,
  step1GenerateRobot,
  type Step1Result,
} from "../lib/brand-agent.js";
import type { HexColor } from "../lib/brand-types.js";
import {
  designRobotFromDescription,
  type DesignProposal,
} from "../lib/design-agent.js";
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

/** Lightweight placeholder so we can call step1GenerateRobot without a
 *  test-company. The image pipeline only reads visualBrief + the 3
 *  colours from the brand object; logo fields stay empty in v13. */
function buildAdHocBrand(args: {
  visualBrief: string;
  primaryColor: HexColor;
  secondaryColor: HexColor;
  backgroundColor: HexColor;
  seed?: number;
}) {
  return {
    name: "ad-hoc",
    service: "ad-hoc",
    visualBrief: args.visualBrief,
    primaryColor: args.primaryColor,
    secondaryColor: args.secondaryColor,
    backgroundColor: args.backgroundColor,
    ...(args.seed !== undefined ? { seed: args.seed } : {}),
    logoDataUri: "",
    logoHasAlpha: true,
  };
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

  // --- Design state (the new front of the pipeline) -----------------
  const [description, setDescription] = useState<string>("");
  const [designRunning, setDesignRunning] = useState(false);
  const [designProposal, setDesignProposal] = useState<DesignProposal | null>(null);
  const [designError, setDesignError] = useState<string | null>(null);

  // Editable design fields. Default values are placeholders the user
  // can ignore (and Sonnet will overwrite). When Sonnet returns, we
  // populate these from the proposal — but only if the operator hasn't
  // manually edited them (so a re-run doesn't clobber tweaks).
  const [visualBrief, setVisualBrief] = useState<string>("");
  const [primaryColor, setPrimaryColor] = useState<HexColor>(DEFAULT_PRIMARY);
  const [secondaryColor, setSecondaryColor] = useState<HexColor>(DEFAULT_SECONDARY);
  const [backgroundColor, setBackgroundColor] = useState<HexColor>(DEFAULT_BACKGROUND);
  const [briefEdited, setBriefEdited] = useState(false);
  const [colorsEdited, setColorsEdited] = useState(false);

  // --- Step 1 state (generate image) --------------------------------
  const [generated, setGenerated] = useState<Step1Result | null>(null);
  const [generating, setGenerating] = useState(false);
  const [modelId, setModelId] = useState<ImageModelChoice>("image:imagen-4");
  const [seedNonce, setSeedNonce] = useState(0);
  const [step1Error, setStep1Error] = useState<string | null>(null);

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

  return (
    <section>
      <h2>Branded robot — v13 (description-driven design)</h2>
      <p className="lede">
        Type or paste a description of a website / product / brand,
        click <em>Generate design</em>, and Sonnet (text mode) acts as a
        brand-mascot art director: it proposes a robot visualBrief and a
        3-colour palette. Both feed editable controls. Then click{" "}
        <em>Generate robot</em> to render the image (existing locked
        composition template still applies). Logo overlay is intentionally
        deferred — v14.
      </p>

      {/* ===================== Describe the brand ===================== */}
      <section style={stepStyle}>
        <h3>Describe the brand</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Free text. Anything that helps Sonnet picture the robot: what
          the company does, who the customers are, the tone you'd want
          on the homepage, any visual references you already have in
          mind. Don't write framing instructions ("square crop",
          "facing camera") — those are owned by the locked composition
          template downstream.
        </p>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={DEFAULT_DESCRIPTION_PLACEHOLDER}
          rows={10}
          style={{
            width: "100%",
            fontFamily: "ui-sans-serif, system-ui, sans-serif",
            fontSize: "0.9em",
            padding: 10,
            border: "1px solid #ccc",
            borderRadius: 4,
            resize: "vertical",
          }}
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
          is appended automatically and is not editable from this view.
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

      {/* ===================== Step 1 — Generate ===================== */}
      <section style={stepStyle}>
        <h3>Step 1 — Generate robot image</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sends <code>visualBrief</code> + locked composition template +
          colour palette to the selected image model.
        </p>

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

      {/* ===================== Logo overlay placeholder ===================== */}
      <section
        style={{
          ...stepStyle,
          background: "#fafafa",
          color: "#888",
          fontStyle: "italic",
        }}
      >
        <h3 style={{ margin: 0, color: "#888" }}>Steps 2-4 — Logo overlay (v14)</h3>
        <p style={{ margin: "6px 0 0", fontSize: "0.9em" }}>
          Logo detection on the chest, transparency processing, and
          compositing are intentionally deferred — coming back next
          branch once we decide how the user provides their logo (upload,
          fetched from URL, or generated).
        </p>
      </section>
    </section>
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
const imgStyle: React.CSSProperties = {
  width: "100%",
  height: "auto",
  display: "block",
};
