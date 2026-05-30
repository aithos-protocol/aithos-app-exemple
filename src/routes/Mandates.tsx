// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /mandates — owner-side mandate lifecycle.
//
// Demonstrates sdk.mandates.create / list / revoke. The created
// mandate's bundle is offered for download as a Blob — the grantee
// imports it on their device via auth.importMandate({ bundle: file }).

import { useEffect, useState } from "react";

import {
  createAppendDataClient,
  createDataClient,
  createDelegateDataClient,
  type MintedMandate,
  type OwnedMandate,
  type Scope,
} from "@aithos/sdk";
import {
  bytesToHex,
  ed25519PublicKeyToMultibase,
  generateKeyPair,
  signMandate,
} from "@aithos/protocol-client";

import {
  demoBrowserIdentity,
  loadOrCreateDemoIdentity,
} from "../demo-identity.js";
import { notesV1Lite } from "../schemas/notes.js";
import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

// Vendor (app-defined) schemas the demo collections use. The SDK needs
// these to split indexable metadata vs encrypted payload on read — both
// the owner client and the delegate client must carry them, otherwise
// `_ensureCollection` throws "schema not known to the SDK". Core schemas
// (e.g. aithos.contacts.v1) are bundled and need not be listed.
const DEMO_SCHEMAS = [notesV1Lite];

const PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_PDS_URL) ||
  "https://slpknok0md.execute-api.eu-west-3.amazonaws.com";

// read/write/admin are hierarchical (write ⊃ read, admin ⊃ write). `append`
// is LATERAL: insert-only, grants NO read — not even read. A mandate carrying
// only `data.<col>.append` can add records but cannot get/list/update/delete,
// and its holder cannot decrypt anything (the DEK is sealed to the owner key,
// never the CMK — so we deliberately do NOT call authorizeDelegate for it).
const DATA_ACTIONS = ["read", "write", "admin", "append"] as const;
type DataAction = (typeof DATA_ACTIONS)[number];

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
        <h2>Data collection mandate</h2>
        <p className="lede">
          Grant a delegate access to one of your <strong>data collections</strong>{" "}
          (the ones created on <code>/data</code>, under the shared demo{" "}
          <code>did:key</code>). Pick a collection and an action —{" "}
          <code>read</code> / <code>write</code> / <code>admin</code> (hierarchical,
          CMK re-wrapped via <code>authorizeDelegate</code>), or{" "}
          <code>append</code> (<strong>lateral, insert-only, no read</strong>:{" "}
          no CMK wrap; the grantee seals each record to your key and cannot read
          the collection, not even read). Mints a{" "}
          <code>data.&lt;collection&gt;.&lt;action&gt;</code> mandate and gives
          you an importable bundle. For append, the result proves it inline:
          the grantee inserts a record, and a read attempt is rejected.
        </p>
        <DataMandateForm />
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
/*  Data collection mandate                                                   */
/* -------------------------------------------------------------------------- */

interface DataMandateResult {
  readonly mandateId: string;
  readonly scope: string;
  readonly bundleUrl: string;
  readonly filename: string;
  /** The importable bundle object — also used to send it by magic link. */
  readonly bundleObject: Record<string, unknown>;
  readonly verifiedReadCount: number | null;
  /** Present for append mandates: proof of insert-only + no-read. */
  readonly append?: {
    readonly insertedRecordId: string;
    /** Grantee cannot even re-read the record it just appended. */
    readonly ownDepositReadBlocked: boolean;
    /** The owner, by contrast, CAN read the deposit (by design, like gamma). */
    readonly ownerCanRead: boolean;
  };
}

