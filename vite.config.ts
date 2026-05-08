import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Minimal Vite config — React + a sensible default port. The SDK is
// constructed in src/sdk-context.tsx; endpoint overrides for staging
// or self-hosting go there, not here.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
