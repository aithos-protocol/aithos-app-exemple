// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Home — the single entry point. You become EITHER an owner OR a delegate:
//
//   - Create a #data identity   → mints a fresh self-custody did:aithos with a
//                                 #data sphere, publishes its DID doc, and gives
//                                 you a recovery file. (runOnboarding — pure
//                                 signed envelopes, no JWT, no account backend.)
//   - Load a recovery file      → restores an owner from its seeds. 100% local.
//   - Paste a mandate           → become that mandate's delegate. 100% local.
//
// No JWT, no custodial/Google in this build: every door above is envelope-only
// and works on localhost. Sign-out (in the nav) wipes everything.

import { useState, type ChangeEvent } from "react";

import { AithosSDKError, type AithosAuth } from "@aithos/sdk";
import { runOnboarding } from "@aithos/protocol-client";

import { CustodialTab } from "./Custodial.js";
import { useActor } from "../actor-context.js";

/**
 * Route an uploaded JSON to the right importer by sniffing its version field, so
 * a delegate bundle dropped on the Recovery tab (or a recovery file on the
 * Mandate tab) still works instead of failing with a confusing parser error
 * (e.g. "unsupported aithos_recovery_version: undefined" on a delegate file).
 */
async function importOwnerOrDelegate(auth: AithosAuth, file: File): Promise<void> {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(await file.text()) as Record<string, unknown>;
  } catch {
    throw new Error("That file isn't valid JSON.");
  }
  if (typeof obj["aithos_delegate_version"] === "string") {
    await auth.importMandate({ bundle: file }); // become the mandate's delegate
  } else if (typeof obj["aithos_recovery_version"] === "string") {
    await auth.signInWithRecovery({ file }); // restore the owner
  } else {
    throw new Error(
      "Unrecognized file — expected an aithos-recovery-*.json (owner) or an aithos-delegate-*.json (mandate).",
    );
  }
}

export function Home() {
  const { actor } = useActor();

  return (
    <>
      <section>
        <h2>Aithos SDK — example app</h2>
        <p className="lede">
          One actor at a time: sign in with your own keys (owner) or with a
          single mandate (delegate). Every call is a <strong>signed
          envelope</strong> — no JWT anywhere. Sign-out erases every trace of
          the key or mandate from this browser.
        </p>
      </section>

      {actor ? <SignedInPanel /> : <SignInPanel />}
    </>
  );
}

function SignedInPanel() {
  const { actor } = useActor();
  if (!actor) return null;
  return (
    <section>
      <h2>Signed in</h2>
      {actor.kind === "owner" ? (
        <p className="lede">
          Owner <code>{actor.subjectDid}</code> (<code>@{actor.handle}</code>)
          {actor.hasData ? (
            <> — carries a <code>#data</code> sphere ✓.</>
          ) : (
            <> — <strong>no <code>#data</code> sphere</strong> (legacy account).</>
          )}{" "}
          Use the nav to act on your ethos, data, mandates, etc.
        </p>
      ) : (
        <p className="lede">
          Acting as a <strong>delegate</strong> of <code>{actor.subjectDid}</code>{" "}
          with scopes <code>{actor.scopes.join(", ") || "(none)"}</code>. The nav
          greys out everything this mandate doesn't grant.
        </p>
      )}
      <p className="lede">Sign out from the top-right to switch actor.</p>
    </section>
  );
}

function SignInPanel() {
  type Tab = "create" | "recovery" | "mandate" | "custodial";
  const [tab, setTab] = useState<Tab>("create");
  return (
    <section>
      <h2>Sign in</h2>
      <div className="tabs">
        <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}>
          Create identity (#data)
        </button>
        <button className={tab === "recovery" ? "active" : ""} onClick={() => setTab("recovery")}>
          Recovery file
        </button>
        <button className={tab === "mandate" ? "active" : ""} onClick={() => setTab("mandate")}>
          Mandate
        </button>
        <button className={tab === "custodial" ? "active" : ""} onClick={() => setTab("custodial")}>
          Email &amp; password
        </button>
      </div>
      {tab === "create" && <CreateIdentity />}
      {tab === "recovery" && <RecoveryUpload />}
      {tab === "mandate" && <MandateImport />}
      {tab === "custodial" && <CustodialTab />}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Owner: create a fresh #data identity                                       */
/* -------------------------------------------------------------------------- */

function CreateIdentity() {
  const { auth, bump } = useActor();
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ blob: Blob; filename: string; did: string } | null>(null);

  const validHandle = /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(handle);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runOnboarding({
        handle,
        displayName: displayName.trim() || handle,
        publicTitle: "Hello from the example app",
        publicBody: "Identity minted in-app with a #data sphere.",
        tags: ["demo"],
      });
      setMinted({
        blob: r.recoveryBlob,
        filename: `aithos-recovery-${r.identity.handle}.json`,
        did: r.identity.did,
      });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    if (!minted) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signInWithRecovery({ file: minted.blob });
      bump();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (minted) {
    return (
      <div className="stack">
        <div className="success">
          Published <code>{minted.did}</code> with a <code>#data</code> sphere ✓
        </div>
        <p className="lede">
          <strong>Save the recovery file first</strong> — it holds your private
          keys in plaintext and is the only way back in.
        </p>
        <div className="row">
          <a href={URL.createObjectURL(minted.blob)} download={minted.filename}>
            Download {minted.filename}
          </a>
          <button type="button" onClick={signIn} disabled={busy}>
            {busy ? "Signing in…" : "Sign in with this identity"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (validHandle && !busy) void create();
      }}
    >
      <p className="lede">
        Mint a self-custody <code>did:aithos</code> with a <code>#data</code>{" "}
        sphere — published to <code>api.aithos.be</code> via signed envelopes.
        No email, no password, no JWT.
      </p>
      <label>
        <span>Handle (1–63 chars, alphanumerics + - / _)</span>
        <input type="text" value={handle} onChange={(e) => setHandle(e.target.value)} disabled={busy} />
      </label>
      <label>
        <span>Display name (optional)</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={busy}
        />
      </label>
      {handle && !validHandle && (
        <div className="error">Handle must be 1–63 chars: alphanumerics + - / _.</div>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !validHandle}>
          {busy ? "Publishing…" : "Create + publish"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Owner: load a recovery file                                                */
/* -------------------------------------------------------------------------- */

function RecoveryUpload() {
  const { auth, bump } = useActor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      // Sniff + route: a delegate bundle dropped here still works.
      await importOwnerOrDelegate(auth, f);
      bump();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="lede">
        Upload an <code>aithos-recovery-*.json</code> file to restore an owner.
        100% local — no network, no JWT.
      </p>
      <input type="file" accept="application/json" onChange={onFile} disabled={busy} />
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Delegate: import a mandate                                                  */
/* -------------------------------------------------------------------------- */

function MandateImport() {
  const { auth, bump } = useActor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      // Sniff + route: a recovery file dropped here still works.
      await importOwnerOrDelegate(auth, f);
      bump();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="lede">
        Upload an <code>aithos-delegate-*.json</code> mandate bundle. You become
        that mandate's delegate — the app exposes exactly what its scopes grant.
        100% local.
      </p>
      <input type="file" accept="application/json" onChange={onFile} disabled={busy} />
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shared error formatter (imported by other pages)                          */
/* -------------------------------------------------------------------------- */

export function formatError(e: unknown): string {
  if (e instanceof AithosSDKError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
