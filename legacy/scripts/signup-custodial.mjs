#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// REMOVED in 2026-05 (Lot H — email verification).
//
// The custodial signup flow no longer requires a server-side caller for
// the example app. Browser-driven sign-up now uses the app's PUBLIC
// client key (configured via VITE_AITHOS_PUBLIC_KEY in .env.local) and
// the formulaire "Créer un compte" of routes/Home.tsx. The verification
// link sent by SES lands on /auth/verify (routes/VerifyEmail.tsx).
//
// If you still need server-side signup for a real production app that
// integrates with a backend (mass import, etc.), keep using the secret
// Bearer API key path via the SDK directly:
//
//   import { AithosAuth } from "@aithos/sdk";
//   const auth = new AithosAuth();
//   await auth.signUpCustodial({
//     apiKey: process.env.AITHOS_API_KEY,
//     email,
//     password,
//   });
//
// The example app no longer ships a CLI demo of that path — see the
// SDK README for the canonical example.

process.stderr.write(
  "scripts/signup-custodial.mjs has been removed. Use the in-app " +
    "Créer un compte form (Custodial tab, requires VITE_AITHOS_PUBLIC_KEY).\n",
);
process.exit(2);
