#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla
//
// e2e-full-flow — exercises, against the LIVE Aithos backend, the exact SDK
// flows the rewritten example app depends on, in pure Node (no browser). Every
// call is an envelope (no JWT). It mints throwaway identities, so it's safe to
// run repeatedly (it leaves orphan published DIDs, same as the app's create
// flow).
//
//   1. owner: runOnboarding (mint #data identity + publish DID doc + edition)
//   2. owner: sign in from the recovery blob (AithosAuth, memory keystore)
//   3. owner: ethos — stage a circle section + publish
//   4. owner: data — create a contacts collection + insert + list
//   5. owner: mandate — combined ethos.read.circle + data.<col>.read, then
//      authorizeDelegate (CMK re-wrap) + RE-publish circle to seal the delegate
//   6. delegate: import the mandate (2nd auth), ethos.of(owner).circle read,
//      delegate data read
//
//   Usage: node scripts/e2e-full-flow.mjs

import { runOnboarding } from "@aithos/protocol-client";
import {
  AithosAuth,
  AithosSDK,
  memoryKeyStore,
  createDataClient,
  createDelegateDataClient,
} from "@aithos/sdk";

const APP_DID = "did:aithos:z6Mkm6tHeRiM1546AJEj8G1JP7qWhqJPnPshVJL14DWAC9q7";
const PDS_URL = "https://pds.aithos.be";

let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  cond ? pass++ : fail++;
  return cond;
};
const step = (n) => console.log(`\n[${n}]`);

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function main() {
  const tag = Date.now().toString(36);
  const handle = `e2e_${tag}`;

  step(`1. owner onboarding (mint #data + publish) — handle ${handle}`);
  const onb = await runOnboarding({
    handle,
    displayName: handle,
    publicTitle: "E2E public",
    publicBody: "public body",
    tags: ["e2e"],
  });
  const ownerDid = onb.identity.did;
  ok(!!onb.identity.data, "identity carries a #data sphere");
  ok(ownerDid.startsWith("did:aithos:"), `published ${ownerDid.slice(0, 30)}…`);
  const recoveryText = await onb.recoveryBlob.text();
  const dataSeedHex = JSON.parse(recoveryText).seeds_hex.data;
  ok(!!dataSeedHex, "recovery carries the #data seed");

  step("2. owner sign-in from recovery (envelope, no JWT)");
  const auth = new AithosAuth({ keyStore: memoryKeyStore() });
  await auth.signInWithRecovery({ file: onb.recoveryBlob });
  const sdk = new AithosSDK({ auth, appDid: APP_DID });
  ok(auth.canSignAsOwner(), "owner signers loaded");

  step("3. owner ethos — stage circle section + publish");
  try {
    const me = sdk.ethos.me();
    me.zone("circle").addSection({ title: "Circle A", body: "secret circle note" });
    const pub = await me.publish();
    ok(pub.zonesPublished.includes("circle"), `published edition #${pub.editionHeight} (${pub.zonesPublished.join(",")})`);
  } catch (e) {
    ok(false, `ethos publish failed: ${e.message}`);
  }

  step("4. owner data — contacts collection + insert + list (#data)");
  const colName = `e2e_${tag}`;
  const ownerData = createDataClient({
    pdsUrl: PDS_URL,
    did: ownerDid,
    sphereSeed: hexToBytes(dataSeedHex),
    verificationMethod: `${ownerDid}#data`,
  });
  let recordId;
  try {
    await ownerData.ensureCollection({ name: colName, schema: "aithos.contacts.v1" });
    recordId = await ownerData.collection(colName).insert({ name: "Jean", notes: "secret note about Jean" });
    const r = await ownerData.collection(colName).list({ limit: 10 });
    ok(r.items.length >= 1, `inserted + listed ${r.items.length} record(s) under #data`);
  } catch (e) {
    ok(false, `owner data failed: ${e.message}`);
  }

  step("5. owner mandate — combined ethos.read.circle + data.<col>.read");
  let bundle, mandate;
  try {
    const minted = await sdk.mandates.create({
      granteeId: "urn:aithos:agent:e2e",
      scopes: ["ethos.read.circle", `data.${colName}.read`],
      ttlSeconds: 3600,
    });
    bundle = JSON.parse(await minted.bundle.text());
    mandate = bundle.mandate;
    ok(!!mandate, `minted mandate ${minted.mandateId}`);
    await ownerData.authorizeDelegate({ collectionName: colName, mandate });
    ok(true, "authorizeDelegate — CMK re-wrapped to grantee");
    // Re-publish circle so the new delegate's wrap gets sealed in.
    const me = sdk.ethos.me();
    me.zone("circle").addSection({ title: "Circle B", body: "second circle note" });
    const pub2 = await me.publish();
    ok(pub2.zonesPublished.includes("circle"), `re-published circle to seal delegate (edition #${pub2.editionHeight})`);
  } catch (e) {
    ok(false, `mandate step failed: ${e.message}`);
  }

  step("6. delegate — import mandate, read circle ethos + read data");
  try {
    const blob = new Blob([JSON.stringify(bundle)], { type: "application/json" });
    const auth2 = new AithosAuth({ keyStore: memoryKeyStore() });
    await auth2.importMandate({ bundle: blob });
    const sdk2 = new AithosSDK({ auth: auth2, appDid: APP_DID });

    // Ethos delegate read (authorized + decryptable?)
    try {
      const of = await sdk2.ethos.of(ownerDid);
      const secs = await of.zone("circle").sections();
      const titles = secs.map((s) => s.title);
      ok(titles.includes("Circle A") || titles.includes("Circle B"), `delegate decrypted circle: [${titles.join(", ")}]`);
    } catch (e) {
      ok(false, `delegate ethos circle read failed (seal issue?): ${e.message}`);
    }

    // Data delegate read
    try {
      const delg = createDelegateDataClient({
        pdsUrl: PDS_URL,
        subjectDid: ownerDid,
        mandate,
        delegateSeed: hexToBytes(bundle.delegate_seed_hex),
      });
      const r = await delg.collection(colName).list({ limit: 10 });
      const decrypted = r.items.some((it) => String(it.notes ?? "").includes("Jean"));
      ok(r.items.length >= 1, `delegate listed ${r.items.length} record(s)`);
      ok(decrypted, "delegate DECRYPTED the encrypted field via re-wrapped CMK");
    } catch (e) {
      ok(false, `delegate data read failed: ${e.message}`);
    }
  } catch (e) {
    ok(false, `delegate import failed: ${e.message}`);
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
