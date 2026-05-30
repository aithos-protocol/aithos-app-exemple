// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /data — `sdk.data` demo: end-to-end vendor-schema flow on an
// ephemeral did:key identity.
//
// What this page demonstrates
// ---------------------------
//   1. `createDataClient({ schemas: [notesV1Lite] })` — registering an
//      app-defined schema (`aithos.x.demo.notes.v1`) with the SDK so it
//      knows how to split records into indexable metadata + encrypted
//      payload (alpha.39+).
//   2. `client.registerSchema(notesV1JsonSchema)` — publishing the
//      JSON Schema 2020-12 document to the subject's PDS. Once
//      published, the PDS validates record writes server-side
//      (additionalProperties:false, required:[title], status enum, …).
//      Idempotent — safe to call on every page mount.
//   3. `client.createCollection({ name, schema: NOTES_SCHEMA_ID })` —
//      attaching a fresh collection to the vendor schema. Multiple
//      collections can share one schema (e.g. "personal", "work").
//   4. `client.collection(name).{insert, list, update, delete}` —
//      CRUD on records via a typed form bound to the active collection.
//
// Why ephemeral did:key, not the signed-in Aithos user?
//   The SDK doesn't yet expose the signed-in owner's sphere seed bytes,
//   so we generate a fresh did:key keypair on first visit and persist
//   its seed in localStorage (key `aithos:demo:data-did-key`). The same
//   identity is shared with /assets so collections / records / assets
//   live under one demo DID across reloads.

import { useEffect, useMemo, useState } from "react";

import {
  createAppendDataClient,
  createDataClient,
  createDelegateDataClient,
  type DataClient,
  type DataCollection,
} from "@aithos/sdk";
import {
  bytesToHex,
  ed25519PublicKeyToMultibase,
  generateKeyPair,
} from "@aithos/protocol-client";

import {
  NOTES_SCHEMA_ID,
  NOTE_STATUSES,
  notesV1Lite,
  notesV1JsonSchema,
  type NoteStatus,
} from "../schemas/notes.js";
import { formatError } from "./Home.js";

const PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_PDS_URL) ||
  "https://slpknok0md.execute-api.eu-west-3.amazonaws.com";

const STORAGE_KEY = "aithos:demo:data-did-key";

/**
 * The full list of vendor schemas the demo carries. Today there's only
 * one (notes) but the structure is intentionally a list so adding
 * `bookmark.v1` / `idea.v1` later means appending to this array +
 * shipping a sibling JSON Schema + registering a form component.
 */
const VENDOR_SCHEMAS = [
  {
    id: NOTES_SCHEMA_ID,
    lite: notesV1Lite,
    jsonSchema: notesV1JsonSchema,
    label: "Notes (demo)",
    description:
      "Markdown notes with title, tags, status (draft/published/archived), pinned flag, and a private side-note. Indexable: title/tags/status/pinned. Encrypted: content/private_notes.",
  },
] as const;

/* -------------------------------------------------------------------------- */
/*  Identity helpers (shared with /assets so the demo DID is shared)          */
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
/*  Top-level component                                                       */
/* -------------------------------------------------------------------------- */

