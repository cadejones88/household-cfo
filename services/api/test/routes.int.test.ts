/**
 * Integration through HTTP (app.inject, dev sign-in): the household scope, plain status words, "This is wrong",
 * the business flag (A4), receipts multipart with the hash, budget moves and approvals with step-up (A8), rules,
 * the read models every screen uses (each with its dataThrough), and the Console's routes.
 */
import { idempotencyKey, sha256Hex } from "@homestead/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildFakeDeps, type Deps } from "../src/deps.js";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { FakeDocumentIntelligence } from "../src/services/receipts/documentIntelligence.js";
import { importTransaction, transition } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, count, describeDb, inHh, seeded, setSettings } from "./helpers/db.js";
import { FixtureMapper, bytesOf, walmartFixtures } from "./helpers/fixtures.js";
import { as, multipart } from "./helpers/http.js";

describeDb("routes", () => {
  let app: FastifyInstance;
  let hh: SeedResult;
  let other: SeedResult;
  let deps: Deps;
  const now = new Date("2026-10-20T16:00:00Z");

  beforeAll(async () => {
    hh = await seeded("routes", { today: "2026-10-20" });
    other = await seeded("routes-other", { today: "2026-10-20" });
    const fixtures = walmartFixtures();
    const di = new FakeDocumentIntelligence((b) => sha256Hex(b));
    for (const f of fixtures) di.receiptsBySha.set(sha256Hex(bytesOf(f.imageText)), f.read);
    deps = buildFakeDeps({ ledger: new InMemoryLedger(), docIntel: di, mapper: new FixtureMapper(fixtures), now: () => now });
    app = await buildApp({ logger: false, deps });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closePool();
  });

  async function addTx(h: SeedResult, code: string, ref: string, amountCents: number, merchant: string, state?: "ready_for_review", postedDate = "2026-10-15"): Promise<string> {
    return inHh(h, async (db) => {
      const t = await importTransaction(db, h.householdId, { accountId: h.accounts[code]!, source: "plaid", sourceRef: ref, idempotencyKey: idempotencyKey.plaid(code, ref), postedDate, amountCents, merchantRaw: merchant }, "test");
      if (state) {
        await transition(db, h.householdId, t.transaction.id, "needs_classification", "jobs");
        await transition(db, h.householdId, t.transaction.id, "ready_for_review", "rule_engine", { patch: { confidence: 0.8 } });
      }
      return t.transaction.id;
    });
  }

  it("GET /v1/me names the member, both spouses, the household and the ledger without credentials", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/me", headers: as(hh.members.vanessa) });
    expect(r.statusCode).toBe(200);
    const me = r.json();
    expect(me.member).toEqual({ id: hh.members.vanessa, displayName: "Vanessa", role: "member" });
    expect(me.members.map((m: { displayName: string }) => m.displayName).sort()).toEqual(["Cade", "Vanessa"]);
    expect(me.household).toMatchObject({ timezone: "America/Boise", today: "2026-10-20", nextPayday: "2026-10-30", quietHours: { start: "21:00", end: "07:00" } });
    expect(me.ledger).toMatchObject({ environment: "CADE_Sandbox_vs25", journalTemplate: "HHAPP", autoPostEnabled: false });
    expect(JSON.stringify(me)).not.toMatch(/cert|secret/i);
  });

  it("scopes every read to the member's household (another household's item is not found)", async () => {
    const theirs = await addTx(other, "BEEHIVE-CHK", "secret-1", -9999, "OTHER FAMILY");
    expect((await app.inject({ method: "GET", url: `/v1/transactions/${theirs}`, headers: as(hh.members.cade) })).statusCode).toBe(404);
    const mine = await app.inject({ method: "GET", url: "/v1/transactions?limit=200", headers: as(hh.members.cade) });
    expect(mine.json().transactions.some((t: { id: string }) => t.id === theirs)).toBe(false);
  });

  it("lists transactions with plain status words and a dataThrough; filters by status word", async () => {
    const id = await addTx(hh, "BEEHIVE-CHK", "list-1", -1999, "NETFLIX.COM", "ready_for_review");
    const r = await app.inject({ method: "GET", url: "/v1/transactions?status=needs_answer", headers: as(hh.members.vanessa) });
    const body = r.json();
    const t = body.transactions.find((x: { id: string }) => x.id === id);
    expect(t).toMatchObject({ state: "ready_for_review", status: "needs_answer", statusWord: "Needs a quick answer" });
    expect(body.dataThrough).toMatchObject({ quality: expect.any(String), pendingCount: expect.any(Number) });
    expect((await app.inject({ method: "GET", url: "/v1/transactions?status=nope", headers: as(hh.members.vanessa) })).statusCode).toBe(400);
  });

  it('"This is wrong" re-classifies a waiting item and approves it with the new category', async () => {
    const id = await addTx(hh, "CAPONE-CC", "wrong-1", -4517, "MAVERIK #417", "ready_for_review");
    const r = await app.inject({ method: "POST", url: `/v1/transactions/${id}/correct`, headers: as(hh.members.vanessa), payload: { categoryId: "treats", reason: "snacks, not fuel" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().transaction).toMatchObject({ state: "approved", categoryId: "treats", statusWord: "Recorded" });
    expect(r.json().correctionRequestId).toBeUndefined();
  });

  it("A4: a Capital One payment marked paid by CTJ posts Cr 404102 with the natural debit; a card charge marked business posts Dr 112101", async () => {
    const pay = await addTx(hh, "CAPONE-CC", "a4-pay", 36300, "PAYMENT THANK YOU", "ready_for_review");
    expect((await app.inject({ method: "POST", url: `/v1/transactions/${pay}/business`, headers: as(hh.members.cade), payload: { flag: "ctj" } })).json().businessFlag).toBe("ctj");
    const charge = await addTx(hh, "CAPONE-CC", "a4-charge", -12999, "MICROSOFT 365 BUSINESS", "ready_for_review");
    await app.inject({ method: "POST", url: `/v1/transactions/${charge}/business`, headers: as(hh.members.vanessa), payload: { flag: "ctj" } });
    for (const [id, cat] of [[pay, "card-payment"], [charge, "software"]] as const) {
      const r = await app.inject({ method: "POST", url: `/v1/questions/${encodeURIComponent(`tx:${id}`)}/answer`, headers: as(hh.members.cade), payload: { optionId: `category:${cat}` } });
      expect(r.statusCode).toBe(200);
    }
    const lines = async (id: string) => inHh(hh, async (db) => (await db.query<{ payload: { lines: { accountType: string; accountNo: string; amountCents: number }[] } }>("select payload from outbox where aggregate_id = $1", [id])).rows[0]!.payload.lines.map((l) => [l.accountNo, l.amountCents]));
    expect(await lines(pay)).toEqual([["CAPONE-CC", 36300], ["404102", -36300]]);
    expect(await lines(charge)).toEqual([["CAPONE-CC", -12999], ["112101", 12999]]);
  });

  it("uploads a receipt as multipart with the device's hash; a mismatch is refused, the same photo twice is 200", async () => {
    const f = walmartFixtures()[0]!;
    await addTx(hh, "CAPONE-CC", "route-walmart", f.bank.amountCents, "Walmart", undefined, f.bank.postedDate);
    const bytes = bytesOf(f.imageText);
    const bad = multipart({ sha256: "0".repeat(64), capturedAt: "2026-10-03T18:00:00-06:00" }, { name: "r.jpg", contentType: "image/jpeg", bytes });
    expect((await app.inject({ method: "POST", url: "/v1/receipts", headers: { ...as(hh.members.vanessa), ...bad.headers }, payload: bad.body })).json()).toMatchObject({ error: "sha256_mismatch" });
    const good = multipart({ sha256: sha256Hex(bytes), capturedAt: "2026-10-03T18:00:00-06:00", offlineId: "queue-7" }, { name: "r.jpg", contentType: "image/jpeg", bytes });
    const r = await app.inject({ method: "POST", url: "/v1/receipts", headers: { ...as(hh.members.vanessa), ...good.headers }, payload: good.body });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ offlineId: "queue-7", ocrStatus: "read", merchant: f.read.merchant, totalCents: f.read.totalCents, syncState: "synced" });
    expect(r.json().matchedTransactionId).toBeTruthy();
    const replay = await app.inject({ method: "POST", url: "/v1/receipts", headers: { ...as(hh.members.vanessa), ...good.headers }, payload: good.body });
    expect(replay.statusCode).toBe(200);
    const detail = (await app.inject({ method: "GET", url: `/v1/receipts/${r.json().id}`, headers: as(hh.members.cade) })).json();
    expect(detail.lines).toHaveLength(f.read.items.length);
    expect(detail.transaction.splits.map((s: { amountCents: number }) => s.amountCents)).toEqual(f.expected.splits.map((s) => s.amountCents));
  });

  it("A8: a budget move needs the other spouse with step-up and writes the next revision; ORIG is refused", async () => {
    const move = await app.inject({ method: "POST", url: "/v1/budget/moves", headers: as(hh.members.vanessa), payload: { fromCategoryId: "eating-out", toCategoryId: "groceries", amountCents: 5000, month: "2026-10" } });
    expect(move.statusCode).toBe(201);
    const approvalId = move.json().id;
    expect(move.json().effect).toMatch(/Moves \$50\.00 from Eating out to Groceries/);
    const own = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: as(hh.members.vanessa, true), payload: { decision: "approved" } });
    expect(own.json().error).toBe("other_spouse_decides");
    const noStep = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: as(hh.members.cade), payload: { decision: "approved" } });
    expect(noStep.statusCode).toBe(403);
    expect(noStep.json().error).toBe("step_up_required");
    const ok = await app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: as(hh.members.cade, true), payload: { decision: "approved" } });
    expect(ok.json()).toMatchObject({ decision: "approved", decidedBy: hh.members.cade, stepUpVerified: true });
    await inHh(hh, async (db) => {
      const rev = await db.query<{ bc_budget_name: string; revision_no: number; lines: { account: string; amount_cents: number }[] }>("select bc_budget_name, revision_no, lines from budget_revisions where approval_id = $1", [approvalId]);
      expect(rev.rows[0]).toMatchObject({ bc_budget_name: "BUD26-REV", revision_no: 1 });
      expect(rev.rows[0]!.lines.map((l) => [l.account, l.amount_cents])).toEqual([["603501", -5000], ["603101", 5000]]);
      const ob = await db.query<{ payload: { budgetName: string; revisionNo: number; entries: { description: string }[] } }>("select payload from outbox where operation = 'write_budget_revision' and household_id = $1", [hh.householdId]);
      expect(ob.rows[0]!.payload).toMatchObject({ budgetName: "BUD26-REV", revisionNo: 1 });
      expect(ob.rows[0]!.payload.entries.every((e) => e.description === "1")).toBe(true);
      await setSettings(db, hh.householdId, { budget: { approvedName: null, revisionName: "BUD26-ORIG", sampleName: "FCST-SAMPLE" } });
    });
    const second = await app.inject({ method: "POST", url: "/v1/budget/moves", headers: as(hh.members.cade), payload: { fromCategoryId: "fuel", toCategoryId: "groceries", amountCents: 100, month: "2026-10" } });
    const refused = await app.inject({ method: "POST", url: `/v1/approvals/${second.json().id}/decide`, headers: as(hh.members.vanessa, true), payload: { decision: "approved" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("orig_refused");
    await inHh(hh, (db) => setSettings(db, hh.householdId, { budget: { approvedName: null, revisionName: "BUD26-REV", sampleName: "FCST-SAMPLE" } }));
  });

  it("rules: the proposer cannot approve; the other spouse can with step-up; an auto-post rule needs Cade's note", async () => {
    const p = await app.inject({ method: "POST", url: "/v1/rules", headers: as(hh.members.vanessa), payload: { kind: "merchant", name: "Sodalicious → treats", match: { merchantNorm: "sodalicious rexburg", direction: "out" }, action: { categoryId: "treats" }, mayAutoPost: true } });
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ state: "proposed", proposedByName: "Vanessa", stats: { fired: 0, corrected: 0 } });
    expect((await app.inject({ method: "POST", url: `/v1/rules/${p.json().id}/approve`, headers: as(hh.members.vanessa, true), payload: {} })).json().error).toBe("other_spouse_decides");
    expect((await app.inject({ method: "POST", url: `/v1/rules/${p.json().id}/approve`, headers: as(hh.members.cade), payload: {} })).json().error).toBe("step_up_required");
    expect((await app.inject({ method: "POST", url: `/v1/rules/${p.json().id}/approve`, headers: as(hh.members.cade, true), payload: {} })).json().error).toBe("approval_note_required");
    const ok = await app.inject({ method: "POST", url: `/v1/rules/${p.json().id}/approve`, headers: as(hh.members.cade, true), payload: { approvalNote: "Approved in writing, Cade, Oct 20 2026" } });
    expect(ok.json()).toMatchObject({ state: "approved", approvedBy: hh.members.cade, approvalNote: "Approved in writing, Cade, Oct 20 2026" });
    expect((await app.inject({ method: "POST", url: "/v1/rules", headers: as(hh.members.cade), payload: { kind: "merchant", name: "x", match: { nonsense: 1 }, action: {} } })).statusCode).toBe(400);
  });

  it("every screen's read carries a dataThrough: accounts, budget, goals, bills, safe-to-spend, questions, alerts", async () => {
    for (const url of ["/v1/accounts", "/v1/budget?month=2026-10", "/v1/goals", "/v1/bills", "/v1/safe-to-spend", "/v1/questions", "/v1/alerts"]) {
      const r = await app.inject({ method: "GET", url, headers: as(hh.members.vanessa) });
      expect(r.statusCode, url).toBe(200);
      expect(r.json().dataThrough, url).toMatchObject({ at: expect.any(String), quality: expect.any(String), pendingCount: expect.any(Number) });
    }
    const bills = (await app.inject({ method: "GET", url: "/v1/bills", headers: as(hh.members.vanessa) })).json();
    expect(bills.nextPayday).toBe("2026-10-30");
    expect(bills.bills.find((b: { name: string }) => b.name === "America First Visa · minimum")).toMatchObject({ dueDate: "2026-10-22", beforePayday: true, isMinimum: true });
    expect(bills.bills.find((b: { name: string }) => b.name === "PennyMac · mortgage")).toMatchObject({ dueDate: "2026-11-01", beforePayday: false, isBcNative: true });
    expect((await app.inject({ method: "GET", url: "/v1/bills/safe-to-spend", headers: as(hh.members.vanessa) })).statusCode).toBe(200);
  });

  it("the Console's routes answer with the documented shapes; post-batch only enqueues and needs step-up", async () => {
    const h = as(hh.members.cade);
    const q = (await app.inject({ method: "GET", url: "/v1/console/queues", headers: h })).json();
    expect(Object.keys(q.counts).sort()).toEqual(["exception", "needs_classification", "needs_receipt", "possible_duplicate", "ready_for_review", "receipts", "rules"]);
    expect(q.rules.map((r: { ruleNo: string }) => r.ruleNo)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]);
    const posting = (await app.inject({ method: "GET", url: "/v1/console/posting", headers: h })).json();
    expect(posting.batches.map((b: { batch: string }) => b.batch)).toEqual(["FEEDS", "RECEIPTS", "AUTOPOST"]);
    expect((await app.inject({ method: "POST", url: "/v1/console/posting/post-batch", headers: h, payload: { batch: "FEEDS" } })).statusCode).toBe(403);
    const pb = await app.inject({ method: "POST", url: "/v1/console/posting/post-batch", headers: as(hh.members.cade, true), payload: { batch: "FEEDS" } });
    expect(pb.statusCode).toBe(202);
    expect(pb.json()).toMatchObject({ batch: "FEEDS", enqueued: false });
    const m = (await app.inject({ method: "GET", url: "/v1/console/mappings", headers: h })).json();
    expect(m.employers.map((e: { code: string }) => e.code).sort()).toEqual(["CTJ", "HFH"]);
    // Bonus posts to gross wages with a BONUS comment until 401102 exists in the company (shared PENDING_SANDBOX_ACCOUNTS).
    expect(m.employers.find((e: { code: string }) => e.code === "HFH").components.map((c: { glAccount: string }) => c.glAccount)).toEqual(["401101", "401101", "701101", "701201", "701301", "701401"]);
    const matrix = (await app.inject({ method: "GET", url: "/v1/console/authority-matrix", headers: h })).json();
    expect(matrix.rows.find((r: { action: string }) => r.action === "Budget move")).toMatchObject({ who: "The other spouse", tbd: true });
    expect(matrix.autoPostRules).toHaveLength(7);
    for (const url of ["/v1/console/sync", "/v1/console/reconciliation", "/v1/console/connections", "/v1/console/audit?limit=5", "/v1/console/alerts", "/v1/console/settings", "/v1/console/outbox", "/v1/console/imports/profiles"]) {
      expect((await app.inject({ method: "GET", url, headers: h })).statusCode, url).toBe(200);
    }
    const audit = (await app.inject({ method: "GET", url: "/v1/console/audit?limit=5", headers: h })).json();
    expect(audit.entries).toHaveLength(5);
    expect(audit.next).toBeTruthy();
  });

  it("Ask answers from rows and writes nothing but its own conversation record", async () => {
    const before = await inHh(hh, async (db) => ({ tx: await count(db, "select 1 from transactions where household_id = $1", [hh.householdId]), apr: await count(db, "select 1 from approvals where household_id = $1", [hh.householdId]), ob: await count(db, "select 1 from outbox where household_id = $1", [hh.householdId]), rev: await count(db, "select 1 from budget_revisions where household_id = $1", [hh.householdId]) }));
    const a = await app.inject({ method: "POST", url: "/v1/ask", headers: as(hh.members.vanessa), payload: { question: "Move $50 to groceries" } });
    expect(a.statusCode).toBe(200);
    expect(a.json().draftAction).toEqual({ kind: "budget_move", fromCategoryId: "", toCategoryId: "groceries", amountCents: 5000 });
    expect(a.json().answer).toMatch(/nothing changes until then/);
    const after = await inHh(hh, async (db) => ({ tx: await count(db, "select 1 from transactions where household_id = $1", [hh.householdId]), apr: await count(db, "select 1 from approvals where household_id = $1", [hh.householdId]), ob: await count(db, "select 1 from outbox where household_id = $1", [hh.householdId]), rev: await count(db, "select 1 from budget_revisions where household_id = $1", [hh.householdId]) }));
    expect(after).toEqual(before);
    const hist = (await app.inject({ method: "GET", url: "/v1/ask/history", headers: as(hh.members.vanessa) })).json();
    expect(hist.conversations[0]).toMatchObject({ question: "Move $50 to groceries" });
    expect((await app.inject({ method: "GET", url: "/v1/ask/history", headers: as(hh.members.cade) })).json().conversations).toEqual([]);
  });

  it("alerts: the member sees both-spouse alerts and their own, and can snooze one while an action is pending", async () => {
    await inHh(hh, async (db) => {
      await db.query("insert into alerts (household_id, member_id, kind, level, fingerprint, payload) values ($1,null,'cash_short','action','cash_short:test',$2), ($1,$3,'needs_relink','watch','needs_relink:test',$4)", [hh.householdId, JSON.stringify({ title: "Cash goes below zero", body: "b" }), hh.members.cade, JSON.stringify({ title: "Beehive needs a fresh sign-in", body: "b" })]);
    });
    const v = (await app.inject({ method: "GET", url: "/v1/alerts", headers: as(hh.members.vanessa) })).json();
    expect(v.alerts.map((a: { fingerprint: string }) => a.fingerprint)).toEqual(["cash_short:test"]);
    const c = (await app.inject({ method: "GET", url: "/v1/alerts", headers: as(hh.members.cade) })).json();
    expect(c.alerts.map((a: { fingerprint: string }) => a.fingerprint).sort()).toEqual(["cash_short:test", "needs_relink:test"]);
    const s = await app.inject({ method: "POST", url: `/v1/alerts/${v.alerts[0].id}/snooze`, headers: as(hh.members.vanessa), payload: { until: "2026-12-31T00:00:00Z", reason: "holding the card payment" } });
    expect(s.statusCode).toBe(200);
    expect(s.json().snoozedUntil).toBe("2026-11-03T16:00:00.000Z"); // capped at 14 days
  });

  it("devices and export: the push token is stored for the member; export needs step-up and is audited", async () => {
    expect((await app.inject({ method: "POST", url: "/v1/devices/push-token", headers: as(hh.members.vanessa), payload: { token: "ExponentPushToken[synthetic]", platform: "ios" } })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/v1/export", headers: as(hh.members.vanessa), payload: {} })).statusCode).toBe(403);
    const ex = await app.inject({ method: "POST", url: "/v1/export", headers: as(hh.members.vanessa, true), payload: {} });
    expect(ex.statusCode).toBe(202);
    await inHh(hh, async (db) => expect(await count(db, "select 1 from audit_log where action = 'export.requested' and household_id = $1", [hh.householdId])).toBe(1));
  });
});
