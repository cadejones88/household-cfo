/**
 * Integration: the paycheck pipeline. A Henry's Fork deposit becomes a paycheck waiting for its stub (asked of Cade
 * only); the stub PDF is read (prebuilt-payStub.us fake), mapped with the employer template and tied to net; an
 * unknown line becomes a one-tap question that the template remembers; under R1 a tied stub within 15% posts by
 * rule; without a stub for 3 days the template proposes an estimate.
 */
import { idempotencyKey, sha256Hex } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMatching } from "../src/services/classify.js";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { applyTemplateFallbacks, intakeStub, listEmployers, listPaychecks, loadComponents } from "../src/services/paychecks/index.js";
import { answerQuestion, listQuestions } from "../src/services/questions.js";
import { FakeDocumentIntelligence } from "../src/services/receipts/documentIntelligence.js";
import { uploadReceipt } from "../src/services/receipts/upload.js";
import { InMemoryBlobStore } from "../src/services/ports.js";
import { importTransaction, loadSplits, loadTx } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { approveSeedRule, closePool, describeDb, inHh, seeded } from "./helpers/db.js";
import { bytesOf, payStubFixture } from "./helpers/fixtures.js";

describeDb("paychecks", () => {
  let hh: SeedResult;
  const ledger = new InMemoryLedger();
  const di = new FakeDocumentIntelligence((b) => sha256Hex(b));
  const blobs = new InMemoryBlobStore();
  const deposits: Record<string, string> = {};
  const stub1 = payStubFixture("hfh-2026-10-16.json");
  const stub2 = payStubFixture("hfh-2026-10-30-roth.json");

  beforeAll(async () => {
    hh = await seeded("pay", { today: "2026-10-20" });
    di.stubsBySha.set(sha256Hex(bytesOf(stub1.imageText)), stub1.read);
    di.stubsBySha.set(sha256Hex(bytesOf(stub2.imageText)), stub2.read);
  });
  afterAll(async () => {
    await closePool();
  });

  async function deposit(name: string, date: string, cents: number, merchant = "HENRYS FORK HOMES PAYROLL PAYCHEX"): Promise<string> {
    return inHh(hh, async (db) => {
      const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts["AFCU-CHK"]!, source: "plaid", sourceRef: name, idempotencyKey: idempotencyKey.plaid("afcu", name), postedDate: date, amountCents: cents, merchantRaw: merchant }, "plaid-sync");
      await runMatching(db, hh.householdId, { ledger, actor: "matching" });
      deposits[name] = t.transaction.id;
      return t.transaction.id;
    });
  }
  async function paycheckFor(txId: string) {
    return inHh(hh, async (db) => (await listPaychecks(db, hh.householdId)).find((p) => p.transaction_id === txId)!);
  }
  async function stub(paycheckId: string, s: { imageText: string }) {
    return inHh(hh, async (db) => {
      const bytes = bytesOf(s.imageText);
      const up = await uploadReceipt(db, hh.householdId, hh.members.cade, { bytes, contentType: "application/pdf", sha256: sha256Hex(bytes), capturedAt: "2026-10-17T09:00:00-06:00", kind: "pay_stub" }, blobs);
      return intakeStub(db, hh.householdId, paycheckId, { bytes, contentType: "application/pdf", receiptId: up.receipt.id }, { docIntel: di }, hh.members.cade);
    });
  }

  it("detects the HFH deposit and waits for the stub; only Cade (the employee) is asked for it", async () => {
    const id = await deposit("pay-1016", "2026-10-16", 313559);
    await inHh(hh, async (db) => expect(await loadTx(db, id)).toMatchObject({ state: "needs_receipt", kind: "paycheck", receipt_status: "needed", category_id: "income-hfh-wages" }));
    const p = await paycheckFor(id);
    expect(p).toMatchObject({ pay_date: "2026-10-16", net_cents: 313559, source: "template", stub_receipt_id: null });
    const cade = await inHh(hh, (db) => listQuestions(db, hh.householdId, hh.members.cade));
    const vanessa = await inHh(hh, (db) => listQuestions(db, hh.householdId, hh.members.vanessa));
    expect(cade.find((q) => q.transactionId === id)?.prompt).toBe("Paycheck of $3,135.59 needs its stub");
    expect(vanessa.find((q) => q.transactionId === id)).toBeUndefined();
  });

  it("reads the stub, maps every line, ties to net, and (R1 not approved yet) waits for one tap with the component split", async () => {
    const p = await paycheckFor(deposits["pay-1016"]!);
    const r = await stub(p.id, stub1);
    expect(r).toMatchObject({ outcome: "ready_for_review", tiesToNet: true, unmapped: [] });
    await inHh(hh, async (db) => {
      const comps = await loadComponents(db, p.id);
      expect(comps.map((c) => [c.kind, c.gl_account, c.amount_cents])).toEqual([
        ["regular", "401101", 365000],
        ["bonus", "401102", 23077], // 401102 exists since 10/21/2026 (BC change 5)
        ["fit", "701101", 29830],
        ["state_tax", "701201", 15000],
        ["social_security", "701301", 24061],
        ["medicare", "701401", 5627],
      ]);
      const t = await loadTx(db, deposits["pay-1016"]!);
      expect(t).toMatchObject({ state: "ready_for_review", receipt_status: "matched" });
      const splits = await loadSplits(db, t.id);
      expect(splits.reduce((s, x) => s + x.amount_cents, 0)).toBe(313559);
      expect(splits.find((x) => x.category_id === "withholding-idaho-hfh")?.amount_cents).toBe(-15000);
      const emp = (await listEmployers(db, hh.householdId)).find((e) => e.code === "HFH")!;
      expect(emp.template.lastSixNetCents[0]).toBe(313559);
      expect(emp.last_stub_at).not.toBeNull();
    });
  });

  it("asks about a line the template has never seen, remembers the answer, and posts by R1 once approved", async () => {
    await inHh(hh, (db) => approveSeedRule(db, hh, "R1"));
    const id = await deposit("pay-1030", "2026-10-30", 280482);
    const p = await paycheckFor(id);
    expect((await stub(p.id, stub2)).outcome).toBe("needs_answers");
    const q = (await inHh(hh, (db) => listQuestions(db, hh.householdId, hh.members.cade))).find((x) => x.kind === "paycheck_component")!;
    expect(q.prompt).toBe('On the 2026-10-30 stub, what is "ROTH 401K" ($162.95)?');
    expect(q.options.map((o) => o.id)).toEqual(["kind:benefit", "kind:other_deduction"]);
    const a = await inHh(hh, (db) => answerQuestion(db, hh.householdId, hh.members.cade, q.id, { optionId: "kind:other_deduction", stepUp: false }));
    expect(a.paycheckOutcome).toBe("approved");
    await inHh(hh, async (db) => {
      expect(await loadTx(db, id)).toMatchObject({ state: "approved", bc_batch: "FEEDS", rule_id: hh.rules["R1"] });
      const emp = (await listEmployers(db, hh.householdId)).find((e) => e.code === "HFH")!;
      expect(emp.template.labelMap["roth 401k"]).toBe("other_deduction");
      const ob = await db.query<{ payload: { lines: { accountNo: string; amountCents: number }[] } }>("select payload from outbox where aggregate_id = $1", [id]);
      expect(ob.rows[0]!.payload.lines.find((l) => l.accountNo === "701801")?.amountCents).toBe(16295);
    });
  });

  it("without a stub for 3 days, the template proposes an estimate that waits for one tap", async () => {
    const id = await deposit("pay-1113", "2026-11-13", 301000);
    expect(await inHh(hh, (db) => applyTemplateFallbacks(db, hh.householdId, "2026-11-15"))).toEqual([]);
    const done = await inHh(hh, (db) => applyTemplateFallbacks(db, hh.householdId, "2026-11-16"));
    expect(done).toHaveLength(1);
    const p = await paycheckFor(id);
    expect(p).toMatchObject({ source: "template", estimated: true });
    await inHh(hh, async (db) => {
      expect(await loadTx(db, id)).toMatchObject({ state: "ready_for_review", receipt_status: "estimated" });
      expect((await loadSplits(db, id)).reduce((s, x) => s + x.amount_cents, 0)).toBe(301000);
    });
  });

  it("recognizes a CTJ (Gusto) deposit as the other employer", async () => {
    const id = await deposit("ctj-1031", "2026-10-31", 150000, "GUSTO PAY 4471 CADE T JONES CPA");
    expect((await paycheckFor(id))).toBeTruthy();
    await inHh(hh, async (db) => expect((await loadTx(db, id)).category_id).toBe("income-ctj-wages"));
  });
});
