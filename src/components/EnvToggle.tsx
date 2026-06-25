// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// Runtime dev/prod switch. Each env has its OWN namespaced keystore + session
// (see actor-context: `aithos-sdk-keys-<env>` / `aithos.session.<env>`), so
// flipping this surfaces the other account — it NEVER mixes seeds. Handy to
// verify a fix on prod (e.g. the #data sphere) without a separate build.
//
// Note: custodial (email/password, invite) sign-in needs a per-env `pk_…`
// (VITE_AITHOS_PUBLIC_KEY for dev, VITE_AITHOS_PUBLIC_KEY_PROD for prod).
// Recovery-file sign-in needs none — the cleanest prod test path.

import { useActor, type Env } from "../actor-context.js";

const ENVS: readonly Env[] = ["dev", "prod"];

export function EnvToggle() {
  const { env, setEnv, actor } = useActor();

  const choose = (next: Env) => {
    if (next === env) return;
    // Switching surfaces a DIFFERENT (namespaced) account — confirm when signed
    // in so a stray click isn't mistaken for a sign-out. The current env's
    // session stays intact in its own keystore.
    if (
      actor &&
      !window.confirm(
        `Switch to ${next.toUpperCase()}? You'll see the ${next} account; ` +
          `your ${env} session stays intact.`,
      )
    ) {
      return;
    }
    setEnv(next);
  };

  return (
    <div
      className="env-toggle"
      role="group"
      aria-label="Account environment"
      title="Account environment — dev (*.dev.aithos.be) vs prod (auth.aithos.be / pds.aithos.be)"
      style={{ display: "inline-flex", gap: 2, marginLeft: "auto" }}
    >
      {ENVS.map((e) => {
        const active = env === e;
        return (
          <button
            key={e}
            type="button"
            onClick={() => choose(e)}
            aria-pressed={active}
            style={{
              textTransform: "uppercase",
              fontSize: 11,
              letterSpacing: 0.4,
              fontWeight: active ? 700 : 400,
              opacity: active ? 1 : 0.5,
              border: "1px solid var(--border, #ccd)",
              background: active
                ? e === "prod"
                  ? "var(--prod-bg, #fde2e1)"
                  : "var(--dev-bg, #e1edfd)"
                : "transparent",
              color: "inherit",
              borderRadius: 4,
              padding: "2px 8px",
              cursor: active ? "default" : "pointer",
            }}
          >
            {e}
          </button>
        );
      })}
    </div>
  );
}
