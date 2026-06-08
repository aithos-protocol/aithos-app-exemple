// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Profile — the Ethos editor, capability-aware.
//
//   - owner    : sdk.ethos.me(), full read/write on every zone.
//   - delegate : sdk.ethos.of(subjectDid). Only the zones the mandate grants
//                are shown; write controls appear only with ethos.write.<zone>.
//
// IMPORTANT — staging model: the EthosClient holds an in-memory buffer of
// pending changes (addSection/updateSection/deleteSection) until publish().
// We therefore build the client ONCE per (actor kind + subject) and keep it
// stable for the whole page lifetime — rebuilding it (e.g. on an unrelated
// context bump) would silently discard staged edits. Re-renders after a stage
// are driven by a LOCAL `rev` counter, never by the global actor bump.
//
// The "authorized vs. decryptable" nuance is surfaced: a delegate may hold
// ethos.read.circle yet fail to decrypt if the owner never sealed the zone to
// them at publish time.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { EthosClient, Section, SectionIndexEntry } from "@aithos/sdk";

import { useActor, type ZoneName } from "../actor-context.js";
import { formatError } from "./Home.js";

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

export function Profile() {
  const { actor, capabilities: cap, getEthosClient } = useActor();
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

  // Build the EthosClient once per subject. Stable across context bumps.
  const subjectKey = actor ? `${actor.kind}:${actor.subjectDid}` : null;
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
    // Intentionally keyed on the stable subject identity only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectKey]);

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
            with <code>{actor.scopes.join(", ")}</code>
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
          {ZONES.some((z) => cap.ethosWrite(z)) && (
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
  const [sections, setSections] = useState<readonly Section[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // index() = every persisted section + per-section readable/writable flags;
      // sections() = decrypted bodies with staged edits applied. We join them so
      // we can show inaccessible sections (greyed) the way index() exposes them.
      const [idx, list] = await Promise.all([
        client.zone(zone).index(),
        client.zone(zone).sections(),
      ]);
      setIndex(idx);
      setSections(list);
    } catch (e) {
      setError(formatError(e));
      setIndex(null);
      setSections(null);
    } finally {
      setLoading(false);
    }
  }, [client, zone]);

  // Re-read whenever the zone changes OR a stage/publish bumped `rev`.
  useEffect(() => {
    void refresh();
  }, [refresh, rev]);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");

  const handleAdd = () => {
    if (!title.trim() || !body.trim()) return;
    client.zone(zone).addSection({
      title,
      body,
      ...(tags ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
    });
    setTitle("");
    setBody("");
    setTags("");
    onChanged();
  };

  // Decrypted bodies keyed by id, and which ids are persisted (in the index).
  const byId = new Map((sections ?? []).map((s) => [s.id, s] as const));
  const persistedIds = new Set((index ?? []).map((e) => e.id));
  // In sections() but not the index = staged-new adds not yet published.
  const stagedNew = (sections ?? []).filter((s) => !persistedIds.has(s.id));
  const nothingToShow =
    index !== null && index.length === 0 && stagedNew.length === 0 && !loading;

  return (
    <div className="stack">
      {loading && <p>Loading sections…</p>}
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

      {/* Every persisted section, in authored order: editable, locked, or
          pending-delete. Sections this actor can't decrypt show greyed. */}
      {index?.map((entry) => {
        if (!entry.readable) {
          return <LockedSlot key={entry.id} entry={entry} zone={zone} />;
        }
        const decrypted = byId.get(entry.id);
        if (!decrypted) {
          // Readable but gone from sections() = staged for deletion.
          return (
            <div key={entry.id} className="section-card" style={{ opacity: 0.55 }}>
              <h4 style={{ textDecoration: "line-through" }}>
                {entry.title ?? entry.id}
              </h4>
              <p className="lede">
                <em>Marked for deletion — publish to apply.</em>
              </p>
            </div>
          );
        }
        return (
          <SectionRow
            key={entry.id}
            section={decrypted}
            zone={zone}
            client={client}
            writable={entry.writable}
            onChanged={onChanged}
          />
        );
      })}

      {/* Locally staged new sections (not yet in the published index). */}
      {stagedNew.map((s) => (
        <SectionRow
          key={s.id}
          section={s}
          zone={zone}
          client={client}
          writable
          staged
          onChanged={onChanged}
        />
      ))}

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
            <button onClick={handleAdd} disabled={!title || !body}>
              Stage add
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
  section,
  zone,
  client,
  writable,
  staged,
  onChanged,
}: {
  readonly section: Section;
  readonly zone: ZoneName;
  readonly client: EthosClient;
  /** This actor's mandate authorizes editing THIS section (owner: always). */
  readonly writable: boolean;
  /** True for a locally-staged, not-yet-published section. */
  readonly staged?: boolean;
  readonly onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(section.title);
  const [body, setBody] = useState(section.body);

  if (!editing) {
    return (
      <div className="section-card">
        <h4>
          {section.title}
          {staged && (
            <span className="tag" style={{ marginLeft: 8, opacity: 0.7 }}>
              staged
            </span>
          )}
        </h4>
        <p className="body">{section.body}</p>
        <div className="meta">
          id: <code>{section.id}</code>
          {section.tags && section.tags.length > 0 ? <> · tags: {section.tags.join(", ")}</> : null}
        </div>
        {writable ? (
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="secondary"
              onClick={() => {
                setEditing(true);
                setTitle(section.title);
                setBody(section.body);
              }}
            >
              Edit
            </button>
            <button
              className="danger"
              onClick={() => {
                client.zone(zone).deleteSection(section.id);
                onChanged();
              }}
            >
              Stage delete
            </button>
          </div>
        ) : (
          <p className="meta" style={{ marginTop: 8 }}>
            <em>Readable, but your mandate can't edit this section.</em>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="section-card">
      <label>
        <span>Title</span>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        <span>Body</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="row" style={{ marginTop: 8 }}>
        <button
          onClick={() => {
            const patch: { title?: string; body?: string } = {};
            if (title !== section.title) patch.title = title;
            if (body !== section.body) patch.body = body;
            if (Object.keys(patch).length > 0) {
              client.zone(zone).updateSection(section.id, patch);
              onChanged();
            }
            setEditing(false);
          }}
        >
          Stage update
        </button>
        <button className="secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
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
      <h3>Pending changes ({pending.length})</h3>
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
