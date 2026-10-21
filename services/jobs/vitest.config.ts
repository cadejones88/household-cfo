import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Applies the migrations once when DATABASE_URL is set; the integration tests skip without it.
    globalSetup: ["./test/globalSetup.ts"],
  },
});