interface CollectionMeta {
  readonly name: string;
  readonly schema: string;
  readonly record_count: number;
}

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
        // Hand the SDK every vendor schema this demo knows about so it
        // can split records correctly into indexable vs encrypted parts.
        schemas: VENDOR_SCHEMAS.map((s) => s.lite),
      }),
    [identity],
  );

  // The collection the records panel operates on. null = "pick one
  // below or create one". Reset to null whenever the identity changes
  // because under a fresh DID no collection is yet known to exist.
  const [activeCollection, setActiveCollection] =
    useState<CollectionMeta | null>(null);

  return (
    <>
      <section>
        <h2>PDS data — sdk.data with a vendor schema</h2>
        <p className="lede">
          End-to-end demo of the Aithos data sub-protocol against the
          dev PDS at <code>{PDS_URL}</code>. This page registers a
          vendor JSON Schema (<code>{NOTES_SCHEMA_ID}</code>) on the PDS,
          lets you create as many collections as you want under that
          schema, then CRUDs records into the active collection. The
          PDS only ever sees indexable metadata in clear — encrypted
          fields stay AEAD'd under a per-collection CMK.
        </p>
        <p className="lede" style={{ marginTop: -8 }}>
          <strong>Note:</strong> this page uses an ephemeral{" "}
          <code>did:key</code> identity persisted in your browser's
          localStorage — shared with <code>/assets</code>. Independent
          from any Aithos sign-in above.
        </p>
        <IdentityPanel
          identity={identity}
          onReset={() => {
            setActiveCollection(null);
            setIdentity(resetIdentity());
          }}
        />
      </section>

      <SchemaPanel client={client} />

      <CollectionsPanel
        client={client}
        activeCollection={activeCollection}
        onSelect={setActiveCollection}
      />

      <RecordsPanel client={client} activeCollection={activeCollection} />

      <AppendMandateBrowser />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Act as an APPEND mandate — the grantee's blind view                        */
/* -------------------------------------------------------------------------- */

/**
 * Load a downloaded `data.<col>.append` bundle and act AS its grantee against
 * the live PDS. This is the view the rest of /data can't give you: /data above
 * always runs as the local owner did:key (decoupled from sign-in), so it shows
 * everything. Here we use the bundle's delegate seed, so you experience the
 * real restriction — you can append, but you cannot read the collection, not
 * even the record you just appended (gamma-style). Only the owner can read it.
 */
function AppendMandateBrowser() {
  interface Loaded {
    readonly mandate: { id: string; issuer: string; scopes: string[]; grantee: { pubkey?: string } };
    readonly seed: Uint8Array;
    readonly collectionName: string;
    readonly subjectDid: string;
    readonly ownerPubMb: string;
  }

  const [bundleText, setBundleText] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [readState, setReadState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "blocked"; message: string }
    | { kind: "visible"; count: number } // would be a BUG
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [addErr, setAddErr] = useState<string | null>(null);

  const load = () => {
    setParseError(null);
    setLoaded(null);
    setReadState({ kind: "idle" });
    setAddMsg(null);
    setAddErr(null);
    try {
      const b = JSON.parse(bundleText) as {
        mandate?: Loaded["mandate"];
        delegate_seed_hex?: string;
      };
      if (!b.mandate || !b.delegate_seed_hex) {
        throw new Error("not an aithos delegate bundle (missing mandate / delegate_seed_hex)");
      }
      const scope = (b.mandate.scopes ?? []).find((s) => /^data\.[^.]+\.append$/.test(s));
      if (!scope) {
        throw new Error("this bundle has no data.<collection>.append scope");
      }
      const collectionName = scope.split(".")[1]!;
      const subjectDid = b.mandate.issuer;
      const ownerPubMb = subjectDid.replace(/^did:key:/, "");
      const seed = hexToBytes(b.delegate_seed_hex);
      const next: Loaded = { mandate: b.mandate, seed, collectionName, subjectDid, ownerPubMb };
      setLoaded(next);
      void checkRead(next);
    } catch (e) {
      setParseError(formatError(e));
    }
  };

  // Try to READ the collection as the grantee — expected to be blocked.
  async function checkRead(l: Loaded) {
    setReadState({ kind: "checking" });
    try {
      const reader = createDelegateDataClient({
        pdsUrl: PDS_URL,
        subjectDid: l.subjectDid,
        mandate: l.mandate as never,
        delegateSeed: l.seed,
        schemas: [notesV1Lite],
      });
      const r = await reader.collection(l.collectionName).list({ limit: 50 });
      // If this succeeds, append leaked read — that's a bug worth surfacing.
      setReadState({ kind: "visible", count: r.items.length });
    } catch (e) {
      setReadState({ kind: "blocked", message: formatError(e) });
    }
  }

  const append = async () => {
    if (!loaded || !title.trim()) return;
    setBusy(true);
    setAddMsg(null);
    setAddErr(null);
    try {
      const appendClient = createAppendDataClient({
        pdsUrl: PDS_URL,
        subjectDid: loaded.subjectDid,
        ownerDataPubkeyMultibase: loaded.ownerPubMb,
        mandate: loaded.mandate as never,
        delegateSeed: loaded.seed,
        schema: notesV1Lite,
      });
      const id = await appendClient
        .collection(loaded.collectionName)
        .insert({ title: title.trim(), ...(content ? { content } : {}) });
      setAddMsg(`Appended ${id}. You still can't read it — only the owner can.`);
      setTitle("");
      setContent("");
    } catch (e) {
      setAddErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Act as an append mandate</h2>
      <p className="lede">
        Paste a downloaded <code>data.&lt;collection&gt;.append</code> bundle to
        act as its grantee against the live PDS. Unlike the owner playground
        above, here you get the <strong>real</strong> append experience: you can
        add a record, but reading the collection is refused — you can&rsquo;t see
        existing records, not even your own deposit. Only the owner can read it.
      </p>
      <label>
        <span>Append bundle (.aithos-delegate.json)</span>
        <textarea
          value={bundleText}
          onChange={(e) => setBundleText(e.target.value)}
          placeholder='{ "aithos_delegate_version": "0.1.0", "mandate": { … "scopes": ["data.test.append"] }, "delegate_seed_hex": "…" }'
          rows={5}
        />
      </label>
      <div className="row">
        <button type="button" onClick={load} disabled={!bundleText.trim()}>
          Load mandate
        </button>
      </div>
      {parseError && <div className="error">{parseError}</div>}

      {loaded && (
        <>
          <dl className="kvtable" style={{ marginTop: 12 }}>
            <dt>Acting as grantee</dt>
            <dd>
              <code>{loaded.mandate.grantee.pubkey?.slice(0, 20)}…</code>
            </dd>
            <dt>Collection</dt>
            <dd>
              <code>{loaded.collectionName}</code> (owner{" "}
              <code>{loaded.subjectDid.slice(0, 20)}…</code>)
            </dd>
            <dt>Read access</dt>
            <dd>
              {readState.kind === "checking" && <em>Checking…</em>}
              {readState.kind === "blocked" && (
                <strong>🔒 Blocked — no read access (append grants no read). You cannot see the collection.</strong>
              )}
              {readState.kind === "visible" && (
                <span className="error" style={{ display: "inline" }}>
                  ⚠️ Unexpected: read returned {readState.count} record(s) — append should NOT grant read.
                </span>
              )}
              {readState.kind === "error" && (
                <span className="error" style={{ display: "inline" }}>{readState.message}</span>
              )}
            </dd>
          </dl>

          {/* No record list is rendered — by design, the grantee can't read. */}

          <form
            className="stack"
            style={{ marginTop: 12 }}
            onSubmit={(e) => {
              e.preventDefault();
              void append();
            }}
          >
            <h3>New note (append-only)</h3>
            <label>
              <span>Title *</span>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              <span>Content (encrypted, sealed to the owner)</span>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={4}
                placeholder="Only the owner will ever be able to read this."
              />
            </label>
            <div className="row">
              <button type="submit" disabled={busy || !title.trim()}>
                {busy ? "Appending…" : "Append"}
              </button>
            </div>
            {addMsg && <div className="success">{addMsg}</div>}
            {addErr && <div className="error">{addErr}</div>}
          </form>
        </>
      )}
    </section>
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
                "Generate a NEW ephemeral did:key? The old one (and any collections / records / assets under it) will be unreachable from this browser.",
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
/*  Schema sub-panel — registerSchema at mount                                */
/* -------------------------------------------------------------------------- */

type SchemaPublishState =
  | { kind: "idle" }
  | { kind: "publishing" }
  | { kind: "ok"; createdNow: boolean; docHash: string }
  | { kind: "error"; message: string };

function SchemaPanel({ client }: { readonly client: DataClient }) {
  const [state, setState] = useState<SchemaPublishState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: "publishing" });
      try {
        // Idempotent: if the same canonical doc was already published,
        // `created` comes back false but the call still succeeds.
        const r = await client.registerSchema(notesV1JsonSchema);
        if (cancelled) return;
        setState({
          kind: "ok",
          createdNow: r.created,
          docHash: r.docHash,
        });
      } catch (e) {
        if (cancelled) return;
        setState({ kind: "error", message: formatError(e) });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Rerun when client changes (e.g. identity reset → fresh PDS state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  return (
    <section>
      <h2>Schema</h2>
      <p className="lede">
        The vendor schema <code>{NOTES_SCHEMA_ID}</code> is published to
        this subject's PDS via{" "}
        <code>client.registerSchema(notesV1JsonSchema)</code> at page
        mount. Once published, the PDS validates every record write
        against the JSON Schema server-side. The call is idempotent —
        replaying it returns <code>{"{created: false}"}</code>; a
        different document for the same id would be rejected with{" "}
        <code>-32082 AITHOS_DATA_SCHEMA_IMMUTABLE</code>.
      </p>
      <dl className="kvtable">
        <dt>Schema id</dt>
        <dd>
          <code>{NOTES_SCHEMA_ID}</code>
        </dd>
        <dt>Indexable fields</dt>
        <dd>
          {Array.from(notesV1Lite.indexable)
            .filter((f) => !notesV1Lite.auto.has(f))
            .map((f) => (
              <code key={f} style={{ marginRight: 6 }}>
                {f}
              </code>
            ))}
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            (plus auto: created_at, modified_at)
          </span>
        </dd>
        <dt>Encrypted fields</dt>
        <dd>
          {Array.from(notesV1Lite.encrypted).map((f) => (
            <code key={f} style={{ marginRight: 6 }}>
              {f}
            </code>
          ))}
        </dd>
        <dt>Publish status</dt>
        <dd>
          {state.kind === "idle" && <em>Queued…</em>}
          {state.kind === "publishing" && <em>Publishing…</em>}
          {state.kind === "ok" && (
            <span>
              ✓ {state.createdNow ? "Published just now" : "Already published"}{" "}
              <span style={{ color: "var(--muted)", fontSize: 12 }}>
                · docHash <code>{state.docHash.slice(0, 16)}…</code>
              </span>
            </span>
          )}
          {state.kind === "error" && (
            <span className="error" style={{ display: "inline" }}>
              {state.message}
            </span>
          )}
        </dd>
      </dl>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Collections sub-panel — list / create / select active                     */
/* -------------------------------------------------------------------------- */

function CollectionsPanel({
  client,
  activeCollection,
  onSelect,
}: {
  readonly client: DataClient;
  readonly activeCollection: CollectionMeta | null;
  readonly onSelect: (col: CollectionMeta | null) => void;
}) {
  const [cols, setCols] = useState<readonly CollectionMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSchema, setNewSchema] = useState<string>(NOTES_SCHEMA_ID);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.listCollections();
      setCols(r);
      // If the active collection no longer exists (e.g. after identity
      // reset), drop the selection so the records panel knows.
      if (
        activeCollection &&
        !r.some((c) => c.name === activeCollection.name)
      ) {
        onSelect(null);
      }
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const create = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await client.createCollection({
        name: newName.trim(),
        schema: newSchema,
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
        A collection binds a name to a schema. Records inside MUST
        conform to that schema (enforced server-side after{" "}
        <code>registerSchema</code>). Pick the schema you want, name
        the collection anything you like, hit <em>Create</em>. Click{" "}
        <em>Use this</em> on a row to make it the target of the records
        panel below.
      </p>

      <form
        className="row"
        style={{ marginBottom: 16, flexWrap: "wrap", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label style={{ flex: "0 0 240px" }}>
          <span>Schema</span>
          <select
            value={newSchema}
            onChange={(e) => setNewSchema(e.target.value)}
          >
            {VENDOR_SCHEMAS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.id}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: "1 1 220px" }}>
          <span>Collection name</span>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder='e.g. "personal", "work", "ideas"'
          />
        </label>
        <div style={{ display: "flex", gap: 8, alignSelf: "flex-end" }}>
          <button type="submit" disabled={busy || !newName.trim()}>
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
        </div>
      </form>

      {error && <div className="error">{error}</div>}

      {cols.length === 0 ? (
        <p>
          <em>
            No collections yet under this identity. Create one with the
            form above.
          </em>
        </p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
          {cols.map((c) => {
            const isActive = activeCollection?.name === c.name;
            return (
              <li
                key={c.name}
                className="section-card"
                style={{
                  marginBottom: 8,
                  borderLeft: isActive
                    ? "3px solid var(--accent, #3b82f6)"
                    : undefined,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ flex: "1 1 240px" }}>
                    <strong>{c.name}</strong>{" "}
                    <span style={{ color: "var(--muted)", fontSize: 13 }}>
                      — <code>{c.schema}</code> · {c.record_count} record
                      {c.record_count === 1 ? "" : "s"}
                    </span>
                  </div>
                  {isActive ? (
                    <span
                      className="pill"
                      style={{
                        background: "var(--accent, #3b82f6)",
                        color: "white",
                      }}
                    >
                      Active
                    </span>
                  ) : (
                    <button
                      className="secondary"
                      onClick={() => onSelect(c)}
                      disabled={busy}
                    >
                      Use this
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Records sub-panel — schema-typed CRUD on the active collection            */
/* -------------------------------------------------------------------------- */

interface NotesDraft {
  title: string;
  tags: string; // CSV in the form, split on submit
  status: NoteStatus;
  pinned: boolean;
  content: string;
  private_notes: string;
}

const EMPTY_NOTES_DRAFT: NotesDraft = {
  title: "",
  tags: "",
  status: "draft",
  pinned: false,
  content: "",
  private_notes: "",
};

function RecordsPanel({
  client,
  activeCollection,
}: {
  readonly client: DataClient;
  readonly activeCollection: CollectionMeta | null;
}) {
  if (!activeCollection) {
    return (
      <section>
        <h2>Records</h2>
        <p className="lede">
          <em>
            Pick a collection above (or create one) to start inserting
            records.
          </em>
        </p>
      </section>
    );
  }

  // Route on the active collection's schema id. Today there's only one
  // form (Notes); future vendor schemas would get sibling components +
  // a dispatch table here.
  if (activeCollection.schema === NOTES_SCHEMA_ID) {
    return (
      <NotesRecordsPanel
        client={client}
        collectionMeta={activeCollection}
      />
    );
  }

  return (
    <section>
      <h2>Records — {activeCollection.name}</h2>
      <p className="error">
        Unknown schema <code>{activeCollection.schema}</code>. Register
        it in <code>VENDOR_SCHEMAS</code> + add a form component.
      </p>
    </section>
  );
}

function NotesRecordsPanel({
  client,
  collectionMeta,
}: {
  readonly client: DataClient;
  readonly collectionMeta: CollectionMeta;
}) {
  type NoteRecord = Record<string, unknown> & { _id?: string };

  const collection = useMemo<DataCollection>(
    () => client.collection(collectionMeta.name),
    [client, collectionMeta.name],
  );

  const [items, setItems] = useState<NoteRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<NotesDraft>(EMPTY_NOTES_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await collection.list({ limit: 50, order: "newest" });
      setItems(r.items as NoteRecord[]);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection]);

  const toRecord = (d: NotesDraft): Record<string, unknown> => {
    const tags = d.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      title: d.title.trim(),
      ...(tags.length > 0 ? { tags } : {}),
      status: d.status,
      pinned: d.pinned,
      ...(d.content ? { content: d.content } : {}),
      ...(d.private_notes ? { private_notes: d.private_notes } : {}),
    };
  };

  const submit = async () => {
    if (!draft.title.trim()) {
      setError("title is required by aithos.x.demo.notes.v1.");
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
      setDraft(EMPTY_NOTES_DRAFT);
      setEditingId(null);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (item: NoteRecord) => {
    const id = (item._id as string | undefined) ?? "";
    setEditingId(id);
    setDraft({
      title: String(item.title ?? ""),
      tags: Array.isArray(item.tags) ? (item.tags as string[]).join(", ") : "",
      status: (NOTE_STATUSES as readonly string[]).includes(
        String(item.status),
      )
        ? (item.status as NoteStatus)
        : "draft",
      pinned: Boolean(item.pinned),
      content: String(item.content ?? ""),
      private_notes: String(item.private_notes ?? ""),
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(EMPTY_NOTES_DRAFT);
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

  return (
    <section>
      <h2>
        Records — collection &quot;{collectionMeta.name}&quot;{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 14 }}>
          ({items.length} loaded · schema <code>{collectionMeta.schema}</code>)
        </span>
      </h2>
      <p className="lede">
        <code>insert</code> / <code>list</code> / <code>update</code> /{" "}
        <code>delete</code> against the active collection. Indexable
        fields (<em>title</em>, <em>tags</em>, <em>status</em>,{" "}
        <em>pinned</em>) are shipped in clear to the PDS for
        filtering/sorting; encrypted fields (<em>content</em>,{" "}
        <em>private_notes</em>) are AEAD'd client-side under the
        collection's CMK and only ever decrypted here.
      </p>

      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3>{editingId ? `Edit ${editingId}` : "New note"}</h3>

        <label>
          <span>Title *</span>
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>

        <div className="row">
          <label style={{ flex: "1 1 200px" }}>
            <span>Tags (comma-separated, indexable)</span>
            <input
              type="text"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              placeholder="aithos, demo, sdk"
            />
          </label>
          <label style={{ flex: "0 0 160px" }}>
            <span>Status</span>
            <select
              value={draft.status}
              onChange={(e) =>
                setDraft({ ...draft, status: e.target.value as NoteStatus })
              }
            >
              {NOTE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label
            style={{
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              gap: 6,
              alignSelf: "flex-end",
              paddingBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={draft.pinned}
              onChange={(e) =>
                setDraft({ ...draft, pinned: e.target.checked })
              }
            />
            <span>📌 Pinned</span>
          </label>
        </div>

        <label>
          <span>Content (markdown · encrypted)</span>
          <textarea
            value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="# My note&#10;&#10;Markdown body — never visible to the PDS in plaintext."
            rows={6}
          />
        </label>

        <label>
          <span>Private notes (encrypted)</span>
          <textarea
            value={draft.private_notes}
            onChange={(e) =>
              setDraft({ ...draft, private_notes: e.target.value })
            }
            placeholder="Side-notes nobody else will ever read."
            rows={3}
          />
        </label>

        <div className="row">
          <button type="submit" disabled={busy || !draft.title.trim()}>
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
          <em>No records yet — insert one above.</em>
        </p>
      ) : (
        <div style={{ marginTop: 16 }}>
          {items.map((item) => {
            const id = (item._id as string | undefined) ?? "";
            const tags = Array.isArray(item.tags) ? (item.tags as string[]) : [];
            return (
              <div key={id} className="section-card">
                <h4 style={{ margin: 0 }}>
                  {item.pinned ? "📌 " : ""}
                  {String(item.title ?? "(untitled)")}{" "}
                  <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
                    — {String(item.status ?? "?")}
                  </span>
                </h4>
                <div className="body" style={{ marginTop: 6 }}>
                  {tags.length > 0 && (
                    <div style={{ marginBottom: 4 }}>
                      {tags.map((t) => (
                        <code
                          key={t}
                          style={{
                            marginRight: 6,
                            background: "var(--bg-elev-1, #f4f4f4)",
                            padding: "1px 6px",
                            borderRadius: 4,
                            fontSize: 12,
                          }}
                        >
                          {t}
                        </code>
                      ))}
                    </div>
                  )}
                  {item.content ? (
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        margin: 0,
                        fontFamily: "inherit",
                        fontSize: 13,
                      }}
                    >
                      {String(item.content)}
                    </pre>
                  ) : null}
                  {item.private_notes ? (
                    <div
                      style={{
                        marginTop: 6,
                        padding: 6,
                        background: "var(--bg-elev-1, #f4f4f4)",
                        borderRadius: 4,
                        fontSize: 12,
                      }}
                    >
                      🔒 {String(item.private_notes)}
                    </div>
                  ) : null}
                </div>
                <div className="meta" style={{ marginTop: 6 }}>
                  <code>{id}</code>
                  {item.created_at ? (
                    <>
                      {" · created "}
                      <span>{String(item.created_at).slice(0, 19)}</span>
                    </>
                  ) : null}
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
