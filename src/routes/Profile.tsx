// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Profile — the Ethos editor, capability-aware.
//
//   - owner    : sdk.ethos.me(), full read/write on every zone.
//   - delegate : sdk.ethos.of(subjectDid). Only the zones the mandate grants
//                are shown; write controls appear only with ethos.write.<zone>.
//
// The "authorized vs. decryptable" nuance is surfaced honestly: a delegate may
// hold ethos.read.circle yet still fail to decrypt if the owner never sealed
// the zone to them at publish time. We show the scope as granted, then report
// the actual read result (and tell the delegate to ask the owner to publish
// the zone once).

import { useCallback, useEffect, useMemo, useState } from "react";

import type { EthosClient, Section } from "@aithos/sdk";

import { useActor, type ZoneName } from "../actor-context.js";
import { formatError } from "./Home.js";

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

export function Profile() {
  const { actor, capabilities: cap, getEthosClient } = useActor();
  const [client, setClient] = useState<EthosClient | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Zones this actor may at least read.
  const readableZones = useMemo(
    () => ZONES.filter((z) => cap.ethosRead(z)),
    [cap],
  );
  const [zone, setZone] = useState<ZoneName>("public");

  useEffect(() => {
    if (readableZones.length > 0 && !readableZones.includes(zone)) {
      setZone(readableZones[0]!);
    }
  }, [readableZones, zone]);

  useEffect(() => {
    if (!actor) {
      setClient(null);
      return;
    }
    let cancelled = false;
    setLoadErr(null);
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
  }, [actor, getEthosClient]);

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
          <code>ethos.read.&lt;zone&gt;</code> (or write) scope to see anything
          here.
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
          />
          {ZONES.some((z) => cap.ethosWrite(z)) && <PublishBar client={client} />}
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
}: {
  readonly client: EthosClient;
  readonly zone: ZoneName;
  readonly canWrite: boolean;
  readonly actorKind: "owner" | "delegate";
}) {
  const { bump } = useActor();
  const [sections, setSections] = useState<readonly Section[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await client.zone(zone).sections();
      setSections(list);
    } catch (e) {
      // Authorized-but-undecryptable lands here for a delegate whose wrap was
      // never sealed by the owner.
      setError(formatError(e));
      setSections(null);
    } finally {
      setLoading(false);
    }
  }, [client, zone]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

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
    setTick((t) => t + 1);
    bump();
  };

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
      {sections && sections.length === 0 && !loading && (
        <p className="lede">
          No sections in <code>{zone}</code> yet.
        </p>
      )}
      {sections?.map((s) => (
        <SectionRow
          key={s.id}
          section={s}
          zone={zone}
          client={client}
          canWrite={canWrite}
          onChanged={() => {
            setTick((t) => t + 1);
            bump();
          }}
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
          <em>Read-only — this actor has no <code>ethos.write.{zone}</code> scope.</em>
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
  canWrite,
  onChanged,
}: {
  readonly section: Section;
  readonly zone: ZoneName;
  readonly client: EthosClient;
  readonly canWrite: boolean;
  readonly onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(section.title);
  const [body, setBody] = useState(section.body);

  if (!editing) {
    return (
      <div className="section-card">
        <h4>{section.title}</h4>
        <p className="body">{section.body}</p>
        <div className="meta">
          id: <code>{section.id}</code>
          {section.tags && section.tags.length > 0 ? <> · tags: {section.tags.join(", ")}</> : null}
        </div>
        {canWrite && (
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
/*  PublishBar                                                                */
/* -------------------------------------------------------------------------- */

function PublishBar({ client }: { readonly client: EthosClient }) {
  const { bump } = useActor();
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
              bump();
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
            bump();
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
