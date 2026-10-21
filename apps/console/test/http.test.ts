// @vitest-environment node
/**
 * The HTTP client against a fake of the API's routes (shapes from services/api/src/routes and services/console.ts).
 * It checks the reconciliation decisions: which route each Console action uses, which calls carry step-up, and
 * that the client refuses rather than sends where the API has no route that does the right thing.
 */
import { describe, expect, it } from "vitest";
import { BANK_CARD_LIST, type AccountSummary, type Transaction } from "@homestead/shared";
import { createHttpApi, txQuestionId } from "../src/api/http";
import { ApiError } from "../src/api/types";
import * as data from "../src/api/mock/data";

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; json?: unknown } | undefined;

function fakeApi(handler: Handler) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: url.pathname + url.search, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = handler(call) ?? { status: 404, json: { error: "not_found", message: "no such route in the fake" } };
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const api = createHttpApi({
    getAuthHeaders: async () => ({ "x-dev-member": "m-cade" }),
    getStepUpHeaders: async () => ({ "x-dev-member": "m-cade", "x-step-up": "true" }),
    member: () => ({ id: "m-cade", displayName: "Cade" }),
    baseUrl: "http://api.test",
    fetchImpl,
  });
  return { api, calls };
}

// /v1/accounts as the API returns it: one account per bank card, by BC bank account code.
const accounts: AccountSummary[] = BANK_CARD_LIST.map((b, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  displayName: b.name,
  institution: b.institution,
  kind: b.kind as AccountSummary["kind"],
  mask: b.mask,
  feedStatus: b.code === "CAPONE-CC" ? "needs_relink" : b.code === "CASH" ? "none" : "ok",
  isRestricted: false,
  bcBankAccountCode: b.code,
  bcGlAccount: b.glAccount,
}));

// API-shaped transactions: the mock rows minus the Console-only fields.
const apiTx = (): Transaction[] =>
  data.transactions.map((t) => {
    const { accountName: _n, accountMask: _m, categoryName: _c, exception: _e, ...rest } = t;
    return { ...rest, splits: [...t.splits] };
  });

function queuesHandler(extra?: Handler): Handler {
  return (c) => {
    if (c.method === "GET" && c.path === "/v1/console/queues") {
      const all = apiTx();
      return { json: { counts: {}, transactions: all.filter((t) => t.state !== "exception"), exceptions: all.filter((t) => t.state === "exception"), receipts: data.receipts, rules: [], dataThrough: { at: "2026-10-20T12:00:00Z", quality: "imported_pending", pendingCount: 3 } } };
    }
    if (c.method === "GET" && c.path === "/v1/accounts") return { json: { accounts } };
    return extra?.(c);
  };
}

