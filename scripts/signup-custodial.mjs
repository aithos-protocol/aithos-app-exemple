#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// scripts/signup-custodial.mjs
//
// Demo of the SERVER-ONLY custodial sign-up flow.
//
// The Aithos custodial sign-up endpoint is gated by an API key
// (Bearer aithos_<env>_<32b58>) that must NEVER ship to a browser —
// it grants the ability to create accounts under your app's name and
// thus to send welcome mails on your behalf via SES.
//
// Typical production flow:
//
//   user → POST https://your-app.com/api/auth/signup { email }
//                       ↓ (your backend)
//             sdk.auth.signUpCustodial({ apiKey, email })
//                       ↓ (HTTPS, Bearer apiKey)
//             https://auth.aithos.be/auth/custodial/sign-up
//                       ↓
//             [generate password + seed bundle, KMS-wrap, send mail via SES]
//                       ↓
//             { userId, did, handle, email, mailSent: true }
//
// This script stands in for "your backend": it reads the API key from
// the environment, prompts (or accepts via CLI) an email, and prints
// the result. SES will deliver the welcome mail with the user's
// freshly-generated password.
//
// Usage:
//   AITHOS_API_KEY=aithos_test_xxxx \
//     node scripts/signup-custodial.mjs alice@example.com [display-name]
//
// Pre-reqs (one-shot, run by Mathieu via AUTH_OPS.md):
//   - Your app must have a row in aithos-auth-apps with an API key
//     and (post-2026-05-20) SES production access on the account.
//   - The recipient address can be anything now that SES is out of
//     sandbox. Before 2026-05-20 you had to verify each recipient
//     manually — that constraint is lifted.

import { AithosAuth } from "@aithos/sdk";

async function main() {
  const apiKey = process.env.AITHOS_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "error: missing AITHOS_API_KEY env var (expected an aithos_<env>_<...> bearer)\n",
    );
    process.exit(2);
  }

  const email = process.argv[2];
  const displayName = process.argv[3];
  if (!email) {
    process.stderr.write(
      "usage: AITHOS_API_KEY=… node scripts/signup-custodial.mjs <email> [display-name]\n",
    );
    process.exit(2);
  }

  // The SDK's AithosAuth class works just as well server-side: no
  // browser-only globals are touched until the consumer hits methods
  // that require window (signInWithGoogle / handleCallback). The
  // custodial flow is pure fetch + JSON.
  const auth = new AithosAuth({
    // Override authBaseUrl if you point at a staging deployment.
    // authBaseUrl: "https://auth.staging.aithos.be",
  });

  process.stdout.write(`Provisioning custodial account for ${email}…\n`);

  try {
    const r = await auth.signUpCustodial({
      apiKey,
      email,
      ...(displayName ? { displayName } : {}),
    });

    process.stdout.write("\n=== ok ===\n");
    process.stdout.write(`userId      : ${r.userId}\n`);
    process.stdout.write(`did         : ${r.did}\n`);
    process.stdout.write(`handle      : @${r.handle}\n`);
    process.stdout.write(`email       : ${r.email}\n`);
    process.stdout.write(`mailSent    : ${r.mailSent}\n`);
    if (r.mailMessageId) {
      process.stdout.write(`mailMessageId: ${r.mailMessageId}\n`);
    }
    process.stdout.write(
      "\nThe user should now find their initial password in their inbox.\n",
    );
    process.stdout.write(
      "They can then sign in via the Custodial tab on Home and (optionally) reset their password via the magic link.\n",
    );

    if (!r.mailSent) {
      process.stderr.write(
        "\nWARNING: account row was created but the welcome email could NOT be delivered by SES.\n" +
          "Possible causes: domain verification expired, SES throttling, recipient on the suppression list.\n" +
          "Recipe to resend: see aithos/AUTH_OPS.md §SES.\n",
      );
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`\nsignUpCustodial failed: ${err?.message ?? err}\n`);
    if (err?.code) process.stderr.write(`code: ${err.code}\n`);
    if (err?.data) {
      process.stderr.write(`data: ${JSON.stringify(err.data, null, 2)}\n`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`unexpected: ${err?.stack ?? err}\n`);
  process.exit(1);
});
