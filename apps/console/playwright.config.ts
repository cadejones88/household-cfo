/**
 * Playwright smoke test for the Console in mock mode (no API, no sign-in). `pnpm test:e2e`.
 *
 * Browsers: CI runs `npx playwright install --with-deps chromium`. In an environment with a pre-installed
 * Chromium, point PW_CHROMIUM_PATH at its executable (for example /opt/pw-browsers/chromium-<rev>/chrome-linux/chrome)
 * and the test uses it instead of downloading one.
 */
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env["PW_PORT"] ?? 4175);
const executablePath = process.env["PW_CHROMIUM_PATH"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    // Mock API + dev auth: the Console runs entirely in the browser with synthetic data.
    command: `VITE_API_MODE=mock VITE_AUTH_MODE=dev npx vite --port ${port} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${port}/health.json`,
    reuseExistingServer: !process.env["CI"],
    timeout: 90_000,
  },
});
