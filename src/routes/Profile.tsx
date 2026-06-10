// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Profile — the Ethos editor, capability-aware.
//
//   - owner    : sdk.ethos.me(), full read/write on every zone.
//   - delegate : sdk.ethos.of(subjectDid). Only the zones the mandate grants
//                are shown; write controls appear only with ethos.write.<zone>.
//
// IMPORTANT — per-section publish: every add / edit / delete is published on its
// own (stage the single change, then publish() immediately), so each action is a
// content-addressed delta edition — only the changed section's blob is uploaded,
// the rest carry forward by sha. The EthosClient still buffers changes in memory,
// so we build it ONCE per (actor kind + subject) and keep it stable for the page
// lifetime; the PublishBar only reappears if a publish failed and left a change
// staged. Re-renders after each action are driven by a LOCAL `rev` counter, never
// the global actor bump.
//
// The "authorized vs. decryptable" nuance is surfaced: a delegate may hold
// ethos.read.circle yet fail to decrypt if the owner never sealed the zone to
// them at publish time.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { EthosClient, Section, SectionIndexEntry } from "@aithos/sdk";

import { useActor, type ZoneName } from "../actor-context.js";
import { formatError } from "./Home.js";

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

/** Sections shown per page in the zone editor (client-side pagination over the
 *  fully-loaded index — only bodies are lazy, so titles/tags are all in hand). */
const PAGE_SIZE = 20;

