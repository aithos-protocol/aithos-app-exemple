// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /append-data — in-browser demo of mandate-scoped APPEND-ONLY data writes
// (@aithos/sdk ≥ 0.1.0-alpha.46).
//
// The "deposit without read" pattern behind Délie's magic link: a depositor
// (the patient) drops a record into the OWNER's (the practitioner's)
// collection WITHOUT being able to read that collection — not other parties'
// records, and not even its own deposit. The DEK is sealed to the owner's
// public key, so only the owner can decrypt it.
//
// One button runs the whole flow on two ephemeral did:key identities against
// the live data PDS:
//
//   1. OWNER (practitioner) creates a collection.
//   2. OWNER mints a `data.<col>.append` mandate for the DEPOSITOR (patient).
//      NO authorizeDelegate — append needs no CMK wrap.
//   3. DEPOSITOR createAppendDataClient(...).insert(...) → 200, sealing the
//      DEK to the owner's #data-kex pubkey. The append client exposes ONLY
//      insert() (no get/list at the type level).
//   4. DEPOSITOR tries to READ the same collection with the append mandate
//      (via a delegate read client) → rejected by the PDS (-32042): append
//      grants no read.
//   5. OWNER reads the deposit and DECRYPTS it → content matches. Proof that
//      the depositor wrote something only the owner can read.

import { useState } from "react";

import { createAppendDataClient, createDataClient, createDelegateDataClient } from "@aithos/sdk";
import type { AithosSchemaLite } from "@aithos/sdk";
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

/**
 * Field split for the deposit collection. Uses the bundled core schema id
 * `aithos.contacts.v1`; the subset of fields we touch (`name` indexable,
 * `notes` encrypted) matches the bundled split, so the owner — which resolves
 * the bundled schema automatically — decrypts what the append client sealed.
 */
const depositLite: AithosSchemaLite = {
  schema: "aithos.contacts.v1",
  indexable: new Set(["name", "email", "status", "created_at", "modified_at"]),
  encrypted: new Set(["notes"]),
  auto: new Set(["created_at", "modified_at"]),
  defaults: {},
};

function freshDidKey() {
  const kp = generateKeyPair();
  const mb = ed25519PublicKeyToMultibase(kp.publicKey);
  return { kp, mb, did: `did:key:${mb}` };
}

/** A BrowserIdentity whose every sphere is the same did:key root key. */
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

export function AppendData() {
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
      const owner = freshDidKey(); // practitioner
      const depositor = freshDidKey(); // patient
      const colName = `app_append_${Date.now()}`;
      push(true, `owner ${owner.did.slice(0, 24)}…  depositor ${depositor.did.slice(0, 24)}…`);

      // 1. Owner creates the collection (no records yet).
      const ownerClient = createDataClient({
        pdsUrl: PDS_URL,
        did: owner.did,
        sphereSeed: owner.kp.seed,
        verificationMethod: `${owner.did}#self`,
      });
      await ownerClient.ensureCollection({ name: colName, schema: "aithos.contacts.v1" });
      push(true, `owner created "${colName}"`);

      // 2. Owner mints a data.<col>.append mandate for the depositor.
      //    No authorizeDelegate: append carries no CMK wrap.
      const ownerIdentity = didKeyBrowserIdentity(owner, "practitioner");
      const mandate = signMandate({
        issuer: ownerIdentity as never,
        actorSphere: "self",
        grantee: { id: depositor.did, label: "patient", pubkey: depositor.mb },
        scopes: [`data.${colName}.append`],
        ttlSeconds: 3600,
      });
      push(true, `minted APPEND mandate ${mandate.id} (scope data.${colName}.append, no authorize_app)`);

      // 3. Depositor deposits — sealing the DEK to the owner's pubkey.
      const bundleText =
        "PATIENT_MANDATE_BUNDLE ethos.read.self → practitioner (long-lived). " +
        `nonce=${Math.random().toString(36).slice(2)}`;
      const appendClient = createAppendDataClient({
        pdsUrl: PDS_URL,
        subjectDid: owner.did,
        ownerDataPubkeyMultibase: owner.mb,
        mandate,
        delegateSeed: depositor.kp.seed,
        schema: depositLite,
      });
      const recordId = await appendClient
        .collection(colName)
        .insert({ name: "Patient deposit", notes: bundleText });
      push(true, `depositor insert() → ${recordId.slice(0, 18)}… (no read key held)`);

      // 4. Depositor cannot READ: try a delegate read with the append mandate.
      let readBlocked = false;
      try {
        const asReader = createDelegateDataClient({
          pdsUrl: PDS_URL,
          subjectDid: owner.did,
          mandate,
          delegateSeed: depositor.kp.seed,
        });
        await asReader.collection(colName).list({ order: "newest" });
      } catch (e) {
        readBlocked = /insufficient_scope|-32042|not permitted|forbidden/i.test(formatError(e));
      }
      push(readBlocked, `depositor read with append mandate → blocked by PDS: ${readBlocked}`);

      // 5. Owner reads + decrypts the deposit.
      const got = await ownerClient.collection(colName).get(recordId);
      const match = got?.notes === bundleText;
      push(match, `owner get(${recordId.slice(0, 14)}…) → deposit DECRYPTED & matches: ${match}`);

      const allOk = !!recordId && readBlocked && match;
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
      <h2>Append-only deposit</h2>
      <p>
        Mandate-scoped <strong>append-only</strong> write: a depositor drops a
        record into the owner&rsquo;s collection without being able to read it
        (the DEK is sealed to the owner&rsquo;s key). The &ldquo;deposit without
        read&rdquo; pattern behind Délie&rsquo;s magic link, run end-to-end on
        two ephemeral did:key identities against the live PDS.
      </p>
      <button onClick={run} disabled={running}>
        {running ? "Running…" : "Run append-deposit demo"}
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
