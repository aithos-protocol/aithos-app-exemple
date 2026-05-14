/// <reference types="vite/client" />

// Allow `import templateRaw from "./foo.html?raw"` — Vite resolves the
// suffix at build time, this declaration tells TypeScript the return
// type is `string`.
declare module "*.html?raw" {
  const src: string;
  export default src;
}

declare module "*.txt?raw" {
  const src: string;
  export default src;
}
