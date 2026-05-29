// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /compute — invoke Claude (text) or an image model (FLUX / Imagen /
// Nano Banana) through the Aithos compute proxy. Both paths require
// a JWT session AND a mandate id (the user pastes one — typically a
// mandate they minted on /mandates and granted to their own
// app-example flow, or one for which their own DID is the actor).
//
// Sub-tabs:
//   - "Text"  → sdk.compute.invokeBedrock — Claude haiku / sonnet / opus.
//   - "Image" → sdk.compute.invokeImage   — FLUX / Imagen / Nano Banana.

import { useState } from "react";

import type {
  ImageAspectRatio,
  ImageModelId,
  InvokeBedrockResult,
  InvokeImageResult,
} from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const TEXT_MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7 — best" },
];

const IMAGE_MODELS: ReadonlyArray<{ id: ImageModelId; label: string }> = [
  { id: "image:flux-schnell", label: "FLUX Schnell — fastest / cheapest" },
  { id: "image:flux-dev", label: "FLUX Dev — open weights, mid quality" },
  { id: "image:flux-pro-1.1", label: "FLUX Pro 1.1 — default" },
  { id: "image:flux-pro-1.1-ultra", label: "FLUX Pro 1.1 Ultra — highest quality" },
  { id: "image:imagen-3", label: "Google Imagen 3" },
  { id: "image:imagen-4", label: "Google Imagen 4" },
  { id: "image:nano-banana", label: "Gemini Flash Image (Nano Banana)" },
];

const ASPECT_RATIOS: ReadonlyArray<ImageAspectRatio> = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "21:9",
];

type ComputeTab = "text" | "image";

export function Compute() {
  const { state } = useSdk();
  const [tab, setTab] = useState<ComputeTab>("text");

  if (!state.canSignAsOwner) {
    return (
      <section>
        <h2>Compute</h2>
        <p className="lede">Sign in as an owner first.</p>
      </section>
    );
  }

  return (
    <section>
      <h2>Compute</h2>
      <p className="lede">
        Calls go through the Aithos compute proxy. The text tab uses{" "}
        <code>sdk.compute.invokeBedrock</code> (Claude). The image tab
        uses <code>sdk.compute.invokeImage</code> (FLUX, Imagen, Nano
        Banana). Both require a mandate id authorizing this app to
        spend your wallet — paste one you've minted on{" "}
        <a href="/mandates">/mandates</a> with <code>app_did</code>{" "}
        matching this example app (placeholder:{" "}
        <code>did:aithos:app:example-placeholder</code>).
      </p>
      <div className="tabs">
        <button
          className={tab === "text" ? "active" : ""}
          onClick={() => setTab("text")}
        >
          Text (Claude)
        </button>
        <button
          className={tab === "image" ? "active" : ""}
          onClick={() => setTab("image")}
        >
          Image
        </button>
      </div>
      {tab === "text" ? <TextPanel /> : <ImagePanel />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Text panel — sdk.compute.invokeBedrock                                    */
/* -------------------------------------------------------------------------- */

function TextPanel() {
  const { sdk } = useSdk();
  const [model, setModel] = useState(TEXT_MODELS[0]!.id);
  const [mandateId, setMandateId] = useState("");
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<InvokeBedrockResult | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const r = await sdk.compute.invokeBedrock({
        mandateId,
        model,
        messages: [{ role: "user", content: prompt }],
        ...(system ? { system } : {}),
        maxTokens: 1024,
      });
      setOut(r);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Mandate ID</span>
          <input
            type="text"
            value={mandateId}
            onChange={(e) => setMandateId(e.target.value)}
            placeholder="mandate:01H8XYZ..."
          />
        </label>
        <label>
          <span>Model</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {TEXT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>System prompt (optional)</span>
          <textarea
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          />
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !prompt || !mandateId}>
            {busy ? "Calling…" : "Invoke"}
          </button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}
      {out && (
        <div className="stack" style={{ marginTop: 16 }}>
          <h3>Response</h3>
          <pre>{out.content}</pre>
          <dl className="kvtable">
            <dt>Stop reason</dt>
            <dd>{out.stopReason}</dd>
            <dt>Tokens (in/out)</dt>
            <dd>
              {out.usage.inputTokens} / {out.usage.outputTokens}
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
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Image panel — sdk.compute.invokeImage                                     */
/* -------------------------------------------------------------------------- */

function ImagePanel() {
  const { sdk } = useSdk();
  const [model, setModel] = useState<ImageModelId>("image:flux-pro-1.1");
  const [mandateId, setMandateId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<ImageAspectRatio>("1:1");
  const [numberOfImages, setNumberOfImages] = useState(1);
  const [seed, setSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<InvokeImageResult | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const seedNum = seed.trim() === "" ? undefined : Number(seed);
      if (seedNum !== undefined && Number.isNaN(seedNum)) {
        throw new Error("Seed must be a number (leave empty for random).");
      }
      const r = await sdk.compute.invokeImage({
        mandateId,
        model,
        prompt,
        aspectRatio,
        numberOfImages,
        ...(negativePrompt ? { negativePrompt } : {}),
        ...(seedNum !== undefined ? { seed: seedNum } : {}),
      });
      setOut(r);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Mandate ID</span>
          <input
            type="text"
            value={mandateId}
            onChange={(e) => setMandateId(e.target.value)}
            placeholder="mandate:01H8XYZ..."
          />
        </label>
        <label>
          <span>Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as ImageModelId)}
          >
            {IMAGE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A misty Breton coastline at dawn, oil-paint texture, soft pastel light"
          />
        </label>
        <label>
          <span>Negative prompt (optional)</span>
          <input
            type="text"
            value={negativePrompt}
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder="blurry, watermark, low quality"
          />
        </label>
        <div className="row">
          <label style={{ flex: "1 1 140px" }}>
            <span>Aspect ratio</span>
            <select
              value={aspectRatio}
              onChange={(e) =>
                setAspectRatio(e.target.value as ImageAspectRatio)
              }
            >
              {ASPECT_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "1 1 100px" }}>
            <span># images (1–4)</span>
            <input
              type="number"
              min={1}
              max={4}
              value={numberOfImages}
              onChange={(e) =>
                setNumberOfImages(
                  Math.min(4, Math.max(1, Number(e.target.value) || 1)),
                )
              }
            />
          </label>
          <label style={{ flex: "1 1 160px" }}>
            <span>Seed (optional)</span>
            <input
              type="text"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="random"
            />
          </label>
        </div>
        <div className="row">
          <button type="submit" disabled={busy || !prompt || !mandateId}>
            {busy ? "Generating…" : "Generate"}
          </button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}
      {out && (
        <div className="stack" style={{ marginTop: 16 }}>
          <h3>Generated {out.images.length === 1 ? "image" : "images"}</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {out.images.map((img, i) => {
              const dataUrl = `data:${img.contentType};base64,${img.base64}`;
              return (
                <figure
                  key={i}
                  style={{ margin: 0, display: "flex", flexDirection: "column", gap: 6 }}
                >
                  <img
                    src={dataUrl}
                    alt={`Generated ${i + 1}`}
                    style={{
                      width: "100%",
                      height: "auto",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--code-bg)",
                    }}
                  />
                  <figcaption
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      fontSize: 12,
                      color: "var(--muted)",
                    }}
                  >
                    <span>
                      {img.width}×{img.height}
                    </span>
                    <a
                      href={dataUrl}
                      download={`aithos-${out.seed}-${i + 1}.${img.contentType === "image/png" ? "png" : "jpg"}`}
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
    </>
  );
}
