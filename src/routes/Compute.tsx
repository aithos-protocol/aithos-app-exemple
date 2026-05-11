// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /compute — invoke Claude through the Aithos compute proxy.
//
// Two callers shapes the page handles:
//   - Owner: pastes a mandate id they minted on /mandates (typically a
//     compute-only mandate granting `compute.invoke` to this app).
//   - Delegate: a mandate id was already imported via Home → Mandate.
//     The mandate id is prefilled from the active delegate; the call
//     spends compute credits against the subject's wallet according to
//     the constraints baked into the mandate.

import { useEffect, useMemo, useState } from "react";

import type { DelegateInfo, InvokeBedrockResult } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7 — best" },
];

const COMPUTE_INVOKE_SCOPE = "compute.invoke";

export function Compute() {
  const { sdk, state } = useSdk();
  const [model, setModel] = useState(MODELS[0]!.id);
  const [mandateId, setMandateId] = useState("");
  const [system, setSystem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<InvokeBedrockResult | null>(null);

  // First imported delegate that carries `compute.invoke` — used to
  // prefill the mandate id input + to surface a scope warning when
  // none of the held mandates allows compute spending.
  const computeDelegate: DelegateInfo | null = useMemo(() => {
    return (
      state.delegates.find((d) =>
        d.scopes.includes(COMPUTE_INVOKE_SCOPE),
      ) ?? null
    );
  }, [state.delegates]);

  useEffect(() => {
    // Prefill ONCE per delegate change. The user can still override
    // manually (e.g. owner pasting a different mandate id of theirs).
    if (computeDelegate && !mandateId) {
      setMandateId(computeDelegate.mandateId);
    }
    // We deliberately omit `mandateId` from deps — we don't want to
    // re-prefill after the user manually clears the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computeDelegate?.mandateId]);

  const isAuthenticated =
    state.canSignAsOwner || state.delegates.length > 0;

  if (!isAuthenticated) {
    return (
      <section>
        <h2>Compute</h2>
        <p className="lede">
          Sign in as an owner first <strong>or</strong> import a mandate
          (Home → Mandate) that carries the <code>{COMPUTE_INVOKE_SCOPE}</code>{" "}
          scope.
        </p>
      </section>
    );
  }

  // If the user is delegate-only and none of their mandates includes
  // compute scope, surface that explicitly — invoking will fail at the
  // server with `compute_authorization_missing_scope` otherwise.
  const delegateWithoutComputeScope =
    !state.canSignAsOwner &&
    state.delegates.length > 0 &&
    computeDelegate === null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const r = await sdk.compute.invokeBedrock({
        // Owner sessions can omit mandateId — the SDK fills it with a
        // sentinel. Delegate sessions still need the explicit id.
        ...(mandateId ? { mandateId } : {}),
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
        Calls <code>aithos.compute_invoke</code> through the compute proxy.{" "}
        {state.canSignAsOwner ? (
          <>
            You're signed in as the wallet owner — calls go straight against
            your own wallet, no mandate needed. (If you want to test a
            specific mandate you minted on <a href="/mandates">/mandates</a>,
            paste its id below.)
          </>
        ) : computeDelegate ? (
          <>
            prefilled from your imported delegate mandate{" "}
            <code>{computeDelegate.mandateId}</code> (subject{" "}
            <code>{computeDelegate.subjectDid}</code>, scopes:{" "}
            <code>{computeDelegate.scopes.join(", ")}</code>).
          </>
        ) : (
          <>
            none of your imported mandates carries the{" "}
            <code>{COMPUTE_INVOKE_SCOPE}</code> scope. Ask the issuer for a
            new bundle that includes it, or sign in as an owner.
          </>
        )}
      </p>

      {delegateWithoutComputeScope && (
        <div className="error">
          No imported mandate authorizes <code>{COMPUTE_INVOKE_SCOPE}</code>.
          The compute proxy will reject the call with
          <code>compute_authorization_missing_scope</code>.
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
          <button
            type="submit"
            disabled={
              busy ||
              !prompt ||
              (!state.canSignAsOwner && !mandateId)
            }
          >
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
