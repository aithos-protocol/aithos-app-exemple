// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Shared demo did:key identity — the same ephemeral identity /data,
// /assets and /delegate-data use to own collections / records / assets.
//
// The SDK does not (yet) expose the signed-in owner's data sphere seed,
// so the demo apps own their data under a browser-local did:key persisted
// in localStorage. This module centralises load/derive so the Mandates
// page can list the SAME collections /data created and mint a data
// mandate whose issuer matches the collection owner (a hard requirement:
// `aithos.data.authorize_app` checks `mandate.issuer === subjectDid`).

import {
  bytesToHex,
  ed25519PublicKeyToMultibase,
  generateKeyPair,
} from "@aithos/protocol-client";

const STORAGE_KEY = "aithos:demo:data-did-key";

export interface DemoIdentity {
  /** `did:key:z…` */
  readonly did: string;
  /** `did:key:z…#self` — owner-path data verificationMethod. */
  readonly verificationMethod: string;
  /** Multibase Ed25519 public key (`z…`). */
  readonly mb: string;
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Load the shared demo did:key (creating + persisting one on first use).
 * Byte-for-byte the same key/format as /data's `loadOrCreateIdentity`. */
export function loadOrCreateDemoIdentity(): DemoIdentity {
  const raw =
    typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { seedHex: string; publicKeyHex: string };
      const seed = hexToBytes(parsed.seedHex);
      const publicKey = hexToBytes(parsed.publicKeyHex);
      const mb = ed25519PublicKeyToMultibase(publicKey);
      const did = `did:key:${mb}`;
      return { did, verificationMethod: `${did}#self`, mb, seed, publicKey };
    } catch {
      // fall through and regenerate
    }
  }
  const kp = generateKeyPair();
  const mb = ed25519PublicKeyToMultibase(kp.publicKey);
  const did = `did:key:${mb}`;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        seedHex: bytesToHex(kp.seed),
        publicKeyHex: bytesToHex(kp.publicKey),
      }),
    );
  }
  return { did, verificationMethod: `${did}#self`, mb, seed: kp.seed, publicKey: kp.publicKey };
}

/**
 * Build a `BrowserIdentity` whose every sphere is the SAME root key — the
 * shape `signMandate` needs. Required for did:key (one key; the PDS
 * resolver aliases #self/#circle/#public to it), so the mandate is signed
 * under #self with this key.
 */
export function demoBrowserIdentity(id: DemoIdentity, handle: string) {
  const kp = { seed: id.seed, publicKey: id.publicKey };
  return {
    handle,
    displayName: handle,
    did: id.did,
    root: kp,
    public: kp,
    circle: kp,
    self: kp,
  };
}
