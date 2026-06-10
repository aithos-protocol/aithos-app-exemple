// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Actor context — the single keystone of the app.
//
// MODEL: exactly ONE acting identity at a time.
//   - owner    : you signed in with your own keys (recovery file or a freshly
//                minted #data identity). You can do everything on your own
//                subject.
//   - delegate : you imported ONE mandate. You can do only what its scopes
//                permit, on the mandate's subject. Everything else is greyed.
//   - none     : not signed in.
//
// NO JWT, EVER. Every protocol call (ethos / data / mandates / compute /
// wallet / assets) is a signed envelope. The owner signs with their sphere
// keys; the delegate signs with the imported delegate key. The auth-account
// session token (custodial / Google) is never created on the recovery+mandate
// paths and is never read here.
//
// Sign-out wipes everything (auth.signOut clears owner + all delegates +
// session). So "disconnect = lose every trace of the key/mandate" holds.

import {
  AithosAuth,
  AithosSDK,
  indexedDbKeyStore,
  DEV_SDK_ENDPOINTS,
  type AithosKeyStore,
  type DataClient,
  type DelegateInfo,
  type EthosClient,
  type ReadonlyDataClient,
  type StoredDelegateKeys,
} from "@aithos/sdk";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { vendorLites } from "./components/DataPlayground.js";

/** The real, registered example-app DID. Mandates / compute / wallet calls are
 * attributed to it. The Google SSO callback registered for it is
 * `http://localhost:5173/auth/callback`. */
export const APP_DID =
  "did:aithos:z6Mkm6tHeRiM1546AJEj8G1JP7qWhqJPnPshVJL14DWAC9q7";

// Follow the SAME env switch as the SDK endpoints below: dev by default, prod only
// when VITE_AITHOS_ENV=prod (or an explicit VITE_AITHOS_PDS_URL override). Hardcoding
// prod here sent the #data client to prod while the rest of the app ran on dev.
const PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_PDS_URL) ||
  (import.meta.env.VITE_AITHOS_ENV === "prod" ? "https://pds.aithos.be" : DEV_SDK_ENDPOINTS.pds);

export type ZoneName = "public" | "circle" | "self";
export type DataAction = "read" | "write" | "admin" | "append";

/* -------------------------------------------------------------------------- */
/*  Actor + capabilities                                                      */
/* -------------------------------------------------------------------------- */

export type Actor =
  | {
      readonly kind: "owner";
      readonly subjectDid: string;
      readonly handle: string;
      /** Present iff the owner account carries a #data sphere seed. */
      readonly hasData: boolean;
    }
  | {
      readonly kind: "delegate";
      readonly subjectDid: string;
      readonly mandateId: string;
      readonly scopes: readonly string[];
      readonly label: string;
    };

/**
 * What the current actor is allowed to do. The owner is just the actor whose
 * every capability is `true`; a delegate is the same surface restricted to its
 * mandate scopes. Pages read this to enable/grey controls.
 */
export interface Capabilities {
  readonly isOwner: boolean;
  /** Can read a given Ethos zone (write implies read). */
  readonly ethosRead: (zone: ZoneName) => boolean;
  /** Can write a given Ethos zone. */
  readonly ethosWrite: (zone: ZoneName) => boolean;
  /** Can perform an action on a data collection (admin⊃write⊃read; append lateral). */
  readonly dataCan: (collection: string, action: DataAction) => boolean;
  /** Owner-only: issue mandates. */
  readonly canIssueMandates: boolean;
  /** Spend compute credits (owner, or delegate with compute.invoke). */
  readonly canCompute: boolean;
  /** Read balance / top up the wallet (owner-only in v1 — signs #public). */
  readonly canWallet: boolean;
  /** Use the assets sub-protocol (owner-only in v1). */
  readonly canAssets: boolean;
}

function ownerCapabilities(): Capabilities {
  return {
    isOwner: true,
    ethosRead: () => true,
    ethosWrite: () => true,
    dataCan: () => true,
    canIssueMandates: true,
    canCompute: true,
    canWallet: true,
    canAssets: true,
  };
}

// Coarse, zone-level read/write gate over the v0.3 verb-scope grammar
// (`ethos.<verb>.<zone>[#selector]`). Read-bearing verbs let the holder decrypt
// the zone; write-bearing verbs let it mutate. Selectors (#id=/#prefix=/#tag=)
// narrow WHICH sections — that per-section truth comes from EthosZone.index();
// here we only decide whether the actor can touch the zone at all (tab + add form).
const ETHOS_READ_VERBS: ReadonlySet<string> = new Set(["read", "edit", "append", "write"]);
const ETHOS_WRITE_VERBS: ReadonlySet<string> = new Set(["edit", "append", "delete", "write"]);

