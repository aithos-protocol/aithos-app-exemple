// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// DataPlayground — the reusable Schema + Collections + Records UI for any
// `DataClient`, regardless of how the underlying identity was obtained.
//
// It's deliberately client-agnostic: hand it a `DataClient` built on a
// throwaway did:key (the legacy /data page) OR on a real did:aithos signing
// under the dedicated #data sphere (the /owner-data page) and it behaves
// identically. The owner of the client decides WHO signs; this component only
// drives the schema/collection/record lifecycle.
//
// Extracted from routes/Data.tsx during the #data strangler migration so the
// new owner-#data page reaches feature parity without duplicating ~400 lines.
// The legacy Data.tsx keeps its own inline copy untouched until cleanup.

import { useEffect, useMemo, useState } from "react";

import {
  type DataClient,
  type DataCollection,
} from "@aithos/sdk";

import {
  NOTES_SCHEMA_ID,
  NOTE_STATUSES,
  notesV1Lite,
  notesV1JsonSchema,
  type NoteStatus,
} from "../schemas/notes.js";
import { formatError } from "../routes/Home.js";

/* -------------------------------------------------------------------------- */
/*  Vendor schemas the playground knows about                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every vendor (app-defined) schema this demo carries. Today there's only one
 * (notes) but the structure is intentionally a list: adding `bookmark.v1` /
 * `idea.v1` later means appending here + shipping a sibling JSON Schema +
 * registering a form component in {@link RecordsPanel}.
 */
export const VENDOR_SCHEMAS = [
  {
    id: NOTES_SCHEMA_ID,
    lite: notesV1Lite,
    jsonSchema: notesV1JsonSchema,
    label: "Notes (demo)",
    description:
      "Markdown notes with title, tags, status (draft/published/archived), pinned flag, and a private side-note. Indexable: title/tags/status/pinned. Encrypted: content/private_notes.",
  },
] as const;

/** The `lite` descriptors to hand to `createDataClient({ schemas })`. */
export function vendorLites() {
  return VENDOR_SCHEMAS.map((s) => s.lite);
}

export interface CollectionMeta {
  readonly name: string;
  readonly schema: string;
  readonly record_count: number;
}

/* -------------------------------------------------------------------------- */
/*  Top-level playground — wires Schema + Collections + Records                */
/* -------------------------------------------------------------------------- */

export function DataPlayground({ client }: { readonly client: DataClient }) {
  // The collection the records panel operates on. null = "pick one below or
  // create one". Reset whenever the client changes (e.g. identity reset, or a
  // different owner signs in) because no collection is known under a fresh DID.
  const [activeCollection, setActiveCollection] =
    useState<CollectionMeta | null>(null);

  useEffect(() => {
    setActiveCollection(null);
  }, [client]);

  return (
    <>
      <SchemaPanel client={client} />
      <CollectionsPanel
        client={client}
        activeCollection={activeCollection}
        onSelect={setActiveCollection}
      />
      <RecordsPanel client={client} activeCollection={activeCollection} />
    </>
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
        setState({ kind: "ok", createdNow: r.created, docHash: r.docHash });
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
        The vendor schema <code>{NOTES_SCHEMA_ID}</code> is published to this
        subject's PDS via{" "}
        <code>client.registerSchema(notesV1JsonSchema)</code> at page mount.
        Once published, the PDS validates every record write against the JSON
        Schema server-side. The call is idempotent — replaying it returns{" "}
        <code>{"{created: false}"}</code>; a different document for the same id
        would be rejected with{" "}
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
      // If the active collection no longer exists (e.g. after identity reset),
      // drop the selection so the records panel knows.
      if (activeCollection && !r.some((c) => c.name === activeCollection.name)) {
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
      await client.createCollection({ name: newName.trim(), schema: newSchema });
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
        A collection binds a name to a schema. Records inside MUST conform to
        that schema (enforced server-side after <code>registerSchema</code>).
        Pick the schema you want, name the collection anything you like, hit{" "}
        <em>Create</em>. Click <em>Use this</em> on a row to make it the target
        of the records panel below.
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
            No collections yet under this identity. Create one with the form
            above.
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
            Pick a collection above (or create one) to start inserting records.
          </em>
        </p>
      </section>
    );
  }

  // Route on the active collection's schema id. Today there's only one form
  // (Notes); future vendor schemas would get sibling components + a dispatch
  // table here.
  if (activeCollection.schema === NOTES_SCHEMA_ID) {
    return (
      <NotesRecordsPanel client={client} collectionMeta={activeCollection} />
    );
  }

  // Any other (vendor) schema: the SDK auto-resolves the published schema from
  // the PDS and decodes records, so we render them generically (read-only).
  // This is the strangler-friendly default — the reference app reads ANY
  // collection without bundling a per-schema form.
  return (
    <GenericRecordsPanel client={client} collectionMeta={activeCollection} />
  );
}

/**
 * Read-only generic record viewer for any collection whose schema has no
 * dedicated form. Relies on the SDK auto-resolving the published schema from
 * the PDS (alpha.55+) so records come back decrypted; we just render their
 * decrypted key/values.
 */
function GenericRecordsPanel({
  client,
  collectionMeta,
}: {
  readonly client: DataClient;
  readonly collectionMeta: CollectionMeta;
}) {
  const collection = useMemo<DataCollection>(
    () => client.collection(collectionMeta.name),
    [client, collectionMeta.name],
  );
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await collection.list({ limit: 50, order: "newest" });
      setItems(r.items as Record<string, unknown>[]);
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

  return (
    <section>
      <h2>
        Records — collection &quot;{collectionMeta.name}&quot;{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 14 }}>
          ({items.length} loaded · schema <code>{collectionMeta.schema}</code>)
        </span>
      </h2>
      <p className="lede">
        Generic read-only view — this app ships no dedicated form for{" "}
        <code>{collectionMeta.schema}</code>, so records are shown as decrypted
        key/values. The schema was auto-resolved from the PDS; encrypted fields
        are decrypted client-side under the collection&apos;s CMK.
      </p>
      <div className="row">
        <button onClick={() => void refresh()} disabled={busy}>
          {busy ? "Loading…" : "Reload"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && !busy && (
        <p className="lede">
          <em>No records.</em>
        </p>
      )}
      <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
        {items.map((it, i) => (
          <li
            key={(it.record_id as string) ?? (it._id as string) ?? String(i)}
            style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}
          >
            <table>
              <tbody>
                {Object.entries(it).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ color: "var(--muted)", paddingRight: 12, verticalAlign: "top" }}>
                      <code>{k}</code>
                    </td>
                    <td>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {renderGenericValue(v)}
                      </pre>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </li>
        ))}
      </ul>
    </section>
  );
}

function renderGenericValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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
      status: (NOTE_STATUSES as readonly string[]).includes(String(item.status))
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
        <code>delete</code> against the active collection. Indexable fields (
        <em>title</em>, <em>tags</em>, <em>status</em>, <em>pinned</em>) are
        shipped in clear to the PDS for filtering/sorting; encrypted fields (
        <em>content</em>, <em>private_notes</em>) are AEAD'd client-side under
        the collection's CMK and only ever decrypted here.
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
              onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })}
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
                  <span
                    style={{
                      color: "var(--muted)",
                      fontWeight: 400,
                      fontSize: 13,
                    }}
                  >
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
