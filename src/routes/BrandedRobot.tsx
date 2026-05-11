// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /branded-robot — agent-driven mascot generator.
//
// Purpose: demo the full agent pipeline. The user picks a test
// company (each is a self-contained BrandProfile), clicks Generate,
// and the agent autonomously:
//
//   1. Composes a brand-aware FLUX prompt
//   2. Calls sdk.compute.invokeImage to produce the raw mascot
//   3. Flood-fills the FLUX background to alpha=0 (client-side)
//   4. Detects the torso position by silhouette bbox heuristic
//   5. Composites the logo on the chest with multiply/screen blend
//   6. Returns a transparent-background PNG ready for use
//
// No UI knobs are exposed beyond the company picker — this is the
// agent's autonomy contract. The same agent could be invoked
// headlessly (e.g. from a build step or a server-side worker) with
// the same BrandProfile input.

import { useState } from "react";

import { generateBrandedRobot, type AgentPhase } from "../lib/brand-agent.js";
import type { BrandProfile, BrandedRobotResult } from "../lib/brand-types.js";
import { TEST_COMPANIES } from "../lib/test-companies.js";
import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const PHASE_LABELS: Record<AgentPhase, string> = {
  "composing-prompt": "Composing the FLUX prompt from the brand brief",
  "calling-flux": "Calling FLUX (the robot model — this is the slowest step)",
  "removing-bg": "Removing the background by flood-fill",
  "detecting-torso": "Detecting the torso position",
  "preparing-logo": "Preparing the logo (auto-transparency if needed)",
  compositing: "Compositing the logo onto the chest",
  encoding: "Encoding the final PNG",
  done: "Done",
};

export function BrandedRobot() {
  const { sdk, state } = useSdk();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<AgentPhase | null>(null);
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BrandedRobotResult | null>(null);
  const [rawDataUri, setRawDataUri] = useState<string | null>(null);

  const isAuthenticated =
    state.canSignAsOwner || state.delegates.length > 0;

  if (!isAuthenticated) {
    return (
      <section>
        <h2>Branded robot — agent</h2>
        <p className="lede">
          Sign in as an owner first so the agent can spend your wallet
          on the FLUX call.
        </p>
      </section>
    );
  }

  const brand: BrandProfile = TEST_COMPANIES[selectedIdx]!;

  const onGenerate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    setRawDataUri(null);
    setPhase("composing-prompt");
    try {
      const r = await generateBrandedRobot(brand, {
        sdk,
        onProgress: (p, detail) => {
          setPhase(p);
          setPhaseDetail(detail ?? null);
        },
      });
      setResult(r);
      // Also surface the raw FLUX output for comparison
      const rawReader = new FileReader();
      rawReader.onload = () => {
        if (typeof rawReader.result === "string") setRawDataUri(rawReader.result);
      };
      rawReader.readAsDataURL(r.rawRobotBlob);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Branded robot — agent</h2>
      <p className="lede">
        End-to-end demo of the brand-mascot agent. Pick a test company,
        click <strong>Generate</strong>, and the agent runs the full
        pipeline autonomously (prompt → FLUX → bg removal → torso
        detection → logo composite). No further UI input.
      </p>

      <h3 style={{ marginTop: 16 }}>1. Pick a brand brief</h3>
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
                <div style={{ fontSize: "0.85em", marginTop: 4 }}>
                  {c.service}
                </div>
                <div
                  style={{
                    fontSize: "0.75em",
                    marginTop: 6,
                    fontFamily: "monospace",
                    opacity: 0.7,
                  }}
                >
                  primary {c.primaryColor} · bg {c.backgroundColor}
                </div>
              </div>
            </div>
          </label>
        ))}
      </div>

      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: "pointer" }}>
          View the brand brief that will feed the FLUX prompt
        </summary>
        <pre
          style={{
            background: "#f7f7f7",
            padding: 12,
            borderRadius: 4,
            marginTop: 8,
            whiteSpace: "pre-wrap",
            fontSize: "0.85em",
          }}
        >
          {brand.visualBrief}
          {"\n\nstyle keywords: "}
          {brand.styleKeywords.join(", ")}
        </pre>
      </details>

      <button
        type="button"
        onClick={() => void onGenerate()}
        disabled={busy}
      >
        {busy ? "Generating…" : `Generate mascot for ${brand.name}`}
      </button>

      {busy && phase && (
        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: "#fff8e1",
            border: "1px solid #ffd58a",
            borderRadius: 6,
            fontSize: "0.9em",
          }}
        >
          <strong>{PHASE_LABELS[phase]}</strong>
          {phaseDetail && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              ({phaseDetail})
            </span>
          )}
        </div>
      )}

      {error && (
        <div className="error" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 24 }}>
          <h3>Result</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
            }}
          >
            <figure style={{ margin: 0 }}>
              <figcaption
                style={{
                  fontSize: "0.85em",
                  marginBottom: 6,
                  fontWeight: 600,
                }}
              >
                Raw FLUX output (before agent post-processing)
              </figcaption>
              {rawDataUri && (
                <img
                  src={rawDataUri}
                  alt="raw flux"
                  style={{
                    width: "100%",
                    height: "auto",
                    background: brand.backgroundColor,
                    borderRadius: 4,
                    display: "block",
                  }}
                />
              )}
            </figure>
            <figure style={{ margin: 0 }}>
              <figcaption
                style={{
                  fontSize: "0.85em",
                  marginBottom: 6,
                  fontWeight: 600,
                }}
              >
                Final composite (transparent BG, logo blended)
              </figcaption>
              <div
                style={{
                  background:
                    "repeating-conic-gradient(#eee 0% 25%, #fff 0% 50%) 50% / 16px 16px",
                  borderRadius: 4,
                  padding: 4,
                }}
              >
                <img
                  src={result.resultDataUri}
                  alt="branded robot"
                  style={{
                    width: "100%",
                    height: "auto",
                    display: "block",
                    borderRadius: 2,
                  }}
                />
              </div>
            </figure>
          </div>

          <div className="row" style={{ gap: 8, marginTop: 12 }}>
            <a
              href={result.resultDataUri}
              download={`${brand.name.toLowerCase().replace(/\W+/g, "-")}-mascot.png`}
            >
              Download final PNG
            </a>
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer" }}>
              Pipeline trace ({result.creditsSpent.toLocaleString()} mc spent)
            </summary>
            <dl className="kvtable" style={{ marginTop: 8 }}>
              <dt>FLUX prompt</dt>
              <dd>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    fontSize: "0.8em",
                    background: "#f7f7f7",
                    padding: 8,
                    borderRadius: 4,
                  }}
                >
                  {result.prompt}
                </pre>
              </dd>
              <dt>Torso center</dt>
              <dd>
                ({result.torso.centerX}, {result.torso.centerY}) — diameter{" "}
                {result.torso.diameter}px
              </dd>
              <dt>Credits charged</dt>
              <dd>{result.creditsSpent.toLocaleString()} mc</dd>
            </dl>
          </details>
        </div>
      )}
    </section>
  );
}
