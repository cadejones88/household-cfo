import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 120000,
    hookTimeout: 120000,
    // Migrates the database named by DATABASE_URL once; the database-backed acceptance tests skip without it.
    globalSetup: ["./harness/globalSetup.ts"],
  },
});
