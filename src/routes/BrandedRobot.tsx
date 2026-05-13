// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — v15 pipeline (URL → 4 structured sections + agent + design).
//
// Front-end flow:
//
//   0. Analyse from URL (OPTIONAL): paste a URL, Sonnet fetches it via
//                            Anthropic's web_fetch tool and produces a
//                            structured analysis that fills:
//                              - Business (paragraph)
//                              - Formulaire (JSON of forms detected)
//                              - UI (primary/secondary/bg colors,
//                                button style, input style, visual brief)
//                              - Logo (auto-fetched as data URI from
//                                the absolute URL Sonnet returned)
//
//   1. Business:             paragraph describing the company. Used by
//                            the Agent generator.
//
//   2. Formulaire:           JSON of detected forms. Editable. Used by
//                            the Agent generator as the data contract.
//
//   3. UI (was "Describe     primary / secondary / background colours,
//      the brand"):          button style, input style, brand visual
//                            brief. Used by Step 1 (image generation).
//
//   4. Logo:                 PNG/SVG file upload. Auto-populated from
//                            URL analysis when possible.
//
//   5. Generate Agent:       button → Sonnet 4.6 turns Business +
//                            Formulaire into the system prompt of a
//                            prospect-qualification agent. Editable
//                            textarea for the result.
//
//   6. Step 1 — Generate:    UI.visualBrief + locked COMPOSITION_TEMPLATE
//                            + UI palette → image model. The "static
//                            robot prompt" (composition + framing) is
//                            still owned by brand-agent.ts.
//   7. Step 1.5 — Prepare:   flood-fill robot bg → transparent.
//   8. Step 2 — Vision:      Sonnet 4.6 (vision) returns logo center,
//                            diameter, and chest colour.
//   9. Step 3 — Prepare logo:background removal on the uploaded logo.
//  10. Step 3.5 — Treat:     Sonnet 4.6 (vision) decides recolor + blend
//                            mode + opacity in ONE call.
//  11. Step 4 — Composite:   treated logo onto the robot chest.
//  12. Step 5 — Judge:       Sonnet 4.6 (vision) judges harmony or
//                            falls back to bare robot.

import { useEffect, useRef, useState } from "react";

import {
  generateAgentSystemPrompt,
  type AgentPromptResult,
} from "../lib/agent-prompt-generator.js";
import {
  COMPOSITION_TEMPLATE,
  step1GenerateRobot,
  step1_5PrepareRobotBg,
  step3PrepareLogo,
  step4Composite,
  type Step1Result,
  type Step1_5Result,
  type Step3LogoResult,
  type Step4CompositeResult,
  type Step4Settings,
} from "../lib/brand-agent.js";
import type { HexColor } from "../lib/brand-types.js";
import { FRAMING_GUIDE } from "../lib/design-agent.js";
import { canvasToBlob } from "../lib/image-pipeline.js";
import {
  analyzeBusinessFromUrl,
  analyzeFormulaireFromUrl,
  analyzeUiFromUrl,
  delay,
  extractLogoFromUrl,
  type BusinessAnalysis,
  type FormulaireAnalysis,
  type FormulaireSchema,
  type LogoExtraction,
  type RetryProgress,
  type UiAnalysis,
} from "../lib/url-analyzer.js";
import {
  applyTreatmentToLogo,
  judgeCompositeHarmony,
  planLogoTreatment,
  type AppliedTreatmentResult,
  type CompositeJudgment,
  type TreatmentPlan,
} from "../lib/treatment-agent.js";
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

/** State of one of the 4 URL sub-step calls. */
type UrlSubStepState<T> =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly retryInfo?: RetryProgress }
  | { readonly status: "done"; readonly result: T }
  | { readonly status: "error"; readonly error: string };

interface SubStepWithMeta {
  readonly creditsSpent: number;
}

function anyStepRunning(...steps: ReadonlyArray<UrlSubStepState<unknown>>): boolean {
  return steps.some((s) => s.status === "running");
}

function anyStepDone(...steps: ReadonlyArray<UrlSubStepState<unknown>>): boolean {
  return steps.some((s) => s.status === "done");
}

