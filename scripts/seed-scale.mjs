// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Scale validation against the LIVE dev backend (PLAN-SEALING-SCALE phase 6).
//
// Seeds a fresh, throwaway Ethos up to 1 000 sections per zone (batched
// publishes), then measures the canonical owner + delegate flows against the
// acceptance criteria:
//   index < 1s · open section < 300ms · edit+publish < 1.5s ·
//   mandate create+seal < 2s · delegate reads right after seal ·
//   revoked delegate blocked server-side · prune steady-state cheap.
//
// Resumable subcommands (state in STATE_FILE, default /var/tmp/scale-state.json):
//   node scripts/seed-scale.mjs init
//   node scripts/seed-scale.mjs seed --zone public --count 1000 --batch 100
//   node scripts/seed-scale.mjs seed --zone circle --count 200 --batch 100
//   node scripts/seed-scale.mjs measure
//   node scripts/seed-scale.mjs mandate-flow
//
// SDK resolution: set AITHOS_SDK_PATH to a built barrel (e.g.
// ../aithos-sdk/dist/src/index.js) to run against an unpublished build; the
// default is the installed @aithos/sdk. Endpoints default to *.dev.aithos.be.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SDK_PATH = process.env.AITHOS_SDK_PATH ?? "@aithos/sdk";
const API_URL = process.env.AITHOS_API_URL ?? "https://api.dev.aithos.be";
const CDN_URL = process.env.AITHOS_CDN_URL ?? "https://cdn.dev.aithos.be";
const STATE_FILE = process.env.SCALE_STATE ?? "/var/tmp/scale-state.json";

const { AithosAuth, AithosSDK, memoryKeyStore, noopStore, onboarding } = await import(SDK_PATH);

const t0 = () => performance.now();
const ms = (a) => `${Math.round(performance.now() - a)}ms`;
const msNum = (a) => Math.round(performance.now() - a);

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

async function ownerSdk(state) {
  const auth = new AithosAuth({
    apiBaseUrl: API_URL,
    sessionStore: noopStore(),
    keyStore: memoryKeyStore(),
  });
  const sdk = new AithosSDK({
    auth,
    appDid: "did:aithos:scale-harness",
    // v0.4 opt-in (AITHOS_V04=1): owner publishes migrate-then-patch. Left
    // OFF for the v0.3 baseline half of the before/after run.
    ...(process.env.AITHOS_V04 === "1" ? { ethosV04: true } : {}),
    endpoints: { api: API_URL, cdn: CDN_URL },
  });
  await auth.signInWithRecovery({ file: state.recovery });
  return { auth, sdk };
}

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

