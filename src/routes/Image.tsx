// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /image — generate images through the Aithos compute proxy (fal.ai FLUX).
//
// Mirror of /compute but for text-to-image instead of text completion. The
// security path is identical: owner-signed envelope or imported delegate
// mandate carrying the `compute.invoke` scope (+ optional allowed_models
// filter restricting which image models the delegate can use).
//
// Default model: FLUX Pro 1.1 — best general-purpose text-to-image at a
// modest cost (~40k microcredits per image + 1mc platform fee).

import { useEffect, useMemo, useState } from "react";

import type {
  DelegateInfo,
  ImageAspectRatio,
  ImageModelId,
  InvokeImageResult,
} from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

interface ImageModel {
  readonly id: ImageModelId;
  readonly label: string;
  /** Per-image microcredit cost — informational. The proxy is the source of truth. */
  readonly mcPerImage: number;
}

const IMAGE_MODELS: readonly ImageModel[] = [
  {
    id: "image:flux-schnell",
    label: "FLUX Schnell — fast, cheapest",
    mcPerImage: 3_000,
  },
  { id: "image:flux-dev", label: "FLUX Dev — balanced", mcPerImage: 25_000 },
  {
    id: "image:flux-pro-1.1",
    label: "FLUX Pro 1.1 — best general (default)",
    mcPerImage: 40_000,
  },
  {
    id: "image:flux-pro-1.1-ultra",
    label: "FLUX Pro 1.1 Ultra — highest detail",
    mcPerImage: 60_000,
  },
];

const ASPECT_RATIOS: readonly { readonly id: ImageAspectRatio; readonly label: string }[] = [
  { id: "1:1", label: "1:1 — square" },
  { id: "16:9", label: "16:9 — landscape" },
  { id: "9:16", label: "9:16 — portrait" },
  { id: "4:3", label: "4:3 — landscape (classic)" },
  { id: "3:4", label: "3:4 — portrait (classic)" },
  { id: "21:9", label: "21:9 — ultrawide" },
];

const COMPUTE_INVOKE_SCOPE = "compute.invoke";

