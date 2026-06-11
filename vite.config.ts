import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal Vite config — React + a sensible default port. The SDK is
// constructed in src/sdk-context.tsx; endpoint overrides for staging
// or self-hosting go there, not here.
export default defineConfig({
  // @aithos/protocol-core's root entry retains a node-only module
  // (storage.js reads process.env at init) in the browser graph since the
  // v0.4 modules joined it. Node builtins are already shimmed empty by the
  // dep optimizer; `process` is a bare global, so we shim it here. The clean
  // fix (lazy env access in core) ships with core 0.11.1.
  define: {
    "process.env": "({})",
  },
  plugins: [react()],
  server: {
    port: 5173,
  },
});
