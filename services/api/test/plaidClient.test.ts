/**
 * The Plaid client (request shapes against a recording fetch; https://plaid.com/docs/api/) and the fake. Only the
 * Transactions, Balance and Liabilities products; no Auth, nothing that moves money.
 */
import { describe, expect, it } from "vitest";
import { FakePlaid, PlaidClient, PlaidError, pendingKey, secretNameFor, toCents } from "../src/services/bankData/plaid.js";

function recorder(responses: Record<string, unknown>) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    const path = new URL(url).pathname;
    const r = responses[path];
    if (r instanceof Error) return new Response(JSON.stringify({ error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "x" }), { status: 400 });
    return new Response(JSON.stringify(r ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("PlaidClient", () => {
  it("creates link tokens for transactions with liabilities optional, and never asks for auth", async () => {
    const { calls, fetchImpl } = recorder({ "/link/token/create": { link_token: "link-sandbox-1", expiration: "2026-10-20T20:00:00Z" } });
    const c = new PlaidClient("sandbox", "client-id-name-only", "secret-from-vault", fetchImpl);
    const t = await c.createLinkToken({ clientUserId: "member-1", webhookUrl: "https://example.invalid/v1/webhooks/plaid" });
    expect(t.linkToken).toBe("link-sandbox-1");
    expect(calls[0]!.url).toBe("https://sandbox.plaid.com/link/token/create");
    expect(calls[0]!.body["products"]).toEqual(["transactions"]);
    expect(calls[0]!.body["optional_products"]).toEqual(["liabilities"]);
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/"auth"|transfer|payment_initiation/);
  });

  it("update mode names the Item and drops products; /accounts/get returns names and masks only", async () => {
    const { calls, fetchImpl } = recorder({
      "/link/token/create": { link_token: "link-sandbox-u", expiration: "2026-10-20T20:00:00Z" },
      "/accounts/get": { accounts: [{ account_id: "a1", name: "Quicksilver", official_name: "Capital One Quicksilver", mask: "6450", type: "credit", subtype: "credit card", balances: { current: 12 } }], item: { item_id: "i" } },
    });
    const c = new PlaidClient("production", "id", "s", fetchImpl);
    await c.createLinkToken({ clientUserId: "member-1", accessToken: "access-token-u", institutionId: "ins_9", webhookUrl: "https://example.invalid/v1/webhooks/plaid" });
    expect(calls[0]!.body).toMatchObject({ access_token: "access-token-u", user: { client_user_id: "member-1" }, webhook: "https://example.invalid/v1/webhooks/plaid" });
    expect(calls[0]!.body).not.toHaveProperty("products");
    expect(calls[0]!.body).not.toHaveProperty("optional_products");
    expect(calls[0]!.body).not.toHaveProperty("institution_id");
    const accts = await c.accountsGet("access-token-u");
    expect(calls[1]!.url).toBe("https://production.plaid.com/accounts/get");
    expect(accts).toEqual([{ account_id: "a1", name: "Quicksilver", official_name: "Capital One Quicksilver", mask: "6450", type: "credit", subtype: "credit card" }]);
  });

  it("syncs with the cursor and count, and maps liabilities", async () => {
    const { calls, fetchImpl } = recorder({
      "/transactions/sync": { added: [], modified: [], removed: [], next_cursor: "c2", has_more: false },
      "/liabilities/get": { liabilities: { credit: [{ account_id: "a1", aprs: [{ apr_percentage: 29.99 }], next_payment_due_date: "2026-11-17", minimum_payment_amount: 363 }], mortgage: [{ account_id: "m1", interest_rate_percentage: 6.25, next_monthly_payment: 5670.39 }] } },
    });
    const c = new PlaidClient("production", "id", "s", fetchImpl);
    await c.transactionsSync("access-token-x", "c1");
    expect(calls[0]!.url).toBe("https://production.plaid.com/transactions/sync");
    expect(calls[0]!.body).toMatchObject({ access_token: "access-token-x", cursor: "c1", count: 250 });
    const l = await c.liabilitiesGet("access-token-x");
    expect(l).toEqual([
      { account_id: "a1", kind: "credit", aprPercent: 29.99, nextPaymentDueDate: "2026-11-17", minimumPaymentAmount: 363 },
      { account_id: "m1", kind: "mortgage", aprPercent: 6.25, minimumPaymentAmount: 5670.39 },
    ]);
  });

  it("raises PlaidError with the error code (ITEM_LOGIN_REQUIRED drives re-link)", async () => {
    const { fetchImpl } = recorder({ "/transactions/sync": new Error("x") });
    await expect(new PlaidClient("sandbox", "id", "s", fetchImpl).transactionsSync("t", null)).rejects.toMatchObject({ errorCode: "ITEM_LOGIN_REQUIRED" });
  });
});

describe("helpers and the fake", () => {
  it("turns Plaid's positive-out amounts into bank-sign cents", () => {
    expect(toCents(45.17)).toBe(-4517);
    expect(toCents(-250)).toBe(25000);
    expect(pendingKey("p-1")).toBe("pending:p-1");
  });
  it("names the vault secret by household and item, never holding the token", () => {
    expect(secretNameFor("12345678-aaaa", "item-sandbox-ABC_def")).toBe("plaid-12345678-item-sandbox-ABCdef");
  });
  it("serves queued pages in order, then an empty page with the same cursor", async () => {
    const f = new FakePlaid();
    f.queue("tok", { next_cursor: "c1", has_more: true });
    f.queue("tok", { next_cursor: "c2", has_more: false });
    expect((await f.transactionsSync("tok", null)).has_more).toBe(true);
    expect((await f.transactionsSync("tok", "c1")).next_cursor).toBe("c2");
    expect((await f.transactionsSync("tok", "c2")).next_cursor).toBe("c2");
    f.failNextSync = new PlaidError("ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "x");
    await expect(f.transactionsSync("tok", "c2")).rejects.toBeInstanceOf(PlaidError);
    expect((await f.institutionsSearch("frontier")).length).toBe(0);
    expect((await f.institutionsSearch("beehive"))[0]?.institution_id).toBe("ins_beehive");
  });
});
