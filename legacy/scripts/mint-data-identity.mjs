#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla
//
// mint-data-identity — forge a brand-new self-custody did:aithos that
// carries the dedicated `#data` sphere, publish its DID document to
// api.aithos.be, and write a plaintext recovery file you can upload in
// the example app's "Recovery" tab.
//
// WHY THIS SCRIPT EXISTS
// ----------------------
// Exercising the `#data` sphere end-to-end needs a self-custody account
// (the seeds are minted client-side, so the 5th `#data` seed exists)
// whose DID document is PUBLISHED (so the PDS can resolve it to verify a
// `#data`-signed envelope). The browser `signUp` path that would do this
// is currently blocked on localhost (the origin allowlist is keyed to a
// real app DID; the example app uses a placeholder). But publishing the
// DID document on api.aithos.be is gated by a signed ENVELOPE, not by the
// Origin header — so a plain Node script with no Origin header sails
// through. That's exactly what `runOnboarding` does.
//
// WHAT IT DOES (all via @aithos/protocol-client@>=0.1.0-alpha.19)
//   1. createBrowserIdentity(handle, displayName) — 5 keypairs incl. #data
//   2. signedDidDocument(identity)               — embeds the #data VM
//   3. POST aithos.publish_identity (envelope #root) to api.aithos.be
//   4. POST aithos.publish_ethos_edition (envelope #public) — makes it a
//      fully-formed Ethos (harmless for the data demo)
//   5. write aithos-recovery-<handle>.json with all 5 seeds_hex incl. data
//
// USAGE
//   node scripts/mint-data-identity.mjs [handle] [displayName]
//
//   # examples
//   node scripts/mint-data-identity.mjs
//   node scripts/mint-data-identity.mjs data_demo "Data Sphere Demo"
//
// Then: open the app, go to the "Recovery" tab on the Home page, upload
// the generated aithos-recovery-<handle>.json, then open "Data (#data)"
// and click "Create + insert under #data".
//
// The recovery file holds your PRIVATE KEYS in plaintext. It is written
// next to this script's invocation cwd. Treat it like a secret: don't
// commit it, email it, or upload it anywhere but this local demo.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runOnboarding, writeEndpoint } from "@aithos/protocol-client";

function randomSuffix() {
  return Math.random().toString(36).slice(2, 8);
}

async function main() {
  const handle = process.argv[2] ?? `data_demo_${randomSuffix()}`;
  const displayName = process.argv[3] ?? handle;

  console.log(`\n  Minting a self-custody did:aithos with a #data sphere…`);
  console.log(`  handle       : ${handle}`);
  console.log(`  display name : ${displayName}`);
  console.log(`  publishing to: ${writeEndpoint()}\n`);

  let result;
  try {
    result = await runOnboarding({
      handle,
      displayName,
      publicTitle: "Data sphere demo",
      publicBody:
        "Identity minted to demonstrate the dedicated #data sphere on a real did:aithos account.",
      tags: ["demo", "data-sphere"],
    });
  } catch (e) {
    console.error(`\n  ✗ onboarding failed at step "${e?.step ?? "?"}": ${e?.message ?? e}`);
    if (e?.data) console.error(`    data: ${JSON.stringify(e.data)}`);
    process.exit(1);
  }

  const { identity, recoveryBlob } = result;

  // Sanity: the identity MUST carry a #data sphere, else the whole point
  // is lost (you'd be back to a 4-sphere account with no #data).
  if (!identity.data) {
    console.error(
      `\n  ✗ minted identity has NO #data sphere — your installed ` +
        `@aithos/protocol-client is older than alpha.19. Run \`pnpm install\` ` +
        `to pull the version pinned in package.json, then retry.\n`,
    );
    process.exit(2);
  }

  const text = await recoveryBlob.text();
  const filename = `aithos-recovery-${handle}.json`;
  const outPath = resolve(process.cwd(), filename);
  writeFileSync(outPath, text);

  console.log(`  ✓ published DID document (with #data) for`);
  console.log(`    ${identity.did}`);
  console.log(`  ✓ recovery file written:`);
  console.log(`    ${outPath}\n`);
  console.log(`  Next:`);
  console.log(`    1. Start the app:        pnpm dev`);
  console.log(`    2. Home → "Recovery" tab → upload ${filename}`);
  console.log(`    3. Open "Data (#data)" → "Create + insert under #data"\n`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
