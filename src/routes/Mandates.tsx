// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Mandates — OWNER ONLY. Issue ONE mandate carrying any mix of:
//   - Ethos zone scopes      (ethos.read/write.<zone>)
//   - #data collection scopes (data.<collection>.<action>) on your own
//     collections, with the CMK re-wrapped to the grantee via authorizeDelegate
//   - Assets scopes          (assets.*.read) — declared forward-compatibly;
//     asset delegate access is a v0.2 target, not enforced in v0.1.
//
// Everything is signed by the owner (envelopes, no JWT). The grantee's keypair
// is minted inside sdk.mandates.create and travels only in the downloaded
// bundle. The grantee imports it on Home to act as the delegate.

import { useEffect, useState } from "react";

import type { DataClient, MintedMandate, OwnedMandate, Scope } from "@aithos/sdk";
import type { SignedMandate } from "@aithos/protocol-client";

import { useActor, type ZoneName } from "../actor-context.js";
import { formatError } from "./Home.js";

const ETHOS_SCOPES: readonly Scope[] = [
  "ethos.read.public",
  "ethos.read.circle",
  "ethos.read.self",
  "ethos.write.public",
  "ethos.write.circle",
  "ethos.write.self",
];

const DATA_ACTIONS = ["read", "write", "admin", "append"] as const;
type DataAction = (typeof DATA_ACTIONS)[number];
type DataGrant = DataAction | "none";

const TTL_PRESETS = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

