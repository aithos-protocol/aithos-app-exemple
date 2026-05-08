// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /auth/callback — handles the redirect from Google's consent screen.
// Reads `?aithos_code=…` out of the URL via auth.handleCallback(),
// then redirects home (or wherever app_state pointed). On error,
// surfaces it inline.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

export function AuthCallback() {
  const { auth, bumpVersion } = useSdk();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await auth.handleCallback();
        if (cancelled) return;
        bumpVersion();
        if (session) {
          // Successful sign-in → home.
          navigate("/", { replace: true });
        } else {
          // No code in the URL — someone hit /auth/callback directly.
          navigate("/", { replace: true });
        }
      } catch (e) {
        if (!cancelled) setError(formatError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, bumpVersion, navigate]);

  return (
    <section>
      <h2>Finishing sign-in…</h2>
      {error ? (
        <div className="error">
          {error} <a href="/">Back home</a>
        </div>
      ) : (
        <p className="lede">Exchanging the code from Google for a session.</p>
      )}
    </section>
  );
}
