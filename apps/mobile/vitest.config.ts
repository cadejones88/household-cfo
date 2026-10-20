import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests cover the pure modules (offline queue, safe-to-spend view model, status words, step-up timer).
// They never import react-native or an expo module; device behaviour is covered by the Maestro flow.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["test/**/*.test.ts"] },
});