function ethosScopeZoneVerb(scope: string): { verb: string; zone: string } | null {
  if (!scope.startsWith("ethos.")) return null;
  const head = scope.split("#")[0]!;
  const parts = head.split(".");
  if (parts.length !== 3) return null;
  return { verb: parts[1]!, zone: parts[2]! };
}

function anyEthosScope(
  scopes: readonly string[],
  zone: ZoneName,
  verbs: ReadonlySet<string>,
  allowAll: boolean,
): boolean {
  return scopes.some((s) => {
    const p = ethosScopeZoneVerb(s);
    return !!p && verbs.has(p.verb) && (p.zone === zone || (allowAll && p.zone === "all"));
  });
}

function delegateCapabilities(scopes: readonly string[]): Capabilities {
  const has = (s: string) => scopes.includes(s);

  const dataScopeAllows = (collection: string, action: DataAction): boolean => {
    // Match data.<collection>.<action> and the cross-collection wildcard
    // data.*.<action>, honoring the read ⊂ write ⊂ admin hierarchy. `append`
    // is lateral: only an explicit append (or a write/admin, which can insert)
    // grants it.
    const rank: Record<Exclude<DataAction, "append">, number> = {
      read: 1,
      write: 2,
      admin: 3,
    };
    for (const s of scopes) {
      const m = /^data\.([^.]+)\.(read|write|admin|append)$/.exec(s);
      if (!m) continue;
      const [, col, act] = m;
      if (col !== collection && col !== "*") continue;
      if (action === "append") {
        if (act === "append" || act === "write" || act === "admin") return true;
        continue;
      }
      if (act === "append") continue; // append never satisfies read/write/admin
      if (rank[act as "read" | "write" | "admin"] >= rank[action]) return true;
    }
    return false;
  };

  return {
    isOwner: false,
    ethosRead: (zone) => anyEthosScope(scopes, zone, ETHOS_READ_VERBS, true),
    ethosWrite: (zone) => anyEthosScope(scopes, zone, ETHOS_WRITE_VERBS, false),
    dataCan: dataScopeAllows,
    canIssueMandates: false,
    canCompute: has("compute.invoke"),
    canWallet: false,
    canAssets: false,
  };
}

/* -------------------------------------------------------------------------- */
/*  Context value                                                             */
/* -------------------------------------------------------------------------- */

interface ActorContextValue {
  readonly auth: AithosAuth;
  readonly sdk: AithosSDK;
  readonly keyStore: AithosKeyStore;
  /** The single acting identity, or null when not signed in. */
  readonly actor: Actor | null;
  readonly capabilities: Capabilities;
  /** Bump after any auth-mutating call (sign-in / import / sign-out). */
  readonly bump: () => void;
  /** Build an EthosClient for the current actor's subject (me() or of()). */
  readonly getEthosClient: () => Promise<EthosClient>;
  /**
   * A data client for the current actor: the owner's full {@link DataClient}
   * (CRUD under #data), or the delegate's {@link ReadonlyDataClient} (list/get
   * only — a delegate reads). null when there's no data-capable actor (no
   * owner #data seed, or no delegate). Pages branch on `capabilities.isOwner`.
   */
  readonly dataClient: DataClient | ReadonlyDataClient | null;
}

const Ctx = createContext<ActorContextValue | null>(null);

