// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Home — auth state display + the four entry doors (sign-up,
// sign-in, Google SSO, recovery, mandate import) + sign-out.

import { useState, type ChangeEvent } from "react";

import { AithosSDKError } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";

type Tab = "signin" | "signup" | "google" | "recovery" | "mandate";

export function Home() {
  const { auth, state, bumpVersion } = useSdk();
  const [tab, setTab] = useState<Tab>("signin");

  return (
    <>
      <section>
        <h2>Aithos SDK — example app</h2>
        <p className="lede">
          Demonstrates every entry point of <code>@aithos/sdk</code>: sign-in
          via email/password, Google SSO, recovery file, or imported mandate.
          Then ethos editing, mandate lifecycle, wallet top-up, and compute
          calls.
        </p>
        <SessionState />
      </section>

      {state.canSignAsOwner ? (
        <section>
          <h2>Already signed in</h2>
          <p className="lede">
            <code>auth.canSignAsOwner()</code> is <code>true</code>. Use the
            navigation above to explore the namespaces, or sign out below.
          </p>
          <button
            onClick={async () => {
              await auth.signOut();
              bumpVersion();
            }}
            className="danger"
          >
            Sign out
          </button>
        </section>
      ) : (
        <section>
          <h2>Sign in</h2>
          <p className="lede">
            Pick an entry door. They all converge on the same in-memory auth
            state (<code>OwnerSigners</code> + optional JWT).
          </p>
          <div className="tabs">
            <button
              className={tab === "signin" ? "active" : ""}
              onClick={() => setTab("signin")}
            >
              Sign in
            </button>
            <button
              className={tab === "signup" ? "active" : ""}
              onClick={() => setTab("signup")}
            >
              Sign up
            </button>
            <button
              className={tab === "google" ? "active" : ""}
              onClick={() => setTab("google")}
            >
              Google
            </button>
            <button
              className={tab === "recovery" ? "active" : ""}
              onClick={() => setTab("recovery")}
            >
              Recovery
            </button>
            <button
              className={tab === "mandate" ? "active" : ""}
              onClick={() => setTab("mandate")}
            >
              Mandate
            </button>
          </div>
          {tab === "signin" && <SignInForm />}
          {tab === "signup" && <SignUpForm />}
          {tab === "google" && <GoogleForm />}
          {tab === "recovery" && <RecoveryForm />}
          {tab === "mandate" && <MandateForm />}
        </section>
      )}

      {state.delegates.length > 0 && (
        <section>
          <h2>Delegate sessions held</h2>
          <p className="lede">
            Mandates this auth instance has imported. Each one lets you act on
            another subject's ethos within the granted scopes.
          </p>
          {state.delegates.map((d) => (
            <div key={d.mandateId} className="section-card">
              <h4>{d.mandateId}</h4>
              <div className="body">
                Subject: <code>{d.subjectDid}</code>
                <br />
                Grantee: <code>{d.granteeId}</code>
              </div>
              <div className="meta">
                Scopes: {d.scopes.join(", ") || "(none)"} · Expires:{" "}
                {d.expiresAt ?? "never"}
              </div>
              <RevokeRow mandateId={d.mandateId} />
            </div>
          ))}
        </section>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  State display                                                             */
/* -------------------------------------------------------------------------- */

function SessionState() {
  const { state } = useSdk();
  return (
    <dl className="kvtable">
      <dt>Owner</dt>
      <dd>
        {state.owner ? (
          <>
            @{state.owner.handle} <span style={{ color: "#666" }}>—</span>{" "}
            <code>{state.owner.did}</code>
          </>
        ) : (
          <em>none</em>
        )}
      </dd>
      <dt>JWT session</dt>
      <dd>
        {state.session ? (
          <>
            present, expires at{" "}
            <code>
              {new Date(state.session.exp * 1000).toLocaleString()}
            </code>
          </>
        ) : (
          <em>absent</em>
        )}
      </dd>
      <dt>Can sign?</dt>
      <dd>
        <code>auth.canSignAsOwner()</code> →{" "}
        <strong>{String(state.canSignAsOwner)}</strong>
      </dd>
      <dt>Delegates held</dt>
      <dd>{state.delegates.length}</dd>
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sign-in form (email + password)                                           */
/* -------------------------------------------------------------------------- */

function SignInForm() {
  const { auth, bumpVersion } = useSdk();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.signIn({ email, password });
      bumpVersion();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <label>
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !email || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Sign-up form                                                              */
/* -------------------------------------------------------------------------- */

function SignUpForm() {
  const { auth, bumpVersion } = useSdk();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
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
      const r = await auth.signUp({
        email,
        password,
        handle,
        ...(displayName ? { displayName } : {}),
      });
      setRecovery({ blob: r.recoveryFile, filename: r.recoveryFilename });
      bumpVersion();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <label>
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label>
        <span>Password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <label>
        <span>Handle (1–63 chars, alphanumerics + - / _)</span>
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
      </label>
      <label>
        <span>Display name (optional, defaults to handle)</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <div className="row">
        <button
          type="submit"
          disabled={busy || !email || !password || !handle}
        >
          {busy ? "Creating account…" : "Create account"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {recovery && (
        <div className="success">
          Account created. <strong>Save this recovery file</strong> — it's the
          only way to restore your seeds without your password.{" "}
          <a
            href={URL.createObjectURL(recovery.blob)}
            download={recovery.filename}
          >
            Download {recovery.filename}
          </a>
        </div>
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/*  Google SSO                                                                */
/* -------------------------------------------------------------------------- */

function GoogleForm() {
  const { auth } = useSdk();
  return (
    <div className="stack">
      <p className="lede">
        Redirects to Google's consent screen, then comes back to{" "}
        <code>/auth/callback</code>. The session is hydrated automatically.
      </p>
      <div className="row">
        <button
          onClick={() => {
            try {
              auth.signInWithGoogle();
            } catch (e) {
              // signInWithGoogle throws a "redirecting" sentinel that we
              // ignore — the navigation has already started.
              if (
                !(
                  e instanceof AithosSDKError &&
                  e.code === "auth_redirecting"
                )
              ) {
                throw e;
              }
            }
          }}
        >
          Sign in with Google
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Recovery file                                                             */
/* -------------------------------------------------------------------------- */

function RecoveryForm() {
  const { auth, bumpVersion } = useSdk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    try {
      await auth.signInWithRecovery({ file: f });
      bumpVersion();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="lede">
        Upload an <code>aithos-recovery-*.json</code> file. Hydrates the
        owner signers locally — no JWT is obtained on this path, so
        compute / wallet calls won't work until you also sign in via
        password or Google.
      </p>
      <input type="file" accept="application/json" onChange={onFile} disabled={busy} />
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Mandate import                                                            */
/* -------------------------------------------------------------------------- */

function MandateForm() {
  const { auth, bumpVersion } = useSdk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const d = await auth.importMandate({ bundle: f });
      setInfo(
        `Imported mandate ${d.mandateId} for subject ${d.subjectDid} with scopes [${d.scopes.join(", ")}]`,
      );
      bumpVersion();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="lede">
        Upload an <code>aithos-delegate-*.json</code> file someone has
        granted you. You'll be able to act on their ethos within the
        scopes the mandate carries.
      </p>
      <input type="file" accept="application/json" onChange={onFile} disabled={busy} />
      {info && <div className="success">{info}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Revoke action (per-mandate)                                               */
/* -------------------------------------------------------------------------- */

function RevokeRow({ mandateId }: { readonly mandateId: string }) {
  const { auth, bumpVersion } = useSdk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <button
        className="secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await auth.removeMandate(mandateId);
            bumpVersion();
          } catch (e) {
            setError(formatError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Removing…" : "Remove from this device"}
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

export function formatError(e: unknown): string {
  if (e instanceof AithosSDKError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
