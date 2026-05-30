// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /delegate-data — in-browser demo of mandate-scoped DELEGATE data read
// (@aithos/sdk ≥ 0.1.0-alpha.45).
//
// One button runs the whole Délie-shaped flow on two ephemeral did:key
// identities (no sign-in needed), against the live data PDS:
//
//   1. OWNER (patient) creates a collection + inserts records with both
//      indexable (`created_at`, `name`) and encrypted (`notes`) fields.
//   2. OWNER mints a `data.<col>.read` mandate for the DELEGATE (psy),
//      signed under actor_sphere=self (did:key resolver aliases #self to
//      the single key).
//   3. OWNER `authorizeDelegate({ collectionName, mandate })` → re-wraps
//      the collection CMK to the delegate's key + aithos.data.authorize_app.
//   4. DELEGATE `createDelegateDataClient(...)`:
//        - list() with a `created_at` window → DECRYPTS `notes`,
//        - get(id) → DECRYPTS,
//        - insert() → rejected (-32042, read-only),
//        - after OWNER revokeDelegate → list() fails (forward-only).
//
// This is the browser counterpart of the SDK e2e
// (aithos-sdk/test/data-delegate-e2e.test.mjs): same logic, proving the
// isomorphic (browser) path + the published package surface.

import { useState } from "react";

import {
  createDataClient,
  createDelegateDataClient,
} from "@aithos/sdk";
import {
  ed25519PublicKeyToMultibase,
  generateKeyPair,
  signMandate,
} from "@aithos/protocol-client";

import { formatError } from "./Home.js";

const PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_PDS_URL) ||
  "https://slpknok0md.execute-api.eu-west-3.amazonaws.com";

/** A did:key identity from a fresh Ed25519 keypair. */
function freshDidKey() {
  const kp = generateKeyPair(); // { seed, publicKey }
  const mb = ed25519PublicKeyToMultibase(kp.publicKey);
  return { kp, mb, did: `did:key:${mb}` };
}

/**
 * A BrowserIdentity whose every sphere is the SAME root key — required
 * for did:key (one key; the PDS resolver aliases #self/#circle/#public to
 * it). The mandate is signed under #self with this key.
 */
function didKeyBrowserIdentity(id: ReturnType<typeof freshDidKey>, handle: string) {
  return {
    handle,
    displayName: handle,
    did: id.did,
    root: id.kp,
    public: id.kp,
    circle: id.kp,
    self: id.kp,
  };
}

type Line = { ok: boolean; text: string };

export function DelegateData() {
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<null | "pass" | "fail">(null);

  async function run() {
    setRunning(true);
    setDone(null);
    const log: Line[] = [];
    const push = (ok: boolean, text: string) => {
      log.push({ ok, text });
      setLines([...log]);
    };

    try {
      const owner = freshDidKey();
      const delegate = freshDidKey();
      const colName = `app_deleg_${Date.now()}`;
      push(true, `owner ${owner.did.slice(0, 24)}…  delegate ${delegate.did.slice(0, 24)}…`);

      // 1. Owner creates collection + inserts
      const ownerClient = createDataClient({
        pdsUrl: PDS_URL,
        did: owner.did,
        sphereSeed: owner.kp.seed,
        verificationMethod: `${owner.did}#self`,
      });
      await ownerClient.ensureCollection({ name: colName, schema: "aithos.contacts.v1" });
      const ownerCol = ownerClient.collection(colName);
      const noteA = "Séance 1 — anxiété au travail, sommeil perturbé.";
      const noteB = "Séance 2 — amélioration, exercices de respiration.";
      const idA = await ownerCol.insert({ name: "Note A", email: "a@ex.com", notes: noteA });
      await ownerCol.insert({ name: "Note B", email: "b@ex.com", notes: noteB });
      push(true, `owner created "${colName}" + inserted 2 records`);

      // 2. Owner mints a data.<col>.read mandate for the delegate
      const ownerIdentity = didKeyBrowserIdentity(owner, "patient");
      const mandate = signMandate({
        issuer: ownerIdentity as never,
        actorSphere: "self",
        grantee: { id: delegate.did, label: "psy", pubkey: delegate.mb },
        scopes: [`data.${colName}.read`],
        ttlSeconds: 3600,
      });
      push(true, `minted mandate ${mandate.id} (actor_sphere=${mandate.actor_sphere}, scope data.${colName}.read)`);

      // 3. Owner authorizes the delegate (re-wrap CMK)
      await ownerClient.authorizeDelegate({ collectionName: colName, mandate });
      push(true, "owner authorizeDelegate ✓ (CMK re-wrapped to delegate)");

      // 4. Delegate reads + decrypts
      const delegateClient = createDelegateDataClient({
        pdsUrl: PDS_URL,
        subjectDid: owner.did,
        mandate,
        delegateSeed: delegate.kp.seed,
      });
      const delegateCol = delegateClient.collection(colName);
      const since = new Date(Date.now() - 3600_000).toISOString();
      const listed = await delegateCol.list({
        filter: { range: { field: "created_at", gte: since } },
        order: "oldest",
      });
      const notes = listed.items.map((r) => String(r.notes ?? ""));
      const decrypted =
        notes.some((n) => n.includes("anxiété")) && notes.some((n) => n.includes("respiration"));
      push(decrypted, `delegate list() → ${listed.items.length} records, notes DECRYPTED: ${decrypted ? "yes" : "NO"}`);
      const gotA = await delegateCol.get(idA);
      push(gotA?.notes === noteA, `delegate get(${idA.slice(0, 14)}…) → notes match: ${gotA?.notes === noteA}`);

      // 5. Delegate write is refused
      let writeRefused = false;
      try {
        // The read-only type omits insert(); cast to exercise the guard.
        await (delegateCol as unknown as { insert: (r: unknown) => Promise<string> }).insert({
          name: "should fail",
          notes: "x",
        });
      } catch (e) {
        writeRefused = /delegate|read-only|not permitted/i.test(formatError(e));
      }
      push(writeRefused, `delegate insert() refused (read-only): ${writeRefused}`);

      // 6. Revocation → delegate read fails
      await ownerClient.revokeDelegate({ collectionName: colName, mandateId: mandate.id, reason: "demo" });
      let readBlocked = false;
      try {
        await delegateCol.list({ order: "oldest" });
      } catch {
        readBlocked = true;
      }
      push(readBlocked, `after revokeDelegate, delegate read blocked: ${readBlocked}`);

      const allOk = decrypted && gotA?.notes === noteA && writeRefused && readBlocked;
      setDone(allOk ? "pass" : "fail");
    } catch (e) {
      push(false, `ERROR: ${formatError(e)}`);
      setDone("fail");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section>
      <h2>Delegate data read</h2>
      <p>
        Mandate-scoped delegate read of an owner&rsquo;s encrypted collection
        (the Délie patient → psy flow), run end-to-end on two ephemeral
        did:key identities against the live PDS.
      </p>
      <button onClick={run} disabled={running}>
        {running ? "Running…" : "Run delegate-read demo"}
      </button>
      {done && (
        <p>
          <strong>{done === "pass" ? "✅ All steps passed" : "❌ Some step failed"}</strong>
        </p>
      )}
      <pre style={{ background: "#0b1021", color: "#cfe", padding: 12, borderRadius: 8, overflow: "auto" }}>
        {lines.map((l) => `${l.ok ? "✓" : "✗"} ${l.text}`).join("\n") || "(idle)"}
      </pre>
    </section>
  );
}
