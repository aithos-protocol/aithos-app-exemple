// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /owner-data — owns data collections under the REAL signed-in did:aithos
// account, signing with the dedicated #data sphere (spec/data/02-key-hierarchy
// §2.2) instead of a throwaway did:key.
//
// This is the "exemplary" pattern the legacy /data page deliberately sidesteps
// (it owns collections under a local did:key). It works only for an account
// that carries a #data seed — today that means a SELF-CUSTODY account (whose
// vault holds the #data seed). A custodial account has no #data sphere yet (the
// seeds come from aithos-auth as a 4-sphere bundle) — the UI surfaces that
// case explicitly and points at the recovery-create flow.
//
// Flow: read the owner's #data seed from the keystore → build a DataClient
// signing under `${did}#data` → hand it to the shared <DataPlayground>, the
// same Schema/Collections/Records UI the legacy /data page uses. The PDS
// resolves the real published DID document (with #data) to verify each
// envelope — no #root, no did:key.

import { useCallback, useEffect, useMemo, useState } from "react";

import { createDataClient, type DataClient } from "@aithos/sdk";

import { DataPlayground, vendorLites } from "../components/DataPlayground.js";
import { useSdk } from "../sdk-context.js";

const PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_PDS_URL) ||
  "https://pds.aithos.be";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface OwnerInfo {
  readonly did: string;
  readonly handle: string;
  readonly dataSeedHex: string | undefined;
}

export function OwnerData() {
  const { keyStore } = useSdk();
  const [owner, setOwner] = useState<OwnerInfo | null | undefined>(undefined);

  const refreshOwner = useCallback(async () => {
    const stored = await keyStore.loadOwner().catch(() => null);
    if (!stored) {
      setOwner(null);
      return;
    }
    setOwner({
      did: stored.did,
      handle: stored.handle,
      dataSeedHex: stored.seedsHex.data,
    });
  }, [keyStore]);

  useEffect(() => {
    void refreshOwner();
  }, [refreshOwner]);

  // Build the owner data client once the #data seed is known. It signs every
  // PDS envelope with the dedicated #data sphere (verificationMethod
  // `${did}#data`); the PDS resolves the published DID document to verify.
  // null whenever there's no #data seed — hooks stay unconditional.
  const client = useMemo<DataClient | null>(() => {
    if (!owner?.dataSeedHex) return null;
    return createDataClient({
      pdsUrl: PDS_URL,
      did: owner.did,
      sphereSeed: hexToBytes(owner.dataSeedHex),
      verificationMethod: `${owner.did}#data`,
      schemas: vendorLites(),
    });
  }, [owner]);

  return (
    <>
      <section>
        <h2>Data under your real account — the #data sphere</h2>
        <p className="lede">
          The legacy data page owns collections under a throwaway{" "}
          <code>did:key</code>. This one owns them under your{" "}
          <strong>
            signed-in <code>did:aithos</code> account
          </strong>
          , signing each PDS envelope with the dedicated <code>#data</code>{" "}
          sphere — so your root key stays cold and the PDS resolves your real
          published DID document to verify.
        </p>

        {owner === undefined && <p>Loading owner…</p>}

        {owner === null && (
          <p className="warn">
            No owner signed in. Create a self-custody account on the{" "}
            <a href="/">home page</a> — open the <strong>Recovery</strong> tab →{" "}
            <strong>Créer une identité (#data)</strong>, then come back here.
          </p>
        )}

        {owner && !owner.dataSeedHex && (
          <p className="warn">
            Signed in as <code>{owner.handle}</code>, but this account has{" "}
            <strong>
              no <code>#data</code> sphere
            </strong>{" "}
            — it predates the data sphere, or it's a custodial account (whose
            seeds come from <code>aithos-auth</code> as a 4-sphere bundle; the
            5th <code>#data</code> seed is a separate follow-up). The{" "}
            <code>#data</code> seed is minted client-side, so{" "}
            <strong>only a self-custody account has one</strong> — creating a{" "}
            <em>custodial</em> account on the current SDK will{" "}
            <strong>not</strong> add it.
            <br />
            <br />
            To get one now: <a href="/">go Home</a>, <strong>Sign out</strong>,
            then open the <strong>Recovery</strong> tab →{" "}
            <strong>Créer une identité (#data)</strong>. Create + publish,
            download the recovery file, click{" "}
            <em>Se connecter avec cette identité</em>, and come back here.
          </p>
        )}

        {owner?.dataSeedHex && (
          <p>
            Owner <code>{owner.did.slice(0, 32)}…</code> — has a{" "}
            <code>#data</code> sphere ✓ · every collection and record below is
            signed under <code>{owner.did.slice(0, 16)}…#data</code>.
          </p>
        )}
      </section>

      {client && <DataPlayground client={client} />}
    </>
  );
}
