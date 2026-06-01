# aithos-app-example

Reference app for `@aithos/sdk` — a single-actor, **envelope-only** demo of the
Aithos protocol. Rebuilt from scratch around one idea:

> You are **either an owner or a single delegate**, never both, and the whole UI
> reflects exactly what that one actor can do. The owner is just the actor whose
> every capability is granted; a delegate is the same surface restricted to its
> mandate scopes (everything else greyed).

There is **no JWT anywhere**. Every protocol call — ethos, data, mandates,
compute, wallet, assets — is a signed envelope. The only sign-in doors are the
two that work purely locally:

- **Create a `#data` identity** — mints a fresh self-custody `did:aithos` with a
  `#data` sphere, publishes its DID document, hands you a recovery file
  (`runOnboarding`).
- **Load a recovery file** — restores an owner from its seeds.
- **Paste a mandate** — become that mandate's delegate.

Sign-out wipes every trace (owner keys + delegates + session).

## Architecture

`src/actor-context.tsx` is the keystone. It exposes:

- `actor` — `{ kind: "owner" | "delegate", subjectDid, … }` or `null`.
- `capabilities` — `ethosRead/ethosWrite(zone)`, `dataCan(col, action)`,
  `canIssueMandates`, `canCompute`, `canWallet`, `canAssets`. Owner = all true.
- `getEthosClient()` — `sdk.ethos.me()` (owner) or `sdk.ethos.of(subjectDid)`
  (delegate).
- `dataClient` — owner's full `DataClient` under `#data`, or the delegate's
  `ReadonlyDataClient`.

Pages read `capabilities` to enable/grey controls. The nav greys links the actor
can't use.

## Pages

| Tab | Owner | Delegate |
|---|---|---|
| **Profile** (ethos) | edit every zone | only granted zones; write needs `ethos.write.<zone>`; surfaces "authorized but not sealed" |
| **Data** (`#data`) | full CRUD playground | read-only over granted `data.<col>.read` collections |
| **Mandates** | issue one combined mandate (zones + `#data` collections + `assets.*.read`) | (owner only) |
| **Compute** | text / image / transcribe, direct | runs under the mandate; needs `compute.invoke` |
| **Agent** | `runConversation` over a working-set | needs `compute.invoke` |
| **Wallet** | balance + Stripe top-up | (owner only) |
| **Assets** | did:key demo (see limits) | (owner only) |

## Known limitations (SDK/protocol, not the UI)

- **Delegate data write.** `createDelegateDataClient` is read-only; `insert /
  update / delete` assert owner. So a `write`/`admin` data scope grants **read**
  only. Delegate mutation is `append`-only (insert sealed to owner) — and the
  delegate Data UI doesn't expose append yet, so write/admin/append are greyed
  in the mandate form (v0.2).
- **Assets under a `did:aithos` owner.** The assets client takes one sphere seed;
  a `did:aithos` owner has independent per-zone keys, so the Assets tab still
  uses an ephemeral `did:key` demo. Assets **delegation** is a v0.2 protocol
  target (scopes are declared forward-compat).
- **Custodial / Google sign-in.** Dropped here (they're the JWT doors and need
  the app's real `appDid` origin-allowlisted for `localhost`). The registered
  appDid is `did:aithos:z6Mkm6tHeRiM1546AJEj8G1JP7qWhqJPnPshVJL14DWAC9q7`; the
  Google callback `http://localhost:5173/auth/callback` is set — wiring these in
  is a follow-up.
- **Ethos delegate reads need a seal.** A zone is decryptable by a delegate only
  after the owner publishes it once *with the delegate's wrap*. The Mandates tab
  reminds you to re-publish the granted zone after issuing.

## End-to-end test

`scripts/e2e-full-flow.mjs` runs the whole actor flow against the **live**
`api`/`pds.aithos.be`, all envelope-signed: owner onboarding → recovery sign-in
→ ethos publish → data CRUD under `#data` → combined ethos+data mandate +
`authorizeDelegate` + re-publish-to-seal → delegate ethos+data **decrypted**
reads.

```bash
node scripts/e2e-full-flow.mjs    # 12/12 passed
```

It mints throwaway identities, so it's safe to run repeatedly.

## Run

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm check-types
```

## `legacy/`

The previous version of this app, kept verbatim for reference during the
strangler migration. Out of the TypeScript build (`tsconfig` only includes
`src`). Delete once the rewrite is fully validated.
