/**
 * Smoke: every MVP page renders in mock mode with its data-through line and quality tag, the six "After the
 * pilot" tiles exist, and the two riskiest flows (bulk approve, exception resolve) complete end to end against
 * the in-browser mock, which enforces the shared state machine.
 */
import { expect, test, type Page } from "@playwright/test";

const MVP = [
  { path: "/queues", heading: "Work queues" },
  { path: "/sync", heading: "BC sync and posting" },
  { path: "/reconciliation", heading: "Reconciliation status" },
  { path: "/mappings", heading: "Account and dimension mappings" },
  { path: "/authority", heading: "Authority matrix" },
  { path: "/health", heading: "Connection health, logs and audit" },
] as const;

async function expectDataThrough(page: Page) {
  const line = page.getByTestId("data-through").first();
  await expect(line).toBeVisible();
  await expect(line).toContainText("Data through");
  await expect(line).toContainText("pending");
  await expect(line.locator(".tag")).toBeVisible(); // the quality tag
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  (page as Page & { __errors?: string[] }).__errors = errors;
});

test.afterEach(async ({ page }) => {
  const errors = (page as Page & { __errors?: string[] }).__errors ?? [];
  expect(errors, "no console or page errors").toEqual([]);
});

test("overview shows the six MVP functions and the six later tiles", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Homestead Console");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Overview");
  await expect(page.getByRole("navigation", { name: "Console" })).toContainText("Work queues");
  const nav = page.getByRole("navigation", { name: "Console" });
  for (const label of ["Work queues", "BC sync and posting", "Reconciliation", "Mappings", "Authority matrix", "Health, logs and audit"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
  await expect(page.getByText("After the pilot").first()).toBeVisible();
  const tiles = page.locator(".tile-foot", { hasText: "After the pilot" });
  await expect(tiles).toHaveCount(6);
});

for (const p of MVP) {
  test(`${p.path} renders with a data-through line`, async ({ page }) => {
    await page.goto(p.path);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(p.heading);
    await expectDataThrough(page);
  });
}

test("a placeholder page says it comes after the pilot", async ({ page }) => {
  await page.goto("/later/forecast");
  await expect(page.getByTestId("placeholder")).toContainText("arrives after the pilot");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("13-week cash forecast");
});

test("work queues: every tab renders; bulk approve moves rows out of Ready for review", async ({ page }) => {
  await page.goto("/queues");
  const table = page.getByTestId("queue-table");
  await expect(table).toBeVisible();
  const rowsBefore = await table.locator("tbody tr").count();
  expect(rowsBefore).toBeGreaterThan(1);

  await page.getByLabel("Select all").check();
  const approve = page.getByTestId("approve-selected");
  await expect(approve).toContainText(`(${rowsBefore})`);
  await approve.click();
  await expect(page.getByRole("status")).toContainText("approved");
  await expect(page.getByTestId("queue-empty")).toBeVisible();

  for (const tab of ["Receipts", "Rules", "Exceptions"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.getByTestId("queue-table")).toBeVisible(); // exceptions
});

test("exceptions: resolve against an existing BC entry records the entry numbers", async ({ page }) => {
  await page.goto("/queues?tab=exceptions");
  const row = page.getByTestId("row-tx-0016");
  await expect(row).toContainText("Exception");
  await row.getByRole("button", { name: "Resolve" }).click();
  const dialog = page.getByTestId("exception-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("exception-keys")).toContainText("4471, 4472");
  await expect(dialog.getByTestId("resolve-submit")).toBeDisabled();
  await dialog.getByLabel("Resolution note").fill("Posted by hand in BC; recording the entry numbers.");
  await dialog.getByTestId("resolve-submit").click();
  await expect(page.getByRole("status")).toContainText("Recorded as posted");
  await expect(page.getByTestId("row-tx-0016")).toHaveCount(0);
  // The audit log carries the resolution with the keys. Navigate in-app: a full page load would reset the
  // in-browser mock, which is deliberate (nothing persists outside the API).
  await page.getByRole("navigation", { name: "Console" }).getByRole("link", { name: "Health, logs and audit" }).click();
  await page.getByRole("tab", { name: "Audit log" }).click();
  await page.getByLabel("Entity id").fill("tx-0016");
  await expect(page.getByTestId("audit-table")).toContainText("exception.resolve");
});

test("BC sync: Post batch only queues a request and says who posts", async ({ page }) => {
  await page.goto("/sync");
  await expect(page.getByTestId("batches-table")).toContainText("HHAPP/FEEDS");
  await page.getByTestId("post-FEEDS").click();
  const dialog = page.getByTestId("post-dialog");
  await expect(dialog).toContainText("post the batch in BC under your own sign-in");
  await dialog.getByTestId("post-confirm").click();
  await expect(page.getByRole("status")).toContainText("Recorded. HHAPP/FEEDS is posted under Cade's own BC sign-in");
});

test("reconciliation lists the 14 bank cards and the three loans", async ({ page }) => {
  await page.goto("/reconciliation");
  await expect(page.locator("[data-testid=recon-table] tbody tr")).toHaveCount(14);
  await expect(page.getByTestId("loan-loan-pennymac")).toContainText("PennyMac");
  await expect(page.getByTestId("loan-loan-frontier-1")).toContainText("Frontier CU");
  await expect(page.getByTestId("loan-loan-frontier-2")).toContainText("Frontier CU");
});

test("authority matrix highlights the I-09 TBD", async ({ page }) => {
  await page.goto("/authority");
  await expect(page.getByText("I-09").first()).toBeVisible();
  await expect(page.getByTestId("tbd-notice")).toBeVisible();
  await expect(page.locator("[data-tbd=true]").first()).toBeVisible();
});

test("health: failed jobs retry and the nightly page reads health.json", async ({ page }) => {
  await page.goto("/health?tab=jobs");
  const retry = page.getByRole("button", { name: "Retry" }).first();
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByRole("status")).toContainText("Requeued");
  await page.getByRole("tab", { name: "Nightly acceptance" }).click();
  await expect(page.getByTestId("nightly-table")).toContainText("A1");
});

test("connect a bank: Link (mocked), confirm where each account goes, and the login appears", async ({ page }) => {
  await page.goto("/health");
  await expect(page.getByTestId("feeds-table")).toContainText("Capital One");
  await page.getByTestId("connect-bank").click();
  const dialog = page.getByTestId("map-accounts-dialog");
  await expect(dialog).toContainText("Frontier Credit Union");
  await expect(dialog.getByLabel("Where Primary Share ending 7003 goes")).toHaveValue("acct-FRONTIER-SH");
  await expect(dialog.getByLabel("Where Auto Loan ending 0001 goes")).toHaveValue("");
  await dialog.getByTestId("save-mapping").click();
  await expect(page.getByRole("status")).toContainText("Frontier Credit Union connected: 1 account");
  await expect(page.getByTestId("feeds-table")).toContainText("Frontier Credit Union");
});