function totalCreditsSpent(
  ...steps: ReadonlyArray<UrlSubStepState<SubStepWithMeta>>
): number {
  let total = 0;
  for (const s of steps) {
    if (s.status === "done") total += s.result.creditsSpent;
  }
  return total;
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

const DEFAULT_BUSINESS_PLACEHOLDER =
  "Paste a paragraph describing the business / company / product here.\n\n" +
  "Example: 'Brewsmith is a specialty coffee subscription that sources " +
  "single-origin beans from small farms in Ethiopia, Colombia, and " +
  "Indonesia. We roast in small batches and ship within 48 hours of " +
  "roasting. Our customers are coffee enthusiasts in their late 20s to " +
  "40s who want better-than-supermarket beans without the hassle of " +
  "visiting a roastery.'";

const DEFAULT_UI_VISUAL_BRIEF_PLACEHOLDER =
  "Paste / write a paragraph describing the visual identity of the brand: " +
  "palette, typographies, polish level, design spirit (minimal / editorial / " +
  "corporate / brutalist / fun…), general site mood. Used directly by the " +
  "image model alongside the static robot composition template.";

const DEFAULT_FORMULAIRE: FormulaireSchema = { forms: [] };

const DEFAULT_PRIMARY: HexColor = "#3e2723";
const DEFAULT_SECONDARY: HexColor = "#d7a86e";
const DEFAULT_BACKGROUND: HexColor = "#fefaf5";

/** Build the visualBrief sent to the image model from the UI section.
 *  The image model receives: the brand visual paragraph, plus a
 *  one-liner anchoring the paint job to the brand palette. The static
 *  composition template (robot framing, bust, lighting style) is
 *  appended downstream by step1GenerateRobot. */
function uiToImageBrief(args: {
  visualBrief: string;
  buttonStyle: string;
  inputStyle: string;
}): string {
  const parts: string[] = [];
  parts.push(args.visualBrief.trim());
  if (args.buttonStyle.trim().length > 0) {
    parts.push(
      `BRAND BUTTON STYLE (use as a finish/material reference for accents): ${args.buttonStyle.trim()}`,
    );
  }
  if (args.inputStyle.trim().length > 0) {
    parts.push(
      `BRAND INPUT/SURFACE STYLE (use as a hint for cleanliness and detailing): ${args.inputStyle.trim()}`,
    );
  }
  return parts.join("\n\n");
}

export function BrandedRobot() {
  const { sdk, state } = useSdk();

  // --- URL analyzer state (4 independent sub-steps) ---
  const [urlInput, setUrlInput] = useState<string>("");
  const [businessStep, setBusinessStep] = useState<UrlSubStepState<BusinessAnalysis>>({ status: "idle" });
  const [formulaireStep, setFormulaireStep] = useState<UrlSubStepState<FormulaireAnalysis>>({ status: "idle" });
  const [uiStep, setUiStep] = useState<UrlSubStepState<UiAnalysis>>({ status: "idle" });
  const [logoStep, setLogoStep] = useState<UrlSubStepState<LogoExtraction>>({ status: "idle" });
  const [runAllRunning, setRunAllRunning] = useState(false);

  // --- Business state ---
  const [business, setBusiness] = useState<string>("");

  // --- Formulaire state (JSON edited as text) ---
  const [formulaire, setFormulaire] = useState<FormulaireSchema>(DEFAULT_FORMULAIRE);
  const [formulaireText, setFormulaireText] = useState<string>(
    JSON.stringify(DEFAULT_FORMULAIRE, null, 2),
  );
  const [formulaireParseError, setFormulaireParseError] = useState<string | null>(null);

  // --- UI state (formerly "Describe the brand") ---
  const [primaryColor, setPrimaryColor] = useState<HexColor>(DEFAULT_PRIMARY);
  const [secondaryColor, setSecondaryColor] = useState<HexColor>(DEFAULT_SECONDARY);
  const [backgroundColor, setBackgroundColor] = useState<HexColor>(DEFAULT_BACKGROUND);
  const [buttonStyle, setButtonStyle] = useState<string>("");
  const [inputStyle, setInputStyle] = useState<string>("");
  const [uiVisualBrief, setUiVisualBrief] = useState<string>("");

  // --- Logo upload state ---
  const [logo, setLogo] = useState<UploadedLogo | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);

  // --- Agent prompt generator state ---
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState<AgentPromptResult | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [agentSystemPrompt, setAgentSystemPrompt] = useState<string>("");
  const [agentPromptEdited, setAgentPromptEdited] = useState(false);

  // --- Step 1 (generate) state ---
  const [generated, setGenerated] = useState<Step1Result | null>(null);
  const [generating, setGenerating] = useState(false);
  const [modelId, setModelId] = useState<ImageModelChoice>("image:imagen-4");
  const [seedNonce, setSeedNonce] = useState(0);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  // --- Step 1.5 (prepare robot bg) state ---
  const [step1_5Running, setStep1_5Running] = useState(false);
  const [step1_5Result, setStep1_5Result] = useState<Step1_5Result | null>(null);
  const [step1_5Tolerance, setStep1_5Tolerance] = useState(38);
  const [step1_5Error, setStep1_5Error] = useState<string | null>(null);

  // --- Step 2 (vision) state ---
  const [step2Running, setStep2Running] = useState(false);
  const [vision, setVision] = useState<VisionTorsoResult | null>(null);
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const [debugOverlay, setDebugOverlay] = useState<string | null>(null);

  // --- Step 3 (prepare logo) state ---
  const [step3Running, setStep3Running] = useState(false);
  const [step3Result, setStep3Result] = useState<Step3LogoResult | null>(null);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  // --- Step 3.5 (smart treatment) state ---
  const [treatmentRunning, setTreatmentRunning] = useState(false);
  const [treatmentPlan, setTreatmentPlan] = useState<TreatmentPlan | null>(null);
  const [treatedLogo, setTreatedLogo] = useState<AppliedTreatmentResult | null>(null);
  const [treatmentError, setTreatmentError] = useState<string | null>(null);

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

  // --- Step 5 (judge) state ---
  const [judgeRunning, setJudgeRunning] = useState(false);
  const [judgment, setJudgment] = useState<CompositeJudgment | null>(null);
  const [judgeError, setJudgeError] = useState<string | null>(null);

  // Reset downstream when the robot image (or logo) changes.
  useEffect(() => {
    setStep1_5Result(null);
    setStep1_5Error(null);
    setVision(null);
    setDebugOverlay(null);
    setStep2Error(null);
    setStep3Result(null);
    setStep3Error(null);
    setTreatmentPlan(null);
    setTreatedLogo(null);
    setTreatmentError(null);
    setStep4Result(null);
    setJudgment(null);
    setJudgeError(null);
  }, [generated, logo]);

  // The judgment becomes stale whenever step4Result changes — invalidate it.
  useEffect(() => {
    setJudgment(null);
    setJudgeError(null);
  }, [step4Result]);

  // Auto-recomposite (Step 4) when its inputs settle.
  useEffect(() => {
    if (!generated || !vision || !treatedLogo) return;
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
            logo: treatedLogo,
            settings,
            ...(step1_5Result
              ? { robotCanvasOverride: step1_5Result.processedCanvas }
              : {}),
          });
          setStep4Result(r);
        } catch (e) {
          console.warn("step4 composite failed", e);
        }
      })();
    }, 80);
  }, [generated, vision, treatedLogo, settings, debugOverlay, step1_5Result]);

  const isAuthenticated = state.canSignAsOwner || state.delegates.length > 0;
  if (!isAuthenticated) {
    return (
      <section>
        <h2>Branded robot — v15</h2>
        <p className="lede">
          Sign in as an owner first so the agent can spend your wallet on
          the Sonnet + image-generation calls.
        </p>
      </section>
    );
  }

  // -------- handlers -----------------------------------------------------

  const runBusinessStep = async (): Promise<boolean> => {
    setBusinessStep({ status: "running" });
    try {
      const r = await analyzeBusinessFromUrl(sdk, urlInput, {
        onRetry: (info) => setBusinessStep({ status: "running", retryInfo: info }),
      });
      setBusiness(r.business);
      setBusinessStep({ status: "done", result: r });
      return true;
    } catch (e) {
      setBusinessStep({ status: "error", error: formatError(e) });
      return false;
    }
  };

  const runFormulaireStep = async (): Promise<boolean> => {
    setFormulaireStep({ status: "running" });
    try {
      const r = await analyzeFormulaireFromUrl(sdk, urlInput, {
        onRetry: (info) => setFormulaireStep({ status: "running", retryInfo: info }),
      });
      setFormulaire(r.formulaire);
      setFormulaireText(JSON.stringify(r.formulaire, null, 2));
      setFormulaireParseError(null);
      setFormulaireStep({ status: "done", result: r });
      return true;
    } catch (e) {
      setFormulaireStep({ status: "error", error: formatError(e) });
      return false;
    }
  };

  const runUiStep = async (): Promise<boolean> => {
    setUiStep({ status: "running" });
    try {
      const r = await analyzeUiFromUrl(sdk, urlInput, {
        onRetry: (info) => setUiStep({ status: "running", retryInfo: info }),
      });
      setPrimaryColor(r.ui.primaryColor);
      setSecondaryColor(r.ui.secondaryColor);
      setBackgroundColor(r.ui.backgroundColor);
      setButtonStyle(r.ui.buttonStyle);
      setInputStyle(r.ui.inputStyle);
      setUiVisualBrief(r.ui.visualBrief);
      setUiStep({ status: "done", result: r });
      return true;
    } catch (e) {
      setUiStep({ status: "error", error: formatError(e) });
      return false;
    }
  };

  const runLogoStep = async (): Promise<boolean> => {
    setLogoStep({ status: "running" });
    try {
      const r = await extractLogoFromUrl(sdk, urlInput, {
        onRetry: (info) => setLogoStep({ status: "running", retryInfo: info }),
      });
      if (r.logoDataUri) {
        try {
          const { hasAlpha, width, height } = await detectAlphaInCorners(r.logoDataUri);
          setLogo({
            dataUri: r.logoDataUri,
            filename: deriveLogoFilename(r.logoUrl),
            hasAlpha,
            width,
            height,
          });
          setLogoError(null);
        } catch (e) {
          setLogoError(formatError(e));
        }
      }
      setLogoStep({ status: "done", result: r });
      return true;
    } catch (e) {
      setLogoStep({ status: "error", error: formatError(e) });
      return false;
    }
  };

  const runAllSubSteps = async () => {
    setRunAllRunning(true);
    try {
      // Sequential with a small inter-step delay (3s) so we don't stack
      // calls inside the same Anthropic per-minute window. Each step's
      // failure doesn't block the others (they're independent).
      await runBusinessStep();
      await delay(3000);
      await runFormulaireStep();
      await delay(3000);
      await runUiStep();
      await delay(3000);
      await runLogoStep();
    } finally {
      setRunAllRunning(false);
    }
  };

  const onFormulaireTextChange = (text: string) => {
    setFormulaireText(text);
    if (text.trim().length === 0) {
      setFormulaire(DEFAULT_FORMULAIRE);
      setFormulaireParseError(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.forms)) {
        throw new Error("Expected an object shaped like { forms: [...] }");
      }
      setFormulaire(parsed as FormulaireSchema);
      setFormulaireParseError(null);
    } catch (e) {
      setFormulaireParseError((e as Error).message);
    }
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

  const runGenerateAgent = async () => {
    setAgentRunning(true);
    setAgentError(null);
    setAgentResult(null);
    try {
      const r = await generateAgentSystemPrompt({
        sdk,
        business,
        formulaire,
      });
      setAgentResult(r);
      setAgentSystemPrompt(r.systemPrompt);
      setAgentPromptEdited(false);
    } catch (e) {
      setAgentError(formatError(e));
    } finally {
      setAgentRunning(false);
    }
  };

  const runStep1Generate = async () => {
    setGenerating(true);
    setStep1Error(null);
    setGenerated(null);
    try {
      const visualBrief = uiToImageBrief({
        visualBrief: uiVisualBrief,
        buttonStyle,
        inputStyle,
      });
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

  const runStep1_5 = async () => {
    if (!generated) return;
    setStep1_5Running(true);
    setStep1_5Error(null);
    try {
      const r = await step1_5PrepareRobotBg({
        rawCanvas: generated.rawCanvas,
        tolerance: step1_5Tolerance,
      });
      setStep1_5Result(r);
    } catch (e) {
      setStep1_5Error(formatError(e));
    } finally {
      setStep1_5Running(false);
    }
  };

  const runStep2 = async () => {
    if (!generated) return;
    setStep2Running(true);
    setStep2Error(null);
    setTreatmentPlan(null);
    setTreatedLogo(null);
    setTreatmentError(null);
    setStep4Result(null);
    try {
      const r = await detectTorsoByVision(sdk, generated.rawCanvas);
      setVision(r);
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
    setTreatmentPlan(null);
    setTreatedLogo(null);
    setTreatmentError(null);
    setStep4Result(null);
    try {
      const r = await step3PrepareLogo({
        brand: buildAdHocBrand({
          visualBrief: uiVisualBrief,
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

  const runJudgment = async () => {
    if (!step4Result) return;
    setJudgeRunning(true);
    setJudgeError(null);
    try {
      const r = await judgeCompositeHarmony({
        sdk,
        compositeBlob: step4Result.blob,
      });
      setJudgment(r);
    } catch (e) {
      setJudgeError(formatError(e));
    } finally {
      setJudgeRunning(false);
    }
  };

  const runSmartTreatment = async () => {
    if (!step3Result || !vision) return;
    if (vision.chestColorHex === null) {
      setTreatmentError(
        "Sonnet vision didn't return a chest colour at Step 2 — can't plan treatment. Re-run Step 2.",
      );
      return;
    }
    setTreatmentRunning(true);
    setTreatmentError(null);
    setStep4Result(null);
    try {
      const logoBlob = await canvasToBlob(
        await (async () => {
          const c = document.createElement("canvas");
          c.width = step3Result.processedImg.naturalWidth;
          c.height = step3Result.processedImg.naturalHeight;
          const ctx = c.getContext("2d");
          if (!ctx) throw new Error("2d context unavailable");
          ctx.drawImage(step3Result.processedImg, 0, 0);
          return c;
        })(),
      );

      const plan = await planLogoTreatment({
        sdk,
        logoBlob,
        chestColorHex: vision.chestColorHex,
        primaryColor,
        secondaryColor,
      });
      setTreatmentPlan(plan);

      const applied = await applyTreatmentToLogo({
        preparedImg: step3Result.processedImg,
        preparedDataUri: step3Result.processedDataUri,
        plan,
        primaryColor,
        secondaryColor,
      });
      setTreatedLogo(applied);

      setSettings((s) => ({
        ...s,
        blendMode: plan.blendMode,
        opacity: plan.opacity,
      }));
    } catch (e) {
      setTreatmentError(formatError(e));
    } finally {
      setTreatmentRunning(false);
    }
  };

  return (
    <section>
      <h2>Branded robot — v15 (URL → 4 sections + agent + design)</h2>
      <p className="lede">
        Drop a URL → Sonnet fills <strong>Business</strong>,{" "}
        <strong>Formulaire</strong>, <strong>UI</strong> and the{" "}
        <strong>Logo</strong>. Generate the qualification agent's system
        prompt from Business + Formulaire. Generate the robot mascot from
        UI + the static composition template, then composite the logo on
        the chest.
      </p>

      {/* ===================== Analyse from URL ===================== */}
      <section style={stepStyle}>
        <h3>Optional — Analyse from URL (4 sub-steps)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          v16 — the analysis is split into 4 small, independent calls so
          a single timeout doesn't kill everything. Run them one by one
          (the buttons below) or fire them all sequentially with{" "}
          <em>Run all</em>. Each one auto-fills its destination section.
        </p>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com"
            spellCheck={false}
            style={{
              flex: 1,
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.9em",
              padding: "6px 10px",
              border: "1px solid #ccc",
              borderRadius: 4,
            }}
            disabled={runAllRunning || anyStepRunning(businessStep, formulaireStep, uiStep, logoStep)}
          />
          <button
            type="button"
            onClick={() => void runAllSubSteps()}
            disabled={runAllRunning || urlInput.trim().length < 8}
          >
            {runAllRunning ? "Running all…" : "Run all"}
          </button>
        </div>

        <div style={{ display: "grid", gap: 8 }}>
          <UrlSubStepRow
            label="1. Business"
            hint="paragraph → Business section"
            state={businessStep}
            disabled={urlInput.trim().length < 8 || runAllRunning}
            onRun={() => void runBusinessStep()}
            describeResult={(r) => `${r.business.length} chars · ${r.elapsedMs.toFixed(0)}ms · ${r.creditsSpent.toLocaleString()} mc`}
          />
          <UrlSubStepRow
            label="2. Formulaire"
            hint="JSON → Formulaire section"
            state={formulaireStep}
            disabled={urlInput.trim().length < 8 || runAllRunning}
            onRun={() => void runFormulaireStep()}
            describeResult={(r) =>
              `${r.formulaire.forms.length} form(s), ${r.formulaire.forms.reduce((s, f) => s + f.fields.length, 0)} field(s) · ${r.elapsedMs.toFixed(0)}ms · ${r.creditsSpent.toLocaleString()} mc`
            }
          />
          <UrlSubStepRow
            label="3. UI"
            hint="colors + button/input style + visual brief → UI section"
            state={uiStep}
            disabled={urlInput.trim().length < 8 || runAllRunning}
            onRun={() => void runUiStep()}
            describeResult={(r) =>
              `${r.ui.primaryColor} / ${r.ui.secondaryColor} / ${r.ui.backgroundColor} · ${r.elapsedMs.toFixed(0)}ms · ${r.creditsSpent.toLocaleString()} mc`
            }
          />
          <UrlSubStepRow
            label="4. Logo"
            hint="logo URL discovery + best-effort client-side fetch → Logo section"
            state={logoStep}
            disabled={urlInput.trim().length < 8 || runAllRunning}
            onRun={() => void runLogoStep()}
            describeResult={(r) => {
              const url = r.logoUrl
                ? r.logoUrl.length > 60
                  ? `${r.logoUrl.slice(0, 57)}…`
                  : r.logoUrl
                : "(none found)";
              const status = r.logoDataUri
                ? "fetched"
                : r.logoUrl
                  ? `URL only — ${r.logoFetchError || "fetch skipped"}`
                  : "no logo URL";
              return `${url} · ${status} · ${r.elapsedMs.toFixed(0)}ms · ${r.creditsSpent.toLocaleString()} mc`;
            }}
          />
        </div>

        {anyStepDone(businessStep, formulaireStep, uiStep, logoStep) && (
          <div style={{ marginTop: 10, fontSize: "0.85em", color: "#555" }}>
            Total cost so far :{" "}
            <strong>
              {totalCreditsSpent(businessStep, formulaireStep, uiStep, logoStep).toLocaleString()} mc
            </strong>
          </div>
        )}
      </section>

      {/* ===================== Business ===================== */}
      <section style={stepStyle}>
        <h3>Business</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Free text. What the company does, who its customers are, the
          tone you'd want on the homepage. Used by the Agent generator.
        </p>
        <textarea
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          placeholder={DEFAULT_BUSINESS_PLACEHOLDER}
          rows={8}
          style={textareaStyle}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75em", color: "#888", marginTop: 4 }}>
          <span>{business.length} chars</span>
          <span>min ~20 chars to enable Agent generation</span>
        </div>
      </section>

      {/* ===================== Formulaire ===================== */}
      <section style={stepStyle}>
        <h3>Formulaire</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          JSON describing the form(s) detected on the site (signup,
          contact, checkout, newsletter…). Each form lists its fields
          (name, label, type, required). Used by the Agent generator as
          the data contract the agent must guide the prospect to fill.
        </p>
        <textarea
          value={formulaireText}
          onChange={(e) => onFormulaireTextChange(e.target.value)}
          rows={14}
          spellCheck={false}
          style={{
            ...textareaStyle,
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.8em",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75em", marginTop: 4 }}>
          <span style={{ color: "#888" }}>
            {formulaire.forms.length} form(s) ·{" "}
            {formulaire.forms.reduce((s, f) => s + f.fields.length, 0)} field(s)
          </span>
          <span style={{ color: formulaireParseError ? "#a40" : "#888" }}>
            {formulaireParseError ? `JSON error: ${formulaireParseError}` : "JSON valid"}
          </span>
        </div>
      </section>

      {/* ===================== UI (was "Describe the brand") ===================== */}
      <section style={stepStyle}>
        <h3>UI</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Graphic DNA of the brand — colours, button & input style,
          visual brief / mood. Used by Step 1 (image generation) alongside
          the static robot composition template.
        </p>

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
            onChange={setPrimaryColor}
            disabled={generating}
          />
          <ColorField
            label="Secondary"
            value={secondaryColor}
            onChange={setSecondaryColor}
            disabled={generating}
          />
          <ColorField
            label="Background (dominant)"
            value={backgroundColor}
            onChange={setBackgroundColor}
            disabled={generating}
          />
        </div>

        <label style={{ display: "block", marginTop: 12 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
            Button style
          </span>
          <textarea
            value={buttonStyle}
            onChange={(e) => setButtonStyle(e.target.value)}
            rows={2}
            placeholder="e.g. fully rounded pill, solid primary fill, no border, soft drop-shadow on hover."
            style={textareaStyle}
          />
        </label>

        <label style={{ display: "block", marginTop: 12 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
            Input style
          </span>
          <textarea
            value={inputStyle}
            onChange={(e) => setInputStyle(e.target.value)}
            rows={2}
            placeholder="e.g. 1px neutral border, 8px radius, white background, label floats above on focus."
            style={textareaStyle}
          />
        </label>

        <label style={{ display: "block", marginTop: 12 }}>
          <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
            Visual brief — brand mood / design spirit
          </span>
          <textarea
            value={uiVisualBrief}
            onChange={(e) => setUiVisualBrief(e.target.value)}
            rows={8}
            placeholder={DEFAULT_UI_VISUAL_BRIEF_PLACEHOLDER}
            style={{
              ...textareaStyle,
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.82em",
            }}
          />
          <div style={{ fontSize: "0.75em", color: "#888", marginTop: 4 }}>
            {uiVisualBrief.length} chars
          </div>
        </label>

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
            View the static framing brief (the robot bust convention)
          </summary>
          <p style={{ fontSize: "0.75em", color: "#666", margin: "6px 0" }}>
            Identical for every brand to keep the mascot library visually
            consistent. Read by the image model alongside your UI brief.
          </p>
          <pre style={{
            background: "#f7f7f7",
            padding: 8,
            borderRadius: 4,
            fontSize: "0.75em",
            whiteSpace: "pre-wrap",
            marginTop: 0,
          }}>
            {FRAMING_GUIDE}
          </pre>
        </details>

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: "0.85em" }}>
            View the locked composition template (appended at Step 1)
          </summary>
          <pre style={{ background: "#f7f7f7", padding: 8, borderRadius: 4, fontSize: "0.75em", whiteSpace: "pre-wrap", marginTop: 6 }}>
            {COMPOSITION_TEMPLATE}
          </pre>
        </details>
      </section>

      {/* ===================== Logo upload ===================== */}
      <section style={stepStyle}>
        <h3>Logo</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          PNG, JPEG, SVG, or WebP. Auto-populated by the URL analyzer when
          a logo is found (and CORS allows the client-side fetch).
          Transparent-background logos are detected automatically.
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

      {/* ===================== Generate Agent ===================== */}
      <section style={stepStyle}>
        <h3>Generate Agent</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sonnet 4.6 turns <em>Business</em> + <em>Formulaire</em> into the
          system prompt of a prospect-qualification agent. The agent's
          mission: guide the prospect to fill the formulaire, then emit
          the JSON contract at the end.
        </p>

        <button
          type="button"
          onClick={() => void runGenerateAgent()}
          disabled={
            agentRunning ||
            business.trim().length < 20 ||
            formulaire.forms.reduce((s, f) => s + f.fields.length, 0) === 0 ||
            formulaireParseError !== null
          }
        >
          {agentRunning
            ? "Asking Sonnet…"
            : agentResult
              ? "Re-generate agent prompt"
              : "Generate agent prompt"}
        </button>
        {(business.trim().length < 20 ||
          formulaire.forms.reduce((s, f) => s + f.fields.length, 0) === 0 ||
          formulaireParseError !== null) && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Need a non-trivial Business and at least one Formulaire field.
          </em>
        )}

        {agentError && (
          <div className="error" style={{ marginTop: 8 }}>{agentError}</div>
        )}

        {(agentResult || agentSystemPrompt.length > 0) && (
          <>
            <label style={{ display: "block", marginTop: 12 }}>
              <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
                System prompt
                {agentPromptEdited && (
                  <em style={{ color: "#a60", marginLeft: 8 }}>(edited)</em>
                )}
              </span>
              <textarea
                value={agentSystemPrompt}
                onChange={(e) => {
                  setAgentSystemPrompt(e.target.value);
                  setAgentPromptEdited(true);
                }}
                rows={16}
                style={{
                  ...textareaStyle,
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "0.8em",
                }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75em", color: "#888", marginTop: 4 }}>
                <span>{agentSystemPrompt.length} chars</span>
                {agentResult && agentPromptEdited && (
                  <button
                    type="button"
                    onClick={() => {
                      setAgentSystemPrompt(agentResult.systemPrompt);
                      setAgentPromptEdited(false);
                    }}
                    style={{ fontSize: "0.85em" }}
                  >
                    Reset to last Sonnet output
                  </button>
                )}
              </div>
            </label>
            {agentResult && (
              <dl className="kvtable" style={{ marginTop: 12, fontSize: "0.85em" }}>
                <dt>Sonnet reasoning</dt>
                <dd style={{ fontStyle: "italic" }}>{agentResult.reasoning}</dd>
                <dt>Cost</dt>
                <dd>{agentResult.creditsSpent.toLocaleString()} mc</dd>
              </dl>
            )}
          </>
        )}
      </section>

      {/* ===================== Step 1 — Generate ===================== */}
      <section style={stepStyle}>
        <h3>Step 1 — Generate robot image</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sends the <em>UI</em> visual brief (+ button/input style hints)
          + locked composition template + UI palette to the selected
          image model.
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
            disabled={generating || uiVisualBrief.trim().length === 0}
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

      {/* ===================== Step 1.5 — Prepare robot bg ===================== */}
      <section style={stepStyle}>
        <h3>Step 1.5 — Prepare robot background (make transparent)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Image models drift on the requested bg colour, so instead of
          trying to match it pixel-perfect on the page, we flood-fill the
          (uniform, halo-free) bg to <code>alpha=0</code>. The downstream
          composite then sits cleanly on any page colour.
        </p>

        <label style={{ display: "block", maxWidth: 360, marginBottom: 10 }}>
          <span style={{ fontSize: "0.85em" }}>
            Flood-fill tolerance — {step1_5Tolerance}
          </span>
          <input
            type="range" min={0} max={100} step={1}
            value={step1_5Tolerance}
            onChange={(e) => setStep1_5Tolerance(Number(e.target.value))}
            disabled={step1_5Running}
            style={{ width: "100%" }}
          />
          <span style={{ fontSize: "0.75em", color: "#888" }}>
            Low = preserves contour detail (risk of leaving a coloured
            halo). High = aggressive (risk of eating soft body shadows).
          </span>
        </label>

        <button
          type="button"
          onClick={() => void runStep1_5()}
          disabled={!generated || step1_5Running}
        >
          {step1_5Running
            ? "Processing…"
            : step1_5Result
              ? "Re-process"
              : "Remove background"}
        </button>
        {!generated && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Run Step 1 first.
          </em>
        )}
        {step1_5Error && (
          <div className="error" style={{ marginTop: 8 }}>{step1_5Error}</div>
        )}

        {step1_5Result && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <figure style={{ margin: 0 }}>
                <figcaption style={figcapStyle}>Raw (Step 1 output)</figcaption>
                <img
                  src={generated?.rawDataUri ?? ""}
                  alt="raw robot"
                  style={{ ...imgStyle, borderRadius: 4 }}
                />
              </figure>
              <figure style={{ margin: 0 }}>
                <figcaption style={figcapStyle}>
                  Transparent bg (removed{" "}
                  <code>{step1_5Result.detectedCornerHex}</code>)
                </figcaption>
                <img
                  src={step1_5Result.processedDataUri}
                  alt="robot with transparent bg"
                  style={{ ...imgStyle, ...checkerBgStyle }}
                />
              </figure>
            </div>
            <dl className="kvtable" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <dt>Detected corner colour</dt>
              <dd>
                <span style={{
                  display: "inline-block",
                  width: 14, height: 14,
                  background: step1_5Result.detectedCornerHex,
                  border: "1px solid #888",
                  verticalAlign: "middle",
                  marginRight: 4,
                }} />
                <code>{step1_5Result.detectedCornerHex}</code>
              </dd>
              <dt>Tolerance applied</dt>
              <dd>{step1_5Result.tolerance}</dd>
              <dt>Used downstream</dt>
              <dd>
                Step 4 will composite onto this transparent canvas
                instead of the raw one.
              </dd>
            </dl>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <a href={step1_5Result.processedDataUri} download="robot-transparent.png">
                Download transparent PNG
              </a>
            </div>
          </>
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

      {/* ===================== Step 3.5 — Smart treatment ===================== */}
      <section style={stepStyle}>
        <h3>Step 3.5 — Plan &amp; apply treatment (Sonnet)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sonnet 4.6 vision sees the prepared logo, receives the chest
          surface colour (Step 2) and the brand palette, and decides
          THREE things at once: whether to recolour the logo, which
          blend mode to use, and at what opacity.
        </p>

        <button
          type="button"
          onClick={() => void runSmartTreatment()}
          disabled={!step3Result || !vision || treatmentRunning}
        >
          {treatmentRunning
            ? "Asking Sonnet…"
            : treatmentPlan
              ? "Re-plan & apply"
              : "Plan & apply treatment"}
        </button>
        {!step3Result && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Run Step 3 first.
          </em>
        )}
        {step3Result && !vision && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Run Step 2 first.
          </em>
        )}
        {treatmentError && (
          <div className="error" style={{ marginTop: 8 }}>{treatmentError}</div>
        )}

        {treatmentPlan && treatedLogo && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
              <figure style={{ margin: 0 }}>
                <figcaption style={figcapStyle}>Prepared (Step 3 output)</figcaption>
                <img
                  src={step3Result?.processedDataUri ?? ""}
                  alt="prepared logo"
                  style={{ ...imgStyle, ...checkerBgStyle }}
                />
              </figure>
              <figure style={{ margin: 0 }}>
                <figcaption style={figcapStyle}>
                  Treated ({treatedLogo.action.replace("_", " ")}
                  {treatedLogo.colorApplied && (
                    <> = <code>{treatedLogo.colorApplied}</code></>
                  )})
                </figcaption>
                <img
                  src={treatedLogo.processedDataUri}
                  alt="treated logo"
                  style={{ ...imgStyle, ...checkerBgStyle }}
                />
              </figure>
            </div>

            <dl className="kvtable" style={{ marginTop: 8, fontSize: "0.85em" }}>
              <dt>Recolor action</dt>
              <dd>
                <strong>{treatmentPlan.recolorAction.replace(/_/g, " ")}</strong>
                {treatmentPlan.recolorCustomHex && (
                  <>
                    {" "}→{" "}
                    <span style={{
                      display: "inline-block",
                      width: 14, height: 14,
                      background: treatmentPlan.recolorCustomHex,
                      border: "1px solid #888",
                      verticalAlign: "middle",
                      marginRight: 4,
                    }} />
                    <code>{treatmentPlan.recolorCustomHex}</code>
                  </>
                )}
              </dd>
              <dt>Blend mode</dt>
              <dd><code>{treatmentPlan.blendMode}</code></dd>
              <dt>Opacity</dt>
              <dd>{(treatmentPlan.opacity * 100).toFixed(0)}%</dd>
              <dt>Confidence</dt>
              <dd>{(treatmentPlan.confidence * 100).toFixed(0)}%</dd>
              <dt>Reasoning</dt>
              <dd style={{ fontStyle: "italic" }}>{treatmentPlan.reasoning}</dd>
              <dt>Cost</dt>
              <dd>{treatmentPlan.creditsSpent.toLocaleString()} mc</dd>
            </dl>
          </>
        )}
      </section>

      {/* ===================== Step 4 — Composite ===================== */}
      <section style={stepStyle}>
        <h3>Step 4 — Composite</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          {!generated || !vision || !treatedLogo
            ? "Run Steps 1, 2, 3 and 3.5 first."
            : "Sliders re-render live. Blend mode + opacity were set by Step 3.5; you can override."}
        </p>
        {generated && vision && treatedLogo && (
          <>
            <Step4Controls settings={settings} onChange={setSettings} />
            {step4Result && (
              <div style={{ marginTop: 12, maxWidth: 520 }}>
                <img
                  src={step4Result.dataUri}
                  alt="composite"
                  style={{ width: "100%", height: "auto", display: "block", borderRadius: 6 }}
                />
              </div>
            )}
          </>
        )}
      </section>

      {/* ===================== Step 5 — Judge ===================== */}
      <section style={stepStyle}>
        <h3>Step 5 — Judge composite harmony (Sonnet)</h3>
        <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
          Sonnet 4.6 vision sees the final composite and decides whether
          the logo is mounted harmoniously, or whether we should fall
          back to the bare robot.
        </p>
        <button
          type="button"
          onClick={() => void runJudgment()}
          disabled={!step4Result || judgeRunning}
        >
          {judgeRunning
            ? "Asking Sonnet…"
            : judgment
              ? "Re-judge"
              : "Judge composite"}
        </button>
        {!step4Result && (
          <em style={{ marginLeft: 8, color: "#888", fontSize: "0.85em" }}>
            Run Step 4 first.
          </em>
        )}
        {judgeError && (
          <div className="error" style={{ marginTop: 8 }}>{judgeError}</div>
        )}

        {judgment && (
          <dl className="kvtable" style={{ marginTop: 12, fontSize: "0.85em" }}>
            <dt>Verdict</dt>
            <dd>
              <strong
                style={{
                  color: judgment.verdict === "harmonious" ? "#0a0" : "#a40",
                }}
              >
                {judgment.verdict === "harmonious"
                  ? "✓ Harmonious — ship with logo"
                  : "✗ Skip logo — ship the bare robot"}
              </strong>
            </dd>
            {judgment.issues.length > 0 && (
              <>
                <dt>Issues</dt>
                <dd>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {judgment.issues.map((issue, i) => (
                      <li key={i}>{issue}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            <dt>Reasoning</dt>
            <dd style={{ fontStyle: "italic" }}>{judgment.reasoning}</dd>
            <dt>Confidence</dt>
            <dd>{(judgment.confidence * 100).toFixed(0)}%</dd>
            <dt>Cost</dt>
            <dd>{judgment.creditsSpent.toLocaleString()} mc</dd>
          </dl>
        )}
      </section>

      {/* ===================== Final output ===================== */}
      {generated && (
        <section style={{ ...stepStyle, background: "#fafafa" }}>
          <h3>Final output</h3>
          <p style={{ fontSize: "0.9em", color: "#555", marginTop: 0 }}>
            {judgment === null
              ? step4Result
                ? "Showing the composite. Run Step 5 to validate (or accept as-is)."
                : "Showing the bare robot — no logo composited yet."
              : judgment.verdict === "harmonious"
                ? "Sonnet approved the composite — shipping with logo."
                : "Sonnet rejected the composite — shipping the bare robot (logo dropped)."}
          </p>
          {(() => {
            const useComposite =
              step4Result !== null &&
              (judgment === null || judgment.verdict === "harmonious");
            const bareUri = step1_5Result
              ? step1_5Result.processedDataUri
              : generated.rawDataUri;
            const finalUri = useComposite ? step4Result?.dataUri : bareUri;
            const filename = useComposite ? "mascot-with-logo.png" : "mascot-bare.png";
            return finalUri ? (
              <div style={{ marginTop: 12, maxWidth: 520 }}>
                <img
                  src={finalUri}
                  alt="final output"
                  style={{ width: "100%", height: "auto", display: "block", borderRadius: 6 }}
                />
                <div className="row" style={{ gap: 8, marginTop: 8 }}>
                  <a href={finalUri} download={filename}>Download PNG</a>
                </div>
              </div>
            ) : null;
          })()}
        </section>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  URL sub-step row                                                          */
/* -------------------------------------------------------------------------- */

function UrlSubStepRow<T>({
  label,
  hint,
  state,
  disabled,
  onRun,
  describeResult,
}: {
  readonly label: string;
  readonly hint: string;
  readonly state: UrlSubStepState<T>;
  readonly disabled: boolean;
  readonly onRun: () => void;
  readonly describeResult: (r: T) => string;
}) {
  const statusBadge = (() => {
    switch (state.status) {
      case "idle":
        return <span style={{ color: "#888" }}>idle</span>;
      case "running":
        if (state.retryInfo) {
          return (
            <span style={{ color: "#a60" }}>
              rate-limited · retry {state.retryInfo.attempt}/{state.retryInfo.maxAttempts} in{" "}
              {(state.retryInfo.waitMs / 1000).toFixed(0)}s…
            </span>
          );
        }
        return <span style={{ color: "#06c" }}>running…</span>;
      case "done":
        return <span style={{ color: "#0a0" }}>✓ done</span>;
      case "error":
        return <span style={{ color: "#c00" }}>✗ error</span>;
    }
  })();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto auto 1fr",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        border: "1px solid #ececec",
        borderRadius: 6,
        background: state.status === "running" ? "#f4f9ff" : "#fff",
      }}
    >
      <button
        type="button"
        onClick={onRun}
        disabled={disabled || state.status === "running"}
        style={{ minWidth: 130 }}
      >
        {state.status === "running"
          ? "Running…"
          : state.status === "done" || state.status === "error"
            ? `Re-run ${label.replace(/^\d\.\s*/, "")}`
            : `Run ${label.replace(/^\d\.\s*/, "")}`}
      </button>
      <div style={{ fontSize: "0.85em", whiteSpace: "nowrap" }}>{statusBadge}</div>
      <div style={{ fontSize: "0.8em", color: "#555", lineHeight: 1.35 }}>
        <div><strong>{label}</strong> — {hint}</div>
        {state.status === "done" && (
          <div style={{ color: "#0a0", marginTop: 2 }}>
            {describeResult(state.result)}
          </div>
        )}
        {state.status === "error" && (
          <div style={{ color: "#c00", marginTop: 2, wordBreak: "break-word" }}>
            {state.error}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function deriveLogoFilename(url: string): string {
  if (!url) return "logo";
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ?? "logo";
  } catch {
    return "logo";
  }
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
  disabled,
}: {
  readonly label: string;
  readonly value: HexColor;
  readonly onChange: (v: HexColor) => void;
  readonly disabled: boolean;
}) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: "0.85em", marginBottom: 4 }}>
        {label}
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
