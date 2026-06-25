// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Mandates — OWNER ONLY. Issue ONE mandate carrying any mix of:
//   - Ethos zone scopes      (ethos.read/write.<zone>)
//   - #data collection scopes (data.<collection>.<action>) on your own
//     collections, with the CMK re-wrapped to the grantee via authorizeDelegate
//   - Assets scopes          (assets.*.read) — declared forward-compatibly;
//     asset delegate access is a v0.2 target, not enforced in v0.1.
//
// Everything is signed by the owner (envelopes, no JWT). The grantee's keypair
// is minted inside sdk.mandates.create and travels only in the downloaded
// bundle. The grantee imports it on Home to act as the delegate.

import { useEffect, useState } from "react";

import type { DataClient, MintedMandate, OwnedMandate, Scope, SectionIndexEntry } from "@aithos/sdk";

import { useActor, type ZoneName } from "../actor-context.js";
import { formatError } from "./Home.js";

const ETHOS_SCOPES: readonly Scope[] = [
  "ethos.read.public",
  "ethos.read.circle",
  "ethos.read.self",
  "ethos.write.public",
  "ethos.write.circle",
  "ethos.write.self",
];

// Per-section verbs for targeted grants → `ethos.<verb>.<zone>#id=<section_id>`.
const ETHOS_VERBS = ["read", "edit", "append", "delete"] as const;
type EthosVerb = (typeof ETHOS_VERBS)[number];

const DATA_ACTIONS = ["read", "write", "admin", "append"] as const;
type DataAction = (typeof DATA_ACTIONS)[number];
type DataGrant = DataAction | "none";

const TTL_PRESETS = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 7 * 86400 },
  { label: "30 days", seconds: 30 * 86400 },
];

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

/** Sections shown per page in the section-grant picker. */
const SECTION_PAGE_SIZE = 20;

/**
 * Turn the per-section selection into mandate scopes: one
 * `ethos.<verb>.<zone>#id=<id>` per selected section, grouped by verb only for the
 * summary line. The scope grammar has no title selector, so a title-based group is
 * always expressed section by section.
 */
function buildSectionScopes(
  grants: Record<string, EthosVerb>,
  zone: ZoneName,
): { scopes: string[]; lines: string[] } {
  const byVerb = new Map<EthosVerb, string[]>();
  for (const [id, verb] of Object.entries(grants)) {
    const arr = byVerb.get(verb) ?? [];
    arr.push(id);
    byVerb.set(verb, arr);
  }
  const scopes: string[] = [];
  const lines: string[] = [];
  for (const [verb, ids] of byVerb) {
    for (const id of ids) scopes.push(`ethos.${verb}.${zone}#id=${id}`);
    lines.push(`${ids.length} × ethos.${verb}.${zone}#id=…`);
  }
  return { scopes, lines };
}

