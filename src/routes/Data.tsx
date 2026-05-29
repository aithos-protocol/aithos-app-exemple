// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /data — `sdk.data` demo: PDS contacts CRUD on an ephemeral did:key.
//
// Why ephemeral did:key, not the signed-in Aithos user?
//
//   `createDataClient` needs the subject's 32-byte sphere seed and
//   verification method URL. The SDK does not expose the signed-in
//   owner's sphere seed bytes — they live behind the OwnerSigners
//   abstraction. To keep this demo self-contained and immediately
//   usable, we generate a fresh did:key keypair on first visit and
//   persist its seed in localStorage (key
//   `aithos:demo:data-did-key`). The same identity is reused across
//   reloads so collections / records survive.
//
//   In a real app you'd:
//     - call createDataClient({ pdsUrl, did: ownerDid, sphereSeed:
//       owner_public_seed, verificationMethod: `${ownerDid}#public` })
//       once the SDK exposes the seed (currently J3+ roadmap), or
//     - use a delegate session imported via auth.importMandate, where
//       the mandate's grantee keypair is the signing material.
//
// PDS endpoint:
//   Default `https://slpknok0md.execute-api.eu-west-3.amazonaws.com`
//   (the dev PDS used by the SDK's e2e tests). Override at build time
//   via `VITE_AITHOS_PDS_URL` for staging / self-hosted deployments.

import { useEffect, useMemo, useState } from "react";

import {
  createDataClient,
  type DataClient,
} from "@aithos/sdk";
import {
  bytesToHex,
  ed25519PublicKeyToMultibase,
  generateKeyPair,
} from "@aithos/protocol-client";

import { formatError } from "./Home.js";

const PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_PDS_URL) ||
  "https://slpknok0md.execute-api.eu-west-3.amazonaws.com";

const STORAGE_KEY = "aithos:demo:data-did-key";

const DEFAULT_COLLECTION = "contacts";

/* -------------------------------------------------------------------------- */
/*  Identity helpers                                                          */
/* -------------------------------------------------------------------------- */

interface DemoIdentity {
  readonly did: string;
  readonly verificationMethod: string;
  readonly seed: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function loadOrCreateIdentity(): DemoIdentity {
  const raw =
    typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        seedHex: string;
        publicKeyHex: string;
      };
      const publicKey = hexToBytes(parsed.publicKeyHex);
      const seed = hexToBytes(parsed.seedHex);
      const mb = ed25519PublicKeyToMultibase(publicKey);
      const did = `did:key:${mb}`;
      return { did, verificationMethod: `${did}#${mb}`, seed };
    } catch {
      // fall through and regenerate
    }
  }
  const kp = generateKeyPair();
  const mb = ed25519PublicKeyToMultibase(kp.publicKey);
  const did = `did:key:${mb}`;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        seedHex: bytesToHex(kp.seed),
        publicKeyHex: bytesToHex(kp.publicKey),
      }),
    );
  }
  return { did, verificationMethod: `${did}#${mb}`, seed: kp.seed };
}