export function Image() {
  const { sdk, state } = useSdk();
  const [model, setModel] = useState<ImageModelId>("image:flux-pro-1.1");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [mandateId, setMandateId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [seed, setSeed] = useState("");
  const [numberOfImages, setNumberOfImages] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<InvokeImageResult | null>(null);

  // First imported delegate carrying compute.invoke — same prefill logic
  // as /compute. A delegate intended for image gen would typically have
  // allowed_models = ["image:flux-pro-1.1", …] so the mandate's
  // constraint matches what the user is calling here.
  const computeDelegate: DelegateInfo | null = useMemo(() => {
    return (
      state.delegates.find((d) => d.scopes.includes(COMPUTE_INVOKE_SCOPE)) ?? null
    );
  }, [state.delegates]);

  useEffect(() => {
    if (computeDelegate && !mandateId) {
      setMandateId(computeDelegate.mandateId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computeDelegate?.mandateId]);

  const isAuthenticated =
    state.canSignAsOwner || state.delegates.length > 0;

  if (!isAuthenticated) {
    return (
      <section>
        <h2>Image generation</h2>
        <p className="lede">
          Sign in as an owner first <strong>or</strong> import a mandate
          (Home → Mandate) that carries the <code>{COMPUTE_INVOKE_SCOPE}</code>{" "}
          scope.
        </p>
      </section>
    );
  }

  const delegateWithoutComputeScope =
    !state.canSignAsOwner &&
    state.delegates.length > 0 &&
    computeDelegate === null;

  const selectedModel = IMAGE_MODELS.find((m) => m.id === model) ?? IMAGE_MODELS[2]!;
  const estimatedCost =
    selectedModel.mcPerImage * Math.max(1, numberOfImages) + 1;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      // Build optional fields ahead so the args object stays readonly-
      // friendly (InvokeImageArgs.* are all `readonly`).
      let parsedSeed: number | undefined;
      const trimmedSeed = seed.trim();
      if (trimmedSeed.length > 0) {
        const n = Number.parseInt(trimmedSeed, 10);
        if (Number.isFinite(n) && n >= 0) parsedSeed = n;
      }
      const args: Parameters<typeof sdk.compute.invokeImage>[0] = {
        // Owner sessions can omit mandateId — the SDK fills it with a
        // sentinel. Delegate sessions still need the explicit id.
        ...(mandateId ? { mandateId } : {}),
        model,
        prompt,
        aspectRatio,
        numberOfImages,
        ...(negativePrompt ? { negativePrompt } : {}),
        ...(parsedSeed !== undefined ? { seed: parsedSeed } : {}),
      };
      const r = await sdk.compute.invokeImage(args);
      setOut(r);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Generate an image</h2>
      <p className="lede">
        Calls <code>aithos.compute_invoke_image</code> through the compute
        proxy (fal.ai FLUX behind the scenes).{" "}
        {state.canSignAsOwner ? (
          <>
            You're signed in as the wallet owner — calls go straight against
            your own wallet, no mandate needed.
          </>
        ) : computeDelegate ? (
          <>
            prefilled from your imported delegate mandate{" "}
            <code>{computeDelegate.mandateId}</code>
          </>
        ) : (
          <>
            none of your imported mandates carries the{" "}
            <code>{COMPUTE_INVOKE_SCOPE}</code> scope.
          </>
        )}
      </p>

      {delegateWithoutComputeScope && (
        <div className="error">
          No imported mandate authorizes <code>{COMPUTE_INVOKE_SCOPE}</code>.
        </div>
      )}

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!state.canSignAsOwner && (
          <label>
            <span>Mandate ID</span>
            <input
              type="text"
              value={mandateId}
              onChange={(e) => setMandateId(e.target.value)}
              placeholder="mandate:01H8XYZ..."
            />
          </label>
        )}
        <label>
          <span>Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as ImageModelId)}
          >
            {IMAGE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.mcPerImage.toLocaleString()} mc / image
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Aspect ratio</span>
          <select
            value={aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as ImageAspectRatio)}
          >
            {ASPECT_RATIOS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="A friendly chatbot robot with a glowing blue logo on its torso, soft studio lighting, isometric illustration"
          />
        </label>
        <label>
          <span>Negative prompt (optional)</span>
          <textarea
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            rows={2}
            placeholder="blurry, watermark, text artifacts, low quality"
          />
        </label>
        <div className="row" style={{ gap: 16 }}>
          <label style={{ flex: 1 }}>
            <span>Seed (optional — for reproducibility)</span>
            <input
              type="text"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="42"
              inputMode="numeric"
            />
          </label>
          <label style={{ width: 140 }}>
            <span>Number of images</span>
            <input
              type="number"
              min={1}
              max={4}
              value={numberOfImages}
              onChange={(e) =>
                setNumberOfImages(
                  Math.min(4, Math.max(1, Number.parseInt(e.target.value, 10) || 1)),
                )
              }
            />
          </label>
        </div>
        <p className="lede" style={{ fontSize: "0.85em" }}>
          Estimated cost:{" "}
          <strong>{estimatedCost.toLocaleString()}</strong> microcredits
          (debited up-front; refunded in full if the provider call fails).
        </p>
        <div className="row">
          <button
            type="submit"
            disabled={
              busy ||
              !prompt ||
              (!state.canSignAsOwner && !mandateId)
            }
          >
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {out && (
        <div className="stack" style={{ marginTop: 16 }}>
          <h3>Result</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns:
                out.images.length === 1
                  ? "1fr"
                  : "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 12,
            }}
          >
            {out.images.map((img, i) => {
              const dataUri = `data:${img.contentType};base64,${img.base64}`;
              return (
                <figure key={i} style={{ margin: 0 }}>
                  <img
                    src={dataUri}
                    alt={`generated image ${i + 1}`}
                    style={{
                      width: "100%",
                      height: "auto",
                      borderRadius: 6,
                      display: "block",
                    }}
                  />
                  <figcaption
                    style={{
                      fontSize: "0.8em",
                      marginTop: 6,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>
                      {img.width}×{img.height}
                    </span>
                    <a
                      href={dataUri}
                      download={`aithos-${out.seed}-${i + 1}.png`}
                    >
                      download
                    </a>
                  </figcaption>
                </figure>
              );
            })}
          </div>
          <dl className="kvtable">
            <dt>Seed used</dt>
            <dd>
              <code>{out.seed}</code>
            </dd>
            <dt>Credits charged</dt>
            <dd>{out.creditsCharged.toLocaleString()}</dd>
            <dt>Wallet balance</dt>
            <dd>{out.walletBalance.toLocaleString()}</dd>
            <dt>Audit id</dt>
            <dd>
              <code>{out.auditId}</code>
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}
