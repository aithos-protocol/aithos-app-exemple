// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Agent — agentic conversation through the Aithos compute proxy
// (sdk.compute.runConversation): a multi-turn Bedrock tool-calling loop billed
// once. The model gets the Aithos MCP tools and reads the subject's ethos from
// a client-decrypted working-set (sdk.buildWorkingSet).
//
// Actor-aware: the mandate is implied by the current actor — no field to paste.
// An owner calls direct; a delegate's calls carry its mandate id automatically.
// Only the zones the actor may read are offered for the working-set.

import { useEffect, useMemo, useState } from "react";

import type { RunConversationResult } from "@aithos/sdk";

import { useActor, type ZoneName } from "../actor-context.js";
import { formatError } from "./Home.js";

const MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 — best" },
];

const ALL_ZONES: readonly ZoneName[] = ["public", "circle", "self"];

export function Agent() {
  const { sdk, actor, capabilities: cap } = useActor();
  const [model, setModel] = useState(MODELS[1]!.id);
  const [system, setSystem] = useState(
    "Tu agis dans la voix de l'utilisateur. Utilise les outils pour lire son ethos avant de répondre.",
  );
  const [prompt, setPrompt] = useState("");
  const [maxIterations, setMaxIterations] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<RunConversationResult | null>(null);

  const readableZones = useMemo(() => ALL_ZONES.filter((z) => cap.ethosRead(z)), [cap]);
  const [zones, setZones] = useState<ZoneName[]>([]);
  // Default the working-set to the first readable zone once we know them.
  useEffect(() => {
    setZones((cur) => (cur.length === 0 && readableZones.length > 0 ? [readableZones[0]!] : cur));
  }, [readableZones]);

  if (!actor || !cap.canCompute) {
    return (
      <section>
        <h2>Agent</h2>
        <p className="warn">
          Needs <code>compute.invoke</code>. {actor ? "This mandate doesn't grant it." : "Sign in first."}
        </p>
      </section>
    );
  }

  const toggleZone = (z: ZoneName) =>
    setZones((cur) => (cur.includes(z) ? cur.filter((x) => x !== z) : [...cur, z]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const did = actor.subjectDid;
      const workingSet = await sdk.buildWorkingSet(did, { zones });
      const r = await sdk.compute.runConversation({
        ...(actor.kind === "delegate" ? { mandateId: actor.mandateId } : {}),
        model,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
        mcp: { server: "aithos" },
        workingSet,
        maxIterations,
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
      <h2>Agent</h2>
      <p className="lede">
        Multi-turn agentic loop via <code>sdk.compute.runConversation</code> —
        the model reads {actor.kind === "owner" ? "your" : "the subject's"} ethos
        from a client-decrypted working-set. One POST, billed once.{" "}
        {actor.kind === "delegate" && <>Runs under your mandate automatically.</>}
      </p>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
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
        <fieldset className="stack">
          <legend>Ethos zones to expose (working-set)</legend>
          {readableZones.length === 0 ? (
            <p className="lede">No readable zone for this actor.</p>
          ) : (
            <div className="row">
              {readableZones.map((z) => (
                <label key={z} className="row" style={{ gap: 4 }}>
                  <input type="checkbox" checked={zones.includes(z)} onChange={() => toggleZone(z)} />
                  <span>{z}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label>
          <span>Max iterations</span>
          <input
            type="number"
            min={1}
            max={12}
            value={maxIterations}
            onChange={(e) => setMaxIterations(Number(e.target.value))}
          />
        </label>
        <label>
          <span>System prompt (optional)</span>
          <textarea value={system} onChange={(e) => setSystem(e.target.value)} />
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ex: Résume ce que tu sais de moi en 3 points."
          />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !prompt}>
            {busy ? "Running…" : "Run agent"}
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
            <dt>Iterations</dt>
            <dd>{out.iterations}</dd>
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
          <h3>Tool calls</h3>
          {out.toolCalls.length === 0 ? (
            <p className="lede">No tools were called.</p>
          ) : (
            <ol>
              {out.toolCalls.map((tc, i) => (
                <li key={i}>
                  <code>{tc.name}</code> — turn {tc.turn} — {tc.ok ? "ok" : "error"}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
