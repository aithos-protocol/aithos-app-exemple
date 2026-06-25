// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Capability-aware navigation. The same links for everyone; ones the current
// actor can't use are greyed (with the reason on hover). An "Acting as" pill
// shows who you are, and Sign out wipes every trace of the key/mandate.

import { NavLink } from "react-router-dom";

import { useActor, type ZoneName } from "../actor-context.js";
import { EnvToggle } from "./EnvToggle.js";

const ZONES: readonly ZoneName[] = ["public", "circle", "self"];

export function Nav() {
  const { actor, capabilities: cap, auth, bump } = useActor();

  const canProfile =
    !actor ? false : ZONES.some((z) => cap.ethosRead(z) || cap.ethosWrite(z));
  // Data is reachable if the actor has a data client (owner #data, or a
  // delegate). The page itself greys the per-collection actions.
  const canData = actor
    ? cap.isOwner || actor.kind === "delegate"
    : false;

  return (
    <nav className="top">
      <NavLink to="/" end>
        Home
      </NavLink>
      <Item to="/profile" enabled={canProfile} reason="needs an ethos scope">
        Profile
      </Item>
      <Item to="/data" enabled={canData} reason="needs a #data or data scope">
        Data
      </Item>
      <Item
        to="/mandates"
        enabled={cap.canIssueMandates}
        reason="owner only"
      >
        Mandates
      </Item>
      <Item to="/compute" enabled={cap.canCompute} reason="needs compute.invoke">
        Compute
      </Item>
      <Item to="/agent" enabled={cap.canCompute} reason="needs compute.invoke">
        Agent
      </Item>
      <Item to="/wallet" enabled={cap.canWallet} reason="owner only">
        Wallet
      </Item>
      <Item to="/assets" enabled={cap.canAssets} reason="owner only">
        Assets
      </Item>

      <EnvToggle />

      <span className="pill" style={{ marginLeft: 12 }}>
        {actor ? <ActorLabel /> : <em>not signed in</em>}
      </span>
      {actor && (
        <button
          className="danger"
          style={{ marginLeft: 8 }}
          onClick={async () => {
            await auth.signOut();
            bump();
          }}
        >
          Sign out
        </button>
      )}
    </nav>
  );
}

function ActorLabel() {
  const { actor } = useActor();
  if (!actor) return null;
  if (actor.kind === "owner") {
    return (
      <>
        <strong>@{actor.handle}</strong> · owner
        {actor.hasData ? " · #data ✓" : " · no #data"}
      </>
    );
  }
  return (
    <>
      <strong>delegate</strong> · {actor.scopes.length} scope
      {actor.scopes.length === 1 ? "" : "s"} ·{" "}
      <code>{actor.subjectDid.slice(0, 16)}…</code>
    </>
  );
}

function Item({
  to,
  enabled,
  reason,
  children,
}: {
  readonly to: string;
  readonly enabled: boolean;
  readonly reason: string;
  readonly children: React.ReactNode;
}) {
  if (enabled) return <NavLink to={to}>{children}</NavLink>;
  return (
    <span
      className="nav-disabled"
      title={`Unavailable — ${reason}`}
      style={{ opacity: 0.4, cursor: "not-allowed" }}
    >
      {children}
    </span>
  );
}
