/**
 * Gate 4 acceptance tests A1–A9 (spec: "Test strategy"), run end to end through the API, the jobs and the ledger:
 * against the BC sandbox when its secrets are set (harness/target.ts), otherwise against MockBcServer behind the real
 * adapter. Results are read back from the ledger, never inferred. The database-backed tests need DATABASE_URL and
 * skip without it. After the run the health report the Console shows is written (harness/report.ts).
 *
 * Steps that need Cade's own BC sign-in in the sandbox (posting FEEDS/RECEIPTS, bank reconciliation, a recurring
 * journal) raise ManualStep and the test is skipped there with that reason; the mock does them through BC's API.
 */
import { CATEGORIES, externalDocumentNo, idempotencyKey, isSpendingAccount, sha256Hex, type DataThrough } from "@homestead/shared";
import { LedgerError, closePool, listRules, loadTx, type GlEntry, type InMemoryQueue, type TxRow } from "@homestead/api";
import { afterAll, beforeAll, describe, expect, it, type TestContext } from "vitest";
import { Recorder } from "./harness/report.js";
import { ManualStep, bcSide, sandboxConfigured } from "./harness/target.js";
import { as, makeWorld, multipart, readFixture, type ReceiptFixture, type World } from "./harness/world.js";

const hasDb = Boolean(process.env["DATABASE_URL"]);
const side = bcSide();
const recorder = new Recorder(side.kind === "sandbox" ? "bc-sandbox" : "mock-bc");

const NAMES: Record<string, string> = {
  A1: "Receipt matches its bank line, posts as a draft with the account and dimensions, entry IDs come back, reconciles, no duplicates on resends",
  A2: "A transfer, a card payment and a loan payment never show as spending",
  A3: "A Walmart receipt splits by line into the right categories",
  A4: "A CTJ-paid personal bill lands in 404102 (and a business card charge in 112101)",
  A5: "Offline capture syncs cleanly",
  A6: "A webhook outage is caught by the polling reconciliation",
  A7: "Safe-to-spend excludes restricted funds and covers bills due before the next paycheck",
  A8: "A budget change needs the other spouse's approval and writes a versioned revision",
  A9: "Everything shown in the app ties to BC with the data-through date displayed",
};

/** One acceptance test: recorded for the health report; ManualStep in the sandbox skips it with the reason. */
function acceptance(id: string, fn: (ctx: TestContext) => Promise<void>): void {
  const name = NAMES[id]!;
  if (!hasDb) {
    it.skip(`${id} ${name} (needs DATABASE_URL)`, () => undefined);
    recorder.record(id, name, "skipped", undefined, "DATABASE_URL not set");
    return;
  }
  it(`${id} ${name}`, async (ctx) => {
    const t0 = Date.now();
    try {
      await fn(ctx);
      recorder.record(id, name, "pass", Date.now() - t0);
    } catch (e) {
      if (e instanceof ManualStep) {
        recorder.record(id, name, "skipped", Date.now() - t0, e.message);
        ctx.skip();
        return;
      }
      recorder.record(id, name, "fail", Date.now() - t0, (e as Error).message);
      throw e;
    }
  });
}

afterAll(() => {
  recorder.write();
});

describe("acceptance harness", () => {
  it("picks the mock unless every sandbox secret is set, and refuses a non-sandbox environment", () => {
    expect(sandboxConfigured({})).toBe(false);
    expect(sandboxConfigured({ BC_SANDBOX_TENANT_ID: "t", BC_SANDBOX_COMPANY_ID: "c", BC_SANDBOX_CLIENT_ID: "a" })).toBe(false);
    expect(side.kind).toBe(sandboxConfigured() ? "sandbox" : "mock");
    expect(() => bcSide({ BC_SANDBOX_TENANT_ID: "t", BC_SANDBOX_COMPANY_ID: "c", BC_SANDBOX_CLIENT_ID: "a", BC_SANDBOX_CERT_PEM: "x", BC_SANDBOX_ENVIRONMENT: "Production" })).toThrow(/non-sandbox/);
  });

  it("writes the health report the Console reads", () => {
    const r = new Recorder("mock-bc");
    r.record("A2", NAMES["A2"]!, "pass", 12);
    r.record("A10", "later", "skipped");
    r.record("A1", NAMES["A1"]!, "fail", 3, "boom");
    r.record("FF", "Forced-failure batch", "pass");
    const rep = r.report(new Date("2026-10-20T08:00:00Z"));
    expect(rep.acceptance.map((x) => x.id)).toEqual(["A1", "A2", "A10"]);
    expect(rep.resilience).toEqual([{ id: "FF", name: "Forced-failure batch", status: "pass" }]);
    expect(rep).toMatchObject({ generatedAt: "2026-10-20T08:00:00.000Z", environment: "mock-bc" });
  });
});

