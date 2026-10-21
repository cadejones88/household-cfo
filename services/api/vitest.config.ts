import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Applies the migrations once when DATABASE_URL is set; integration tests skip without it.
    globalSetup: ["./test/helpers/globalSetup.ts"],
  },
});