function DataMandateForm() {
  const [collections, setCollections] = useState<readonly string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [action, setAction] = useState<DataAction>("read");
  const [ttlSeconds, setTtlSeconds] = useState(86400);
  const [granteeLabel, setGranteeLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DataMandateResult | null>(null);

  // List the demo did:key's collections on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const id = loadOrCreateDemoIdentity();
        const client = createDataClient({
          pdsUrl: PDS_URL,
          did: id.did,
          sphereSeed: id.seed,
          verificationMethod: id.verificationMethod,
          schemas: DEMO_SCHEMAS,
        });
        const cols = await client.listCollections();
        if (cancelled) return;
        const names = cols.map((c) => c.name);
        setCollections(names);
        if (names.length > 0) setSelected((s) => s || names[0]!);
      } catch (e) {
        if (!cancelled) setLoadError(formatError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const id = loadOrCreateDemoIdentity();
      const ownerClient = createDataClient({
        pdsUrl: PDS_URL,
        did: id.did,
        sphereSeed: id.seed,
        verificationMethod: id.verificationMethod,
        schemas: DEMO_SCHEMAS,
      });

      // Fresh grantee keypair (the delegate). Its seed travels only in the
      // downloadable bundle.
      const granteeKp = generateKeyPair();
      const granteeMb = ed25519PublicKeyToMultibase(granteeKp.publicKey);
      const scope = `data.${selected}.${action}`;

      const mandate = signMandate({
        issuer: demoBrowserIdentity(id, "data-owner") as never,
        actorSphere: "self",
        grantee: {
          id: `did:key:${granteeMb}`,
          ...(granteeLabel ? { label: granteeLabel } : {}),
          pubkey: granteeMb,
        },
        scopes: [scope],
        ttlSeconds,
      });

      // Importable bundle (same shape as sdk.mandates.create / mintDelegateBundle).
      const bundle = {
        aithos_delegate_version: "0.1.0",
        mandate,
        delegate_seed_hex: bytesToHex(granteeKp.seed),
      };
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const bundleUrl = URL.createObjectURL(blob);
      const filename = `${selected}-${action}.aithos-delegate.json`;

      if (action === "append") {
        // APPEND: lateral, insert-only, no read. Do NOT authorizeDelegate —
        // an append holder must never receive the CMK (that would grant read).
        // It seals each DEK to the owner's pubkey instead.
        const appendClient = createAppendDataClient({
          pdsUrl: PDS_URL,
          subjectDid: id.did,
          // did:key encodes the owner's Ed25519 pubkey after the prefix.
          ownerDataPubkeyMultibase: id.did.replace(/^did:key:/, ""),
          mandate,
          delegateSeed: granteeKp.seed,
          schema: notesV1Lite,
        });
        // Proof 1 — the grantee CAN insert.
        const insertedRecordId = await appendClient
          .collection(selected)
          .insert({ title: "Append deposit", content: "deposited via append mandate" });

        // Proof 2 — the grantee cannot even SEE the record it just appended.
        // (gamma-style: append grants no read at all.) We try to re-read that
        // exact record id through a delegate read client → PDS rejects -32042.
        let ownDepositReadBlocked = false;
        try {
          const asReader = createDelegateDataClient({
            pdsUrl: PDS_URL,
            subjectDid: id.did,
            mandate,
            delegateSeed: granteeKp.seed,
            schemas: DEMO_SCHEMAS,
          });
          await asReader.collection(selected).get(insertedRecordId);
        } catch {
          ownDepositReadBlocked = true;
        }

        // Proof 3 — the OWNER, by contrast, can read the deposit (by design:
        // the practitioner reads what the patient deposited).
        let ownerCanRead = false;
        try {
          const got = await ownerClient.collection(selected).get(insertedRecordId);
          ownerCanRead = !!got;
        } catch {
          ownerCanRead = false;
        }

        setResult({
          mandateId: mandate.id,
          scope,
          bundleUrl,
          filename,
          bundleObject: bundle,
          verifiedReadCount: null,
          append: { insertedRecordId, ownDepositReadBlocked, ownerCanRead },
        });
        return;
      }

      // read / write / admin: re-wrap the collection CMK to the grantee so the
      // mandate is usable for reading.
      await ownerClient.authorizeDelegate({ collectionName: selected, mandate });

      // Inline proof: read as the delegate right now.
      let verifiedReadCount: number | null = null;
      try {
        const delegateClient = createDelegateDataClient({
          pdsUrl: PDS_URL,
          subjectDid: id.did,
          mandate,
          delegateSeed: granteeKp.seed,
          schemas: DEMO_SCHEMAS,
        });
        const r = await delegateClient.collection(selected).list({ limit: 50 });
        verifiedReadCount = r.items.length;
      } catch {
        verifiedReadCount = null;
      }

      setResult({
        mandateId: mandate.id,
        scope,
        bundleUrl,
        filename,
        bundleObject: bundle,
        verifiedReadCount,
      });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return <div className="error">Couldn&rsquo;t list collections: {loadError}</div>;
  }
  if (collections === null) {
    return <p>Loading collections…</p>;
  }
  if (collections.length === 0) {
    return (
      <p className="lede">
        No collections yet under the demo identity. Create one on{" "}
        <code>/data</code> first, then come back.
      </p>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        <span>Collection</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {collections.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Action</span>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as DataAction)}
        >
          {DATA_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
              {a === "read" ? "" : a === "append" ? " (insert-only, no read)" : " (implies read)"}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Grantee label (optional)</span>
        <input
          type="text"
          value={granteeLabel}
          onChange={(e) => setGranteeLabel(e.target.value)}
          placeholder="e.g. psy, accountant agent…"
        />
      </label>
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
        <button type="submit" disabled={busy || !selected}>
          {busy ? "Creating…" : "Create data mandate"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          Created <code>{result.mandateId}</code> · scope{" "}
          <code>{result.scope}</code>.{" "}
          {result.verifiedReadCount !== null && (
            <>
              Verified: delegate read returned{" "}
              <strong>{result.verifiedReadCount}</strong> record
              {result.verifiedReadCount === 1 ? "" : "s"}.{" "}
            </>
          )}
          {result.append && (
            <>
              <br />
              Grantee appended <code>{result.append.insertedRecordId.slice(0, 16)}…</code> ✓
              <br />
              Grantee re-reading its own deposit →{" "}
              <strong>
                {result.append.ownDepositReadBlocked
                  ? "blocked ✓ (can't even see what it appended)"
                  : "NOT blocked ✗"}
              </strong>
              <br />
              Owner reading the same deposit →{" "}
              <strong>
                {result.append.ownerCanRead
                  ? "visible ✓ (owner reads it, like gamma)"
                  : "NOT visible ✗"}
              </strong>
              <br />
            </>
          )}
          <a href={result.bundleUrl} download={result.filename}>
            Download {result.filename}
          </a>
          <InviteByEmail bundleObject={result.bundleObject} />
        </div>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Invite by magic link — deliver the minted bundle to an email             */
/* -------------------------------------------------------------------------- */

function InviteByEmail({
  bundleObject,
}: {
  readonly bundleObject: Record<string, unknown>;
}) {
  const { auth } = useSdk();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      // Generic SDK call — works for ANY mandate scope. The bundle (with its
      // delegate seed) is stored server-side bound to a single-use token; only
      // the token rides the email. The invitee redeems it on /auth/invite.
      const r = await auth.inviteCustodial({ email, mandateBundle: bundleObject });
      setMsg(
        `Magic link ${r.mailSent ? "sent" : "queued (mail not sent — check SES)"} to ${r.email}.`,
      );
      setEmail("");
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <span style={{ display: "block", marginBottom: 4, color: "var(--muted)" }}>
        …or send it by magic link (the mandate never rides the URL):
      </span>
      <form
        className="row"
        style={{ gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="patient@example.com"
        />
        <button type="submit" disabled={busy || !email}>
          {busy ? "Sending…" : "Send magic link"}
        </button>
      </form>
      {msg && <div className="success" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="error" style={{ marginTop: 6 }}>{err}</div>}
    </div>
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
