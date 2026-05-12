// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /mandates — owner-side mandate lifecycle.
//
// Demonstrates sdk.mandates.create / list / revoke. The created
// mandate's bundle is offered for download as a Blob — the grantee
// imports it on their device via auth.importMandate({ bundle: file }).

import { useEffect, useState } from "react";

import type { MintedMandate, OwnedMandate, Scope } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const ALL_SCOPES: readonly Scope[] = [
  "ethos.read.public",
  "ethos.read.circle",
  "ethos.read.self",
  "ethos.write.public",
  "ethos.write.circle",
  "ethos.write.self",
];

const TTL_PRESETS: { readonly label: string; readonly seconds: number }[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

export function Mandates() {
  const { sdk, state } = useSdk();
  const [list, setList] = useState<readonly OwnedMandate[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    if (!state.canSignAsOwner) return;
    let cancelled = false;
    setListBusy(true);
    setListError(null);
    sdk.mandates
      .list()
      .then((items) => {
        if (cancelled) return;
        setList(items);
      })
      .catch((e) => {
        if (cancelled) return;
        setListError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setListBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, state.canSignAsOwner, refreshTick]);

  if (!state.canSignAsOwner) {
    return (
      <section>
        <h2>Mandates</h2>
        <p className="lede">Sign in as an owner first.</p>
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>Create a mandate</h2>
        <p className="lede">
          Mints a fresh delegate keypair, signs the mandate with your owner
          identity, posts <code>aithos.publish_mandate</code>, and gives you a
          downloadable bundle to hand to the grantee.
        </p>
        <CreateMandateForm
          onCreated={() => setRefreshTick((t) => t + 1)}
        />
      </section>

      <section>
        <h2>Mandates you've issued</h2>
        <p className="lede">
          From <code>aithos.list_mandates</code>, paginated. Refreshes
          after every create / revoke.
        </p>
        {listBusy && <p>Loading…</p>}
        {listError && <div className="error">{listError}</div>}
        {list && list.length === 0 && !listBusy && (
          <p className="lede">No mandates issued yet.</p>
        )}
        {list?.map((m) => (
          <div key={m.mandateId} className="section-card">
            <h4>{m.mandateId}</h4>
            <div className="body">
              actor: <code>{m.actorDid}</code>
              <br />
              scopes: {m.scopes.join(", ") || "(none)"}
            </div>
            <div className="meta">
              created: {fmtUnix(m.createdAt)} · not_after:{" "}
              {fmtUnix(m.notAfter)}
            </div>
            <RevokeRow
              mandateId={m.mandateId}
              onRevoked={() => setRefreshTick((t) => t + 1)}
            />
          </div>
        ))}
      </section>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create form                                                               */
/* -------------------------------------------------------------------------- */

// Models the compute proxy currently routes. Mirrors the allowlists
// exposed by /compute (text) and /image (image-gen). Keep in sync when
// the proxy adds models.
const ALL_MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest (text)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced (text)" },
  // Opus 4.7 is provisioned on the proxy account but commercial access
  // is gated behind an AWS Sales unlock (as of May 2026). Opus 4.6 is
  // the strongest model currently invocable.
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 — best (text)" },
  { id: "image:flux-schnell", label: "FLUX Schnell — cheapest (image)" },
  { id: "image:flux-dev", label: "FLUX Dev — balanced (image)" },
  { id: "image:flux-pro-1.1", label: "FLUX Pro 1.1 — best general (image)" },
  { id: "image:flux-pro-1.1-ultra", label: "FLUX Pro 1.1 Ultra — highest detail (image)" },
] as const;

// 1 credit = 1_000_000 microcredits — matches the SDK's wire unit. The
// form lets the user think in credits (decimal allowed) and we translate
// to microcredits at submit time.
const MICRO_PER_CREDIT = 1_000_000;
const creditsToMicro = (credits: string): number | undefined => {
  const trimmed = credits.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * MICRO_PER_CREDIT);
};

function CreateMandateForm({
  onCreated,
}: {
  readonly onCreated: () => void;
}) {
  const { sdk } = useSdk();
  const [granteeId, setGranteeId] = useState("urn:aithos:agent:demo1");
  const [granteeLabel, setGranteeLabel] = useState("");
  const [scopes, setScopes] = useState<Set<Scope>>(
    new Set<Scope>(["ethos.read.public"]),
  );
  const [ttlSeconds, setTtlSeconds] = useState(86400);
  // Compute namespace state — opt-in via toggle, all caps in CREDITS
  // (decimal allowed). At submit we convert to microcredits.
  const [computeEnabled, setComputeEnabled] = useState(false);
  const [dailyCapCredits, setDailyCapCredits] = useState("");
  const [totalCapCredits, setTotalCapCredits] = useState("1");
  const [perCallCapCredits, setPerCallCapCredits] = useState("");
  const [allowedModels, setAllowedModels] = useState<Set<string>>(
    new Set<string>(ALL_MODELS.map((m) => m.id)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<MintedMandate | null>(null);

  const toggleScope = (s: Scope) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const toggleModel = (id: string) => {
    setAllowedModels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMinted(null);
    try {
      // Build the optional compute namespace if enabled. The SDK
      // requires at least one of dailyCap / totalCap when compute is
      // present — we surface that as a UX validation here too so the
      // error doesn't bubble up from deep in the SDK.
      let compute: Parameters<typeof sdk.mandates.create>[0]["compute"];
      if (computeEnabled) {
        const daily = creditsToMicro(dailyCapCredits);
        const total = creditsToMicro(totalCapCredits);
        const perCall = creditsToMicro(perCallCapCredits);
        if (!daily && !total) {
          throw new Error(
            "Compute access enabled but no spending cap set. Provide at least one of: daily cap or total cap.",
          );
        }
        if (allowedModels.size === 0) {
          throw new Error(
            "Compute access enabled but no model selected. Pick at least one model the delegate may invoke.",
          );
        }
        compute = {
          ...(daily !== undefined ? { dailyCapMicrocredits: daily } : {}),
          ...(total !== undefined ? { totalCapMicrocredits: total } : {}),
          ...(perCall !== undefined ? { maxCreditsPerCall: perCall } : {}),
          ...(allowedModels.size < ALL_MODELS.length
            ? { allowedModels: [...allowedModels] }
            : {}),
        };
      }

      const r = await sdk.mandates.create({
        granteeId,
        ...(granteeLabel ? { granteeLabel } : {}),
        scopes: [...scopes],
        ttlSeconds,
        ...(compute ? { compute } : {}),
      });
      setMinted(r);
      onCreated();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        <span>Grantee URN</span>
        <input
          type="text"
          value={granteeId}
          onChange={(e) => setGranteeId(e.target.value)}
        />
      </label>
      <label>
        <span>Grantee label (optional)</span>
        <input
          type="text"
          value={granteeLabel}
          onChange={(e) => setGranteeLabel(e.target.value)}
        />
      </label>
      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>
          Scopes
        </span>
        <div className="row">
          {ALL_SCOPES.map((s) => (
            <label key={s} style={{ marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={scopes.has(s)}
                onChange={() => toggleScope(s)}
              />
              <span style={{ display: "inline-block", marginLeft: 4 }}>
                {s}
              </span>
            </label>
          ))}
        </div>
      </div>
      <label>
        <span>TTL</span>
        <select
          value={ttlSeconds}
          onChange={(e) => setTtlSeconds(Number(e.target.value))}
        >
          {TTL_PRESETS.map((p) => (
            <option key={p.seconds} value={p.seconds}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      {/* ----- Compute namespace ---------------------------------------- */}
      <fieldset className="stack" style={{ border: "1px solid #ddd", padding: 12, borderRadius: 6 }}>
        <legend style={{ padding: "0 6px", color: "#666" }}>
          Compute (token-spending) access
        </legend>
        <label style={{ marginBottom: 0 }}>
          <input
            type="checkbox"
            checked={computeEnabled}
            onChange={(e) => setComputeEnabled(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>
            Allow this delegate to spend my compute credits.{" "}
            <span style={{ color: "#666", fontSize: 13 }}>
              Adds the <code>compute.invoke</code> scope. The proxy enforces
              the budget caps below on every call.
            </span>
          </span>
        </label>

        {computeEnabled && (
          <>
            <p className="lede" style={{ fontSize: 13, color: "#666" }}>
              All caps below are in <strong>credits</strong> (decimal allowed,
              e.g. <code>0.5</code>). 1 credit = 1,000,000 microcredits on the
              wire. <strong>At least one of</strong> the daily / total caps is
              required.
            </p>
            <label>
              <span>Daily cap (credits / UTC day)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={dailyCapCredits}
                onChange={(e) => setDailyCapCredits(e.target.value)}
                placeholder="e.g. 5"
              />
            </label>
            <label>
              <span>Total cap (credits over the mandate's lifetime)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={totalCapCredits}
                onChange={(e) => setTotalCapCredits(e.target.value)}
                placeholder="e.g. 1"
              />
            </label>
            <label>
              <span>Per-call cap (credits per invocation, optional)</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={perCallCapCredits}
                onChange={(e) => setPerCallCapCredits(e.target.value)}
                placeholder="e.g. 0.2"
              />
            </label>
            <div>
              <span style={{ display: "block", marginBottom: 4, color: "#666" }}>
                Allowed models
              </span>
              <div className="stack" style={{ gap: 4 }}>
                {ALL_MODELS.map((m) => (
                  <label key={m.id} style={{ marginBottom: 0 }}>
                    <input
                      type="checkbox"
                      checked={allowedModels.has(m.id)}
                      onChange={() => toggleModel(m.id)}
                    />
                    <span style={{ marginLeft: 6 }}>
                      <code>{m.id}</code> — {m.label.split(" — ")[1]}
                    </span>
                  </label>
                ))}
              </div>
              <p style={{ color: "#666", fontSize: 12, marginTop: 4 }}>
                If all of the above are selected, no allowlist is sent and
                any model the proxy supports is permitted. Image models
                cost more per call than text — restrict the allowlist if
                you want to grant only one modality.
              </p>
            </div>
          </>
        )}
      </fieldset>

      <div className="row">
        <button
          type="submit"
          disabled={
            busy ||
            !granteeId ||
            (scopes.size === 0 && !computeEnabled)
          }
        >
          {busy ? "Creating…" : "Create mandate"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {minted && (
        <div className="success">
          Created <code>{minted.mandateId}</code>. Hand this file to the
          grantee — it contains the delegate seed.{" "}
          <a
            href={URL.createObjectURL(minted.bundle)}
            download={minted.filename}
          >
            Download {minted.filename}
          </a>
        </div>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Revoke row                                                                */
/* -------------------------------------------------------------------------- */

function RevokeRow({
  mandateId,
  onRevoked,
}: {
  readonly mandateId: string;
  readonly onRevoked: () => void;
}) {
  const { sdk } = useSdk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setSuccess(null);
          try {
            await sdk.mandates.revoke(mandateId);
            setSuccess("Revoked");
            onRevoked();
          } catch (e) {
            setError(formatError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Revoking…" : "Revoke"}
      </button>
      {success && <span className="meta">{success}</span>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function fmtUnix(s: number | null): string {
  if (!s) return "—";
  return new Date(s * 1000).toLocaleString();
}
