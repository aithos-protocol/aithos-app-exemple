// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mathieu Colla

// /assets — `sdk.assets` demo: upload an image and display it from
// any of the three Ethos zones (public / circle / self).
//
// What this demonstrates
// ----------------------
//   - `createAssetsClient({pdsUrl, did, sphereSeed, verificationMethod})`
//     — building an AssetsClient directly (the SDK does NOT expose
//     `sdk.assets` on AithosSDK; see Data.tsx for the same rationale
//     around the missing sphere-seed accessor).
//   - `client.upload({bytes, mediaType, attachTo: { ethos: { zone } }})`
//     — the SDK auto-resolves the regime from the zone:
//       · `zone: "public"` → public regime, served from a stable
//          CloudFront URL (no per-asset key, no decrypt step).
//       · `zone: "circle"` or `"self"` → private regime, AEAD-encrypted
//          client-side under a per-asset AMK wrapped for the subject's
//          per-zone X25519 sphere key (`#circle-kex` / `#self-kex`).
//   - `client.list(...)` — listing every asset under the subject DID.
//   - `<AssetsClientProvider>` + `<AithosAsset>` from `@aithos/sdk/react`
//     — drop-in render that fetches + decrypts + revokes the blob URL
//     automatically (private assets), and serves the CloudFront URL
//     directly (public assets).
//
// Identity — same ephemeral did:key as /data
// ------------------------------------------
//   The SDK doesn't expose the signed-in owner's sphere seed bytes, so
//   `createAssetsClient` can't be constructed from `sdk.auth`. We reuse
//   the same ephemeral did:key the /data page persists in localStorage
//   (key `aithos:demo:data-did-key`) so a single demo identity owns
//   both collections and assets across reloads. The same per-zone DID
//   URL fragment convention (#kex / #circle-kex / #self-kex) is applied
//   by the SDK's default RecipientResolver.
//
// PDS endpoint — DIFFERENT from /data
// -----------------------------------
//   The Aithos assets sub-protocol is its own backend (separate
//   Lambda + S3 bucket + DynamoDB tables), not part of the data PDS.
//   It's deployed at a distinct API Gateway URL. We read it from
//   `VITE_AITHOS_ASSETS_PDS_URL` and fall back to the current dev
//   deployment (`AithosAssetsPdsDev`, 2026-05-26, eu-west-3).

import { useEffect, useMemo, useRef, useState } from "react";

import {
  createAssetsClient,
  type AssetBrief,
  type AssetsClient,
} from "@aithos/sdk";
import {
  AssetsClientProvider,
  AithosAsset,
} from "@aithos/sdk/react";
import {
  bytesToHex,
  ed25519PublicKeyToMultibase,
  generateKeyPair,
} from "@aithos/protocol-client";

import { formatError } from "./Home.js";

const ASSETS_PDS_URL =
  (typeof import.meta.env.VITE_AITHOS_ASSETS_PDS_URL === "string" &&
    import.meta.env.VITE_AITHOS_ASSETS_PDS_URL) ||
  "https://yfzex613w3.execute-api.eu-west-3.amazonaws.com";

// CloudFront distribution that fronts the public-regime S3 bucket of
// the assets PDS. Used to render public images via `<img src={...}>`
// directly (no JS fetch → no CORS round-trip → no SHA verification
// needed). Mirrors `publicAssetUrl()` in
// aithos-protocol/packages/assets-backend/lambda/s3-presign.ts:
//   https://<cdn>/<subject_did>/<asset_id>/raw.bin
const ASSETS_PUBLIC_CDN_DOMAIN =
  (typeof import.meta.env.VITE_AITHOS_ASSETS_PUBLIC_CDN_DOMAIN === "string" &&
    import.meta.env.VITE_AITHOS_ASSETS_PUBLIC_CDN_DOMAIN) ||
  "d3sc3ay3heqzig.cloudfront.net";

/**
 * Compose the stable CloudFront URL for a public asset from its URN.
 * URN format: `urn:aithos:asset:<subject_did>:<asset_id>`.
 * Returns null on malformed URNs.
 */
function publicCdnUrlForUrn(urn: string): string | null {
  // The DID can itself contain colons (did:key:z6Mk…). Split off the
  // fixed prefix first, then take the LAST colon-separated segment as
  // the asset_id and rejoin the rest as the DID.
  const PREFIX = "urn:aithos:asset:";
  if (!urn.startsWith(PREFIX)) return null;
  const rest = urn.slice(PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) return null;
  const subjectDid = rest.slice(0, lastColon);
  const assetId = rest.slice(lastColon + 1);
  if (!subjectDid || !assetId) return null;
  return `https://${ASSETS_PUBLIC_CDN_DOMAIN}/${subjectDid}/${assetId}/raw.bin`;
}

