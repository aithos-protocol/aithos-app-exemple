// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /auth/callback — handles the redirect from Google's consent screen.
//
// Three states the page can be in:
//
//   1. "loading"       — initial mount, calling auth.handleCallback().
//   2. "needs-bootstrap" — the user authenticated successfully (JWT
//      received) but their auth account has no Aithos identity yet
//      (blob_version === 0). We render a small form to collect a
//      handle + display name and call auth.completeSsoFirstLogin to
//      generate the seeds, publish the identity, and upload the
//      encrypted blob. After this completes, navigate home.
//   3. "error"         — handleCallback threw, surface the message.
//
// On the happy path (returning user with an existing blob), the page
// flashes very briefly: handleCallback decrypts the blob, hydrates
// owner signers, and we navigate("/") immediately.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

type Phase = "loading" | "needs-bootstrap" | "error";

export function AuthCallback() {
  const { auth, bumpVersion } = useSdk();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  // Pre-fill the suggested handle from the session payload (the auth
  // backend auto-generates one from the user's email local-part). The
  // user can edit it; the SDK re-validates on submit.
  const [suggestedHandle, setSuggestedHandle] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await auth.handleCallback();
        if (cancelled) return;
        bumpVersion();

        if (!session) {
          // No code in the URL — direct hit on /auth/callback.
          navigate("/", { replace: true });
          return;
        }

        // First-time SSO sign-in: the auth backend created a user
        // record (and minted a JWT) but no Aithos identity exists yet.
        // The session carries an enc_key but the blob is empty.
        if (session.blob_version === 0 && session.enc_key_b64) {
          setSuggestedHandle(session.handle);
          setPhase("needs-bootstrap");
          return;
        }

        // Returning user with an existing blob — handleCallback already
        // hydrated owner signers. Just go home.
        navigate("/", { replace: true });
      } catch (e) {
        if (!cancelled) {
          setError(formatError(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, bumpVersion, navigate]);

  if (phase === "loading") {
    return (
      <section>
        <h2>Finishing sign-in…</h2>
        <p className="lede">Exchanging the code from Google for a session.</p>
      </section>
    );
  }

  if (phase === "error") {
    return (
      <section>
        <h2>Sign-in failed</h2>
        <div className="error">
          {error} <a href="/">Back home</a>
        </div>
      </section>
    );
  }

  // phase === "needs-bootstrap"
  return (
    <BootstrapForm
      suggestedHandle={suggestedHandle}
      onDone={() => {
        bumpVersion();
        navigate("/", { replace: true });
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap form                                                            */
/* -------------------------------------------------------------------------- */

function BootstrapForm({
  suggestedHandle,
  onDone,
}: {
  readonly suggestedHandle: string;
  readonly onDone: () => void;
}) {
  const { auth } = useSdk();
  const [handle, setHandle] = useState(suggestedHandle);
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{
    blob: Blob;
    filename: string;
  } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await auth.completeSsoFirstLogin({
        handle,
        ...(displayName ? { displayName } : {}),
      });
      setRecovery({
        blob: r.recoveryFile,
        filename: r.recoveryFilename,
      });
      // Don't auto-redirect — give the user a chance to download the
      // recovery file before we navigate. The "Continue to app" button
      // calls onDone() once they've grabbed it.
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Welcome — finalize your account</h2>
      <p className="lede">
        Google verified your identity. Now we need to generate your
        Aithos identity (4 Ed25519 keypairs in your browser, never sent
        to the server) and publish it.
      </p>

      {!recovery ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            <span>Handle (1–63 chars, alphanumerics + - / _)</span>
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              maxLength={63}
              required
            />
          </label>
          <label>
            <span>Display name (optional, defaults to handle)</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={200}
            />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || !handle}>
              {busy ? "Creating your ethos…" : "Create my ethos"}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </form>
      ) : (
        <div className="success">
          <p>
            <strong>Your ethos is online.</strong> Save the recovery file
            below — it's the only way to restore your seeds if you lose
            access to your Google account.
          </p>
          <p>
            <a
              href={URL.createObjectURL(recovery.blob)}
              download={recovery.filename}
            >
              Download {recovery.filename}
            </a>
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={onDone}>Continue to app</button>
          </div>
        </div>
      )}
    </section>
  );
}
