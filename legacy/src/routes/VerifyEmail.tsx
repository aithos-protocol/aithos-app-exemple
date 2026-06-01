// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /auth/verify — landing page for the magic-link sent at sign-up.
//
// The link in the email has the shape:
//   https://<app-domain>/auth/verify?email=<email>&token=<raw>
//
// Magic-link behaviour:
//   1. Read email + token from the URL.
//   2. Call sdk.auth.verifyEmail({ email, token }).
//      - On a fresh click → the SDK consumes the token AND hydrates
//        the local session + keystore. The user is now signed in.
//        We navigate to /profile.
//      - On a replay (`status: "already_verified"`) → no session is
//        minted; we show "this email is already verified, sign in"
//        with a CTA back to /.
//   3. On token errors → offer a "Renvoyer le mail" button that
//      calls resendVerificationEmail (capped 1/h server-side).

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AithosSDKError } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

type Phase =
  | { kind: "checking" }
  | { kind: "signed_in" }
  | { kind: "already_verified"; email: string }
  | { kind: "error"; message: string; code: string | null };

export function VerifyEmail() {
  const { auth, bumpVersion } = useSdk();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Read once at mount — the link's params don't change on subsequent
  // renders, and we don't want the user to be able to edit them.
  const initial = useMemo(
    () => ({
      email: params.get("email") ?? "",
      token: params.get("token") ?? "",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [phase, setPhase] = useState<Phase>({ kind: "checking" });

  // Resend state (shown on token errors).
  const [resendBusy, setResendBusy] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!initial.email || !initial.token) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message:
            "Lien invalide : email ou token manquant. Demande un nouveau mail depuis l'accueil.",
          code: null,
        });
        return;
      }
      try {
        const r = await auth.verifyEmail({
          email: initial.email,
          token: initial.token,
        });
        if (cancelled) return;
        if (r.status === "signed_in") {
          bumpVersion();
          setPhase({ kind: "signed_in" });
          // Tiny pause so the user gets visual feedback before the redirect.
          setTimeout(() => {
            if (!cancelled) navigate("/profile");
          }, 700);
        } else {
          setPhase({ kind: "already_verified", email: r.email });
        }
      } catch (e) {
        if (cancelled) return;
        const code = e instanceof AithosSDKError ? e.code : null;
        setPhase({ kind: "error", message: formatError(e), code });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [auth, bumpVersion, initial, navigate]);

  const resend = async () => {
    if (!initial.email) return;
    setResendBusy(true);
    setResendError(null);
    setResendSent(false);
    try {
      await auth.resendVerificationEmail({ email: initial.email });
      setResendSent(true);
    } catch (e) {
      setResendError(formatError(e));
    } finally {
      setResendBusy(false);
    }
  };

  return (
    <section>
      <h2>Confirmation de l'email</h2>

      {phase.kind === "checking" && (
        <p className="lede">
          Validation du lien envoyé à{" "}
          <code>{initial.email || "(email manquant)"}</code>…
        </p>
      )}

      {phase.kind === "signed_in" && (
        <div className="success">
          ✓ Email confirmé et session active. Redirection en cours…
        </div>
      )}

      {phase.kind === "already_verified" && (
        <>
          <p className="lede">
            Cet email (<code>{phase.email}</code>) est déjà confirmé. Le lien
            de confirmation a déjà été utilisé une fois. Connecte-toi avec ton
            mot de passe depuis l'accueil.
          </p>
          <div className="row">
            <Link to="/">
              <button type="button">Aller à la page de connexion</button>
            </Link>
          </div>
        </>
      )}

      {phase.kind === "error" && (
        <>
          <p className="lede">{phase.message}</p>
          {phase.code === "auth_token_invalid_or_expired" && initial.email && (
            <>
              <p>
                Tu peux demander un nouveau lien — un mail repartira à{" "}
                <code>{initial.email}</code>.
              </p>
              <div className="row">
                <button type="button" onClick={resend} disabled={resendBusy}>
                  {resendBusy
                    ? "Envoi…"
                    : "Renvoyer le mail de confirmation"}
                </button>
                <Link to="/">
                  <button type="button" className="secondary">
                    Retour à l'accueil
                  </button>
                </Link>
              </div>
              {resendSent && (
                <div className="success">
                  Si le compte existe et n'est pas encore vérifié, un nouveau
                  mail vient de partir. Vérifie ta boîte (et les spams).
                </div>
              )}
              {resendError && <div className="error">{resendError}</div>}
            </>
          )}
          {phase.code !== "auth_token_invalid_or_expired" && (
            <div className="row">
              <Link to="/">
                <button type="button" className="secondary">
                  Retour à l'accueil
                </button>
              </Link>
            </div>
          )}
        </>
      )}
    </section>
  );
}
