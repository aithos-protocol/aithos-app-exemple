// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// SDK provider — singleton AithosAuth + AithosSDK exposed via React
// context. Boots once: constructs the auth + sdk, calls auth.resume()
// to rehydrate any persisted session, then renders children.
//
// AithosAuth doesn't (yet) emit events. Until it does, mutations to
// the auth state happen through `useAuthOps()` hooks that wrap the
// async auth methods and force a re-render after each call. That
// pattern is acceptable for a demo app — a real app might keep its
// own thin reactive layer over AithosAuth.
//
// ┌─ Local-dev caveats ─────────────────────────────────────────────┐
// │ Two of the four entry doors hit infrastructure that today does │
// │ not allow arbitrary origins:                                   │
// │                                                                 │
// │  1. Email + password (signUp / signIn) → POSTs to              │
// │     auth.aithos.be. The browser sends a CORS preflight; the    │
// │     auth Lambda must include this origin in its CORS allowlist │
// │     or the call fails before it even leaves localhost.         │
// │                                                                 │
// │  2. Google SSO → after the OAuth round-trip, auth.aithos.be    │
// │     redirects the user to a hard-coded post-callback URL       │
// │     (currently app.aithos.be). Localhost won't see the         │
// │     aithos_code.                                               │
// │                                                                 │
// │ The two paths that work locally without backend changes:       │
// │  - signInWithRecovery({ file })  — purely local                │
// │  - importMandate({ bundle })     — purely local                │
// │                                                                 │
// │ Once an owner signer is loaded by either path, the rest        │
// │ (sdk.ethos / sdk.mandates / sdk.wallet / sdk.compute) goes     │
// │ through envelope-signed POSTs. Those endpoints (compute and    │
// │ wallet) likely have their own CORS allowlists too — the same   │
// │ caveat applies.                                                │
// │                                                                 │
// │ Productisation TODOs (tracked in README):                      │
// │  - SDK: add `returnTo` to signInWithGoogle so the consumer app │
// │    declares its callback URL explicitly                        │
// │  - Backend: per-appDid origin registry (CORS + post-Google     │
// │    redirect allowlist) instead of static config                │
// └─────────────────────────────────────────────────────────────────┘

import {
  AithosAuth,
  AithosSDK,
  localStorageStore,
  type AithosSession,
  type DelegateInfo,
  type OwnerInfo,
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

// TODO(real-app): replace with the real example-app DID once one is
// issued. The current value is a placeholder; mandates / compute /
// wallet calls will succeed envelope-wise but won't be attributed
// against any real audit trail.
const APP_DID = "did:aithos:app:example-placeholder";

interface SdkContextValue {
  readonly auth: AithosAuth;
  readonly sdk: AithosSDK;
  /** Increments after every auth-mutating call so consumers re-render. */
  readonly version: number;
  readonly bumpVersion: () => void;
  /** Captured derived state — refreshed on every version bump. */
  readonly state: {
    readonly session: AithosSession | null;
    readonly owner: OwnerInfo | null;
    readonly delegates: readonly DelegateInfo[];
    readonly canSignAsOwner: boolean;
  };
}

const SdkContext = createContext<SdkContextValue | null>(null);

export function SdkProvider({ children }: { readonly children: ReactNode }) {
  // One auth + one sdk for the whole app. useMemo ensures we don't
  // rebuild on re-render.
  const [auth] = useState(() =>
    new AithosAuth({
      // Persist the JWT across reloads via localStorage. Sessions are
      // pinned to the page origin like any cookie, only longer-lived.
      sessionStore: localStorageStore(),
    }),
  );
  const [sdk] = useState(() => new AithosSDK({ auth, appDid: APP_DID }));
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);

  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  // Boot: rehydrate from KeyStore + SessionStore.
  useEffect(() => {
    let cancelled = false;
    auth
      .resume()
      .catch((err) => {
        // Don't block the app — surface the issue in the console.
        // eslint-disable-next-line no-console
        console.warn("[aithos] auth.resume() failed:", err);
      })
      .finally(() => {
        if (!cancelled) {
          setReady(true);
          bumpVersion();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, bumpVersion]);

  const state = useMemo(
    () => ({
      session: auth.getCurrentSession(),
      owner: auth.getOwnerInfo(),
      delegates: auth.getDelegates(),
      canSignAsOwner: auth.canSignAsOwner(),
    }),
    // version is the trigger; auth instance is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth, version],
  );

  const value = useMemo<SdkContextValue>(
    () => ({ auth, sdk, version, bumpVersion, state }),
    [auth, sdk, version, bumpVersion, state],
  );

  if (!ready) return <div className="boot">Loading…</div>;
  return <SdkContext.Provider value={value}>{children}</SdkContext.Provider>;
}

export function useSdk(): SdkContextValue {
  const ctx = useContext(SdkContext);
  if (!ctx) {
    throw new Error("useSdk must be used inside <SdkProvider>");
  }
  return ctx;
}