describe("HTTP ConsoleApi", () => {
  it("approves through the question API with 'confirm', not as a correction, and skips what is not ready", async () => {
    const { api, calls } = fakeApi(queuesHandler((c) => (c.method === "POST" && c.path.startsWith("/v1/questions/") ? { json: {} } : undefined)));
    const ready = (await api.transactions("ready_for_review")).items.filter((t) => t.categoryId);
    expect(ready.length).toBeGreaterThan(1);
    const ids = ready.slice(0, 2).map((t) => t.id);
    const r = await api.approveTransactions([...ids, "tx-0014" /* an exception */, "nope"]);
    expect(r.approved).toBe(2);
    expect(r.skipped.map((s) => s.id).sort()).toEqual(["nope", "tx-0014"]);
    const answers = calls.filter((c) => c.method === "POST");
    expect(answers.map((c) => c.path)).toEqual(ids.map((id) => `/v1/questions/${encodeURIComponent(txQuestionId(id))}/answer`));
    expect(answers.every((c) => (c.body as { optionId: string }).optionId === "confirm")).toBe(true);
    expect(calls.some((c) => c.path.includes("/correct"))).toBe(false);
  });

  it("sends step-up only on the calls the API guards", async () => {
    const tx = apiTx().find((t) => t.id === "tx-0016")!;
    const { api, calls } = fakeApi(
      queuesHandler((c) => {
        if (c.path === "/v1/console/exceptions/tx-0016/resolve") return { json: { ...tx, state: "posted" } };
        if (c.path === "/v1/console/posting/post-batch") return { status: 202, json: { batch: "FEEDS", outboxId: "ob-1", queuedAt: "2026-10-20T12:00:00Z", lineCount: 4, draftCount: 4, enqueued: false, message: "Recorded. HHAPP/FEEDS is posted under Cade's own BC sign-in." } };
        if (c.path === "/v1/console/outbox/ob-9/retry") return { json: { id: "ob-9", aggregate: "transaction", aggregateId: "tx-1", operation: "send_to_bc", attempts: 0, nextAttemptAt: "2026-10-20T12:00:00Z", deadLettered: false, createdAt: "2026-10-19T12:00:00Z" } };
        if (c.path === "/v1/rules/r-1/approve" || c.path === "/v1/rules/r-1/retire") return { json: { ...data.rules[0], id: "r-1" } };
        if (c.path === "/v1/transactions/tx-0001/business") return { json: apiTx()[0] };
        return undefined;
      }),
    );
    await api.resolveException("tx-0016", { to: "posted", note: "posted by hand", bcEntryNos: [4471], bcDocumentNo: "G01016", bcPostingDate: "2026-10-01" });
    const post = await api.postBatch("FEEDS");
    await api.retryOutbox("ob-9");
    await api.decideRule("r-1", "approve", "ok");
    await api.decideRule("r-1", "decline");
    await api.setBusinessFlag("tx-0001", "ctj");

    const stepUp = (path: string) => calls.find((c) => c.path === path)?.headers["x-step-up"];
    expect(stepUp("/v1/console/exceptions/tx-0016/resolve")).toBe("true");
    expect(stepUp("/v1/console/posting/post-batch")).toBe("true");
    expect(stepUp("/v1/console/outbox/ob-9/retry")).toBe("true");
    expect(stepUp("/v1/rules/r-1/approve")).toBe("true");
    expect(stepUp("/v1/rules/r-1/retire")).toBe("true");
    expect(stepUp("/v1/transactions/tx-0001/business")).toBeUndefined();

    expect(calls.find((c) => c.path === "/v1/console/exceptions/tx-0016/resolve")?.body).toEqual({ to: "posted", entryNos: [4471], documentNo: "G01016", postingDate: "2026-10-01", note: "posted by hand" });
    expect(calls.find((c) => c.path === "/v1/rules/r-1/retire")?.body).toEqual({ reason: "declined in the Console" });
    expect(post).toMatchObject({ batch: "FEEDS", outboxId: "ob-1", lineCount: 4, enqueued: false });
    expect(post.message).toMatch(/own BC sign-in/);
  });

  it("refuses a mapping proposal instead of sending one the API would apply as a settings change", async () => {
    const { api, calls } = fakeApi(() => undefined);
    await expect(api.proposeMapping({ categoryId: "groceries", glAccount: "501101", dims: {}, reason: "x" })).rejects.toMatchObject({ status: 501, code: "not_in_api" });
    expect(calls).toHaveLength(0);
  });

  it("builds the 14 bank cards from the reconciliation route and says what the API does not report", async () => {
    const chk = accounts.find((a) => a.bcBankAccountCode === "BEEHIVE-CHK")!;
    const { api } = fakeApi(
      queuesHandler((c) =>
        c.path === "/v1/console/reconciliation"
          ? { json: { accounts: [{ accountId: chk.id, displayName: chk.displayName, bcBankAccountCode: "BEEHIVE-CHK", posted: 9, reconciled: 212, bcNative: 3, differences: 1, lastPollAt: "2026-10-20T09:00:00Z" }] } }
          : undefined,
      ),
    );
    const r = await api.reconciliation();
    expect(r.bankCards).toHaveLength(BANK_CARD_LIST.length);
    const card = r.bankCards.find((b) => b.code === "BEEHIVE-CHK")!;
    expect(card.openCount).toBe(9); // posted and not yet reconciled; the two states are disjoint
    expect(card.reconciledCount).toBe(212);
    expect(card.feedStatus).toBe("ok");
    expect(r.bankCards.find((b) => b.code === "CAPONE-CC")?.feedStatus).toBe("needs_relink");
    expect(card.differences).toHaveLength(1);
    expect(r.loans).toEqual([]);
    expect(r.missing).toEqual(expect.arrayContaining(["loans", "openSum"]));
    expect(r.dataThrough).toMatchObject({ at: "2026-10-20T09:00:00Z", quality: "posted_unreconciled" });
  });

  it("fills receipt candidates from the receipt detail for the unmatched tab", async () => {
    const rec = { id: "rcpt-x", capturedAt: "2026-10-18T15:00:00Z", uploadedAt: "2026-10-18T15:00:05Z", sha256: "a".repeat(64), ocrStatus: "read", kind: "receipt", syncState: "synced", merchant: "WALMART", totalCents: 8412 };
    const t1 = apiTx()[0]!;
    const { api, calls } = fakeApi((c) => {
      if (c.path === "/v1/console/queues") return { json: { transactions: [t1], exceptions: [], receipts: [rec], rules: [] } };
      if (c.path === "/v1/receipts/rcpt-x") return { json: { ...rec, lines: [], candidates: [{ transactionId: t1.id, score: 0.71 }, { transactionId: "tx-elsewhere", score: 0.69 }] } };
      if (c.path === "/v1/transactions/tx-elsewhere") return { json: { ...t1, id: "tx-elsewhere", merchantRaw: "WAL-MART #1234" } };
      return undefined;
    });
    const page = await api.receipts("unmatched");
    expect(page.total).toBe(1);
    expect(page.items[0]?.candidates?.map((c) => [c.transactionId, c.confidence])).toEqual([
      [t1.id, 0.71],
      ["tx-elsewhere", 0.69],
    ]);
    expect(calls.filter((c) => c.path === `/v1/transactions/${t1.id}`)).toHaveLength(0); // found in the queue read
  });

  it("reads the header from /v1/me and employer templates from the mappings route", async () => {
    const employer = { id: "e-1", code: "HFH", name: "Henry's Fork Homes", memberName: "Cade", descriptorPattern: "henry", grossAccount: "401101", bonusAccount: "401102", components: [] };
    const { api, calls } = fakeApi((c) => {
      if (c.path === "/v1/me") return { json: { member: { id: "m-cade", displayName: "Cade", role: "member" }, household: { id: "hh-1", name: "Jones", timezone: "America/Boise", settingsVersion: 3 }, ledger: { tenantId: "t", environment: "CADE_Sandbox_vs25", companyId: "c-1", journalTemplate: "HHAPP", autoPostEnabled: false } } };
      if (c.path === "/v1/console/mappings") return { json: { catalogVersion: 2, categories: [], accounts: [], dimensions: { SPEND_CLASS: ["ESSENTIAL"], PROJECT: [] }, employers: [employer] } };
      return undefined;
    });
    const me = await api.me();
    expect(me).toMatchObject({ household: { id: "hh-1", settingsVersion: 3 }, ledger: { companyId: "c-1", environment: "CADE_Sandbox_vs25" } });
    const m = await api.mappings();
    expect(m.employers).toEqual([employer]);
    expect(m.dimensions.map((d) => [d.code, d.slot])).toEqual([
      ["SPEND_CLASS", "global1"],
      ["PROJECT", "shortcut5"],
    ]);
    expect(calls.map((c) => c.path)).toEqual(["/v1/me", "/v1/console/mappings"]);
  });

  it("turns the API's error body into an ApiError with its code", async () => {
    const { api } = fakeApi((c) => (c.path === "/v1/console/outbox/ob-1/retry" ? { status: 409, json: { error: "not_dead_lettered", message: "Only a dead-lettered row can be retried" } } : undefined));
    const err = await api.retryOutbox("ob-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "not_dead_lettered", message: "Only a dead-lettered row can be retried" });
  });
});
