// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /auth/reset — landing page for the magic link sent by the auth
// Lambda when the user clicked "I forgot my password" on Home.
//
// The link in the email has the shape:
//   https://<app-domain>/auth/reset?email=<email>&token=<raw>
//
// This page:
//   1. Reads email + token from the URL.
//   2. Shows a friendly "Set a new password" form (with confirm).
//   3. POSTs to /auth/custodial/reset/finalize via
//      sdk.auth.applyPasswordReset(...).
//   4. On success, immediately calls signInCustodial(email, newPassword)
//      to hydrate the keystore — the reset endpoint mints a JWT but
//      doesn't return the seed bundle, so a fresh sign-in is what
//      materialises the four sphere seeds locally.
//   5. Bumps the SDK context and routes the user to /profile.
//
// Errors are surfaced inline; the user can retry without leaving the
// page. Token-expired / consumed errors get a "back to home" CTA so the
// user can request a fresh link.

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { AithosSDKError } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

export function ResetPassword() {
  const { auth, bumpVersion } = useSdk();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Pull email + token out of the URL once. We intentionally don't
  // re-read them on every render — the user shouldn't be able to edit
  // them, and re-reading would make the form jitter if the parent
  // re-mounted.
  const initial = useMemo(
    () => ({
      email: params.get("email") ?? "",
      token: params.get("token") ?? "",
    }),
    // params is stable per location; reading once at mount is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Validate the URL params on mount so the user sees a clear error
  // before they bother typing a password.
  useEffect(() => {
    if (!initial.email || !initial.token) {
      setError(
        "Lien invalide : email ou token manquant. Demande un nouveau mail depuis l'accueil.",
      );
    }
  }, [initial]);

  const canSubmit =
    !busy &&
    password.length >= 10 &&
    password === confirm &&
    !!initial.email &&
    !!initial.token;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // 1. Finalise the reset — replaces the password hash server-side
      //    and mints a fresh JWT.
      await auth.applyPasswordReset({
        email: initial.email,
        token: initial.token,
        newPassword: password,
      });

      // 2. Sign in immediately with the new password to materialise the
      //    seed bundle in the local keystore. Without this the SDK has
      //    a JWT but cannot sign envelopes (no owner signers loaded).
      await auth.signInCustodial({
        email: initial.email,
        password,
      });

      setSuccess(true);
      bumpVersion();

      // Small UX pause so the user sees the success line before we
      // redirect them away.
      setTimeout(() => navigate("/profile"), 800);
    } catch (e) {
      setError(formatError(e));
      // Wipe any half-set JWT — if reset succeeded but signIn failed
      // (rare: clock skew, KMS hiccup), keeping the JWT around is
      // misleading because the keystore is empty.
      if (
        e instanceof AithosSDKError &&
        !e.code.startsWith("auth_reset_") &&
        !e.code.startsWith("auth_invalid_input")
      ) {
        await auth.signOut().catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Choisis un nouveau mot de passe</h2>
      <p className="lede">
        Tu as cliqué sur le lien de réinitialisation envoyé à{" "}
        <code>{initial.email || "(email manquant)"}</code>. Définis un nouveau
        mot de passe — il remplacera l'ancien immédiatement et tu seras
        connecté(e) sur la foulée.
      </p>

      <form
        className="stack"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (canSubmit) submit();
        }}
      >
        <label>
          <span>Nouveau mot de passe (≥ 10 caractères)</span>
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy || success}
            minLength={10}
          />
        </label>
        <label>
          <span>Confirme</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            disabled={busy || success}
            minLength={10}
          />
        </label>
        {password && confirm && password !== confirm && (
          <div className="error">Les deux mots de passe ne correspondent pas.</div>
        )}
        <div className="row">
          <button type="submit" disabled={!canSubmit}>
            {busy
              ? "Réinitialisation…"
              : success
                ? "Connecté(e) — redirection…"
                : "Définir le mot de passe"}
          </button>
        </div>
        {error && (
          <div className="error">
            {error}
            <div className="row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="secondary"
                onClick={() => navigate("/")}
              >
                Revenir à l'accueil
              </button>
            </div>
          </div>
        )}
        {success && (
          <div className="success">
            Mot de passe mis à jour, session active. Redirection en cours…
          </div>
        )}
      </form>
    </section>
  );
}
