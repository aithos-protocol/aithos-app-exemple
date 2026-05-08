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

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMinted(null);
    try {
      const r = await sdk.mandates.create({
        granteeId,
        ...(granteeLabel ? { granteeLabel } : {}),
        scopes: [...scopes],
        ttlSeconds,
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
      <div className="row">
        <button
          type="submit"
          disabled={busy || scopes.size === 0 || !granteeId}
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