function resetIdentity(): DemoIdentity {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  return loadOrCreateIdentity();
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

type ContactRecord = Record<string, unknown> & { _id?: string };

export function Data() {
  const [identity, setIdentity] = useState<DemoIdentity>(() =>
    loadOrCreateIdentity(),
  );

  const client = useMemo<DataClient>(
    () =>
      createDataClient({
        pdsUrl: PDS_URL,
        did: identity.did,
        sphereSeed: identity.seed,
        verificationMethod: identity.verificationMethod,
      }),
    [identity],
  );

  return (
    <>
      <section>
        <h2>PDS data — sdk.data</h2>
        <p className="lede">
          Demo of <code>sdk.data</code> against the Aithos PDS at{" "}
          <code>{PDS_URL}</code>. Records are encrypted client-side; the
          server only ever sees the indexable metadata (name, email,
          status, tags…). Encrypted fields (phone, notes,
          conversation_log, form_responses, custom_fields) are
          re-decrypted on read using a per-collection CMK.
        </p>
        <p className="lede" style={{ marginTop: -8 }}>
          <strong>Note:</strong> this page uses an ephemeral{" "}
          <code>did:key</code> identity persisted in your browser's
          localStorage — independent from any Aithos sign-in above. See
          the file header for the rationale and how to swap in a real
          Aithos identity.
        </p>
        <IdentityPanel
          identity={identity}
          onReset={() => setIdentity(resetIdentity())}
        />
      </section>

      <CollectionsPanel client={client} />

      <ContactsPanel client={client} collectionName={DEFAULT_COLLECTION} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Identity sub-panel                                                        */
/* -------------------------------------------------------------------------- */

function IdentityPanel({
  identity,
  onReset,
}: {
  readonly identity: DemoIdentity;
  readonly onReset: () => void;
}) {
  return (
    <dl className="kvtable">
      <dt>Subject DID</dt>
      <dd>
        <code>{identity.did}</code>
      </dd>
      <dt>Verification method</dt>
      <dd>
        <code>{identity.verificationMethod}</code>
      </dd>
      <dt>Reset</dt>
      <dd>
        <button
          className="secondary"
          onClick={() => {
            if (
              typeof window !== "undefined" &&
              window.confirm(
                "Generate a NEW ephemeral did:key? The old one (and any collections / records under it) will be unreachable from this browser.",
              )
            ) {
              onReset();
            }
          }}
        >
          New did:key
        </button>
      </dd>
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/*  Collections sub-panel — listCollections + createCollection                */
/* -------------------------------------------------------------------------- */

function CollectionsPanel({ client }: { readonly client: DataClient }) {
  const [cols, setCols] = useState<
    ReadonlyArray<{ name: string; schema: string; record_count: number }>
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.listCollections();
      setCols(r);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // Refresh once on mount and whenever the client (i.e. identity) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const create = async () => {
    if (!newName) return;
    setBusy(true);
    setError(null);
    try {
      await client.createCollection({
        name: newName,
        schema: "aithos.contacts.v1",
      });
      setNewName("");
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Collections</h2>
      <p className="lede">
        <code>client.listCollections()</code> /{" "}
        <code>client.createCollection()</code>. The SDK currently bundles
        only the <code>aithos.contacts.v1</code> schema; more land in
        future alphas.
      </p>
      {cols.length === 0 ? (
        <p>
          <em>No collections yet under this identity.</em>
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {cols.map((c) => (
            <li key={c.name}>
              <strong>{c.name}</strong>{" "}
              <span style={{ color: "var(--muted)" }}>
                — {c.schema} · {c.record_count} record
                {c.record_count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={`new collection name (e.g. "${DEFAULT_COLLECTION}")`}
          style={{ flex: "1 1 240px" }}
        />
        <button type="submit" disabled={busy || !newName}>
          {busy ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void refresh()}
          disabled={busy}
        >
          Refresh
        </button>
      </form>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Contacts CRUD sub-panel — insert / list / update / delete                 */
/* -------------------------------------------------------------------------- */

interface ContactDraft {
  name: string;
  email: string;
  status: string;
  tags: string;
  phone: string;
  notes: string;
}

const EMPTY_DRAFT: ContactDraft = {
  name: "",
  email: "",
  status: "lead",
  tags: "",
  phone: "",
  notes: "",
};

function ContactsPanel({
  client,
  collectionName,
}: {
  readonly client: DataClient;
  readonly collectionName: string;
}) {
  const [items, setItems] = useState<ContactRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ContactDraft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [collectionExists, setCollectionExists] = useState<boolean | null>(
    null,
  );

  const collection = useMemo(
    () => client.collection(collectionName),
    [client, collectionName],
  );

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await collection.list({ limit: 50, order: "newest" });
      setItems(r.items as ContactRecord[]);
      setCollectionExists(true);
    } catch (e) {
      // -32020 = collection not found (SDK re-emits cleanly).
      // Surface that as a "create the collection first" CTA rather
      // than a scary error.
      const msg = formatError(e);
      if (msg.includes("-32020") || msg.includes("not found")) {
        setCollectionExists(false);
        setItems([]);
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection]);

  const createCollection = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.createCollection({
        name: collectionName,
        schema: "aithos.contacts.v1",
      });
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const toRecord = (d: ContactDraft): Record<string, unknown> => {
    const tags = d.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      name: d.name,
      ...(d.email ? { email: d.email } : {}),
      status: d.status || "lead",
      ...(tags.length > 0 ? { tags } : {}),
      ...(d.phone ? { phone: d.phone } : {}),
      ...(d.notes ? { notes: d.notes } : {}),
    };
  };

  const submit = async () => {
    if (!draft.name) {
      setError("Le champ name est requis par aithos.contacts.v1.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await collection.update(editingId, toRecord(draft));
      } else {
        await collection.insert(toRecord(draft));
      }
      setDraft(EMPTY_DRAFT);
      setEditingId(null);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (item: ContactRecord) => {
    const id = (item._id as string | undefined) ?? "";
    setEditingId(id);
    setDraft({
      name: String(item.name ?? ""),
      email: String(item.email ?? ""),
      status: String(item.status ?? "lead"),
      tags: Array.isArray(item.tags) ? (item.tags as string[]).join(", ") : "",
      phone: String(item.phone ?? ""),
      notes: String(item.notes ?? ""),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const remove = async (id: string) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Soft-delete record ${id}?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await collection.delete(id);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (collectionExists === false) {
    return (
      <section>
        <h2>Contacts — collection &quot;{collectionName}&quot;</h2>
        <p className="lede">
          Cette collection n'existe pas encore sous cette identité.
        </p>
        <button onClick={() => void createCollection()} disabled={busy}>
          {busy ? "Création…" : `Créer la collection "${collectionName}"`}
        </button>
        {error && <div className="error">{error}</div>}
      </section>
    );
  }

  return (
    <section>
      <h2>
        Contacts — collection &quot;{collectionName}&quot;{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 14 }}>
          ({items.length})
        </span>
      </h2>
      <p className="lede">
        <code>insert</code> / <code>list</code> / <code>update</code> /{" "}
        <code>delete</code>. <em>Indexable</em> fields (name, email,
        status, tags) are sent in clear to the PDS for filtering /
        sorting; <em>encrypted</em> fields (phone, notes) are
        AEAD-encrypted client-side with a per-collection CMK and only
        decrypted in this browser.
      </p>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{editingId ? `Edit ${editingId}` : "New contact"}</h3>
        <div className="row">
          <label style={{ flex: "1 1 200px" }}>
            <span>Name *</span>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label style={{ flex: "1 1 200px" }}>
            <span>Email</span>
            <input
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </label>
        </div>
        <div className="row">
          <label style={{ flex: "1 1 140px" }}>
            <span>Status</span>
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value })}
            >
              <option value="lead">lead</option>
              <option value="contacted">contacted</option>
              <option value="qualified">qualified</option>
              <option value="won">won</option>
              <option value="lost">lost</option>
              <option value="archived">archived</option>
            </select>
          </label>
          <label style={{ flex: "1 1 220px" }}>
            <span>Tags (comma-separated, indexable)</span>
            <input
              type="text"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              placeholder="priority, fr"
            />
          </label>
          <label style={{ flex: "1 1 200px" }}>
            <span>Phone (encrypted)</span>
            <input
              type="tel"
              value={draft.phone}
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              placeholder="+33612345678"
            />
          </label>
        </div>
        <label>
          <span>Notes (encrypted)</span>
          <textarea
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            placeholder="Met at SaaStr 2026, interested in our pro tier…"
          />
        </label>
        <div className="row">
          <button type="submit" disabled={busy || !draft.name}>
            {busy
              ? editingId
                ? "Updating…"
                : "Inserting…"
              : editingId
                ? "Update"
                : "Insert"}
          </button>
          {editingId && (
            <button type="button" className="secondary" onClick={cancelEdit}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => void refresh()}
            disabled={busy}
          >
            Refresh list
          </button>
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {items.length === 0 ? (
        <p style={{ marginTop: 16 }}>
          <em>No contacts yet — insert one above.</em>
        </p>
      ) : (
        <div style={{ marginTop: 16 }}>
          {items.map((item) => {
            const id = (item._id as string | undefined) ?? "";
            return (
              <div key={id} className="section-card">
                <h4>
                  {String(item.name ?? "(unnamed)")}{" "}
                  <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                    — {String(item.status ?? "?")}
                  </span>
                </h4>
                <div className="body">
                  {item.email ? <>📧 {String(item.email)}<br /></> : null}
                  {item.phone ? <>📞 {String(item.phone)}<br /></> : null}
                  {Array.isArray(item.tags) && item.tags.length > 0 ? (
                    <>🏷️ {(item.tags as string[]).join(", ")}<br /></>
                  ) : null}
                  {item.notes ? <>📝 {String(item.notes)}</> : null}
                </div>
                <div className="meta">
                  <code>{id}</code>
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    className="secondary"
                    onClick={() => startEdit(item)}
                    disabled={busy}
                  >
                    Edit
                  </button>
                  <button
                    className="danger"
                    onClick={() => void remove(id)}
                    disabled={busy || !id}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
