# aithos-app-example

Public example app for [`@aithos/sdk`](https://www.npmjs.com/package/@aithos/sdk).
Demonstrates every public verb of the SDK against the production
Aithos infrastructure — sign-in (4 entry doors), ethos editing,
mandate lifecycle, wallet top-up, Claude inference.

## Run

```bash
npm install
npm run dev
# → http://localhost:5173
```

You'll need at least Node 20 and a recent npm.

## What it shows

- **`AithosAuth`** — sign-up, sign-in, sign-in-with-Google, recovery
  file upload, mandate bundle import. Sign-out. `auth.resume()` at
  boot rehydrates from `localStorageStore` (JWT) +
  `indexedDbKeyStore` (signing material).
- **`sdk.ethos`** (Profile route) — load sections per zone (public /
  circle / self), stage add / update / delete, `me.publish()` commits
  one new edition.
- **`sdk.mandates`** (Mandates route) — create a mandate (download
  the bundle to hand to the grantee), list issued mandates, revoke.
- **`sdk.wallet`** (Wallet route) — get balance, redirect to Stripe
  Checkout to top up.
- **`sdk.compute`** (Compute route) — invoke Claude through the
  Aithos compute proxy, gated by a mandate id you mint on the
  Mandates route.

## Layout

```
src/
  main.tsx              entry — BrowserRouter + SdkProvider + App
  App.tsx               route table
  sdk-context.tsx       singleton AithosAuth + AithosSDK exposed via React context
  styles.css            minimal CSS (no framework)
  components/Nav.tsx    top bar with route links + state pill
  routes/
    Home.tsx            auth state + 4 entry doors + sign-out
    AuthCallback.tsx    /auth/callback — handleCallback() then redirect
    Profile.tsx         ethos editor (lazy + commit pattern)
    Mandates.tsx        create / list / revoke
    Wallet.tsx          balance + Stripe top-up
    Compute.tsx         invoke Claude
```

## Configuration

The SDK is constructed in `src/sdk-context.tsx`. Two things you may
want to change:

1. **`APP_DID`** — placeholder
   `did:aithos:app:example-placeholder`. Replace with the DID issued
   to your app (mandates and audit logs identify the calling app by
   this DID).
2. **Endpoint overrides** — pass `endpoints: { compute, wallet }` to
   `new AithosSDK({ ... })` if you target staging or a self-hosted
   deployment instead of production.

## Notes

- Sessions are persisted via the SDK's bundled `localStorageStore`
  (JWT) and `indexedDbKeyStore` (signing material). Clearing the
  browser's site data signs you out.
- The Google SSO flow assumes `auth.aithos.be` is reachable and that
  the example app's origin is in the auth backend's allowed
  redirect-URI list. If not, register the origin (e.g.
  `http://localhost:5173`) on the auth backend, or run the example
  through a tunnel/HTTPS host.
- Wallet & compute calls require a JWT-backed session — the
  recovery / mandate flows give local signing capability without a
  JWT, so those tabs will surface "JWT-less session" hints.

## Known limits in local dev

Two of the five entry doors talk to Aithos-hosted infra that today
hard-codes `app.aithos.be` as the only allowed origin:

- **Sign-up / sign-in (email + password)** posts to
  `auth.aithos.be`. From `http://localhost:5173` the browser will
  fail the CORS preflight — the auth Lambda has to allowlist the
  example app's origin.
- **Sign in with Google** comes back to a redirect URL the auth
  backend chooses, currently hard-coded to `app.aithos.be`.
  Localhost won't see the `aithos_code` and won't sign in.

The other three paths work locally without any backend change:

- `signInWithRecovery({ file })` — purely client-side, hydrates the
  owner signers from a recovery JSON file.
- `importMandate({ bundle })` — purely client-side, registers a
  delegate session from an `.aithos-delegate.json` bundle.
- Anything past auth (ethos editing, mandates, wallet balance, compute)
  goes through envelope-signed POSTs that don't depend on origin
  for authentication. The relevant Lambdas may still need CORS
  config though — see TODOs.

## TODOs (post-alpha hardening)

These are not blockers for the example to run; they're the roadmap
to make `@aithos/sdk` consumable from arbitrary consumer-app domains
without bespoke backend tweaks per consumer.

- **SDK** — add a `returnTo` parameter to
  `auth.signInWithGoogle({ returnTo })`. The consumer app declares
  its callback URL explicitly; the auth backend validates it
  against the allowlist registered for the consumer's `appDid`,
  and forwards there with `aithos_code`. Today the redirect target
  is implicit and bound to the auth backend's static config.
- **Auth backend** — per-`appDid` origin registry. When a developer
  registers their app and obtains an `appDid`, they declare the
  origins they'll be calling from (production, staging, dev). The
  Lambda reads these on every CORS preflight and on every Google
  callback, instead of carrying a static allowlist in code.
- **Compute / wallet backends** — same per-`appDid` CORS posture
  for the `compute.aithos.be` and `wallet.aithos.be` endpoints.
- **`@aithos/protocol-client`** — expose a public configuration
  API for the `api` endpoint, so the SDK's `mandates.revoke()`
  (and any future write call) can target a non-production deployment
  cleanly. Tracked as a TODO inside `src/mandates.ts` of the SDK.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