export function Mandates() {
  const { actor, capabilities: cap } = useActor();
  const [refreshTick, setRefreshTick] = useState(0);

  if (!actor || !cap.canIssueMandates) {
    return (
      <section>
        <h2>Mandates</h2>
        <p className="warn">
          <strong>Owner only.</strong> Issuing mandates requires your owner
          keys. {actor ? "You're acting as a delegate." : "Sign in as owner on Home."}
        </p>
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>Issue a mandate</h2>
        <p className="lede">
          One signed mandate carrying any mix of Ethos zones, your{" "}
          <code>#data</code> collections, and assets. For{" "}
          <code>read/write/admin</code> data grants the collection CMK is
          re-wrapped to the grantee. Download the bundle and hand it over — the
          grantee imports it on Home.
        </p>
        <CreateMandateForm onCreated={() => setRefreshTick((t) => t + 1)} />
      </section>
      <IssuedMandates refreshTick={refreshTick} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Create form                                                               */
/* -------------------------------------------------------------------------- */

interface Minted {
  readonly mandate: MintedMandate;
  readonly dataAuth: readonly {
    readonly collection: string;
    readonly action: string;
    readonly ok: boolean;
    readonly detail?: string;
  }[];
}

function CreateMandateForm({ onCreated }: { readonly onCreated: () => void }) {
  const { sdk, dataClient } = useActor();
  const owner = dataClient as DataClient | null; // owner #data client (or null)

  const [granteeId, setGranteeId] = useState("urn:aithos:agent:demo1");
  const [granteeLabel, setGranteeLabel] = useState("");
  const [ethos, setEthos] = useState<Set<Scope>>(new Set<Scope>(["ethos.read.public"]));
  const [ttlSeconds, setTtlSeconds] = useState(86400);
  const [assetsRead, setAssetsRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<Minted | null>(null);
  const [resealNote, setResealNote] = useState<string | null>(null);

  // Owner's #data collections, for the data-grants section.
  const [collections, setCollections] = useState<readonly string[] | null>(null);
  const [grants, setGrants] = useState<Record<string, DataGrant>>({});

  // Section-targeted ethos grants. A mandate writes ONE zone, so the selection is
  // a `section_id → verb` map all within the current `sectionZone` (switching zones
  // clears it). Two pickers feed the same selection: a TITLE-START bulk-selector
  // (select every section whose title begins with the text) and a TEXT search with
  // pagination. Emits one `#id=` per selected section (the scope grammar has no
  // title selector).
  const [sectionZone, setSectionZone] = useState<ZoneName>("public");
  const [sectionIndex, setSectionIndex] = useState<readonly SectionIndexEntry[] | null>(null);
  const [sectionGrants, setSectionGrants] = useState<Record<string, EthosVerb>>({});
  const [startQuery, setStartQuery] = useState("");
  const [startVerb, setStartVerb] = useState<EthosVerb>("read");
  const [textQuery, setTextQuery] = useState("");
  const [secPage, setSecPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSectionIndex(null);
    sdk.ethos
      .me()
      .zone(sectionZone)
      .index()
      .then((idx) => !cancelled && setSectionIndex(idx))
      .catch(() => !cancelled && setSectionIndex([]));
    return () => {
      cancelled = true;
    };
  }, [sdk, sectionZone]);

  // A new text query (or zone) jumps back to the first page of the picker.
  useEffect(() => {
    setSecPage(0);
  }, [textQuery, sectionZone]);

  useEffect(() => {
    let cancelled = false;
    if (!owner) {
      setCollections([]);
      return;
    }
    owner
      .listCollections()
      .then((cols) => !cancelled && setCollections(cols.map((c) => c.name)))
      .catch(() => !cancelled && setCollections([]));
    return () => {
      cancelled = true;
    };
  }, [owner]);

  const toggleEthos = (s: Scope) =>
    setEthos((prev) => {
      const next = new Set(prev);
      next.has(s) ? next.delete(s) : next.add(s);
      return next;
    });

  const submit = async () => {
    setBusy(true);
    setError(null);
    setMinted(null);
    setResealNote(null);
    try {
      const dataScopes: Scope[] = Object.entries(grants)
        .filter(([, a]) => a !== "none")
        .map(([col, a]) => `data.${col}.${a}` as Scope);
      // Assets scope is forward-compat (v0.2). Cast through the Scope union —
      // the SDK passes unknown scopes through to the signed mandate verbatim.
      const assetScopes = assetsRead ? (["assets.*.read"] as unknown as Scope[]) : [];
      // One `#id=` per selected section (titles aren't part of the scope grammar).
      const sectionScopes = buildSectionScopes(sectionGrants, sectionZone).scopes as Scope[];
      const all: Scope[] = [...ethos, ...dataScopes, ...assetScopes, ...sectionScopes];
      if (all.length === 0) {
        setError("Pick at least one scope.");
        setBusy(false);
        return;
      }

      // actor_sphere must be the highest zone any ethos scope touches. The SDK's
      // default can't infer it from a section scope (`...#id=X` doesn't end in
      // `.self`), so compute it here from both whole-zone and per-section grants.
      const ethosZones = [
        ...[...ethos].map((s) => (s as string).split("#")[0]!.split(".")[2]),
        ...(Object.keys(sectionGrants).length > 0 ? [sectionZone] : []),
      ];
      const hasEthos = ethos.size > 0 || sectionScopes.length > 0;
      const actorSphere: "public" | "circle" | "self" = ethosZones.includes("self")
        ? "self"
        : ethosZones.includes("circle")
          ? "circle"
          : "public";

      // §4.8′ guard: every MUTATING ethos verb (edit/append/delete/write) must
      // target the actor_sphere (the single highest zone). Surface a cross-zone
      // mutation here with a clear message instead of the raw server/SDK error
      // ("scope ethos.edit.X#… requires actor_sphere=X (got Y)").
      const MUTATING_VERBS = new Set(["edit", "append", "delete", "write"]);
      const crossZone = [
        ...new Set(
          (all as readonly string[])
            .map((s) => /^ethos\.([a-z]+)\.([a-z]+)/.exec(s))
            .filter(
              (m): m is RegExpExecArray =>
                !!m && MUTATING_VERBS.has(m[1]!) && m[2] !== actorSphere,
            )
            .map((m) => m[2]!),
        ),
      ];
      if (crossZone.length > 0) {
        setError(
          `A mandate can only write ONE zone (its actor_sphere = "${actorSphere}"). ` +
            `These grants target a different zone: ${crossZone.join(", ")}. ` +
            `Issue them as a separate mandate.`,
        );
        setBusy(false);
        return;
      }

      const r = await sdk.mandates.create({
        granteeId,
        ...(granteeLabel ? { granteeLabel } : {}),
        scopes: all,
        ttlSeconds,
        ...(hasEthos ? { actorSphere } : {}),
      });

      // Re-wrap the CMK for read/write/admin data grants (append is lateral).
      // Each collection's re-wrap is independent — run them IN PARALLEL: the
      // sequential version cost N back-to-back round-trips for N collections.
      const dataAuth: Minted["dataAuth"] = [];
      let list: { collection: string; action: string; ok: boolean; detail?: string }[] = [];
      if (owner) {
        const targets = Object.entries(grants).filter(
          ([, a]) => a !== "none" && a !== "append",
        );
        list = await Promise.all(
          targets.map(async ([col, a]) => {
            try {
              await owner.authorizeDelegate({ collectionName: col, mandate: r.mandate });
              return { collection: col, action: a, ok: true };
            } catch (e) {
              return { collection: col, action: a, ok: false, detail: formatError(e) };
            }
          }),
        );
      }
      // Auto-seal: a mandate only AUTHORISES — a delegate can DECRYPT a granted
      // section only once it's (re)sealed with its wrap. sealGrant (sdk >=
      // alpha.78) is the targeted fast path: seals THIS mandate into its
      // covered sections only — zero mandate crawl (scales with the ethos, not
      // with how many mandates exist), zero blob upload, race-proof by
      // construction, can't jam on revoked residue (additive).
      if (hasEthos) {
        try {
          const sealed = await sdk.ethos.me().sealGrant(r.mandate);
          if (sealed) setResealNote(`Delegate sealed in — edition #${sealed.editionHeight}.`);
        } catch (e) {
          setResealNote(
            `Mandate created, but auto-seal failed (${formatError(e)}). Open Profile and edit + publish the granted zone once.`,
          );
        }
      }
      setMinted({ mandate: r, dataAuth: [...dataAuth, ...list] });
      onCreated();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  // Derived picker state — all client-side over the in-hand index.
  const idxRows = sectionIndex ?? [];
  // Bulk-selector: match the START of the TITLE (case-insensitive), falling back to
  // the id for sealed sections with no clear title. Emits `#id=` per section — the
  // scope grammar has no title selector, so a title group can't collapse to one scope.
  const startNeedle = startQuery.trim().toLowerCase();
  const startMatches = startNeedle
    ? idxRows.filter((e) => (e.title ?? e.id).toLowerCase().startsWith(startNeedle))
    : [];
  const startAllSelected =
    startMatches.length > 0 && startMatches.every((e) => sectionGrants[e.id] === startVerb);
  const tq = textQuery.trim().toLowerCase();
  const secFiltered = tq
    ? idxRows.filter((e) =>
        [e.title ?? "", ...(e.tags ?? []), e.title === undefined ? e.id : ""]
          .join(" ")
          .toLowerCase()
          .includes(tq),
      )
    : idxRows;
  const secPageCount = Math.max(1, Math.ceil(secFiltered.length / SECTION_PAGE_SIZE));
  const secSafePage = Math.min(secPage, secPageCount - 1);
  const secPageRows = secFiltered.slice(
    secSafePage * SECTION_PAGE_SIZE,
    secSafePage * SECTION_PAGE_SIZE + SECTION_PAGE_SIZE,
  );
  const secRangeStart = secFiltered.length === 0 ? 0 : secSafePage * SECTION_PAGE_SIZE + 1;
  const secRangeEnd = Math.min(secFiltered.length, secSafePage * SECTION_PAGE_SIZE + SECTION_PAGE_SIZE);
  const selectedEntries = idxRows.filter((e) => sectionGrants[e.id]);
  const sectionScopePreview = buildSectionScopes(sectionGrants, sectionZone).lines;

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Grantee URN</span>
        <input type="text" value={granteeId} onChange={(e) => setGranteeId(e.target.value)} />
      </label>
      <label>
        <span>Grantee label (optional)</span>
        <input type="text" value={granteeLabel} onChange={(e) => setGranteeLabel(e.target.value)} />
      </label>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>Ethos zone scopes</span>
        <div className="row">
          {ETHOS_SCOPES.map((s) => (
            <label key={s} style={{ marginBottom: 0 }}>
              <input type="checkbox" checked={ethos.has(s)} onChange={() => toggleEthos(s)} />
              <span style={{ marginLeft: 4 }}>{s}</span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>
          Section-targeted ethos grants (optional)
        </span>
        <label style={{ marginBottom: 6 }}>
          <span>Zone</span>
          <select
            value={sectionZone}
            onChange={(e) => {
              setSectionZone(e.target.value as ZoneName);
              // A mandate writes ONE zone (its actor_sphere); switching zones
              // clears the section grants from the previous zone (whose sections
              // are no longer shown anyway).
              setSectionGrants({});
            }}
          >
            {ZONES.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        {sectionIndex === null && (
          <p className="lede" style={{ marginTop: 0 }}>
            Loading sections…
          </p>
        )}
        {sectionIndex && sectionIndex.length === 0 && (
          <p className="lede" style={{ marginTop: 0 }}>
            No sections in <code>{sectionZone}</code> yet.
          </p>
        )}
        {sectionIndex && sectionIndex.length > 0 && (
          <>
            {/* TITLE-START bulk-selector — type the beginning of a title + verb,
                click to (de)select EVERY section whose title starts with it. The
                count is live. (Emits `#id=` per section; titles aren't in scopes.) */}
            <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                type="search"
                placeholder="title starts with… (e.g. Méthode)"
                value={startQuery}
                onChange={(e) => setStartQuery(e.target.value)}
                style={{ flex: "1 1 160px" }}
              />
              <select value={startVerb} onChange={(e) => setStartVerb(e.target.value as EthosVerb)}>
                {ETHOS_VERBS.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={startMatches.length === 0}
                onClick={() =>
                  setSectionGrants((p) => {
                    const next = { ...p };
                    if (startAllSelected) for (const e of startMatches) delete next[e.id];
                    else for (const e of startMatches) next[e.id] = startVerb;
                    return next;
                  })
                }
              >
                {startAllSelected ? "Deselect" : "Select"} {startMatches.length} section
                {startMatches.length === 1 ? "" : "s"}
              </button>
            </div>

            {/* TEXT search over the same index (title / tag). */}
            <input
              type="search"
              placeholder="Filter by title or tag…"
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              style={{ marginBottom: 6, width: "100%" }}
            />

            {secPageRows.length === 0 ? (
              <p className="lede" style={{ marginTop: 0 }}>
                No section matches “{textQuery.trim()}”.
              </p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {secPageRows.map((entry) => (
                  <div key={entry.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                    <code style={{ flex: "1 1 200px" }}>{entry.title ?? entry.id}</code>
                    <select
                      value={sectionGrants[entry.id] ?? "none"}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSectionGrants((p) => {
                          const next = { ...p };
                          if (v === "none") delete next[entry.id];
                          else next[entry.id] = v as EthosVerb;
                          return next;
                        });
                      }}
                    >
                      <option value="none">no grant</option>
                      {ETHOS_VERBS.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}

            {secFiltered.length > SECTION_PAGE_SIZE && (
              <div className="row" style={{ alignItems: "center", gap: 12, marginTop: 6 }}>
                <button
                  type="button"
                  className="secondary"
                  disabled={secSafePage === 0}
                  onClick={() => setSecPage(Math.max(0, secSafePage - 1))}
                >
                  ← Prev
                </button>
                <span className="meta">
                  {secRangeStart}–{secRangeEnd} of {secFiltered.length}
                  {tq ? " (filtered)" : ""}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={secSafePage >= secPageCount - 1}
                  onClick={() => setSecPage(Math.min(secPageCount - 1, secSafePage + 1))}
                >
                  Next →
                </button>
              </div>
            )}

            {/* Persistent selection panel (survives search / pagination). */}
            {selectedEntries.length > 0 && (
              <div
                style={{
                  marginTop: 8,
                  padding: 8,
                  border: "1px solid var(--border, #ddd)",
                  borderRadius: 4,
                }}
              >
                <strong>Selected ({selectedEntries.length})</strong>
                <div className="stack" style={{ gap: 4, marginTop: 4 }}>
                  {selectedEntries.map((entry) => (
                    <div key={entry.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                      <span className="tag">{sectionGrants[entry.id]}</span>
                      <code style={{ flex: "1 1 160px" }}>{entry.title ?? entry.id}</code>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          setSectionGrants((p) => {
                            const next = { ...p };
                            delete next[entry.id];
                            return next;
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="lede" style={{ marginTop: 6 }}>
                  Emits:{" "}
                  {sectionScopePreview.map((l) => (
                    <code key={l} style={{ marginRight: 8 }}>
                      {l}
                    </code>
                  ))}
                </div>
              </div>
            )}

            {selectedEntries.length > 0 && (
              <p className="lede" style={{ marginTop: 6 }}>
                Issuing auto-seals the delegate into the granted sections (a cheap re-wrap —
                no re-encryption), so it can read them right away.
              </p>
            )}
          </>
        )}
      </div>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>
          Data collections (<code>#data</code>)
        </span>
        {collections === null && <p className="lede">Loading your #data collections…</p>}
        {collections && collections.length === 0 && (
          <p className="lede" style={{ marginTop: 0 }}>
            No <code>#data</code> collections yet. Create one on the Data tab first.
          </p>
        )}
        {collections && collections.length > 0 && (
          <div className="stack" style={{ gap: 6 }}>
            {collections.map((col) => (
              <div key={col} className="row" style={{ gap: 8, alignItems: "center" }}>
                <code style={{ flex: "1 1 200px" }}>{col}</code>
                <select
                  value={grants[col] ?? "none"}
                  onChange={(e) =>
                    setGrants((p) => ({ ...p, [col]: e.target.value as DataGrant }))
                  }
                >
                  <option value="none">no access</option>
                  {DATA_ACTIONS.map((a) => {
                    // All data actions are MINTABLE — the SDK/protocol support
                    // data.<col>.{read,write,admin,append}. NB: this example app's
                    // delegate-side UI only exercises READ (its delegate data
                    // client is read-only, no append-insert UI), so a
                    // write/admin/append mandate is issued here but exercised
                    // elsewhere (delie, or a script).
                    return (
                      <option key={a} value={a}>
                        {a}
                        {a === "read" ? "" : " (mint only — no delegate UI here)"}
                      </option>
                    );
                  })}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <span style={{ display: "block", marginBottom: 4, color: "#666" }}>Assets</span>
        <label style={{ marginBottom: 0 }}>
          <input type="checkbox" checked={assetsRead} onChange={(e) => setAssetsRead(e.target.checked)} />
          <span style={{ marginLeft: 4 }}>
            <code>assets.*.read</code> — read all assets{" "}
            <em style={{ color: "var(--muted)" }}>
              (declared now; delegate asset access is a v0.2 target, not enforced
              in v0.1)
            </em>
          </span>
        </label>
      </div>

      <label>
        <span>TTL</span>
        <select value={ttlSeconds} onChange={(e) => setTtlSeconds(Number(e.target.value))}>
          {TTL_PRESETS.map((p) => (
            <option key={p.seconds} value={p.seconds}>
              {p.label}
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <button type="submit" disabled={busy || !granteeId}>
          {busy ? "Creating…" : "Create mandate"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {minted && (
        <div className="success">
          Created <code>{minted.mandate.mandateId}</code> · scopes{" "}
          <code>{minted.mandate.scopes.join(", ")}</code>.
          {minted.dataAuth.map((d) => (
            <span key={`${d.collection}.${d.action}`}>
              <br />
              CMK re-wrap <code>{d.collection}</code> ({d.action}) →{" "}
              <strong>{d.ok ? "authorized ✓" : `failed ✗ — ${d.detail ?? ""}`}</strong>
            </span>
          ))}
          {resealNote && (
            <>
              <br />
              <strong>{resealNote}</strong>
            </>
          )}
          <br />
          <a href={URL.createObjectURL(minted.mandate.bundle)} download={minted.mandate.filename}>
            Download {minted.mandate.filename}
          </a>{" "}
          — hand it to the grantee (sign out, then import it on Home to test).
        </div>
      )}
      {/* Hint: a write/admin delegate also needs the zone/collection readable.
          For ethos zones, publish the zone once after issuing so the grantee's
          wrap is sealed in. */}
      {ZONES.some((z) => ethos.has(`ethos.write.${z}` as Scope)) && (
        <p className="lede">
          Note: a delegate can only read/write an Ethos zone the owner has{" "}
          <strong>sealed with their wrap</strong>. Issuing now does this
          automatically (auto-reseal), so the delegate is sealed in immediately.
        </p>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Issued mandates list                                                      */
/* -------------------------------------------------------------------------- */

function IssuedMandates({ refreshTick }: { readonly refreshTick: number }) {
  const { sdk } = useActor();
  const [list, setList] = useState<readonly OwnedMandate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    sdk.mandates
      .list()
      .then((items) => !cancelled && setList(items))
      .catch((e) => !cancelled && setError(formatError(e)));
    return () => {
      cancelled = true;
    };
  }, [sdk, tick, refreshTick]);

  return (
    <section>
      <h2>Mandates you've issued</h2>
      {error && <div className="error">{error}</div>}
      {!list && !error && <p>Loading…</p>}
      {list && list.length === 0 && <p className="lede">None yet.</p>}
      {list && list.length > 0 && <RevokeAllRow onDone={() => setTick((t) => t + 1)} />}
      {list?.map((m) => (
        <div
          key={m.mandateId}
          className="section-card"
          style={m.revoked ? { opacity: 0.6, filter: "grayscale(0.6)" } : undefined}
        >
          <h4>
            {m.mandateId}
            {m.revoked && (
              <span className="tag" style={{ marginLeft: 8, color: "var(--danger, #c0392b)" }}>
                REVOKED
              </span>
            )}
          </h4>
          <div className="body">
            actor: <code>{m.actorDid}</code>
            <br />
            scopes: {m.scopes.join(", ") || "(none)"}
          </div>
          <div className="meta">
            not_after: {m.notAfter ? new Date(m.notAfter * 1000).toLocaleString() : "—"}
          </div>
          {m.revoked ? (
            <div style={{ marginTop: 8 }}>
              <p className="meta">
                <em>
                  Revoked — the platform now refuses this delegate's reads and writes
                  (mandate + revocation checked server-side). No re-encryption needed.
                </em>
              </p>
              <RotateKeysRow />
            </div>
          ) : (
            <RevokeRow mandateId={m.mandateId} onRevoked={() => setTick((t) => t + 1)} />
          )}
        </div>
      ))}
    </section>
  );
}

/** One-write "revoke ALL" — bumps the revocation epoch on the did.json. */
function RevokeAllRow({ onDone }: { readonly onDone: () => void }) {
  const { sdk } = useActor();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginBottom: 10 }}>
      <button
        className="secondary"
        disabled={busy}
        title="Sets the revocation epoch: every mandate issued before now becomes void in ONE signed write — no per-mandate enumeration. Wraps are cleaned by the background prune; 'Rotate keys' remains the cryptographic cut."
        onClick={async () => {
          if (!confirm("Void EVERY mandate issued until now? Delegates lose access immediately.")) return;
          setBusy(true);
          setError(null);
          setNote(null);
          try {
            const r = await sdk.mandates.revokeAll();
            setNote(`Epoch set — every mandate issued before ${new Date(r.mandatesVoidBefore).toLocaleString()} is void.`);
            onDone();
          } catch (e) {
            setError(formatError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Revoking all…" : "Revoke ALL (epoch)"}
      </button>
      {note && <span className="meta" style={{ marginLeft: 8 }}>{note}</span>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function RevokeRow({
  mandateId,
  onRevoked,
}: {
  readonly mandateId: string;
  readonly onRevoked: () => void;
}) {
  const { sdk } = useActor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button
        className="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await sdk.mandates.revoke(mandateId);
            // Revoking writes the §4.3 revocation (one write). The platform now
            // enforces it on BOTH reads and writes server-side (mandate +
            // revocation checked on every encrypted read), so the delegate is cut
            // immediately — no reseal / re-encryption, no read amplification.
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
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/**
 * Optional "hard cut" after a revocation. Server-side enforcement already blocks
 * the revoked delegate's API reads, so this is NOT required. It re-encrypts the
 * ethos (rotates section DEKs, drops the revoked delegate's wraps) so the
 * delegate can't decrypt FUTURE editions even if it obtains the ciphertext by
 * other means. Editions it already downloaded stay readable to it (no system can
 * un-send those). Reserve this for a real key-compromise, not routine revocation.
 */
function RotateKeysRow() {
  const { sdk } = useActor();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <button
        disabled={busy}
        title="Optional cryptographic hard cut: re-encrypt so revoked delegates can't decrypt FUTURE editions. Not required — the platform already blocks their API reads."
        onClick={async () => {
          setBusy(true);
          setError(null);
          setNote(null);
          try {
            // mode:"rotate" is the explicit hard-cut — the only path that
            // removes recipients + rotates DEKs (normal publishes are additive).
            const sealed = await sdk.ethos.me().reseal({ mode: "rotate" });
            setNote(
              sealed
                ? `Keys rotated — edition #${sealed.editionHeight}.`
                : "Nothing to rotate (no published edition).",
            );
          } catch (e) {
            setError(formatError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Rotating keys…" : "Rotate keys (hard cut)"}
      </button>
      {note && (
        <span className="meta" style={{ marginLeft: 8 }}>
          {note}
        </span>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
