# TODO — Owner data ops on a real `did:aithos` account (sphere `#root`)

> Found while wiring Délie (`praticien.delie.fr`) on the signed-in custodial
> account. The example currently sidesteps this by owning all data under
> local `did:key` identities — which hides a real requirement.

## The finding

For a **`did:aithos`** account, `pds.aithos.be` verifies owner data
envelopes against the key embedded in the DID's multibase — i.e. the
**`#root`** key (a `did:key`-style resolution of `did:aithos:z6Mk…`).
Signing owner data ops with `#self` or `#public` fails signature
verification.

Verified empirically against the live PDS with a generated `did:aithos`
identity (`createDataClient(...).collection("notes").list()`):

| verificationMethod / sphere | result |
|---|---|
| `#self`   | `401 envelope signature did not verify` |
| `#public` | `401 envelope signature did not verify` |
| **`#root`** | `404 collection "notes" not found` → **signature accepted** ✅ |

So: **owner data client on a `did:aithos` account ⇒ `sphereSeed = root seed`,
`verificationMethod = ${did}#root`.**

## Why the example appears fine today

Every data/assets flow here owns collections under a **local `did:key`**
(`demo-identity.ts` `loadOrCreateDemoIdentity`, `DelegateData.tsx`
`freshDidKey`, `_probe_064.mjs`). With `did:key` there is a single key and
the PDS resolver aliases `#self`/`#circle`/`#public` to it, so `#self`
"works" — but only by accident of the single-key aliasing. The comment in
`demo-identity.ts` ("the SDK does not (yet) expose the signed-in owner's data
sphere seed") is now stale: `keyStore.loadOwner().seedsHex.{root,public,
circle,self}` exposes the seeds after sign-in.

The `#self` "owner-path data verificationMethod" labels in `demo-identity.ts`,
`Data.tsx`, `Assets.tsx`, `DelegateData.tsx` are therefore misleading for
real accounts.

## To do — make the example clean

- [ ] Add a route/section that owns a collection under the **real signed-in
      `did:aithos` account** (seeds from `keyStore.loadOwner()`), signing with
      `#root`, to demonstrate (and lock in) the correct pattern.
- [ ] Update the `#self` "owner-path data verificationMethod" comments to
      state the rule: **`did:key` → any sphere (single key); `did:aithos` →
      `#root`** for owner PDS ops.
- [ ] Drop the stale "SDK does not expose the signed-in owner's data sphere
      seed" note (it does, via `loadOwner().seedsHex`).
- [ ] Remove leftover probe scripts (`_probe_064.mjs`) once covered by a real
      route/test.

## SDK-side (separate)

The SDK docs/JSDoc say data uses `#self` (`createDataClient` arg comment:
"`<did>#data` (or `#public`)"; CHANGELOG: "minted under the owner's `self`
sphere by default"). For `did:aithos` owner data this is wrong — it's `#root`.
Either the PDS should resolve the published DID document (so any sphere works
per the doc) or the SDK should document/handle the `#root` requirement and
ideally expose a ready-made owner data client from the signed-in session.
Tracked app-side in delie `docs/sdk-improvements.md`.