if (cmd === "init") {
  const handle = `scale_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const auth = new AithosAuth({ apiBaseUrl: API_URL, sessionStore: noopStore(), keyStore: memoryKeyStore() });
  new AithosSDK({ auth, appDid: "did:aithos:scale-harness", endpoints: { api: API_URL, cdn: CDN_URL } });
  const a = t0();
  const created = await onboarding.runOnboarding({
    handle,
    displayName: "Scale Harness",
    publicTitle: "scale baseline",
    publicBody: "Baseline section.",
  });
  const recovery = typeof created.recoveryBlob === "string" ? created.recoveryBlob : await created.recoveryBlob.text();
  saveState({ handle, did: created.identity.did, recovery, seeded: {}, timings: {} });
  console.log(`init OK did=${created.identity.did} handle=${handle} (${ms(a)})`);
} else if (cmd === "seed") {
  const zone = opt("zone", "public");
  const count = parseInt(opt("count", "1000"), 10);
  const batch = parseInt(opt("batch", "100"), 10);
  const state = loadState();
  const { sdk } = await ownerSdk(state);
  const done = state.seeded[zone] ?? 0;
  const me = sdk.ethos.me();
  let i = done;
  const body =
    "Lorem aithos dolor sit amet, una vita digitalis integra. ".repeat(6) + "Fin de section.";
  while (i < count) {
    const n = Math.min(batch, count - i);
    const client = sdk.ethos.me();
    for (let k = 0; k < n; k++) {
      client.zone(zone).addSection({
        title: `${zone} section ${i + k + 1}`,
        body: `${body} [#${i + k + 1}]`,
        tags: (i + k) % 10 === 0 ? ["décennale"] : undefined,
      });
    }
    const a = t0();
    const r = await client.publish();
    i += n;
    state.seeded[zone] = i;
    saveState(state);
    console.log(`publish +${n} ${zone} (total ${i}) → edition #${r.editionHeight} in ${ms(a)}`);
  }
  console.log(`seed ${zone} done: ${i} sections`);
  void me;
} else if (cmd === "measure") {
  const state = loadState();
  const { sdk } = await ownerSdk(state);
  const zone = opt("zone", "public");
  const out = state.timings;

  // Fresh client = cold caches: the honest end-to-end cost.
  let a = t0();
  let me = sdk.ethos.me();
  const idx = await me.zone(zone).index();
  out[`index_cold_${zone}_${idx.length}`] = msNum(a);
  console.log(`index() cold: ${idx.length} rows in ${ms(a)}`);

  const target = idx[Math.floor(idx.length / 2)].id;
  a = t0();
  const sec = await me.zone(zone).section(target);
  out[`open_section_${zone}`] = msNum(a);
  console.log(`section(${target}) "${sec.title}" in ${ms(a)}`);

  me.zone(zone).updateSection(target, { body: sec.body + `\n\nEdit @${new Date().toISOString()}` });
  a = t0();
  const pub = await me.publish();
  out[`edit_publish_${zone}`] = msNum(a);
  console.log(`edit+publish → edition #${pub.editionHeight} in ${ms(a)}`);

  // Post-publish UI loop must be local (seeded caches): 0 network.
  a = t0();
  await me.zone(zone).index();
  await me.zone(zone).section(target);
  out["post_publish_refresh"] = msNum(a);
  console.log(`post-publish index()+section() (seeded caches) in ${ms(a)}`);

  // Eager full zone (batched reads on the wire).
  a = t0();
  const all = await sdk.ethos.me().zone(zone).sections();
  out[`eager_sections_${zone}_${all.length}`] = msNum(a);
  console.log(`eager sections(): ${all.length} decrypted in ${ms(a)}`);

  saveState(state);
} else if (cmd === "mandate-flow") {
  const state = loadState();
  const { sdk } = await ownerSdk(state);
  const out = state.timings;
  const zone = opt("zone", "circle");

  // create + targeted seal
  let a = t0();
  const minted = await sdk.mandates.create({
    granteeId: `urn:aithos:agent:scale${Date.now().toString(36)}`,
    scopes: [`ethos.read.${zone}`],
    ttlSeconds: 3600,
  });
  const sealed = await sdk.ethos.me().sealGrant(minted.mandate);
  out["mandate_create_plus_seal"] = msNum(a);
  console.log(`mandate.create + sealGrant → edition #${sealed?.editionHeight} in ${ms(a)}`);

  // delegate session reads IMMEDIATELY
  const dAuth = new AithosAuth({ apiBaseUrl: API_URL, sessionStore: noopStore(), keyStore: memoryKeyStore() });
  const dSdk = new AithosSDK({ auth: dAuth, appDid: "did:aithos:scale-delegate", endpoints: { api: API_URL, cdn: CDN_URL } });
  await dAuth.importMandate({ bundle: minted.bundle });
  a = t0();
  const dClient = await dSdk.ethos.of(state.did);
  const dIdx = await dClient.zone(zone).index();
  const readable = dIdx.filter((r) => r.readable);
  const got = readable.length > 0 ? await dClient.zone(zone).section(readable[0].id) : null;
  out["delegate_first_read"] = msNum(a);
  console.log(
    `delegate index: ${dIdx.length} rows (${readable.length} readable), first body ${got ? "OK" : "none"} in ${ms(a)}`,
  );
  if (readable.length === 0) console.error("✗ ACCEPTANCE FAIL: delegate cannot read right after sealGrant");

  // revoke → server blocks the delegate's NEXT read
  a = t0();
  await sdk.mandates.revoke(minted.mandateId);
  out["revoke"] = msNum(a);
  console.log(`revoke in ${ms(a)}`);
  const dClient2 = await dSdk.ethos.of(state.did);
  let blocked = false;
  try {
    const idx2 = await dClient2.zone(zone).index();
    const r2 = idx2.find((r) => r.readable);
    // alpha.83 contract: a server-side denial reads as NULL (not a throw) —
    // the assertion must check the BODY, not just the index row.
    const body2 = r2 ? await dClient2.zone(zone).section(r2.id) : null;
    blocked = !r2 || body2 === null;
  } catch {
    blocked = true;
  }
  console.log(blocked ? "revoked delegate blocked ✓" : "✗ ACCEPTANCE FAIL: revoked delegate still reads");

  // prune (drops the dead wrap), then steady-state prune (no publish)
  a = t0();
  const pruned = await sdk.ethos.me().pruneWraps();
  out["prune_first"] = msNum(a);
  console.log(`pruneWraps → ${pruned ? `edition #${pruned.editionHeight}` : "nothing"} in ${ms(a)}`);
  a = t0();
  const again = await sdk.ethos.me().pruneWraps();
  out["prune_steady"] = msNum(a);
  console.log(`pruneWraps steady-state → ${again ? "PUBLISHED (unexpected)" : "null ✓"} in ${ms(a)}`);

  saveState(state);
} else if (cmd === "migrate") {
  const state = loadState();
  if (!state) throw new Error("run init first");
  const { sdk } = await ownerSdk(state);
  const a = t0();
  const r = await sdk.ethos.me().migrateToV04();
  if (!r) {
    console.log("migrate: nothing to do (already v0.4 or no edition)");
  } else {
    console.log(`migrate: v0.3→v0.4 in ${ms(a)} — edition #${r.editionHeight}`);
    state.v04 = true;
    saveState(state);
  }
} else if (cmd === "summary") {
  const state = loadState();
  console.log(JSON.stringify({ did: state.did, seeded: state.seeded, timings: state.timings }, null, 1));
} else {
  console.log("usage: seed-scale.mjs init|seed|measure|mandate-flow|summary [--zone z] [--count n] [--batch n]");
  process.exit(1);
}
