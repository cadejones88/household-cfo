/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @homestead/shared imports `node:crypto` for SHA-256 (idempotency keys and External Document Nos.).
// The browser has no synchronous hash, so the Console supplies a small shim with the same `createHash`
// surface (src/shims/node-crypto.ts). Everything else in the shared package is plain TypeScript.
const nodeCryptoShim = fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^node:crypto$/, replacement: nodeCryptoShim }],
  },
  server: { port: 5174, strictPort: false },
  preview: { port: 4174 },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    globals: false,
    css: false,
  },
});
