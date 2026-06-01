// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /auth/invite — landing page for an invitation magic link
// (@aithos/sdk ≥ 0.1.0-alpha.47).
//
// The link looks like `…/auth/invite?email=<email>&token=<token>`. The user
// types a password (sets it for a new account, or authenticates an existing
// one — re-asked by design), and `auth.acceptInvite` consumes the token,
// signs them in, and AUTO-IMPORTS the mandate the inviter attached.
//
// Generic: works for any mandate scope. Here we surface the imported mandate
// and its issuer DID (resolvable to the inviter's public Ethos).

import { useState } from "react";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

interface Done {
  readonly handle: string;
  readonly did: string;
  readonly accountCreated: boolean;
  readonly mandateId: string;
  readonly issuerDid: string;
  readonly scopes: readonly string[];
}

export function AcceptInvite() {
  const { auth, bumpVersion } = useSdk();

  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const email = params.get("email") ?? "";
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const linkValid = email.length > 0 && token.length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await auth.acceptInvite({ email, token, password });
      setDone({
        handle: r.session.handle,
        did: r.session.did,
        accountCreated: r.accountCreated,
        mandateId: r.delegate.mandateId,
        issuerDid: r.delegate.subjectDid,
        scopes: r.delegate.scopes,
      });
      bumpVersion(); // refresh Nav (now signed in + holds a delegate)
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Accept invitation</h2>
      <p className="lede">
        You followed an invitation magic link. Set (or enter) your password to
        sign in — the mandate the inviter granted is imported automatically.
      </p>

      {!linkValid && (
        <div className="error">
          This link is missing its <code>email</code> / <code>token</code>{" "}
          parameters. Open the exact link from your invitation email.
        </div>
      )}

      {linkValid && !done && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <dl className="kvtable">
            <dt>Invited email</dt>
            <dd>
              <code>{email}</code>
            </dd>
          </dl>
          <label>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Set a password (new account) or enter yours (existing)"
              autoComplete="current-password"
            />
          </label>
          <div className="row">
            <button type="submit" disabled={busy || password.length === 0}>
              {busy ? "Accepting…" : "Accept invitation"}
            </button>
          </div>
          {error && <div className="error">{error}</div>}
        </form>
      )}

      {done && (
        <div className="success">
          <p>
            <strong>{done.accountCreated ? "Account created ✓" : "Signed in ✓"}</strong>{" "}
            as <code>@{done.handle}</code>.
          </p>
          <p>
            Mandate imported: <code>{done.mandateId}</code>
            <br />
            scopes: {done.scopes.join(", ") || "(none)"}
            <br />
            granted by (issuer DID): <code>{done.issuerDid}</code>
          </p>
          <p className="lede">
            The issuer DID identifies who invited you — resolve their public
            profile with <code>sdk.ethos.of(issuerDid)</code>. You now hold the
            mandate and can act under it (e.g. append into the issuer&rsquo;s
            collection).
          </p>
        </div>
      )}
    </section>
  );
}
