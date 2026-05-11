// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

import { NavLink } from "react-router-dom";

import { useSdk } from "../sdk-context.js";

export function Nav() {
  const { state } = useSdk();
  const ownerLabel = state.owner ? `@${state.owner.handle}` : "anonymous";
  const jwtLabel = state.session ? "JWT ✓" : "no JWT";
  const delegateLabel =
    state.delegates.length > 0
      ? `· ${state.delegates.length} mandate${state.delegates.length > 1 ? "s" : ""}`
      : "";

  return (
    <nav className="top">
      <NavLink to="/" end>
        Home
      </NavLink>
      <NavLink to="/profile">Profile</NavLink>
      <NavLink to="/mandates">Mandates</NavLink>
      <NavLink to="/wallet">Wallet</NavLink>
      <NavLink to="/compute">Compute</NavLink>
      <NavLink to="/image">Image</NavLink>
      <NavLink to="/branded-robot">Branded robot</NavLink>
      <span className="pill">
        <strong>{ownerLabel}</strong> · {jwtLabel} {delegateLabel}
      </span>
    </nav>
  );
}
