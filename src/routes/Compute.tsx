// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /compute — invoke Claude through the Aithos compute proxy. Requires
// a JWT session AND a mandate id (the user pastes one — typically a
// mandate they minted on /mandates and granted to their own
// app-example flow, or one for which their own DID is the actor).

import { useState } from "react";

import type { InvokeBedrockResult } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7 — best" },
];

export function Compute() {
  const { sdk, state } = useSdk();
  const [model, setModel] = useState(MODELS[0]!.id);
  const [mandateId, setMandateId] = useState("");
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<InvokeBedrockResult | null>(null);

  if (!state.canSignAsOwner) {
    return (
      <section>
        <h2>Compute</h2>
        <p className="lede">Sign in as an owner first.</p>
      </section>
    );
  }

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
    <section>
      <h2>Invoke Claude</h2>
      <p className="lede">
        Calls <code>aithos.compute_invoke</code> through the compute proxy.
        Requires a mandate id authorizing this app to spend your wallet
        — paste one you've minted on <a href="/mandates">/mandates</a>{" "}
        with <code>app_did</code> matching what's in this example app
        (placeholder: <code>did:aithos:app:example-placeholder</code>).
      </p>
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
            {MODELS.map((m) => (
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
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
    </section>
  );
}
