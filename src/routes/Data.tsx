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

import {
  createAppendDataClient,
  type AithosSchemaLite,
  type DataClient,
  type ReadonlyDataClient,
} from "@aithos/sdk";

import { useActor, type Actor } from "../actor-context.js";
import { DataPlayground, vendorLites } from "../components/DataPlayground.js";
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
  const { collections, wildcard, hasWriteScope, appendCollections } = useMemo(() => {
    const names = new Set<string>();
    const appendNames = new Set<string>();
    let wild = false;
    let writeish = false;
    if (actor.kind === "delegate") {
      for (const s of actor.scopes) {
        const m = /^data\.([^.]+)\.(read|write|admin|append)$/.exec(s);
        if (!m) continue;
        const col = m[1]!;
        const verb = m[2]!;
        if (verb === "write" || verb === "admin") writeish = true;
        // Read view (the SDK's read-only client): read/write/admin decrypt.
        if (verb !== "append") {
          if (col === "*") wild = true;
          else names.add(col);
        }
        // Append-capable: explicit append, or write/admin (insert-capable).
        if ((verb === "append" || verb === "write" || verb === "admin") && col !== "*") {
          appendNames.add(col);
        }
      }
    }
    return {
      collections: [...names],
      wildcard: wild,
      hasWriteScope: writeish,
      appendCollections: [...appendNames],
    };
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
          <strong>read</strong> here (the collection is decryptable) and{" "}
          <strong>append</strong> (insert-only — see the form below). Full delegate{" "}
          <strong>update/delete is owner-only in v0.x</strong> (an SDK limit). An
          appended record is sealed to the OWNER, so it won&apos;t appear here —
          switch to the owner to read it.
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

      {appendCollections.length > 0 && (
        <DelegateAppendForm
          subjectDid={actor.subjectDid}
          collections={appendCollections}
        />
      )}
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

/* -------------------------------------------------------------------------- */
/*  Delegate APPEND (insert-only) — createAppendDataClient                     */
/* -------------------------------------------------------------------------- */

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Resolve the subject's `#data` Ed25519 pubkey from their published did.json
 * (anonymous read). Each appended record's DEK is sealed to it, so only the
 * OWNER can read what a delegate deposits — exactly Délie's patient → praticien
 * path. */
async function resolveOwnerDataPubkey(did: string, apiBase: string): Promise<string> {
  const res = await fetch(`${apiBase}/mcp/primitives/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "get_identity",
      method: "aithos.get_identity",
      params: { did },
    }),
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: { object?: { verificationMethod?: { id?: string; publicKeyMultibase?: string }[] } };
  };
  if (json.error) throw new Error(json.error.message ?? "DID resolution failed");
  const vm = (json.result?.object?.verificationMethod ?? []).find(
    (v) => typeof v.id === "string" && v.id.endsWith("#data"),
  );
  if (!vm?.publicKeyMultibase) {
    throw new Error("subject has no published #data sphere (legacy account)");
  }
  return vm.publicKeyMultibase;
}

function DelegateAppendForm({
  subjectDid,
  collections,
}: {
  readonly subjectDid: string;
  readonly collections: readonly string[];
}) {
  const { sdk, keyStore } = useActor();
  const lites = useMemo<readonly AithosSchemaLite[]>(() => vendorLites(), []);
  const [collection, setCollection] = useState(collections[0] ?? "");
  const [schemaId, setSchemaId] = useState(lites[0]?.schema ?? "");
  const [json, setJson] = useState(
    '{\n  "title": "from a delegate",\n  "content": "appended via createAppendDataClient"\n}',
  );
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setOk(null);
    setErr(null);
    try {
      const record = JSON.parse(json) as Record<string, unknown>;
      const schema = lites.find((l) => l.schema === schemaId);
      if (!schema) throw new Error("pick a schema");
      const dels = await keyStore.listDelegates();
      const d = dels.find((x) => x.subjectDid === subjectDid) ?? dels[0];
      if (!d) throw new Error("no delegate mandate in this session");
      const ownerDataPubkeyMultibase = await resolveOwnerDataPubkey(
        subjectDid,
        sdk.endpoints.api,
      );
      const append = createAppendDataClient({
        pdsUrl: sdk.endpoints.pds,
        subjectDid,
        ownerDataPubkeyMultibase,
        mandate: d.mandate as never,
        delegateSeed: hexToBytes(d.delegateSeedHex),
        granteePubkeyMultibase: d.granteePubkeyMultibase,
        schema,
        schemas: lites,
      });
      const recordId = await append.collection(collection).insert(record);
      setOk(
        `Appended ${recordId} — sealed to the owner. You can't read it back here; switch to the owner to see it.`,
      );
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section-card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Append a record (delegate → owner)</h3>
      <p className="lede" style={{ marginTop: 0 }}>
        Insert-only via <code>createAppendDataClient</code>: each record is sealed
        to the owner&apos;s <code>#data</code> key, so the delegate can&apos;t read
        it back. This is exactly Délie&apos;s patient-deposit path.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label>
          collection{" "}
          <select value={collection} onChange={(e) => setCollection(e.target.value)}>
            {collections.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          schema{" "}
          <select value={schemaId} onChange={(e) => setSchemaId(e.target.value)}>
            {lites.map((l) => (
              <option key={l.schema} value={l.schema}>
                {l.schema}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        rows={5}
        spellCheck={false}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 13, marginTop: 8 }}
      />
      <button
        onClick={() => void submit()}
        disabled={busy || !collection || !schemaId}
        style={{ marginTop: 8 }}
      >
        {busy ? "Appending…" : "Append"}
      </button>
      {ok && <p className="lede" style={{ marginBottom: 0 }}>{ok}</p>}
      {err && <div className="warn" style={{ marginTop: 8 }}>{err}</div>}
    </div>
  );
}
