// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /wallet — balance + Stripe top-up.

import { useEffect, useState } from "react";

import type { CreditPackId, GetBalanceResult } from "@aithos/sdk";

import { useSdk } from "../sdk-context.js";
import { formatError } from "./Home.js";

const PACKS: { readonly id: CreditPackId; readonly label: string }[] = [
  { id: "credits-100k", label: "100K microcredits (~5 €)" },
  { id: "credits-1m", label: "1M microcredits (~45 €)" },
  { id: "credits-5m", label: "5M microcredits (~200 €)" },
];

export function Wallet() {
  const { sdk, state } = useSdk();
  const [balance, setBalance] = useState<GetBalanceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!state.canSignAsOwner || !state.session) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    sdk.wallet
      .getBalance()
      .then((r) => {
        if (cancelled) return;
        setBalance(r);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(formatError(e));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sdk, state.canSignAsOwner, state.session, tick]);

  if (!state.canSignAsOwner) {
    return (
      <section>
        <h2>Wallet</h2>
        <p className="lede">Sign in as an owner first.</p>
      </section>
    );
  }
  if (!state.session) {
    return (
      <section>
        <h2>Wallet</h2>
        <p className="lede">
          Wallet calls require a JWT-backed session (email/password or
          Google sign-in). The recovery / mandate flows don't yield one;
          please sign in via password or Google to use the wallet.
        </p>
      </section>
    );
  }

  return (
    <>
      <section>
        <h2>Balance</h2>
        {busy && <p>Loading…</p>}
        {error && <div className="error">{error}</div>}
        {balance && (
          <dl className="kvtable">
            <dt>Balance</dt>
            <dd>
              <code>{balance.balance.toLocaleString()}</code> microcredits
            </dd>
            <dt>Daily spent</dt>
            <dd>
              <code>{balance.dailySpent.toLocaleString()}</code> microcredits
            </dd>
            <dt>Wallet exists</dt>
            <dd>{String(balance.exists)}</dd>
          </dl>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="secondary"
            onClick={() => setTick((t) => t + 1)}
            disabled={busy}
          >
            Refresh
          </button>
        </div>
      </section>

      <section>
        <h2>Top up via Stripe Checkout</h2>
        <p className="lede">
          Creates a Stripe Checkout session bound to your DID. After
          payment, the webhook credits your wallet — usually a few seconds
          later. Click "Refresh" above once you're back from Stripe.
        </p>
        <TopupRow />
      </section>
    </>
  );
}

function TopupRow() {
  const { sdk } = useSdk();
  const [busy, setBusy] = useState<CreditPackId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (packId: CreditPackId) => {
    setBusy(packId);
    setError(null);
    try {
      const r = await sdk.wallet.createTopupSession({
        packId,
        successUrl: window.location.origin + "/wallet?topup=ok",
        cancelUrl: window.location.origin + "/wallet?topup=ko",
      });
      window.location.href = r.checkoutUrl;
    } catch (e) {
      setError(formatError(e));
      setBusy(null);
    }
  };

  return (
    <>
      <div className="row">
        {PACKS.map((p) => (
          <button
            key={p.id}
            disabled={busy !== null}
            onClick={() => void start(p.id)}
          >
            {busy === p.id ? "Redirecting…" : `Buy ${p.label}`}
          </button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
    </>
  );
}
