/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Public Aithos client key issued to this app via
   * `auth/scripts/provision-app-api-key.mjs --credentials public_key`.
   * Shipped to the browser bundle; the auth backend gates it by Origin
   * + per-IP rate limits. Required for the in-app "Créer un compte"
   * (custodial) flow to work without a backend.
   *
   * Example: VITE_AITHOS_PUBLIC_KEY=pk_test_xxxxxxxxxxxx
   */
  readonly VITE_AITHOS_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
