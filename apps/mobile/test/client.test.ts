/**
 * HttpApi against a fake fetch: the paths and bodies match services/api/openapi.yaml, the sign-in headers and the
 * step-up proof are added, the error envelope becomes typed errors, and the routes that exist in the API's code
 * but not yet in the OpenAPI document fall back cleanly.
 */
import { describe, expect, it } from "vitest";
import type { MemberSummary } from "@homestead/shared";
import { HttpApi, type AuthHeaderSource } from "@/api/client";
import { ApiError, StepUpRequiredError } from "@/api/types";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const VANESSA: MemberSummary = { id: "11111111-1111-4111-8111-111111111111", displayName: "Vanessa", role: "member" };
const dt = { at: "2026-10-19T23:59:00-06:00", quality: "imported_pending", pendingCount: 2 };

function setup(routes: Record<string, (call: Call) => { status: number; body?: unknown }>, opts: { fresh?: boolean } = {}) {
  const calls: Call[] = [];
  let unauthorized = 0;
  const auth: AuthHeaderSource = {
    async headers(o) {
      const h: Record<string, string> = { "x-dev-member": VANESSA.id };
      if (o?.stepUp && opts.fresh !== false) h["x-step-up"] = "true";
      return h;
    },
    currentMember: () => VANESSA,
    onUnauthorized: () => void (unauthorized += 1),
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? "GET",
      url: `${u.pathname}${u.search}`,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${u.pathname}`];
    const r = handler ? handler(call) : { status: 404, body: { error: "not_found" } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const api = new HttpApi({ baseUrl: "http://api.test/", auth, fetchFn });
  return { api, calls, unauthorized: () => unauthorized };
}

describe("HttpApi", () => {
  it("sends the member header and builds the activity query from the filters", async () => {
    const { api, calls } = setup({ "GET /v1/transactions": () => ({ status: 200, body: { transactions: [], dataThrough: dt } }) });
    await api.transactions({ q: "walmart", status: "needs_answer", limit: 100, cursor: "" });
    expect(calls[0]?.url).toBe("/v1/transactions?q=walmart&status=needs_answer&limit=100");
    expect(calls[0]?.headers["x-dev-member"]).toBe(VANESSA.id);
    expect(calls[0]?.headers["x-step-up"]).toBeUndefined();
  });

  it("answers a question with the option id and adds the step-up proof only when asked", async () => {
    const { api, calls } = setup({
      "POST /v1/questions/tx%3Aabc/answer": () => ({ status: 200, body: { transaction: { id: "abc" } } }),
      "POST /v1/questions/apr%3Aq1/answer": () => ({ status: 200, body: { approval: { id: "q1", payload: { revisionNo: 3 } } } }),
    });
    await api.answerQuestion("tx:abc", { optionId: "category:groceries", categoryId: "groceries" });
    expect(calls[0]?.body).toEqual({ optionId: "category:groceries", categoryId: "groceries" });
    expect(calls[0]?.headers["x-step-up"]).toBeUndefined();
    await api.answerQuestion("apr:q1", { optionId: "approve" }, { stepUp: true });
    expect(calls[1]?.headers["x-step-up"]).toBe("true");
  });

  it("turns 403 step_up_required into StepUpRequiredError and other errors into ApiError with the code", async () => {
    const { api, unauthorized } = setup(
      {
        "POST /v1/approvals/a1/decide": () => ({ status: 403, body: { error: "step_up_required", message: "Confirm with Face ID (or your passcode) first" } }),
        "POST /v1/approvals/a2/decide": () => ({ status: 403, body: { error: "other_spouse_decides" } }),
        "GET /v1/goals": () => ({ status: 401, body: { error: "unauthorized" } }),
      },
      { fresh: false },
    );
    await expect(api.decideApproval("a1", "declined")).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(api.decideApproval("a2", "approved")).rejects.toMatchObject({ status: 403, code: "other_spouse_decides" });
    await expect(api.goals()).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized()).toBe(1);
  });

  it("proposes a budget move and a merchant rule with the OpenAPI bodies", async () => {
    const { api, calls } = setup({
      "POST /v1/budget/moves": () => ({ status: 201, body: { id: "m1", kind: "budget_move", payload: {}, requestedBy: VANESSA.id, requestedAt: "x", stepUpVerified: false } }),
      "POST /v1/rules": () => ({ status: 201, body: { id: "r1" } }),
    });
    await api.proposeBudgetMove({ fromCategoryId: "fun-shopping", toCategoryId: "gas-car", amountCents: 7500, month: "2026-10" });
    expect(calls[0]?.body).toEqual({ fromCategoryId: "fun-shopping", toCategoryId: "gas-car", amountCents: 7500, month: "2026-10" });
    await api.proposeRule({ merchantNorm: "maverik", categoryId: "fuel", name: "Maverik → Fuel" });
    expect(calls[1]?.body).toEqual({ kind: "merchant", name: "Maverik → Fuel", match: { merchantNorm: "maverik", direction: "out" }, action: { categoryId: "fuel" }, mayAutoPost: false });
  });

  it("uploads a receipt as multipart with sha256, capturedAt, offlineId and kind; 200 means already held", async () => {
    const summary = { id: "r1", capturedAt: "2026-10-20T15:00:00.000Z", sha256: "a".repeat(64), ocrStatus: "queued", syncState: "synced" };
    let status = 201;
    const { api, calls } = setup({ "POST /v1/receipts": () => ({ status, body: summary }) });
    const first = await api.uploadReceipt({ fileUri: "file:///doc/receipts/x.jpg", sha256: "a".repeat(64), capturedAt: summary.capturedAt, offlineId: "man:x", bytes: 10 });
    expect(first.alreadyHeld).toBe(false);
    const form = calls[0]?.body as FormData;
    expect(form.get("sha256")).toBe("a".repeat(64));
    expect(form.get("capturedAt")).toBe(summary.capturedAt);
    expect(form.get("offlineId")).toBe("man:x");
    expect(form.get("kind")).toBe("receipt");
    expect(form.has("file")).toBe(true);
    status = 200;
    expect((await api.uploadReceipt({ fileUri: "file:///y.jpg", sha256: "a".repeat(64), capturedAt: summary.capturedAt, offlineId: "man:y", bytes: 10 })).alreadyHeld).toBe(true);
  });

  it("reads who is who from /v1/me (the member ids the approvals use)", async () => {
    const { api, calls } = setup({
      "GET /v1/me": () => ({
        status: 200,
        body: {
          member: { id: "m-v", displayName: "Vanessa", role: "member" },
          members: [{ id: "m-v", displayName: "Vanessa", role: "member" }, { id: "m-c", displayName: "Cade", role: "member" }],
          household: { id: "h", name: "Jones", timezone: "America/Boise", currency: "USD", settingsVersion: 3, quietHours: { start: "21:00", end: "07:00" }, nextPayday: "2026-10-23", today: "2026-10-20" },
        },
      }),
    });
    const me = await api.me();
    expect(me.member.id).toBe("m-v");
    expect(me.members.find((m) => m.id !== me.member.id)?.displayName).toBe("Cade");
    expect(me.household).toEqual({ id: "h", name: "Jones", timezone: "America/Boise", quietHours: { start: "21:00", end: "07:00" }, nextPaydayIso: "2026-10-23" });
    expect(calls.map((c) => c.url)).toEqual(["/v1/me"]);
  });

  it("prefers /v1/safe-to-spend and the member alerts route", async () => {
    const sts = { safeCents: 1, cashCents: 1, setAsideCents: 0, billsBeforePaydayCents: 0, billsBeforePayday: [], givingDueCents: 0, liquidityFloorCents: 0, nextPaydayIso: "2026-10-23", daysUntilPayday: 3, perDayCents: 0, balanceAsOf: dt.at, status: "watch", dataThrough: dt, accountsWithoutBalance: 0 };
    const { api, calls } = setup({
      "GET /v1/safe-to-spend": () => ({ status: 200, body: sts }),
      "GET /v1/bills": () => ({ status: 200, body: { bills: [], nextPayday: "2026-10-23", dataThrough: dt } }),
      "GET /v1/budget": () => ({ status: 500, body: { error: "internal" } }),
      "GET /v1/alerts": () => ({ status: 200, body: { alerts: [{ id: "a", kind: "receipt_missing", level: "watch", fingerprint: "f", title: "t", body: "b", createdAt: dt.at }], dataThrough: dt } }),
    });
    expect((await api.safeToSpend()).status).toBe("watch");
    expect(calls.some((c) => c.url === "/v1/bills/safe-to-spend")).toBe(false);
    expect((await api.alerts()).map((a) => a.id)).toEqual(["a"]);
    expect(calls.some((c) => c.url === "/v1/console/alerts")).toBe(false);
  });

  it("falls back to /bills/safe-to-spend on an older API and names the bills from /bills", async () => {
    const { api } = setup({
      "GET /v1/bills/safe-to-spend": () => ({
        status: 200,
        body: {
          safeCents: 44042, cashCents: 101202, setAsideCents: 30000, billsBeforePaydayCents: 27160,
          billsBeforePayday: [{ dueDateIso: "2026-10-20", amountCents: 15320 }, { dueDateIso: "2026-10-22", amountCents: 11840 }],
          givingDueCents: 0, liquidityFloorCents: 0, nextPaydayIso: "2026-10-23", daysUntilPayday: 3, perDayCents: 14680,
          balanceAsOf: dt.at, status: "on_track", dataThrough: dt, accountsWithoutBalance: 0,
        },
      }),
      "GET /v1/bills": () => ({ status: 200, body: { bills: [{ id: "b1", name: "Verizon · phones", dueDate: "2026-10-20", amountCents: 15320, isMinimum: false, beforePayday: true, paid: false }, { id: "b2", name: "Rocky Mountain Power", dueDate: "2026-10-22", amountCents: 11840, isMinimum: false, beforePayday: true, paid: false }], nextPayday: "2026-10-23", dataThrough: dt } }),
      "GET /v1/budget": () => ({ status: 200, body: { month: "2026-10", budgetName: "sample", isSample: true, lines: [{ categoryId: "g", name: "Groceries", budgetCents: 190000, spentCents: 141000, leftCents: 49000, pace: "on_track", forecastCents: 178000 }], dataThrough: dt } }),
    });
    const s = await api.safeToSpend();
    expect(s.safeCents).toBe(44042);
    expect(s.billsBeforePayday.map((b) => b.name)).toEqual(["Verizon · phones", "Rocky Mountain Power"]);
    expect(s.forecast).toBe("At this pace you'll finish the month about $120 under budget.");
  });

  it("composes safe to spend on the phone when the API has no route for it (404)", async () => {
    const { api, calls } = setup({
      "GET /v1/bills": () => ({ status: 200, body: { bills: [{ id: "b1", name: "Verizon", dueDate: "2099-01-01", amountCents: 100, isMinimum: false, beforePayday: false, paid: false }], nextPayday: "2099-01-02", dataThrough: dt } }),
      "GET /v1/accounts": () => ({ status: 200, body: { accounts: [{ id: "c", displayName: "Checking", institution: "Beehive", kind: "checking", mask: "4821", balanceCents: 50000, balanceAsOf: dt.at, feedStatus: "ok" }], dataThrough: dt } }),
      "GET /v1/goals": () => ({ status: 200, body: { goals: [], dataThrough: dt } }),
    });
    const s = await api.safeToSpend();
    expect(s.cashCents).toBe(50000);
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(["/v1/safe-to-spend", "/v1/bills/safe-to-spend", "/v1/accounts", "/v1/goals"]));
  });

  it("registers the push token, and treats a missing push or export route (older API) as not available", async () => {
    const { api, calls } = setup({ "POST /v1/devices/push-token": () => ({ status: 204 }) });
    await api.registerPushToken({ token: "ExponentPushToken[x]", platform: "ios" });
    expect(calls[0]?.body).toEqual({ token: "ExponentPushToken[x]", platform: "ios" });
    expect(await api.requestExport()).toEqual({ requested: false, available: false });
    const second = setup({ "POST /v1/export": () => ({ status: 202, body: { requestId: "e1", status: "requested" } }) });
    expect(await second.api.requestExport()).toEqual({ requested: true, available: true });
    expect(second.calls[0]?.headers["x-step-up"]).toBe("true");
  });

  it("finds the other spouse and quiet hours on an API without /me", async () => {
    const { api } = setup({
      "GET /v1/approvals": () => ({ status: 200, body: { approvals: [{ id: "a", kind: "budget_move", payload: {}, requestedBy: "22222222-2222-4222-8222-222222222222", requestedByName: "Cade", requestedAt: "x", stepUpVerified: false }, { id: "b", kind: "budget_move", payload: {}, requestedBy: "oid-of-vanessa", requestedByName: "Vanessa", requestedAt: "x", stepUpVerified: false }] } }),
      "GET /v1/bills": () => ({ status: 200, body: { bills: [], nextPayday: "2026-10-23", dataThrough: dt } }),
      "GET /v1/console/settings": () => ({ status: 200, body: { version: 1, settings: { quietHours: { start: "21:30", end: "06:30" } } } }),
    });
    const me = await api.me();
    expect(me.members.map((m) => m.displayName)).toEqual(["Vanessa", "Cade"]);
    expect(me.household.quietHours).toEqual({ start: "21:30", end: "06:30" });
    expect(me.household.nextPaydayIso).toBe("2026-10-23");
  });
});