// Reuse the same localStorage key as /data so both pages share one
// ephemeral identity in this browser. Resetting from either page
// regenerates the seed and both demos start fresh together.
const STORAGE_KEY = "aithos:demo:data-did-key";

type Zone = "public" | "circle" | "self";
const ZONES: ReadonlyArray<Zone> = ["public", "circle", "self"];

/* -------------------------------------------------------------------------- */
/*  Identity helpers (mirror /data so the demo identity is shared)            */
/* -------------------------------------------------------------------------- */

interface DemoIdentity {
  readonly did: string;
  readonly verificationMethod: string;
  readonly seed: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function loadOrCreateIdentity(): DemoIdentity {
  const raw =
    typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        seedHex: string;
        publicKeyHex: string;
      };
      const publicKey = hexToBytes(parsed.publicKeyHex);
      const seed = hexToBytes(parsed.seedHex);
      const mb = ed25519PublicKeyToMultibase(publicKey);
      const did = `did:key:${mb}`;
      return { did, verificationMethod: `${did}#${mb}`, seed };
    } catch {
      // fall through and regenerate
    }
  }
  const kp = generateKeyPair();
  const mb = ed25519PublicKeyToMultibase(kp.publicKey);
  const did = `did:key:${mb}`;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        seedHex: bytesToHex(kp.seed),
        publicKeyHex: bytesToHex(kp.publicKey),
      }),
    );
  }
  return { did, verificationMethod: `${did}#${mb}`, seed: kp.seed };
}

function resetIdentity(): DemoIdentity {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  return loadOrCreateIdentity();
}

/* -------------------------------------------------------------------------- */
/*  Per-upload metadata cache (so the gallery can show the zone an asset      */
/*  was uploaded under without an extra round-trip per asset).                */
/* -------------------------------------------------------------------------- */

const UPLOAD_LOG_KEY = "aithos:demo:asset-uploads";

interface UploadLogEntry {
  readonly urn: string;
  readonly zone: Zone;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly publicUrl?: string;
  readonly encrypted: boolean;
  readonly uploadedAt: string;
  readonly filename: string;
}

