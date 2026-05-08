// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /profile — ethos editor.
//
// Demonstrates the lazy / commit pattern of sdk.ethos.me():
//   me.zone(...).addSection / updateSection / deleteSection are sync,
//   they stage in memory. await me.publish() commits a single
//   edition. Reads (sections()) hit the network on first call per
//   zone, then memoize.

import { useCallback, useEffect, useMemo, useState } from "react";

import type { EthosClient, Section, ZoneName } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

export function Profile() {
  const { sdk, state } = useSdk();
  const [zone, setZone] = useState<ZoneName>("public");
  const [error, setError] = useState<string | null>(null);

  // One EthosClient for the whole page lifetime. New buffer per
  // navigation away/back (memo deps), which is fine for a demo.
  const me = useMemo<EthosClient | null>(() => {
    if (!state.canSignAsOwner) return null;
    setError(null);
    try {
      return sdk.ethos.me();
    } catch (e) {
      setError(formatError(e));
      return null;
    }
    // me lives for as long as the owner DID is unchanged.
  }, [sdk, state.canSignAsOwner, state.owner?.did]);

  if (!state.canSignAsOwner) {
    return (
      <section>
        <h2>Profile</h2>
        <p className="lede">
          Sign in as an owner first (Home → Sign in / Sign up / Recovery /
          Google).
        </p>
      </section>
    );
  }
  if (!me) {
    return (
      <section>
        <h2>Profile</h2>
        <div className="error">{error ?? "Could not open ethos client"}</div>
      </section>
    );
  }

  return (
    <section>
      <h2>Ethos editor</h2>
      <p className="lede">
        Subject: <code>{me.subjectDid}</code> · Mode: <code>{me.mode}</code>
      </p>
      <div className="tabs">
        {ZONES.map((z) => (
          <button
            key={z}
            className={zone === z ? "active" : ""}
            onClick={() => setZone(z)}
          >
            {z}
          </button>
        ))}
      </div>
      <ZoneEditor me={me} zone={zone} />
      <PublishBar me={me} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  ZoneEditor                                                                */
/* -------------------------------------------------------------------------- */

function ZoneEditor({
  me,
  zone,
}: {
  readonly me: EthosClient;
  readonly zone: ZoneName;
}) {
  const { bumpVersion } = useSdk();
  const [sections, setSections] = useState<readonly Section[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumps when local mutations happen

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await me.zone(zone).sections();
      setSections(list);
    } catch (e) {
      setError(formatError(e));
      setSections([]);
    } finally {
      setLoading(false);
    }
  }, [me, zone]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  // Form state for the "add" input.
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");

  const handleAdd = () => {
    if (!title.trim() || !body.trim()) return;
    me.zone(zone).addSection({
      title,
      body,
      ...(tags
        ? { tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }
        : {}),
    });
    setTitle("");
    setBody("");
    setTags("");
    setTick((t) => t + 1);
    bumpVersion();
  };

  return (
    <div className="stack">
      {loading && <p>Loading sections…</p>}
      {error && <div className="error">{error}</div>}
      {sections && sections.length === 0 && !loading && (
        <p className="lede">
          No sections in <code>{zone}</code> yet.
        </p>
      )}
      {sections?.map((s) => (
        <SectionRow
          key={s.id}
          section={s}
          onChanged={() => {
            setTick((t) => t + 1);
            bumpVersion();
          }}
          zone={zone}
          me={me}
        />
      ))}
      <h3>Add a section to {zone}</h3>
      <label>
        <span>Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        <span>Body</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label>
        <span>Tags (comma-separated, optional)</span>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <div className="row">
        <button onClick={handleAdd} disabled={!title || !body}>
          Stage add
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  SectionRow                                                                */
/* -------------------------------------------------------------------------- */

function SectionRow({
  section,
  zone,
  me,
  onChanged,
}: {
  readonly section: Section;
  readonly zone: ZoneName;
  readonly me: EthosClient;
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
          {section.tags && section.tags.length > 0 ? (
            <> · tags: {section.tags.join(", ")}</>
          ) : null}
        </div>
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
              me.zone(zone).deleteSection(section.id);
              onChanged();
            }}
          >
            Stage delete
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="section-card">
      <label>
        <span>Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
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
              me.zone(zone).updateSection(section.id, patch);
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

function PublishBar({ me }: { readonly me: EthosClient }) {
  const { bumpVersion } = useSdk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Force a re-read on every parent re-render to catch staged mutations.
  const pending = me.pendingChanges();

  return (
    <div style={{ marginTop: 16 }}>
      <h3>Pending changes ({pending.length})</h3>
      {pending.length === 0 ? (
        <p className="lede">Nothing staged. Make some edits above.</p>
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
              const r = await me.publish();
              setSuccess(
                `Published edition #${r.editionHeight} (zones: ${r.zonesPublished.join(", ")})`,
              );
              bumpVersion();
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
            me.discard();
            bumpVersion();
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