const d = hasDb ? describe : describe.skip;

d("A1–A9", () => {
  let w: World;
  let today = "";
  beforeAll(async () => {
    w = await makeWorld(side, side.kind);
    today = new Date().toISOString().slice(0, 10);
    // Webhook subscriptions first, so BC's notifications reach the app during the run.
    await w.job("webhook-renewal");
  });
  afterAll(async () => {
    await w?.close();
    await closePool();
  });

  const tx = (id: string): Promise<TxRow> => w.db((db) => loadTx(db, id));
  const txByKey = async (key: string): Promise<TxRow> => w.db(async (db) => loadTx(db, (await db.query<{ id: string }>("select id from transactions where household_id = $1 and idempotency_key = $2", [w.hh.householdId, key])).rows[0]!.id));
  const entries = (doc: string): Promise<GlEntry[]> => w.side.ledger.readGlEntriesByExternalDocNo({ externalDocumentNo: doc });
  const outboxLinesOf = async (id: string) => w.db(async (db) => (await db.query<{ payload: { lines: { accountType: string; accountNo: string; amountCents: number }[] } }>("select payload from outbox where aggregate_id = $1 and operation = 'send_to_bc'", [id])).rows[0]!.payload.lines);
  const answer = async (memberId: string, questionId: string, optionId: string, stepUp = false) => {
    const r = await w.app.inject({ method: "POST", url: `/v1/questions/${encodeURIComponent(questionId)}/answer`, headers: as(memberId, stepUp), payload: { optionId } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { transaction?: { id: string; state: string } };
  };
  const upload = async (memberId: string, f: ReceiptFixture, capturedAt: string, offlineId: string) => {
    const bytes = new TextEncoder().encode(f.imageText);
    const m = multipart({ sha256: sha256Hex(bytes), capturedAt, offlineId }, { name: `${offlineId}.jpg`, contentType: "image/jpeg", bytes });
    return w.app.inject({ method: "POST", url: "/v1/receipts", headers: { ...as(memberId), ...m.headers }, payload: m.body });
  };

  acceptance("A1", async () => {
    const f = readFixture<ReceiptFixture & { bank: { plaidAccountId: string; transactionId: string; date: string; amount: number; name: string; merchant_name: string } }>("../fixtures/receipts/broulims-2026-10-18.json");
    w.addReceiptFixture(f, "groceries");
    w.plaidTx("BEEHIVE-CHK", f.bank.transactionId, f.bank.date, f.bank.amount, f.bank.name, f.bank.merchant_name);
    await w.job("plaid-sync");
    await w.job("matching");
    const key = idempotencyKey.plaid(f.bank.plaidAccountId, f.bank.transactionId);
    const bankLine = await txByKey(key);
    // Vanessa snaps the receipt; it is read, mapped, matched and split.
    const up = await upload(w.hh.members.vanessa, f, "2026-10-18T17:40:00-06:00", "a1-queue-1");
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ matchedTransactionId: bankLine.id, ocrStatus: "read" });
    const q = (await w.app.inject({ method: "GET", url: "/v1/questions", headers: as(w.hh.members.vanessa) })).json().questions.find((x: { transactionId?: string }) => x.transactionId === bankLine.id);
    expect(q.kind).toBe("confirm_split");
    await answer(w.hh.members.vanessa, q.id, "confirm");
    await w.job("outbox-relay");
    const drafted = await tx(bankLine.id);
    expect(drafted).toMatchObject({ state: "bc_draft_created", bc_batch: "RECEIPTS" });
    const doc = drafted.bc_external_doc_no!;
    expect(doc).toBe(externalDocumentNo(key, "2026-10-19"));
    // The draft in HHAPP/RECEIPTS: 603101 with the dimension set of Groceries, as BC holds it.
    const found = await w.side.ledger.findByExternalDocumentNo(doc);
    expect(found).toMatchObject({ batch: "RECEIPTS", lineCount: 2, sumCents: 0 });
    if (w.side.server) {
      const g = w.side.server.draftLines("RECEIPTS").find((l) => l.externalDocumentNumber === doc && l.accountNumber === "603101")!;
      expect(Object.fromEntries(g.dimensionSetLines.map((x) => [x.code, x.valueCode]))).toEqual({ SPEND_CLASS: "ESSENTIAL", FAMILY_AREA: "JOINT", TAX_TREATMENT: "NONDEDUCT" });
    }
    // Cade posts the batch in BC; the webhook notification reaches the app and the read-back records the entries.
    await w.side.postAsCade("RECEIPTS");
    await w.job("outbox-relay"); // the receiver queued a bc_readback; the worker runs it
    const posted = await tx(bankLine.id);
    expect(posted.state).toBe("posted");
    expect(posted.bc_entry_nos).toHaveLength(2);
    expect((await entries(doc)).map((e) => e.entryNo).sort()).toEqual([...posted.bc_entry_nos!].sort());
    // The poll agrees.
    const poll = (await w.job("nightly-poll")) as { counts: Record<string, Record<string, number>> };
    expect(poll.counts[w.hh.householdId]!["differences"]).toBe(0);
    // Bank reconciliation in BC closes the bank ledger entry: Matched to the bank.
    await w.side.reconcile(doc, "STMT-2026-10", "2026-10-31");
    await w.job("bc-readback");
    expect((await tx(bankLine.id)).state).toBe("reconciled");
    // Resend the outbox message three times: still one document.
    for (let i = 0; i < 3; i += 1) {
      await w.db((db) => db.query("update outbox set completed_at = null, published_at = now(), next_attempt_at = now() - interval '1 minute' where aggregate_id = $1 and operation = 'send_to_bc'", [bankLine.id]));
      await w.job("bc-worker");
    }
    expect(await entries(doc)).toHaveLength(2);
    expect((await w.side.ledger.findByExternalDocumentNo(doc)).journalLineIds).toEqual([]);
    expect((w.deps.queue as InMemoryQueue).depth?.("homestead-outbox") ?? 0).toBe(0);
  });

  acceptance("A2", async () => {
    const rules = await w.db((db) => listRules(db, w.hh.householdId, "proposed"));
    for (const ruleNo of ["R2", "R3", "R7"]) {
      const r = rules.find((x) => x.rule_no === ruleNo)!;
      const res = await w.app.inject({ method: "POST", url: `/v1/rules/${r.id}/approve`, headers: as(w.hh.members.cade, true), payload: { approvalNote: `Approved in writing by Cade for the acceptance run (${ruleNo})` } });
      expect(res.statusCode, res.body).toBe(200);
    }
    await w.side.nativePayment("AFCU-CHK", "2026-11-01", -567039, "RJ-PM-1101");
    w.plaidTx("BEEHIVE-CHK", "a2-xfer-out", "2026-10-21", 500, "ONLINE TRANSFER TO SAVINGS");
    w.plaidTx("BEEHIVE-SAV", "a2-xfer-in", "2026-10-22", -500, "ONLINE TRANSFER FROM CHECKING");
    w.plaidTx("AFCU-CHK", "a2-pay-out", "2026-10-23", 363, "CAPITAL ONE ONLINE PMT");
    w.plaidTx("CAPONE-CC", "a2-pay-in", "2026-10-24", -363, "PAYMENT THANK YOU");
    w.plaidTx("AFCU-CHK", "a2-pennymac", "2026-11-01", 5670.39, "PENNYMAC LOAN SERVICES PAYMENT");
    for (let i = 0; i < 5; i += 1) await w.job("plaid-sync");
    await w.job("matching");
    const k = (code: string, id: string) => idempotencyKey.plaid(({ "BEEHIVE-CHK": "plaid-beehive-chk", "BEEHIVE-SAV": "plaid-beehive-sav", "AFCU-CHK": "plaid-afcu-chk", "CAPONE-CC": "plaid-capone-cc" } as Record<string, string>)[code]!, id);
    const [xo, xi, po, pi, pm] = await Promise.all([txByKey(k("BEEHIVE-CHK", "a2-xfer-out")), txByKey(k("BEEHIVE-SAV", "a2-xfer-in")), txByKey(k("AFCU-CHK", "a2-pay-out")), txByKey(k("CAPONE-CC", "a2-pay-in")), txByKey(k("AFCU-CHK", "a2-pennymac"))]);
    expect([xo.kind, po.kind, pm.kind]).toEqual(["transfer", "transfer", "bc_native"]);
    expect(pm.state).toBe("reconciled");
    await w.job("outbox-relay");
    await w.side.postAsCade("FEEDS");
    await w.job("bc-readback");
    const posted: GlEntry[] = [];
    for (const t of [xo, xi, po, pi]) {
      const now = await tx(t.id);
      expect(now.state).toBe("posted");
      posted.push(...(await entries(now.bc_external_doc_no!)));
    }
    const net = (acct: string) => posted.filter((e) => e.accountNo === acct).reduce((s, e) => s + e.amountCents, 0);
    expect(net("115101")).toBe(0);
    expect(net("115201")).toBe(0);
    expect(posted.filter((e) => isSpendingAccount(e.accountNo))).toEqual([]);
    const budget = (await w.app.inject({ method: "GET", url: "/v1/budget?month=2026-10", headers: as(w.hh.members.vanessa) })).json();
    expect(budget.lines.some((l: { categoryId: string; spentCents: number }) => ["transfer-own", "card-payment"].includes(l.categoryId))).toBe(false);
  });

  acceptance("A3", async () => {
    const names = ["walmart-1-mixed", "walmart-2-big-grocery", "walmart-3-groceries-only", "walmart-4-school-electronics", "walmart-5-rounding"];
    const fixtures = names.map((n) => readFixture<ReceiptFixture & { bank: { postedDate: string; amountCents: number; merchant: string }; expected: { splits: { categoryId: string; amountCents: number }[] } }>(`../../services/api/test/fixtures/walmart/${n}.json`));
    for (const f of fixtures) {
      w.addReceiptFixture(f);
      w.plaidTx("CAPONE-CC", `a3-${f.name}`, f.bank.postedDate, -f.bank.amountCents / 100, f.bank.merchant, f.bank.merchant);
    }
    for (let i = 0; i < fixtures.length; i += 1) await w.job("plaid-sync");
    await w.job("matching");
    for (const f of fixtures) {
      const up = await upload(w.hh.members.vanessa, f, `${f.read.date}T18:00:00-06:00`, `a3-${f.name}`);
      expect(up.statusCode).toBe(201);
      const t = await txByKey(idempotencyKey.plaid("plaid-capone-cc", `a3-${f.name}`));
      expect(up.json().matchedTransactionId).toBe(t.id);
      const q = (await w.app.inject({ method: "GET", url: "/v1/questions", headers: as(w.hh.members.vanessa) })).json().questions.find((x: { transactionId?: string }) => x.transactionId === t.id);
      expect(q.kind).toBe("confirm_split");
      expect(q.splits.map((s: { amountCents: number }) => s.amountCents)).toEqual(f.expected.splits.map((s) => s.amountCents));
      await answer(w.hh.members.vanessa, q.id, "confirm");
    }
    await w.job("outbox-relay");
    for (const f of fixtures) {
      const t = await txByKey(idempotencyKey.plaid("plaid-capone-cc", `a3-${f.name}`));
      const lines = await outboxLinesOf(t.id);
      const glByCat = new Map(CATEGORIES.map((c) => [c.id, c.glAccount]));
      expect(lines.filter((l) => l.accountType === "G/L Account").map((l) => [l.accountNo, -l.amountCents])).toEqual(f.expected.splits.map((s) => [glByCat.get(s.categoryId), s.amountCents]));
      expect((await w.side.ledger.findByExternalDocumentNo(t.bc_external_doc_no!)).lineCount).toBe(f.expected.splits.length + 1);
    }
  });

  acceptance("A4", async () => {
    w.plaidTx("CAPONE-CC", "a4-pay", "2026-10-25", -363, "PAYMENT THANK YOU");
    w.plaidTx("CAPONE-CC", "a4-charge", "2026-10-25", 129.99, "MICROSOFT 365 BUSINESS");
    await w.job("plaid-sync");
    await w.job("plaid-sync");
    await w.job("matching");
    const pay = await txByKey(idempotencyKey.plaid("plaid-capone-cc", "a4-pay"));
    const charge = await txByKey(idempotencyKey.plaid("plaid-capone-cc", "a4-charge"));
    for (const [t, cat] of [[pay, "card-payment"], [charge, "software"]] as const) {
      expect((await w.app.inject({ method: "POST", url: `/v1/transactions/${t.id}/business`, headers: as(w.hh.members.cade), payload: { flag: "ctj" } })).statusCode).toBe(200);
      await answer(w.hh.members.cade, `tx:${t.id}`, `category:${cat}`);
    }
    await w.job("outbox-relay");
    const bcLines = async (t: TxRow) => {
      const doc = (await tx(t.id)).bc_external_doc_no!;
      if (w.side.server) return w.side.server.draftLines("FEEDS").filter((l) => l.externalDocumentNumber === doc).map((l) => [l.accountNumber, Math.round(l.amount * 100)]);
      return (await outboxLinesOf(t.id)).map((l) => [l.accountNo, l.amountCents]);
    };
    expect(await bcLines(pay)).toEqual([["CAPONE-CC", 36300], ["404102", -36300]]);
    expect(await bcLines(charge)).toEqual([["CAPONE-CC", -12999], ["112101", 12999]]);
  });

  acceptance("A5", async () => {
    // Server half: two captures made offline arrive later, possibly twice; each lands once with the same hash.
    const caps: ReceiptFixture[] = [1, 2].map((i) => ({ imageText: `synthetic offline capture ${i}`, read: { merchant: "Maverik", date: "2026-10-26", totalCents: 500 * i, taxCents: 0, items: [{ description: "FOUNTAIN DRINK", amountCents: 500 * i, confidence: 0.9 }], fieldConfidence: {} } }));
    caps.forEach((c) => w.addReceiptFixture(c, "treats"));
    const first = await Promise.all(caps.map((c, i) => upload(w.hh.members.vanessa, c, "2026-10-26T08:00:00-06:00", `offline-${i}`)));
    const replay = await Promise.all(caps.map((c, i) => upload(w.hh.members.vanessa, c, "2026-10-26T08:00:00-06:00", `offline-${i}`)));
    expect(first.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(replay.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(replay.map((r) => r.json().id)).toEqual(first.map((r) => r.json().id));
    expect(first.map((r) => r.json().sha256)).toEqual(caps.map((c) => sha256Hex(new TextEncoder().encode(c.imageText))));
    // The device half (camera, encrypted queue, "not synced yet", network cut) is apps/mobile's queue tests and the Maestro flow.
  });

  acceptance("A6", async () => {
    // Only this run's subscriptions: in the sandbox the pilot's live ones (same app registration) must survive.
    const mine = async () => w.db(async (db) => (await db.query<{ subscription_id: string }>("select subscription_id from bc_webhook_subscriptions where household_id = $1", [w.hh.householdId])).rows.map((r) => r.subscription_id));
    const before = await mine();
    expect(before.length).toBe(2);
    await w.side.dropSubscriptions(before);
    expect(await w.side.subscriptionCount(before)).toBe(0);
    w.plaidTx("BEEHIVE-CHK", "a6-line", "2026-10-27", 33.1, "WINCO FOODS", "WinCo");
    await w.job("plaid-sync");
    await w.job("matching");
    const t = await txByKey(idempotencyKey.plaid("plaid-beehive-chk", "a6-line"));
    await answer(w.hh.members.vanessa, `tx:${t.id}`, "category:groceries");
    await w.job("outbox-relay");
    await w.side.postAsCade("FEEDS");
    expect((await tx(t.id)).state).toBe("bc_draft_created"); // no webhook arrived
    await w.job("nightly-poll");
    expect((await tx(t.id)).state).toBe("posted");
    await w.job("webhook-renewal");
    expect(await w.side.subscriptionCount(await mine())).toBe(2);
  });

  acceptance("A7", async () => {
    await w.side.goalDeposit("BEEHIVE-SAV", today, 75000, "EMERG-1M");
    await w.db(async (db) => {
      await db.query("update accounts set balance_cents = 0, balance_as_of = now(), is_restricted = false where household_id = $1", [w.hh.householdId]);
      await db.query("update accounts set balance_cents = 420000 where id = $1", [w.hh.accounts["AFCU-CHK"]]);
      await db.query("update accounts set balance_cents = 90000 where id = $1", [w.hh.accounts["BEEHIVE-SAV"]]);
      await db.query("update accounts set balance_cents = 500000, is_restricted = true where id = $1", [w.hh.accounts["MACU-SAV"]]);
    });
    const s = (await w.app.inject({ method: "GET", url: "/v1/safe-to-spend", headers: as(w.hh.members.vanessa) })).json();
    const bills = (await w.app.inject({ method: "GET", url: "/v1/bills", headers: as(w.hh.members.vanessa) })).json();
    const before = bills.bills.filter((b: { beforePayday: boolean; paid: boolean }) => b.beforePayday && !b.paid).reduce((a: number, b: { amountCents: number }) => a + b.amountCents, 0);
    expect(s.cashCents).toBe(510000); // the restricted account is not cash to spend
    expect(s.setAsideCents).toBe(75000);
    expect(s.billsBeforePaydayCents).toBe(before);
    expect(s.nextPaydayIso).toBe(bills.nextPayday);
    expect(s.safeCents).toBe(510000 - 75000 - before - s.givingDueCents - s.liquidityFloorCents);
    expect(s.dataThrough.at).toBeTruthy();
  });

  acceptance("A8", async () => {
    const move = await w.app.inject({ method: "POST", url: "/v1/budget/moves", headers: as(w.hh.members.vanessa), payload: { fromCategoryId: "eating-out", toCategoryId: "groceries", amountCents: 5000, month: "2026-10" } });
    expect(move.statusCode).toBe(201);
    expect((await w.app.inject({ method: "POST", url: `/v1/approvals/${move.json().id}/decide`, headers: as(w.hh.members.vanessa, true), payload: { decision: "approved" } })).json().error).toBe("other_spouse_decides");
    expect((await w.app.inject({ method: "POST", url: `/v1/approvals/${move.json().id}/decide`, headers: as(w.hh.members.cade), payload: { decision: "approved" } })).json().error).toBe("step_up_required");
    expect((await w.app.inject({ method: "POST", url: `/v1/approvals/${move.json().id}/decide`, headers: as(w.hh.members.cade, true), payload: { decision: "approved" } })).statusCode).toBe(200);
    await w.job("outbox-relay");
    const rev = await w.db(async (db) => (await db.query<{ revision_no: number; written_to_bc_at: Date | null }>("select revision_no, written_to_bc_at from budget_revisions where approval_id = $1", [move.json().id])).rows[0]!);
    expect(rev.revision_no).toBe(1);
    expect(rev.written_to_bc_at).not.toBeNull();
    const inBc = await w.side.ledger.readBudget("BUD26-REV");
    expect(inBc.filter((e) => e.description === "1").map((e) => [e.glAccount, e.amountCents])).toEqual(expect.arrayContaining([["603501", -5000], ["603101", 5000]]));
    const refused = await w.side.ledger.writeBudgetEntries([{ budgetName: "2026-ORIG", glAccount: "603101", date: "2026-10-01", amountCents: 1, dimensions: [], description: "x" }]).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(LedgerError);
    expect(refused).toMatchObject({ retryable: false });
  });

  acceptance("A9", async () => {
    const dt = (x: DataThrough) => expect(x).toMatchObject({ at: expect.any(String), quality: expect.any(String), pendingCount: expect.any(Number) });
    const get = async (url: string) => (await w.app.inject({ method: "GET", url, headers: as(w.hh.members.vanessa) })).json();
    // Home
    dt((await get("/v1/safe-to-spend")).dataThrough);
    dt((await get("/v1/questions")).dataThrough);
    dt((await get("/v1/accounts")).dataThrough);
    // Budget
    const budget = await get("/v1/budget");
    dt(budget.dataThrough);
    expect(budget.isSample).toBe(true);
    // Goals: the emergency fund's balance is BC's FUND_GOAL entries
    const goals = await get("/v1/goals");
    dt(goals.dataThrough);
    expect(goals.goals.find((g: { fundGoal: string }) => g.fundGoal === "EMERG-1M").currentCents).toBe(75000);
    // Ask: every number from the rows, with the data-through
    const ask = (await w.app.inject({ method: "POST", url: "/v1/ask", headers: as(w.hh.members.vanessa), payload: { question: "How much is safe to spend?" } })).json();
    dt(ask.dataThrough);
    expect(ask.used[0].fn).toBe("get_safe_to_spend");
    // The nightly poll finds no difference on the test household.
    const poll = (await w.job("nightly-poll")) as { counts: Record<string, Record<string, number>> };
    const c = poll.counts[w.hh.householdId]!;
    recorder.nightlyPoll = { ranAt: new Date().toISOString(), differences: (c["differences"] ?? 0) + (c["batchDateDifferences"] ?? 0) };
    expect(c["differences"]).toBe(0);
    expect(c["batchDateDifferences"]).toBe(0);
  });
});