function loadUploadLog(): UploadLogEntry[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(UPLOAD_LOG_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as UploadLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveUploadLog(entries: UploadLogEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(UPLOAD_LOG_KEY, JSON.stringify(entries));
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export function Assets() {
  const [identity, setIdentity] = useState<DemoIdentity>(() =>
    loadOrCreateIdentity(),
  );

  const client = useMemo<AssetsClient>(
    () =>
      createAssetsClient({
        pdsUrl: ASSETS_PDS_URL,
        did: identity.did,
        sphereSeed: identity.seed,
        verificationMethod: identity.verificationMethod,
      }),
    [identity],
  );

  return (
    <AssetsClientProvider client={client}>
      <section>
        <h2>Assets — sdk.assets</h2>
        <p className="lede">
          Demo of <code>sdk.assets</code> against the Aithos assets PDS
          at <code>{ASSETS_PDS_URL}</code>. Upload an image attached to a zone of
          the Ethos and watch how the SDK routes it: <strong>public</strong>{" "}
          is served from a stable CloudFront URL with no key wrapping;{" "}
          <strong>circle</strong> and <strong>self</strong> are
          AEAD-encrypted client-side under a per-asset AMK wrapped for
          the subject's per-zone X25519 sphere key
          (<code>#circle-kex</code> / <code>#self-kex</code>) and fetched
          via short-lived presigned URLs.
        </p>
        <p className="lede" style={{ marginTop: -8 }}>
          <strong>Note:</strong> this page reuses the same ephemeral{" "}
          <code>did:key</code> identity as <code>/data</code> — see that
          page for the rationale (the SDK does not yet expose the
          signed-in owner's sphere seed).
        </p>
        <IdentityPanel
          identity={identity}
          onReset={() => setIdentity(resetIdentity())}
        />
      </section>

      <UploadPanel client={client} />

      <GalleryPanel client={client} identity={identity} />
    </AssetsClientProvider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Identity sub-panel                                                        */
/* -------------------------------------------------------------------------- */

function IdentityPanel({
  identity,
  onReset,
}: {
  readonly identity: DemoIdentity;
  readonly onReset: () => void;
}) {
  return (
    <dl className="kvtable">
      <dt>Subject DID</dt>
      <dd>
        <code>{identity.did}</code>
      </dd>
      <dt>Verification method</dt>
      <dd>
        <code>{identity.verificationMethod}</code>
      </dd>
      <dt>Reset</dt>
      <dd>
        <button
          className="secondary"
          onClick={() => {
            if (
              typeof window !== "undefined" &&
              window.confirm(
                "Generate a NEW ephemeral did:key? Both /data and /assets will start fresh under a new subject DID.",
              )
            ) {
              if (typeof window !== "undefined") {
                window.localStorage.removeItem(UPLOAD_LOG_KEY);
              }
              onReset();
            }
          }}
        >
          New did:key
        </button>
      </dd>
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/*  Upload sub-panel                                                          */
/* -------------------------------------------------------------------------- */

function UploadPanel({ client }: { readonly client: AssetsClient }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [zone, setZone] = useState<Zone>("public");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<UploadLogEntry | null>(null);

  const submit = async () => {
    if (!file) {
      setError("Pick an image file first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await client.upload({
        bytes,
        mediaType: file.type || "application/octet-stream",
        attachTo: { ethos: { zone } },
      });
      const entry: UploadLogEntry = {
        urn: result.urn,
        zone,
        mediaType: result.mediaType,
        sizeBytes: result.sizeBytes,
        ...(result.url ? { publicUrl: result.url } : {}),
        encrypted: result.encrypted,
        uploadedAt: new Date().toISOString(),
        filename: file.name,
      };
      const next = [entry, ...loadUploadLog()].slice(0, 100);
      saveUploadLog(next);
      setLastResult(entry);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      // Nudge the gallery to refresh.
      window.dispatchEvent(new CustomEvent("aithos:assets:changed"));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>Upload an image</h2>
      <p className="lede">
        Pick an image (PNG, JPEG, WebP, GIF…), choose a zone, hit{" "}
        <em>Upload</em>. Behind the scenes the SDK either ships the bytes
        in clear to S3 (public) or generates an AMK, encrypts the bytes,
        wraps the AMK to your <code>#&lt;zone&gt;-kex</code> X25519 key
        and uploads the ciphertext (circle / self).
      </p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="row">
          <label style={{ flex: "1 1 320px" }}>
            <span>Image file</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label style={{ flex: "0 0 200px" }}>
            <span>Zone</span>
            <select
              value={zone}
              onChange={(e) => setZone(e.target.value as Zone)}
            >
              {ZONES.map((z) => (
                <option key={z} value={z}>
                  {z}{" "}
                  {z === "public"
                    ? "(stable CloudFront URL)"
                    : "(AEAD-encrypted)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <button type="submit" disabled={busy || !file}>
            {busy ? "Uploading…" : `Upload to ${zone}`}
          </button>
        </div>
      </form>
      {error && <div className="error">{error}</div>}
      {lastResult && (
        <div className="section-card" style={{ marginTop: 12 }}>
          <h4>Last upload</h4>
          <div className="body">
            <code>{lastResult.urn}</code>
            <br />
            zone <strong>{lastResult.zone}</strong> ·{" "}
            {lastResult.encrypted ? "encrypted" : "public"} ·{" "}
            {lastResult.mediaType} · {formatBytes(lastResult.sizeBytes)}
          </div>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Gallery sub-panel — three columns, one per zone                           */
/* -------------------------------------------------------------------------- */

function GalleryPanel({
  client,
  identity,
}: {
  readonly client: AssetsClient;
  readonly identity: DemoIdentity;
}) {
  const [serverItems, setServerItems] = useState<readonly AssetBrief[]>([]);
  const [uploadLog, setUploadLog] = useState<readonly UploadLogEntry[]>(() =>
    loadUploadLog(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await client.list({ limit: 100, order: "newest" });
      setServerItems(r.items);
      setUploadLog(loadUploadLog());
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener("aithos:assets:changed", onChanged);
    return () => window.removeEventListener("aithos:assets:changed", onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const logByUrn = useMemo(() => {
    const m = new Map<string, UploadLogEntry>();
    for (const e of uploadLog) m.set(e.urn, e);
    return m;
  }, [uploadLog]);

  // Group server items by best-known zone. We trust the local upload
  // log when available; otherwise fall back to a heuristic
  // (encrypted ⇒ circle, plain ⇒ public — coarse but harmless for the
  // demo).
  const byZone = useMemo(() => {
    const buckets: Record<Zone, AssetBrief[]> = {
      public: [],
      circle: [],
      self: [],
    };
    for (const item of serverItems) {
      const log = logByUrn.get(item.urn);
      const zone: Zone =
        log?.zone ?? (item.encrypted ? "circle" : "public");
      buckets[zone].push(item);
    }
    return buckets;
  }, [serverItems, logByUrn]);

  const remove = async (urn: string) => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Tombstone asset ${urn}?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.delete(urn);
      // Drop from local upload log too.
      const next = loadUploadLog().filter((e) => e.urn !== urn);
      saveUploadLog(next);
      await refresh();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2>
        Gallery{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 14 }}>
          ({serverItems.length} asset{serverItems.length === 1 ? "" : "s"}{" "}
          under <code>{shortDid(identity.did)}</code>)
        </span>
      </h2>
      <p className="lede">
        Server-side <code>list_assets</code> returns every active asset
        under the subject DID, regardless of zone. Public images render
        via the stable CloudFront URL; encrypted ones go through{" "}
        <code>&lt;AithosAsset&gt;</code> which fetches the presigned URL,
        decrypts the bytes client-side and exposes a <code>blob:</code>{" "}
        URL with full lifecycle management (revoke on unmount, race-cancel
        on URN change).
      </p>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className="secondary"
          onClick={() => void refresh()}
          disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
        }}
      >
        {ZONES.map((zone) => (
          <ZoneColumn
            key={zone}
            zone={zone}
            items={byZone[zone]}
            logByUrn={logByUrn}
            onDelete={(urn) => void remove(urn)}
            busy={busy}
          />
        ))}
      </div>
    </section>
  );
}

function ZoneColumn({
  zone,
  items,
  logByUrn,
  onDelete,
  busy,
}: {
  readonly zone: Zone;
  readonly items: readonly AssetBrief[];
  readonly logByUrn: ReadonlyMap<string, UploadLogEntry>;
  readonly onDelete: (urn: string) => void;
  readonly busy: boolean;
}) {
  return (
    <div className="section-card">
      <h3 style={{ marginTop: 0 }}>
        {zone}{" "}
        <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
          ({items.length})
        </span>
      </h3>
      <p
        className="meta"
        style={{ marginTop: -4, marginBottom: 12, fontSize: 12 }}
      >
        {zone === "public"
          ? "Stable CloudFront URL · no encryption"
          : `AEAD · wraps to #${zone}-kex`}
      </p>
      {items.length === 0 ? (
        <p style={{ color: "var(--muted)" }}>
          <em>No assets yet.</em>
        </p>
      ) : (
        <div className="stack">
          {items.map((item) => {
            const log = logByUrn.get(item.urn);
            const isImage = item.mediaType.startsWith("image/");
            return (
              <div key={item.urn} className="stack" style={{ gap: 6 }}>
                {isImage ? (
                  // Public assets render via a direct <img src=CloudFront>
                  // — the bytes ARE the plaintext, no decrypt step is
                  // needed, and going through the JS fetch path adds a
                  // CORS round-trip + an unnecessary SHA-256 re-check.
                  // This is the path the @aithos/sdk/react docstring
                  // explicitly recommends for the public regime.
                  //
                  // Private (circle/self) assets MUST go through
                  // <AithosAsset> so the SDK can fetch the presigned
                  // S3 URL, decrypt the bytes with the AMK and expose
                  // them as a `blob:` URL.
                  !item.encrypted ? (
                    <img
                      src={log?.publicUrl ?? publicCdnUrlForUrn(item.urn) ?? undefined}
                      alt={log?.filename ?? item.urn}
                      style={{
                        width: "100%",
                        height: 140,
                        objectFit: "cover",
                        borderRadius: 6,
                        background: "var(--bg-elev-1, #f4f4f4)",
                      }}
                    />
                  ) : (
                    <AithosAsset
                      urn={item.urn}
                      alt={log?.filename ?? item.urn}
                      style={{
                        width: "100%",
                        height: 140,
                        objectFit: "cover",
                        borderRadius: 6,
                        background: "var(--bg-elev-1, #f4f4f4)",
                      }}
                      fallback={
                        <div
                          style={{
                            width: "100%",
                            height: 140,
                            borderRadius: 6,
                            background: "var(--bg-elev-1, #f4f4f4)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "var(--muted)",
                            fontSize: 12,
                          }}
                        >
                          Decrypting…
                        </div>
                      }
                    />
                  )
                ) : (
                  <div
                    style={{
                      padding: 12,
                      borderRadius: 6,
                      background: "var(--bg-elev-1, #f4f4f4)",
                      fontSize: 12,
                    }}
                  >
                    {item.mediaType}
                  </div>
                )}
                <div
                  className="meta"
                  style={{ fontSize: 11, wordBreak: "break-all" }}
                >
                  <code>{item.urn.replace(/^urn:aithos:asset:/, "")}</code>
                  <br />
                  {formatBytes(item.sizeBytes)} ·{" "}
                  {item.encrypted ? "encrypted" : "public"}
                  {log?.filename ? <> · {log.filename}</> : null}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button
                    className="danger"
                    onClick={() => onDelete(item.urn)}
                    disabled={busy}
                    style={{ fontSize: 12, padding: "4px 8px" }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  tiny helpers                                                              */
/* -------------------------------------------------------------------------- */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function shortDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 16)}…${did.slice(-6)}`;
}
