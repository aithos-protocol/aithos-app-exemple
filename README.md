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

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
