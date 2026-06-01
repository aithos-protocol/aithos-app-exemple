// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /agent — run an agentic conversation through the Aithos compute proxy.
//
// Unlike /compute (single-shot invokeBedrock), this uses
// `sdk.compute.runConversation`: a multi-turn Bedrock tool-calling loop that
// runs server-side in a single POST and is billed once for the cumulative
// token usage. The model is given the Aithos MCP tools (ethos_list_sections,
// ethos_read_section, data_query) and reads the user's data from a
// client-decrypted working-set built with `sdk.buildWorkingSet`.
//
// Requires an owner session. A mandate id is optional for owner-direct calls
// (the owner has full authority over their own ethos); paste one to exercise
// the delegate path.

import { useState } from "react";

import type { RunConversationResult } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 — best" },
];

const ALL_ZONES = ["public", "circle", "self"] as const;
type Zone = (typeof ALL_ZONES)[number];

export function Agent() {
  const { sdk, state } = useSdk();
  const [model, setModel] = useState(MODELS[1]!.id);
  const [mandateId, setMandateId] = useState("");
  const [system, setSystem] = useState(
    "Tu agis dans la voix de l'utilisateur. Utilise les outils pour lire son ethos avant de répondre.",
  );
  const [prompt, setPrompt] = useState("");
  const [zones, setZones] = useState<Zone[]>(["public"]);
  const [maxIterations, setMaxIterations] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [out, setOut] = useState<RunConversationResult | null>(null);

  if (!state.canSignAsOwner) {
    return (
      <section>
        <h2>Agent</h2>
        <p className="lede">Sign in as an owner first.</p>
      </section>
    );
  }

  const toggleZone = (z: Zone) =>
    setZones((cur) => (cur.includes(z) ? cur.filter((x) => x !== z) : [...cur, z]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const did = sdk.userDid;
      if (!did) throw new Error("no owner signed in");
      // Decrypt the granted zones client-side into the working-set.
      const workingSet = await sdk.buildWorkingSet(did, { zones });
      const r = await sdk.compute.runConversation({
        ...(mandateId ? { mandateId } : {}),
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
        Multi-turn agentic loop via <code>sdk.compute.runConversation</code>.
        The model gets the Aithos MCP tools and reads your ethos from a
        client-decrypted working-set (<code>sdk.buildWorkingSet</code>). One
        POST, billed once for the whole loop. Mandate id is optional for
        owner-direct calls.
      </p>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label>
          <span>Mandate ID (optional for owner)</span>
          <input
            type="text"
            value={mandateId}
            onChange={(e) => setMandateId(e.target.value)}
            placeholder="mandate:01H8XYZ… (leave blank for owner-direct)"
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
        <fieldset className="stack">
          <legend>Ethos zones to expose (working-set)</legend>
          <div className="row">
            {ALL_ZONES.map((z) => (
              <label key={z} className="row" style={{ gap: 4 }}>
                <input
                  type="checkbox"
                  checked={zones.includes(z)}
                  onChange={() => toggleZone(z)}
                />
                <span>{z}</span>
              </label>
            ))}
          </div>
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
            <dt>Iterations (Bedrock turns)</dt>
            <dd>{out.iterations}</dd>
            <dt>Tokens (in/out)</dt>
            <dd>
              {out.usage.inputTokens} / {out.usage.outputTokens}
            </dd>
            <dt>Credits charged</dt>
            <dd>{out.creditsCharged.toLocaleString()}</dd>
            <dt>Wallet balance</dt>
            <dd>{out.walletBalance.toLocaleString()}</dd>
            <dt>Funded by</dt>
            <dd>{out.fundedBy ?? "—"}</dd>
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
                  <code>{tc.name}</code> — turn {tc.turn} —{" "}
                  {tc.ok ? "ok" : "error"}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
