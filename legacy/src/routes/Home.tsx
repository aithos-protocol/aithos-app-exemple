// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Home — auth state display + the four entry doors (sign-up,
// sign-in, Google SSO, recovery, mandate import) + sign-out.

import { useState, type ChangeEvent } from "react";

import { runOnboarding } from "@aithos/protocol-client";
import { AithosSDKError } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";

// Tabs that are currently surfaced to developers. The legacy
// zero-knowledge `signin` / `signup` flows (auth.signIn / auth.signUp)
// remain implemented further down this file (SignInForm /
// SignUpForm) so they can be re-enabled by a flag, but are no longer
// reachable from this UI — new integrations should default to the
// custodial path (renamed "Email + mot de passe" here) or Google SSO.
type Tab = "email" | "google" | "recovery" | "mandate";

export function Home() {
  const { auth, state, bumpVersion } = useSdk();
  const [tab, setTab] = useState<Tab>("email");

  return (
    <>
      <section>
        <h2>Aithos SDK — example app</h2>
        <p className="lede">
          Demonstrates every entry point of <code>@aithos/sdk</code>: sign-in
          via email + password (custodial), Google SSO, recovery file, or
          imported mandate. Then ethos editing, mandate lifecycle, wallet
          top-up, compute calls (text + image), and PDS data CRUD.
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
            Pick an entry door. They all converge on the same in-memory
            auth state (<code>OwnerSigners</code> + optional JWT). The
            recommended path for new integrations is{" "}
            <strong>Email + mot de passe</strong> (custodial mode).
          </p>
          <div className="tabs">
            <button
              className={tab === "email" ? "active" : ""}
              onClick={() => setTab("email")}
            >
              Email + mot de passe
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
          {tab === "email" && <CustodialForm />}
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
/*  Sign-in form — LEGACY zero-knowledge flow (auth.signIn).                  */
/*                                                                            */
/*  Exported (not rendered) so the legacy flow stays compiled and easy to     */
/*  re-mount from another page or behind a dev flag. New integrations should  */
/*  use CustodialForm (rendered under the "Email + mot de passe" tab).        */
/* -------------------------------------------------------------------------- */

/** @deprecated Use CustodialSignInForm. Retained for reference / debugging. */
export function SignInForm() {
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
/*  Sign-up form — LEGACY zero-knowledge flow (auth.signUp).                  */
/*                                                                            */
/*  Exported (not rendered) so the legacy flow stays compiled and easy to     */
/*  re-mount from another page or behind a dev flag. New integrations should  */
/*  use CustodialSignUpForm (rendered under the "Email + mot de passe" tab).  */
/* -------------------------------------------------------------------------- */

/** @deprecated Use CustodialSignUpForm. Retained for reference / debugging. */
export function SignUpForm() {
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
/*  Custodial sign-in + magic-link reset                                      */
/* -------------------------------------------------------------------------- */

// Custodial mode is the "Coinbase-style" flow: Aithos custody the user's
// Ed25519 seed bundle in KMS. Sign-up is browser-driven via the public
// client key (`pk_<env>_<…>`) configured on the AithosAuth constructor
// — no app-side backend needed. The account starts as *pending*; the
// user must click the link sent to their inbox before /sign-in works.
//
// Magic-link reset uses the same shape: `<reset_base_url>?email=&token=`.
// Email confirmation follows the same shape:
// `<verify_base_url>?email=&token=`. The two landing pages are
// routes/ResetPassword.tsx and routes/VerifyEmail.tsx.

type CustodialMode = "signin" | "signup";

function CustodialForm() {
  const [mode, setMode] = useState<CustodialMode>("signin");
  return (
    <div className="stack">
      <div className="tabs" style={{ marginBottom: 8 }}>
        <button
          className={mode === "signin" ? "active" : ""}
          onClick={() => setMode("signin")}
        >
          Connexion
        </button>
        <button
          className={mode === "signup" ? "active" : ""}
          onClick={() => setMode("signup")}
        >
          Créer un compte
        </button>
      </div>
      {mode === "signin" ? <CustodialSignInForm /> : <CustodialSignUpForm />}
    </div>
  );
}

function CustodialSignInForm() {
  const { auth, bumpVersion } = useSdk();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setErrorCode(null);
    setResetSent(false);
    setResendSent(false);
    try {
      const r = await auth.signInCustodial({ email, password });
      if (r.passwordMustChange) {
        // eslint-disable-next-line no-console
        console.info(
          "[aithos] passwordMustChange=true — nudge the user to reset.",
        );
      }
      bumpVersion();
    } catch (e) {
      setError(formatError(e));
      if (e instanceof AithosSDKError) setErrorCode(e.code);
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async () => {
    if (!email) {
      setError("Saisis ton email pour recevoir un lien de réinitialisation.");
      return;
    }
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      await auth.requestPasswordReset({ email });
      setResetSent(true);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const resendVerification = async () => {
    if (!email) return;
    setBusy(true);
    setError(null);
    try {
      await auth.resendVerificationEmail({ email });
      setResendSent(true);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const emailNotVerified = errorCode === "auth_email_not_verified";

  return (
    <form
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <p className="lede">
        Auth <strong>email + mot de passe</strong> — mode dit{" "}
        <em>custodial</em> côté SDK (Aithos garde tes clés en KMS, comme un
        SaaS classique). La création de compte se fait dans l'onglet "Créer
        un compte" et exige une confirmation par mail avant la première
        connexion.
      </p>
      <label>
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        <span>Mot de passe</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !email || !password}>
          {busy ? "Connexion…" : "Sign in (custodial)"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={requestReset}
          disabled={busy || !email}
          title="Envoie un magic link de réinitialisation à l'email saisi."
        >
          Mot de passe oublié ?
        </button>
      </div>
      {error && (
        <div className="error">
          {error}
          {emailNotVerified && (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="secondary"
                onClick={resendVerification}
                disabled={busy || !email}
              >
                Renvoyer le mail de confirmation
              </button>
            </div>
          )}
        </div>
      )}
      {resendSent && (
        <div className="success">
          Si <code>{email}</code> existe et n'est pas encore vérifié, un nouveau
          mail vient de partir. Vérifie ta boîte (et les spams). Tu peux
          relancer une fois par heure.
        </div>
      )}
      {resetSent && (
        <div className="success">
          Si <code>{email}</code> est associé à un compte custodial, un mail
          vient de partir avec un lien de réinitialisation. Vérifie ta boîte
          (et les spams). Le lien expire dans 1 heure.
        </div>
      )}
    </form>
  );
}

function CustodialSignUpForm() {
  const { auth } = useSdk();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ email: string; mailSent: boolean } | null>(
    null,
  );
  const [resendSent, setResendSent] = useState(false);

  const passwordsMatch = password.length > 0 && password === confirm;
  const passwordLongEnough = password.length >= 10;
  const canSubmit =
    !busy && !!email && passwordsMatch && passwordLongEnough && !pending;

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResendSent(false);
    try {
      const r = await auth.signUpCustodial({
        email,
        password,
        ...(displayName ? { displayName } : {}),
      });
      setPending({ email: r.email, mailSent: r.mailSent });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await auth.resendVerificationEmail({ email: pending.email });
      setResendSent(true);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <div className="stack">
        <p className="lede">
          Compte créé pour <code>{pending.email}</code>. Clique sur le lien
          de confirmation envoyé à cette adresse (lien valable 1h) — tu seras
          automatiquement connecté(e) en arrivant sur la page.
        </p>
        {pending.mailSent ? (
          <div className="success">
            Mail envoyé. Vérifie ta boîte (et les spams).
          </div>
        ) : (
          <div className="error">
            ⚠️ Le compte a été créé mais le mail n'a pas pu partir. Clique sur
            "Renvoyer" pour réessayer.
          </div>
        )}
        <div className="row" style={{ marginTop: 8 }}>
          <button
            type="button"
            className="secondary"
            onClick={resend}
            disabled={busy}
          >
            Renvoyer le mail de confirmation
          </button>
        </div>
        {resendSent && (
          <div className="success">
            Si le compte existe et n'est pas encore vérifié, un nouveau mail
            vient de partir. Tu peux relancer une fois par heure.
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <p className="lede">
        Création de compte <strong>email + mot de passe</strong> (mode{" "}
        <em>custodial</em> côté SDK — Aithos garde tes clés en KMS). Avant
        la première connexion, tu recevras un mail pour confirmer que cette
        adresse est bien la tienne.
      </p>
      <label>
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        <span>Mot de passe (≥ 10 caractères)</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={10}
          disabled={busy}
        />
      </label>
      <label>
        <span>Confirme le mot de passe</span>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          minLength={10}
          disabled={busy}
        />
      </label>
      <label>
        <span>Nom affiché (optionnel)</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={busy}
        />
      </label>
      {password && confirm && !passwordsMatch && (
        <div className="error">Les deux mots de passe ne correspondent pas.</div>
      )}
      <div className="row">
        <button type="submit" disabled={!canSubmit}>
          {busy ? "Création…" : "Créer le compte"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
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

type RecoveryMode = "upload" | "create";

function RecoveryForm() {
  const [mode, setMode] = useState<RecoveryMode>("upload");
  return (
    <div className="stack">
      <div className="tabs" style={{ marginBottom: 8 }}>
        <button
          className={mode === "upload" ? "active" : ""}
          onClick={() => setMode("upload")}
        >
          Charger un fichier
        </button>
        <button
          className={mode === "create" ? "active" : ""}
          onClick={() => setMode("create")}
        >
          Créer une identité (#data)
        </button>
      </div>
      {mode === "upload" ? <RecoveryUpload /> : <RecoveryCreate />}
    </div>
  );
}

function RecoveryUpload() {
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
/*  Create a fresh self-custody identity (with the #data sphere) in-browser.  */
/*                                                                            */
/*  This is the local-friendly counterpart to app.aithos.be's account        */
/*  creation. It calls protocol-client's `runOnboarding`, which:             */
/*    1. generates a 5-sphere identity client-side (incl. #data),            */
/*    2. publishes its DID document to api.aithos.be (signed #root envelope), */
/*    3. publishes a first public Ethos edition,                             */
/*    4. returns a plaintext recovery blob (seeds_hex incl. data).           */
/*                                                                            */
/*  Crucially this NEVER touches auth.aithos.be, so the localhost CORS gate   */
/*  that blocks `signUp` does not apply — api.aithos.be primitives are        */
/*  CORS-open and gated by the signed envelope, not the Origin header.        */
/*                                                                            */
/*  We force the user to download the recovery file BEFORE signing in: it's   */
/*  the only copy of the private keys, and signing in flips the page to the   */
/*  "already signed in" view, unmounting this form.                          */
/* -------------------------------------------------------------------------- */

function RecoveryCreate() {
  const { auth, bumpVersion } = useSdk();
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{
    blob: Blob;
    filename: string;
    did: string;
    hasData: boolean;
  } | null>(null);

  const validHandle = /^[a-z0-9][a-z0-9_-]{0,62}$/i.test(handle);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await runOnboarding({
        handle,
        displayName: displayName.trim() || handle,
        publicTitle: "Data sphere demo",
        publicBody:
          "Identity minted in-app to demonstrate the #data sphere on a real did:aithos account.",
        tags: ["demo", "data-sphere"],
      });
      setMinted({
        blob: r.recoveryBlob,
        filename: `aithos-recovery-${r.identity.handle}.json`,
        did: r.identity.did,
        hasData: !!r.identity.data,
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
      // Re-read the same blob we just downloaded — signInWithRecovery
      // accepts a Blob directly, so no round-trip through disk is needed.
      await auth.signInWithRecovery({ file: minted.blob });
      bumpVersion();
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
          Identity published on <code>api.aithos.be</code>:{" "}
          <code>{minted.did}</code>
          {minted.hasData ? (
            <>
              {" "}
              — carries a <code>#data</code> sphere ✓
            </>
          ) : (
            <>
              {" "}
              — <strong>WITHOUT</strong> a <code>#data</code> sphere (your
              installed <code>@aithos/protocol-client</code> predates
              alpha.19). Run <code>pnpm install</code> and retry.
            </>
          )}
        </div>
        <p className="lede">
          <strong>Save this recovery file first</strong> — it holds your
          private keys in plaintext and is the only way back into this
          identity.
        </p>
        <div className="row">
          <a href={URL.createObjectURL(minted.blob)} download={minted.filename}>
            Download {minted.filename}
          </a>
          <button type="button" onClick={signIn} disabled={busy}>
            {busy ? "Signing in…" : "Se connecter avec cette identité"}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (validHandle && !busy) void create();
      }}
    >
      <p className="lede">
        Mint a brand-new <strong>self-custody <code>did:aithos</code></strong>{" "}
        with the dedicated <code>#data</code> sphere, entirely in this
        browser. Publishes the DID document to <code>api.aithos.be</code> so
        the PDS can resolve it — then download the recovery file. No email,
        no password, no JWT (so compute / wallet stay unavailable on this
        account, but ethos + <code>#data</code> PDS ops work).
      </p>
      <label>
        <span>Handle (1–63 chars, alphanumerics + - / _)</span>
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          disabled={busy}
        />
      </label>
      <label>
        <span>Display name (optional, defaults to handle)</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={busy}
        />
      </label>
      {handle && !validHandle && (
        <div className="error">
          Handle must be 1–63 chars: alphanumerics plus <code>-</code> /{" "}
          <code>_</code>, starting with a letter or digit.
        </div>
      )}
      <div className="row">
        <button type="submit" disabled={busy || !validHandle}>
          {busy ? "Publishing…" : "Créer + publier l'identité"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
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