export function Mandates() {
  const { actor, capabilities: cap } = useActor();

  if (!actor || !cap.canIssueMandates) {
    return (
      <section>
        <h2>Mandates</h2>
        <p className="warn">
          <strong>Owner only.</strong> Issuing mandates requires your owner
          keys. {actor ? "You're acting as a delegate." : "Sign in as owner on Home."}
        </p>
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>Issue a mandate</h2>
        <p className="lede">
          One signed mandate carrying any mix of Ethos zones, your{" "}
          <code>#data</code> collections, and assets. For{" "}
          <code>read/write/admin</code> data grants the collection CMK is
          re-wrapped to the grantee. Download the bundle and hand it over — the
          grantee imports it on Home.
        </p>
        <CreateMandateForm />
      </section>
      <IssuedMandates />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create form                                                               */
/* -------------------------------------------------------------------------- */

interface Minted {
  readonly mandate: MintedMandate;
  readonly dataAuth: readonly {
    readonly collection: string;
    readonly action: string;
    readonly ok: boolean;
    readonly detail?: string;
  }[];
}

function CreateMandateForm() {
  const { sdk, dataClient, bump } = useActor();
  const owner = dataClient as DataClient | null; // owner #data client (or null)

  const [granteeId, setGranteeId] = useState("urn:aithos:agent:demo1");
  const [granteeLabel, setGranteeLabel] = useState("");
  const [ethos, setEthos] = useState<Set<Scope>>(new Set<Scope>(["ethos.read.public"]));
  const [ttlSeconds, setTtlSeconds] = useState(86400);
  const [assetsRead, setAssetsRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);

  // Owner's #data collections, for the data-grants section.
  const [collections, setCollections] = useState<readonly string[] | null>(null);
  const [grants, setGrants] = useState<Record<string, DataGrant>>({});

  useEffect(() => {
    let cancelled = false;
    if (!owner) {
      setCollections([]);
      return;
    }
    owner
      .listCollections()
      .then((cols) => !cancelled && setCollections(cols.map((c) => c.name)))
      .catch(() => !cancelled && setCollections([]));
    return () => {
      cancelled = true;
    };
  }, [owner]);

  const toggleEthos = (s: Scope) =>
    setEthos((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMinted(null);
    try {
      const dataScopes: Scope[] = Object.entries(grants)
        .filter(([, a]) => a !== "none")
        .map(([col, a]) => `data.${col}.${a}` as Scope);
      // Assets scope is forward-compat (v0.2). Cast through the Scope union —
      // the SDK passes unknown scopes through to the signed mandate verbatim.
      const assetScopes = assetsRead ? (["assets.*.read"] as unknown as Scope[]) : [];
      const all: Scope[] = [...ethos, ...dataScopes, ...assetScopes];
      if (all.length === 0) {
        setError("Pick at least one scope.");
        setBusy(false);
        return;
      }

      const r = await sdk.mandates.create({
        granteeId,
        ...(granteeLabel ? { granteeLabel } : {}),
        scopes: all,
        ttlSeconds,
      });

      // Re-wrap the CMK for read/write/admin data grants (append is lateral).
      const dataAuth: Minted["dataAuth"] = [];
      const list: { collection: string; action: string; ok: boolean; detail?: string }[] = [];
      if (owner) {
        const bundle = JSON.parse(await r.bundle.text()) as { mandate: unknown };
        const mandate = bundle.mandate as SignedMandate;
        for (const [col, a] of Object.entries(grants)) {
          if (a === "none" || a === "append") continue;
          try {
            await owner.authorizeDelegate({ collectionName: col, mandate });
            list.push({ collection: col, action: a, ok: true });
          } catch (e) {
            list.push({ collection: col, action: a, ok: false, detail: formatError(e) });
          }
        }
      }
      setMinted({ mandate: r, dataAuth: [...dataAuth, ...list] });
      bump();
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
        void submit();
      }}
    >
      <label>
        <span>Grantee URN</span>
        <input type="text" value={granteeId} onChange={(e) => setGranteeId(e.target.value)} />
      </label>
      <label>
        <span>Grantee label (optional)</span>
        <input type="text" value={granteeLabel} onChange={(e) => setGranteeLabel(e.target.value)} />
      </label>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>Ethos zone scopes</span>
        <div className="row">
          {ETHOS_SCOPES.map((s) => (
            <label key={s} style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={ethos.has(s)} onChange={() => toggleEthos(s)} />
              <span style={{ marginLeft: 4 }}>{s}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>
          Data collections (<code>#data</code>)
        </span>
        {collections === null && <p className="lede">Loading your #data collections…</p>}
        {collections && collections.length === 0 && (
          <p className="lede" style={{ marginTop: 0 }}>
            No <code>#data</code> collections yet. Create one on the Data tab first.
          </p>
        )}
        {collections && collections.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            {collections.map((col) => (
              <div key={col} className="row" style={{ gap: 8, alignItems: "center" }}>
                <code style={{ flex: "1 1 200px" }}>{col}</code>
                <select
                  value={grants[col] ?? "none"}
                  onChange={(e) =>
                    setGrants((p) => ({ ...p, [col]: e.target.value as DataGrant }))
                  }
                >
                  <option value="none">no access</option>
                  {DATA_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                      {a === "append" ? " (insert-only)" : a === "read" ? "" : " (implies read)"}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>Assets</span>
        <label style={{ marginBottom: 0 }}>
          <input type="checkbox" checked={assetsRead} onChange={(e) => setAssetsRead(e.target.checked)} />
          <span style={{ marginLeft: 4 }}>
            <code>assets.*.read</code> — read all assets{" "}
            <em style={{ color: "var(--muted)" }}>
              (declared now; delegate asset access is a v0.2 target, not enforced
              in v0.1)
            </em>
          </span>
        </label>
      </div>

      <label>
        <span>TTL</span>
        <select value={ttlSeconds} onChange={(e) => setTtlSeconds(Number(e.target.value))}>
          {TTL_PRESETS.map((p) => (
            <option key={p.seconds} value={p.seconds}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <button type="submit" disabled={busy || !granteeId}>
          {busy ? "Creating…" : "Create mandate"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {minted && (
        <div className="success">
          Created <code>{minted.mandate.mandateId}</code> · scopes{" "}
          <code>{minted.mandate.scopes.join(", ")}</code>.
          {minted.dataAuth.map((d) => (
            <span key={`${d.collection}.${d.action}`}>
              <br />
              CMK re-wrap <code>{d.collection}</code> ({d.action}) →{" "}
              <strong>{d.ok ? "authorized ✓" : `failed ✗ — ${d.detail ?? ""}`}</strong>
            </span>
          ))}
          <br />
          <a href={URL.createObjectURL(minted.mandate.bundle)} download={minted.mandate.filename}>
            Download {minted.mandate.filename}
          </a>{" "}
          — hand it to the grantee (sign out, then import it on Home to test).
        </div>
      )}
      {/* Hint: a write/admin delegate also needs the zone/collection readable.
          For ethos zones, publish the zone once after issuing so the grantee's
          wrap is sealed in. */}
      {ZONES.some((z) => ethos.has(`ethos.write.${z}` as Scope)) && (
        <p className="lede">
          Note: a delegate can only read/write an Ethos zone the owner has{" "}
          <strong>published with their wrap</strong>. After issuing, open Profile
          and publish the granted zone(s) once so the delegate is sealed in.
        </p>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Issued mandates list                                                      */
/* -------------------------------------------------------------------------- */

function IssuedMandates() {
  const { sdk } = useActor();
  const [list, setList] = useState<readonly OwnedMandate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sdk.mandates
      .list()
      .then((items) => !cancelled && setList(items))
      .catch((e) => !cancelled && setError(formatError(e)));
    return () => {
      cancelled = true;
    };
  }, [sdk, tick]);

  return (
    <section>
      <h2>Mandates you've issued</h2>
      {error && <div className="error">{error}</div>}
      {!list && !error && <p>Loading…</p>}
      {list && list.length === 0 && <p className="lede">None yet.</p>}
      {list?.map((m) => (
        <div key={m.mandateId} className="section-card">
          <h4>{m.mandateId}</h4>
          <div className="body">
            actor: <code>{m.actorDid}</code>
            <br />
            scopes: {m.scopes.join(", ") || "(none)"}
          </div>
          <div className="meta">
            not_after: {m.notAfter ? new Date(m.notAfter * 1000).toLocaleString() : "—"}
          </div>
          <RevokeRow mandateId={m.mandateId} onRevoked={() => setTick((t) => t + 1)} />
        </div>
      ))}
    </section>
  );
}

function RevokeRow({
  mandateId,
  onRevoked,
}: {
  readonly mandateId: string;
  readonly onRevoked: () => void;
}) {
  const { sdk } = useActor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await sdk.mandates.revoke(mandateId);
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
      {error && <div className="error">{error}</div>}
    </div>
  );
}
