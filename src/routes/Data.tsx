// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Data — the #data sub-protocol, capability-aware.
//
//   - owner    : full CRUD playground signing under the owner's #data sphere
//                (the shared <DataPlayground>).
//   - delegate : read-only view of exactly the collections the mandate grants
//                (data.<col>.read|write|admin). A delegate reads — the SDK hands
//                a ReadonlyDataClient. Per-collection records are listed and
//                decrypted; no create/insert/update/delete controls.

import { useEffect, useMemo, useState } from "react";

import type { DataClient, ReadonlyDataClient } from "@aithos/sdk";

import { useActor, type Actor } from "../actor-context.js";
import { DataPlayground } from "../components/DataPlayground.js";
import { formatError } from "./Home.js";

export function DataPage() {
  const { actor, capabilities: cap, dataClient } = useActor();

  if (!actor) {
    return (
      <section>
        <h2>Data</h2>
        <p className="lede">Sign in on the Home page first.</p>
      </section>
    );
  }

  if (cap.isOwner) {
    if (!dataClient) {
      return (
        <section>
          <h2>Data</h2>
          <p className="warn">
            Signed in as owner <code>{actor.subjectDid.slice(0, 24)}…</code> but
            this account has <strong>no <code>#data</code> sphere</strong>.
            Create a <code>#data</code> identity on Home (Create identity) to own
            collections under your real account.
          </p>
        </section>
      );
    }
    return (
      <>
        <section>
          <h2>Data — your collections (#data)</h2>
          <p className="lede">
            Owned under <code>{actor.subjectDid.slice(0, 28)}…</code>, every
            envelope signed by your dedicated <code>#data</code> sphere.
          </p>
        </section>
        <DataPlayground client={dataClient as DataClient} />
      </>
    );
  }

  // Delegate: read-only over the granted collections.
  return (
    <DelegateDataView
      client={(dataClient as ReadonlyDataClient | null) ?? null}
      actor={actor}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Delegate read-only view                                                   */
/* -------------------------------------------------------------------------- */

function DelegateDataView({
  client,
  actor,
}: {
  readonly client: ReadonlyDataClient | null;
  readonly actor: Actor;
}) {
  const { collections, wildcard, hasWriteScope } = useMemo(() => {
    const names = new Set<string>();
    let wild = false;
    let writeish = false;
    if (actor.kind === "delegate") {
      for (const s of actor.scopes) {
        const m = /^data\.([^.]+)\.(read|write|admin)$/.exec(s);
        if (!m) continue;
        if (m[2] === "write" || m[2] === "admin") writeish = true;
        if (m[1] === "*") wild = true;
        else names.add(m[1]!);
      }
    }
    return { collections: [...names], wildcard: wild, hasWriteScope: writeish };
  }, [actor]);

  return (
    <section>
      <h2>Data — delegate read</h2>
      <p className="lede">
        Acting as a delegate of <code>{actor.subjectDid.slice(0, 28)}…</code>.
        You can read the collections your mandate grants — no writes (the SDK
        hands a read-only client).
      </p>

      {wildcard && (
        <p className="lede">
          Your mandate carries a <code>data.*.read</code> wildcard — open the
          owner's collection by name below.
        </p>
      )}

      {hasWriteScope && (
        <p className="warn">
          Your <code>write</code>/<code>admin</code> data scope grants{" "}
          <strong>read</strong> here (the collection is decryptable). The current
          SDK exposes delegate data <strong>mutation only via{" "}
          <code>append</code></strong> (insert-only, sealed to the owner) — full
          delegate update/delete is owner-only in v0.x. That's an SDK limit, not
          a UI one.
        </p>
      )}

      {collections.length === 0 && !wildcard && (
        <p className="warn">
          This mandate grants no readable data collection (no{" "}
          <code>data.&lt;collection&gt;.read</code> scope).
        </p>
      )}

      {client &&
        collections.map((name) => (
          <CollectionReader key={name} client={client} name={name} />
        ))}

      {client && wildcard && <WildcardReader client={client} />}
    </section>
  );
}

function WildcardReader({ client }: { readonly client: ReadonlyDataClient }) {
  const [name, setName] = useState("");
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) setActive(name.trim());
        }}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="collection name"
        />
        <button type="submit" disabled={!name.trim()}>
          Open
        </button>
      </form>
      {active && <CollectionReader client={client} name={active} />}
    </div>
  );
}

function CollectionReader({
  client,
  name,
}: {
  readonly client: ReadonlyDataClient;
  readonly name: string;
}) {
  type Rec = Record<string, unknown> & { _id?: string };
  const [items, setItems] = useState<Rec[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.collection(name).list({ limit: 50, order: "newest" });
      setItems(r.items as Rec[]);
    } catch (e) {
      setError(formatError(e));
      setItems(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, name]);

  return (
    <div className="section-card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>
        Collection <code>{name}</code>{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
          ({items?.length ?? 0} record{items?.length === 1 ? "" : "s"})
        </span>
        <button
          className="secondary"
          style={{ marginLeft: 8 }}
          onClick={() => void refresh()}
          disabled={busy}
        >
          {busy ? "…" : "Refresh"}
        </button>
      </h3>

      {error && (
        <div className="warn">
          {error}
          <br />
          If your mandate grants this collection but reads fail, ask the owner to
          re-run <code>authorizeDelegate</code> for it.
        </div>
      )}

      {items && items.length === 0 && <p className="lede">No records.</p>}

      {items?.map((item) => {
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
            {tags.length > 0 && (
              <div style={{ marginTop: 4 }}>
                {tags.map((t) => (
                  <code key={t} style={{ marginRight: 6, fontSize: 12 }}>
                    {t}
                  </code>
                ))}
              </div>
            )}
            {item.content ? (
              <pre style={{ whiteSpace: "pre-wrap", margin: "6px 0 0", fontFamily: "inherit", fontSize: 13 }}>
                {String(item.content)}
              </pre>
            ) : null}
            <div className="meta" style={{ marginTop: 6 }}>
              <code>{id}</code>
            </div>
          </div>
        );
      })}
    </div>
  );
}