export function Profile() {
  const { actor, capabilities: cap, getEthosClient, auth } = useActor();
  const [client, setClient] = useState<EthosClient | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // Local re-render trigger: bumped after every stage / publish so the editor
  // and the publish bar re-read the client's pending buffer. NOT the context
  // bump (which would rebuild the client and lose the buffer).
  const [rev, setRev] = useState(0);

  const readableZones = useMemo(() => ZONES.filter((z) => cap.ethosRead(z)), [cap]);
  const [zone, setZone] = useState<ZoneName>("public");

  useEffect(() => {
    if (readableZones.length > 0 && !readableZones.includes(zone)) {
      setZone(readableZones[0]!);
    }
  }, [readableZones, zone]);

  // Build the EthosClient once per (subject × session delegate-set). The
  // registry fingerprint matters: `sdk.ethos.of()` resolves its actor at BUILD
  // time, so a client created in an instant where the auth session's delegate
  // registry didn't (yet) hold the mandate comes out ANONYMOUS — and sticks.
  // Symptom of that stuck state: circle titles render (the anonymous index is
  // spec-true since sdk alpha.83) but every Open returns null WITHOUT a single
  // network request. Re-keying on the registry rebuilds the client the moment
  // the delegate set changes (import / remove / sign-in) — auth mutations only,
  // so the staged-buffer stability promise below still holds between edits.
  const subjectKey = actor ? `${actor.kind}:${actor.subjectDid}` : null;
  const registryKey = auth
    .getDelegates()
    .map((d) => d.mandateId)
    .sort()
    .join("|");
  useEffect(() => {
    if (!actor) {
      setClient(null);
      return;
    }
    let cancelled = false;
    setLoadErr(null);
    setClient(null);
    getEthosClient()
      .then((c) => {
        if (!cancelled) setClient(c);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(formatError(e));
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the stable subject identity + the session's delegate set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectKey, registryKey]);

  if (!actor) {
    return (
      <section>
        <h2>Profile</h2>
        <p className="lede">Sign in on the Home page first.</p>
      </section>
    );
  }

  if (readableZones.length === 0) {
    return (
      <section>
        <h2>Profile</h2>
        <p className="warn">
          This {actor.kind} has no Ethos read scope. A delegate needs an{" "}
          <code>ethos.read.&lt;zone&gt;</code> (or write) scope to see anything here.
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Ethos editor</h2>
      <p className="lede">
        Subject: <code>{actor.subjectDid}</code> · acting as{" "}
        <strong>{actor.kind}</strong>
        {actor.kind === "delegate" && (
          <>
            {" "}
            with <code>{actor.scopes.join(", ")}</code> — mandate{" "}
            <code>{actor.mandateId}</code>
          </>
        )}
        .
      </p>
      <div className="tabs">
        {ZONES.map((z) => {
          const readable = cap.ethosRead(z);
          return (
            <button
              key={z}
              className={zone === z ? "active" : ""}
              disabled={!readable}
              title={readable ? undefined : `needs ethos.read.${z}`}
              style={readable ? undefined : { opacity: 0.4, cursor: "not-allowed" }}
              onClick={() => readable && setZone(z)}
            >
              {z}
              {cap.ethosWrite(z) ? " ✎" : readable ? " 👁" : " 🔒"}
            </button>
          );
        })}
      </div>

      {loadErr && <div className="error">{loadErr}</div>}
      {!client && !loadErr && <p>Opening ethos client…</p>}
      {client && client.mode !== actor.kind && (
        <div className="error">
          ⚠ The Ethos client runs in <strong>{client.mode}</strong> mode while you are signed in
          as a <strong>{actor.kind}</strong>
          {actor.kind === "delegate" && (
            <>
              {" "}
              — the session holds no active mandate matching subject{" "}
              <code>{actor.subjectDid}</code>. Encrypted zones will list titles but every section
              opens empty, with no network request. Re-import the bundle on the Home page, then
              reload.
            </>
          )}
        </div>
      )}
      {client && (
        <>
          <ZoneEditor
            client={client}
            zone={zone}
            canWrite={cap.ethosWrite(zone)}
            actorKind={actor.kind}
            rev={rev}
            onChanged={() => setRev((r) => r + 1)}
          />
          {/* Per-section publish means there is normally nothing pending; this
              bar only surfaces if a publish failed and left a change staged. */}
          {ZONES.some((z) => cap.ethosWrite(z)) && client.pendingChanges().length > 0 && (
            <PublishBar client={client} onChanged={() => setRev((r) => r + 1)} />
          )}
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  ZoneEditor                                                                */
/* -------------------------------------------------------------------------- */

function ZoneEditor({
  client,
  zone,
  canWrite,
  actorKind,
  rev,
  onChanged,
}: {
  readonly client: EthosClient;
  readonly zone: ZoneName;
  readonly canWrite: boolean;
  readonly actorKind: "owner" | "delegate";
  readonly rev: number;
  readonly onChanged: () => void;
}) {
  const [index, setIndex] = useState<readonly SectionIndexEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy: load ONLY the index (titles + readable/writable flags) — never every
  // body. Each section's content is fetched on demand when the user opens it
  // (the point of content-addressing: you're never meant to load everything).
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIndex(await client.zone(zone).index());
    } catch (e) {
      setError(formatError(e));
      setIndex(null);
    } finally {
      setLoading(false);
    }
  }, [client, zone]);

  // Re-read whenever the zone changes OR a stage/publish bumped `rev`.
  useEffect(() => {
    void refresh();
  }, [refresh, rev]);

  // Client-side search + pagination over the (fully-loaded) index. The index
  // holds every section's title + tags already, so filtering never touches the
  // network; only bodies are lazy (fetched when a row is opened).
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  // A new query — or switching zones — jumps back to the first page.
  useEffect(() => {
    setPage(0);
  }, [query, zone]);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");

  // Per-section publish: stage ONE change then publish it on its own, so each
  // add / edit / delete is a content-addressed delta edition — only that
  // section's blob is uploaded, every other section carries forward by sha.
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pubError, setPubError] = useState<string | null>(null);

  const publishNow = useCallback(
    async (label: string) => {
      setBusy(true);
      setPubError(null);
      setStatus(null);
      try {
        const r = await client.publish();
        setStatus(`${label} — published edition #${r.editionHeight} (delta: only the changed section was uploaded).`);
      } catch (e) {
        setPubError(formatError(e));
      } finally {
        setBusy(false);
        onChanged();
      }
    },
    [client, onChanged],
  );

  const handleAdd = async () => {
    if (!title.trim() || !body.trim() || busy) return;
    const t = title;
    client.zone(zone).addSection({
      title,
      body,
      ...(tags ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    });
    setTitle("");
    setBody("");
    setTags("");
    await publishNow(`Added “${t}”`);
  };

  // Lazy model: we hold only the index. Each readable row fetches its own body
  // on demand; there is no staged-new buffer because every add publishes at once.
  const rows = index ?? [];
  const q = query.trim().toLowerCase();
  // Match title + tags, case-insensitive. A sealed section with no clear title
  // (self, out of scope) is still findable by its id.
  const filtered = q
    ? rows.filter((e) =>
        [e.title ?? "", ...(e.tags ?? []), e.title === undefined ? e.id : ""]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : rows;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const rangeStart = filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(filtered.length, safePage * PAGE_SIZE + PAGE_SIZE);

  const nothingToShow = index !== null && index.length === 0 && !loading;
  const noMatches = index !== null && index.length > 0 && filtered.length === 0 && !loading;

  return (
    <div className="stack">
      {loading && <p>Loading index…</p>}
      {error && (
        <div className="warn">
          Couldn't read <code>{zone}</code>: {error}
          {actorKind === "delegate" && (
            <>
              <br />
              Your mandate authorizes this zone, but it's not decryptable yet —
              ask the owner to <strong>publish {zone} once</strong> so your wrap
              is sealed in.
            </>
          )}
        </div>
      )}
      {nothingToShow && (
        <p className="lede">
          No sections in <code>{zone}</code> yet.
        </p>
      )}

      {busy && <p className="lede">Publishing this section…</p>}
      {status && <div className="success">{status}</div>}
      {pubError && <div className="error">Publish failed: {pubError}</div>}

      {/* Client-side search over the in-hand index (titles + tags). */}
      {index && index.length > 0 && (
        <label className="search">
          <span>Search {zone}</span>
          <input
            type="search"
            placeholder="Filter by title or tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}

      {noMatches && (
        <p className="lede">
          No section in <code>{zone}</code> matches “{query.trim()}”.
        </p>
      )}

      {/* One page of the index — titles + flags only, never bodies. Each readable
          row fetches its own content on demand; locked rows can't be decrypted. */}
      {pageRows.map((entry) =>
        entry.readable ? (
          <SectionRow
            key={entry.id}
            entry={entry}
            zone={zone}
            client={client}
            writable={entry.writable}
            busy={busy}
            publishNow={publishNow}
          />
        ) : (
          <LockedSlot key={entry.id} entry={entry} zone={zone} />
        ),
      )}

      {/* Prev/Next pagination — only when the (filtered) list spills past one page. */}
      {filtered.length > PAGE_SIZE && (
        <div className="row" style={{ alignItems: "center", gap: 12, marginTop: 8 }}>
          <button
            className="secondary"
            disabled={safePage === 0}
            onClick={() => setPage(Math.max(0, safePage - 1))}
          >
            ← Prev
          </button>
          <span className="meta">
            {rangeStart}–{rangeEnd} of {filtered.length}
            {q ? " (filtered)" : ""}
          </span>
          <button
            className="secondary"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
          >
            Next →
          </button>
        </div>
      )}

      {canWrite ? (
        <>
          <h3>Add a section to {zone}</h3>
          <label>
            <span>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            <span>Body</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <label>
            <span>Tags (comma-separated, optional)</span>
            <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <div className="row">
            <button onClick={handleAdd} disabled={!title || !body || busy}>
              {busy ? "Publishing…" : "Add & publish"}
            </button>
          </div>
        </>
      ) : (
        <p className="lede">
          <em>Read-only here — your mandate has no write verb (edit / append / write) on <code>{zone}</code>.</em>
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  SectionRow                                                                */
/* -------------------------------------------------------------------------- */

function SectionRow({
  entry,
  zone,
  client,
  writable,
  busy,
  publishNow,
}: {
  /** Index entry — title + flags only; the body is fetched lazily on Open. */
  readonly entry: SectionIndexEntry;
  readonly zone: ZoneName;
  readonly client: EthosClient;
  /** This actor's mandate authorizes editing THIS section (owner: always). */
  readonly writable: boolean;
  /** A publish is in flight — disable this row's actions. */
  readonly busy: boolean;
  /** Stage-then-publish helper (per-section delta upload). */
  readonly publishNow: (label: string) => Promise<void>;
}) {
  // Lazy body: `undefined` = collapsed, never fetched; `null` = opened but the
  // section came back empty / gone; `Section` = loaded. Opening fetches THIS
  // section alone — the whole point of content-addressing.
  const [body, setBody] = useState<Section | null | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");

  const open = useCallback(async () => {
    setOpening(true);
    setOpenErr(null);
    try {
      setBody(await client.zone(zone).section(entry.id));
    } catch (e) {
      setOpenErr(formatError(e));
    } finally {
      setOpening(false);
    }
  }, [client, zone, entry.id]);

  // On-screen diagnoser for the "opened but null" state: dumps the client mode,
  // the session's delegate registry, then re-runs the read with an instrumented
  // fetch to count network calls. "ZERO requests" proves the client is serving
  // the null locally (anonymous mode / short-circuit) rather than being denied
  // by the platform — the decisive split when hunting decrypt failures.
  const { auth } = useActor();
  const [diag, setDiag] = useState<string | null>(null);
  const runDiag = useCallback(async () => {
    const lines: string[] = [];
    lines.push(`client.mode = ${client.mode}`);
    lines.push(`subject     = ${client.subjectDid}`);
    lines.push(`row.readable = ${String(entry.readable)}`);
    const dels = auth.getDelegates();
    lines.push(
      dels.length === 0
        ? "session delegates = NONE (registry empty — resume()/import never landed here)"
        : `session delegates = ${dels
            .map(
              (d) =>
                `${d.mandateId} [subject ${d.subjectDid === client.subjectDid ? "matches" : "≠ MISMATCH"}, expires ${d.expiresAt ?? "never"}]`,
            )
            .join(" · ")}`,
    );
    const calls: string[] = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        calls.push((JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method ?? "blob");
      } catch {
        calls.push("blob");
      }
      return realFetch(input, init);
    };
    try {
      const sec = await client.zone(zone).section(entry.id);
      lines.push(
        `re-read → ${sec ? "BODY OK" : "null"} | network: ${
          calls.length === 0 ? "ZERO requests ⟵ local short-circuit (anonymous client?)" : calls.join(", ")
        }`,
      );
    } catch (e) {
      lines.push(`re-read threw: ${formatError(e)} | network: ${calls.join(", ") || "none"}`);
    } finally {
      window.fetch = realFetch;
    }
    setDiag(lines.join("\n"));
  }, [auth, client, zone, entry.id, entry.readable]);

  // Collapsed — only the index title is known; no body has been loaded.
  if (body === undefined) {
    return (
      <div className="section-card" style={entry.readable ? undefined : { opacity: 0.55 }}>
        <h4>{entry.title ?? entry.id}</h4>
        <div className="meta">
          id: <code>{entry.id}</code>
        </div>
        {openErr && <div className="error">{openErr}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="secondary"
            disabled={opening || !entry.readable}
            title={
              entry.readable
                ? undefined
                : "Not decryptable for this mandate: the section isn't sealed to it (or the mandate was revoked). Ask the owner to re-seal, or import a fresh bundle."
            }
            onClick={() => void open()}
          >
            {opening ? "Opening…" : entry.readable ? "Open" : "Sealed 🔒"}
          </button>
        </div>
      </div>
    );
  }

  // Opened but nothing came back (just deleted, or not found). This state is
  // ALSO what a mode mismatch looks like (an anonymous client null-shorts every
  // encrypted read with zero network), so it carries its own diagnoser.
  if (body === null) {
    return (
      <div className="section-card" style={{ opacity: 0.6 }}>
        <h4>{entry.title ?? entry.id}</h4>
        <p className="lede">
          <em>Section is empty or no longer available.</em>
        </p>
        {diag && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{diag}</pre>}
        <div className="row" style={{ marginTop: 8 }}>
          <button className="secondary" disabled={opening} onClick={() => setBody(undefined)}>
            Close
          </button>
          <button className="secondary" disabled={opening} onClick={() => void runDiag()}>
            Diagnose
          </button>
        </div>
      </div>
    );
  }

  // Opened + editing.
  if (editing) {
    return (
      <div className="section-card">
        <label>
          <span>Title</span>
          <input type="text" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
        </label>
        <label>
          <span>Body</span>
          <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            disabled={busy}
            onClick={async () => {
              const patch: { title?: string; body?: string } = {};
              if (editTitle !== body.title) patch.title = editTitle;
              if (editBody !== body.body) patch.body = editBody;
              setEditing(false);
              if (Object.keys(patch).length > 0) {
                client.zone(zone).updateSection(entry.id, patch);
                await publishNow(`Updated “${body.title}”`);
                // The publish succeeded with EXACTLY this content — render it
                // locally instead of re-downloading the blob we just uploaded
                // (saves one read RPC and makes the save feel instant). SDK
                // >= alpha.76 also re-seeds its caches from the publish, so a
                // later re-open is served locally either way.
                setBody({ ...body, ...patch });
              }
            }}
          >
            {busy ? "Publishing…" : "Save & publish"}
          </button>
          <button className="secondary" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Opened, viewing.
  return (
    <div className="section-card">
      <h4>{body.title}</h4>
      <p className="body">{body.body}</p>
      <div className="meta">
        id: <code>{body.id}</code>
        {body.tags && body.tags.length > 0 ? <> · tags: {body.tags.join(", ")}</> : null}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="secondary" disabled={busy} onClick={() => setBody(undefined)}>
          Close
        </button>
        {writable && (
          <>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setEditTitle(body.title);
                setEditBody(body.body);
              }}
            >
              Edit
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                client.zone(zone).deleteSection(entry.id);
                await publishNow(`Deleted “${body.title}”`);
              }}
            >
              {busy ? "Publishing…" : "Delete & publish"}
            </button>
          </>
        )}
      </div>
      {!writable && (
        <p className="meta" style={{ marginTop: 8 }}>
          <em>Readable, but your mandate can't edit this section.</em>
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  LockedSlot — an inaccessible section, shown greyed                         */
/* -------------------------------------------------------------------------- */

function LockedSlot({
  entry,
  zone,
}: {
  readonly entry: SectionIndexEntry;
  readonly zone: ZoneName;
}) {
  // `self` seals its index, so an out-of-scope section has no decryptable title;
  // `public`/`circle` keep the clear title (only the body stays sealed).
  const heading = entry.title ?? (zone === "self" ? "Sealed section" : entry.id);
  return (
    <div
      className="section-card"
      style={{ opacity: 0.5, filter: "grayscale(1)" }}
      aria-disabled
      title="Not accessible with your current mandate"
    >
      <h4>🔒 {heading}</h4>
      <p className="lede">
        <em>Not accessible with your mandate{entry.title ? "" : " (title sealed)"}.</em>
      </p>
      <div className="meta">
        id: <code>{entry.id}</code>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  PublishBar                                                                */
/* -------------------------------------------------------------------------- */

function PublishBar({
  client,
  onChanged,
}: {
  readonly client: EthosClient;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const pending = client.pendingChanges();

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Unpublished changes ({pending.length}) — retry or discard</h3>
      {pending.length === 0 ? (
        <p className="lede">Nothing staged.</p>
      ) : (
        <pre>
          {pending
            .map((c) =>
              c.kind === "add"
                ? `+ ${c.zone}: add "${c.section.title}"`
                : c.kind === "update"
                  ? `~ ${c.zone}: update ${c.sectionId}`
                  : `- ${c.zone}: delete ${c.sectionId}`,
            )
            .join("\n")}
        </pre>
      )}
      <div className="row">
        <button
          disabled={busy || pending.length === 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setSuccess(null);
            try {
              const r = await client.publish();
              setSuccess(
                `Published edition #${r.editionHeight} (zones: ${r.zonesPublished.join(", ")})`,
              );
              onChanged();
            } catch (e) {
              setError(formatError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Publishing…" : "Publish"}
        </button>
        <button
          className="secondary"
          disabled={busy || pending.length === 0}
          onClick={() => {
            client.discard();
            onChanged();
          }}
        >
          Discard
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
    </div>
  );
}