export function ActorProvider({ children }: { readonly children: ReactNode }) {
  const [keyStore] = useState<AithosKeyStore>(() => indexedDbKeyStore());
  // No sessionStore: the app is JWT-agnostic. AithosAuth still accepts one,
  // but we never read getCurrentSession(); recovery + mandate paths never
  // create a JWT anyway.
  const [auth] = useState(() => new AithosAuth({ keyStore }));
  // Dev by default: the whole SDK (incl. the ethos api/cdn reached through
  // protocol-client) targets the *.dev.aithos.be account. Set VITE_AITHOS_ENV=prod
  // to hit production instead.
  const [sdk] = useState(() =>
    new AithosSDK({
      auth,
      appDid: APP_DID,
      ...(import.meta.env.VITE_AITHOS_ENV === "prod" ? {} : { endpoints: DEV_SDK_ENDPOINTS }),
    }),
  );

  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  // Resolved actor + the material needed to build its data client.
  const [actor, setActor] = useState<Actor | null>(null);
  const [ownerDataSeedHex, setOwnerDataSeedHex] = useState<string | undefined>();
  const [delegateKeys, setDelegateKeys] = useState<StoredDelegateKeys | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Boot once: rehydrate persisted owner / delegates.
  useEffect(() => {
    let cancelled = false;
    auth
      .resume()
      .catch(() => {
        /* surfaced as "not signed in"; nothing to block boot on */
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
          bump();
          // Background wrap pruning — once per owner session, fire-and-forget.
          // Drops revoked/expired mandates' wraps from the manifest (metadata
          // hygiene under the additive doctrine: the server already gates dead
          // reads; the crypto cut stays the explicit Rotate keys). Steady state
          // costs one list_mandates and publishes nothing.
          if (auth.getOwnerInfo()) {
            sdk.ethos
              .me()
              .pruneWraps()
              .then((r) => {
                if (r) console.info(`[aithos] pruned dead wraps — edition #${r.editionHeight}`);
              })
              .catch(() => {
                /* hygiene only — never surface */
              });
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, sdk, bump]);

  // Re-derive the single actor whenever auth state changes (version bump).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ownerInfo = auth.getOwnerInfo();
      if (ownerInfo) {
        const stored = await keyStore.loadOwner().catch(() => null);
        if (cancelled) return;
        setActor({
          kind: "owner",
          subjectDid: ownerInfo.did,
          handle: ownerInfo.handle,
          hasData: !!stored?.seedsHex.data,
        });
        setOwnerDataSeedHex(stored?.seedsHex.data);
        setDelegateKeys(null);
        return;
      }
      // No owner → a single delegate, if any.
      const dels = await keyStore.listDelegates().catch(() => []);
      if (cancelled) return;
      if (dels.length > 0) {
        // The MOST RECENTLY IMPORTED bundle is the one the user means to act
        // under. The previous `dels[0]` (oldest stored) let a stale bundle
        // from earlier sessions shadow a fresh grant: titles rendered but
        // nothing decrypted. (Per-subject refinement — non-expired, newest
        // issued — lives in the SDK's pickDelegateActor for ethos.of().)
        const d = [...dels].sort(
          (x, y) => Date.parse(y.importedAt ?? 0) - Date.parse(x.importedAt ?? 0),
        )[0]!;
        const info: DelegateInfo | undefined = auth
          .getDelegates()
          .find((x) => x.mandateId === d.mandateId);
        setActor({
          kind: "delegate",
          subjectDid: d.subjectDid,
          mandateId: d.mandateId,
          scopes: info?.scopes ?? [],
          label: info?.granteeId ?? d.mandateId,
        });
        setDelegateKeys(d);
        setOwnerDataSeedHex(undefined);
        return;
      }
      setActor(null);
      setOwnerDataSeedHex(undefined);
      setDelegateKeys(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, keyStore, version]);

  const capabilities = useMemo<Capabilities>(() => {
    if (!actor) return delegateCapabilities([]); // all-false surface
    return actor.kind === "owner"
      ? ownerCapabilities()
      : delegateCapabilities(actor.scopes);
  }, [actor]);

  const dataClient = useMemo<DataClient | ReadonlyDataClient | null>(() => {
    // Don't touch the auth session until resume() has rehydrated it. The
    // actor-derive effect can set `actor` from the KEYSTORE before resume() has
    // populated the in-memory owner/delegate registry; computing the client
    // then would call delegateDataClient on an empty registry and throw
    // "mandate not active in this session" DURING RENDER — crashing the whole
    // app on refresh (the dataClient useMemo runs before the `!ready` guard).
    if (!ready) return null;
    if (!actor) return null;
    if (actor.kind === "owner") {
      if (!ownerDataSeedHex) return null;
      // Session-based: the owner's #data sphere seed lives in the keystore
      // (loaded by auth.resume()); the SDK derives the client from it. No raw
      // seed plumbing here anymore.
      return auth.ownerDataClient({ pdsUrl: PDS_URL, schemas: vendorLites() });
    }
    if (!delegateKeys) return null;
    // Delegate path needs the mandate imported into the auth session
    // (auth.importMandate / rehydrated by resume()). Guard against a transient
    // keystore↔session mismatch so a missing session entry degrades to "no
    // client" instead of throwing during render.
    try {
      return auth.delegateDataClient({
        subjectDid: delegateKeys.subjectDid,
        mandateId: delegateKeys.mandateId,
        pdsUrl: PDS_URL,
        schemas: vendorLites(),
      });
    } catch {
      return null;
    }
  }, [ready, actor, auth, ownerDataSeedHex, delegateKeys]);

  const getEthosClient = useCallback(async (): Promise<EthosClient> => {
    if (!actor) throw new Error("no actor signed in");
    return actor.kind === "owner"
      ? sdk.ethos.me()
      : sdk.ethos.of(actor.subjectDid);
  }, [actor, sdk]);

  const value = useMemo<ActorContextValue>(
    () => ({ auth, sdk, keyStore, actor, capabilities, bump, getEthosClient, dataClient }),
    [auth, sdk, keyStore, actor, capabilities, bump, getEthosClient, dataClient],
  );

  if (!ready) return <div className="boot">Loading…</div>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useActor(): ActorContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useActor must be used inside <ActorProvider>");
  return ctx;
}
