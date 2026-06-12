// Custodial auth flows — email + password against auth.dev.aithos.be.
//
// Three pieces:
//   - <CustodialTab/>     : Home sign-in tab — sign-up (sends the SES
//                           verification magic-link), sign-in, forgot-password.
//   - <AuthVerifyPage/>   : /auth/verify?token=…&email=… — the magic-link
//                           landing. verifyEmail() signs the user in directly
//                           (magic-link mode) and hydrates the owner keys.
//   - <ResetPage/>        : /reset[?token=…&email=…] — request a reset link,
//                           or (with token) set the new password then sign in.
//
// The callback URLs the auth backend builds for THIS app come from its row
// in aithos-auth-apps (verify_base_url / reset_base_url) selected by the
// VITE_AITHOS_PUBLIC_KEY app key — register the app + URLs on
// builders.dev.aithos.be (or seed apps.dev.json).
//
// SES sandbox (dev): emails only reach VERIFIED inboxes — verify your test
// address once (AWS sends a confirmation email on the first terraform apply).

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useActor } from "../actor-context.js";
import { formatError } from "./Home.js";

// App credential for the custodial endpoints. Two options:
//   - VITE_AITHOS_PUBLIC_KEY (pk_…)     — browser-safe, set on the AithosAuth
//     constructor in actor-context (preferred).
//   - VITE_AITHOS_API_KEY (aithos_…)    — the app's SECRET key. Server-only
//     in principle; tolerated here as a DEV/TEST convenience (.env.local,
//     never committed). Rotate it from the builders console if it leaks.
const APP_API_KEY: string | undefined =
  typeof import.meta.env.VITE_AITHOS_API_KEY === "string" && import.meta.env.VITE_AITHOS_API_KEY
    ? import.meta.env.VITE_AITHOS_API_KEY
    : undefined;

/* -------------------------------------------------------------------------- */
/*  Home tab — sign-up / sign-in / forgot                                      */
/* -------------------------------------------------------------------------- */

export function CustodialTab() {
  type Mode = "signin" | "signup" | "forgot";
  const [mode, setMode] = useState<Mode>("signin");
  return (
    <div>
      <div className="tabs">
        <button className={mode === "signin" ? "active" : ""} onClick={() => setMode("signin")}>
          Sign in
        </button>
        <button className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>
          Create account
        </button>
        <button className={mode === "forgot" ? "active" : ""} onClick={() => setMode("forgot")}>
          Forgot password
        </button>
      </div>
      {mode === "signin" && <CustodialSignIn />}
      {mode === "signup" && <CustodialSignUp />}
      {mode === "forgot" && <ForgotPassword />}
    </div>
  );
}

function CustodialSignUp() {
  const { auth } = useActor();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ email: string; mailSent: boolean } | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await auth.signUpCustodial({
        email: email.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(APP_API_KEY ? { apiKey: APP_API_KEY } : {}),
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
      await auth.resendVerificationEmail({
        email: pending.email,
        ...(APP_API_KEY ? { apiKey: APP_API_KEY } : {}),
      });
      setPending({ ...pending, mailSent: true });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <div>
        <p className="lede">
          Account created for <code>{pending.email}</code> — status{" "}
          <code>pending_verification</code>.{" "}
          {pending.mailSent ? (
            <>
              Check your inbox: the message contains a <strong>magic link</strong> back to{" "}
              <code>/auth/verify</code> which signs you in directly.
            </>
          ) : (
            <>
              <strong>The verification email could not be sent</strong> (SES sandbox: only
              verified inboxes receive mail on dev).
            </>
          )}
        </p>
        <button onClick={resend} disabled={busy}>
          Resend verification email
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      <p className="lede">
        Email + password account. The verification email comes from{" "}
        <code>no-reply@dev.aithos.be</code> with a magic link landing on this app's{" "}
        <code>/auth/verify</code>.
      </p>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <label>
        Display name (optional)
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </label>
      <button onClick={submit} disabled={busy || !email.includes("@") || password.length < 10}>
        {busy ? "Creating…" : "Create account"}
      </button>
      {password.length > 0 && password.length < 10 && (
        <p className="error">Password must be at least 10 characters (letters + digits/symbols).</p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function CustodialSignIn() {
  const { auth, bump } = useActor();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await auth.signInCustodial({ email: email.trim(), password });
      bump();
      if (r.passwordMustChange) {
        setError("Password must be changed — use the Forgot password tab to set a new one.");
      }
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button onClick={submit} disabled={busy || !email.includes("@") || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function ForgotPassword() {
  const { auth } = useActor();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.requestPasswordReset({ email: email.trim() });
      setSent(true);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <p className="lede">
        If an account exists for <code>{email}</code>, a reset link is on its way — it lands on{" "}
        <code>/reset</code> with a one-shot token.
      </p>
    );
  }
  return (
    <div>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button onClick={submit} disabled={busy || !email.includes("@")}>
        {busy ? "Sending…" : "Send reset link"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  /auth/verify — magic-link landing                                          */
/* -------------------------------------------------------------------------- */

export function AuthVerifyPage() {
  const { auth, bump } = useActor();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<"working" | "done" | "already" | "error">("working");
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false); // StrictMode double-mount guard (token is one-shot)

  const token = params.get("token") ?? "";
  const email = params.get("email") ?? "";

  useEffect(() => {
    if (ran.current || !token || !email) return;
    ran.current = true;
    auth
      .verifyEmail({ email, token })
      .then((r) => {
        if (r.status === "signed_in") {
          bump();
          setState("done");
          setTimeout(() => navigate("/"), 1200);
        } else {
          setState("already");
        }
      })
      .catch((e) => {
        setError(formatError(e));
        setState("error");
      });
  }, [auth, bump, email, navigate, token]);

  if (!token || !email) {
    return (
      <section>
        <h2>Email verification</h2>
        <p className="error">
          Missing <code>token</code> / <code>email</code> query parameters — open this page from
          the magic link in the verification email.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2>Email verification</h2>
      {state === "working" && <p className="lede">Verifying <code>{email}</code>…</p>}
      {state === "done" && (
        <p className="lede">
          ✓ Verified and <strong>signed in</strong> — redirecting to the app…
        </p>
      )}
      {state === "already" && (
        <p className="lede">
          This address was already verified. <Link to="/">Sign in with your password</Link>.
        </p>
      )}
      {state === "error" && <p className="error">{error}</p>}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  /reset — password reset landing (and request fallback)                     */
/* -------------------------------------------------------------------------- */

export function ResetPage() {
  const { auth, bump } = useActor();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") ?? "";
  const email = params.get("email") ?? "";

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token || !email) {
    return (
      <section>
        <h2>Password reset</h2>
        <p className="lede">
          No reset token in the URL — request one from the{" "}
          <Link to="/">Forgot password tab</Link>; the email link lands back here.
        </p>
      </section>
    );
  }

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await auth.applyPasswordReset({ email, token, newPassword: password });
      // applyPasswordReset does NOT hydrate the local keys — complete with a
      // regular sign-in using the fresh password.
      await auth.signInCustodial({ email, password });
      bump();
      navigate("/");
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Password reset</h2>
      <p className="lede">
        Set a new password for <code>{email}</code>.
      </p>
      <label>
        New password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button onClick={submit} disabled={busy || password.length < 10}>
        {busy ? "Applying…" : "Set password & sign in"}
      </button>
      {password.length > 0 && password.length < 10 && (
        <p className="error">Password must be at least 10 characters (letters + digits/symbols).</p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
