/**
 * A3 (integration): a Walmart receipt splits by line into the right categories. Five synthetic receipts, each with
 * known lines: the bank line waits in Needs receipt, the photo is uploaded with its hash, read (Document Intelligence
 * fake), mapped (fixture mapper), matched to the bank line, split with tax prorated to the cent, and shown once as a
 * one-tap confirmation; one tap approves it into HHAPP/RECEIPTS with one line per category.
 */
import { idempotencyKey, sha256Hex } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildFakeDeps, type Deps } from "../src/deps.js";
import { runMatching } from "../src/services/classify.js";
import { InMemoryLedger, type LedgerJournalLine } from "../src/services/ledgerPort.js";
import { answerQuestion, listQuestions } from "../src/services/questions.js";
import { FakeDocumentIntelligence } from "../src/services/receipts/documentIntelligence.js";
import { matchReceiptToTransaction, readReceipt } from "../src/services/receipts/pipeline.js";
import { uploadReceipt } from "../src/services/receipts/upload.js";
import { importTransaction, loadSplits, loadTx } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, describeDb, inHh, seeded } from "./helpers/db.js";
import { FixtureMapper, bytesOf, walmartFixtures } from "./helpers/fixtures.js";

const fixtures = walmartFixtures();

describeDb("A3: Walmart receipts split by line", () => {
  let hh: SeedResult;
  let deps: Deps;
  const txIds = new Map<string, string>();
  beforeAll(async () => {
    hh = await seeded("a3", { today: "2026-10-20" });
    const di = new FakeDocumentIntelligence((b) => sha256Hex(b));
    for (const f of fixtures) di.receiptsBySha.set(sha256Hex(bytesOf(f.imageText)), f.read);
    deps = buildFakeDeps({ docIntel: di, mapper: new FixtureMapper(fixtures), ledger: new InMemoryLedger() });
    await inHh(hh, async (db) => {
      for (const f of fixtures) {
        const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts[f.bank.account]!, source: "plaid", sourceRef: f.name, idempotencyKey: idempotencyKey.plaid("capone", f.name), postedDate: f.bank.postedDate, amountCents: f.bank.amountCents, merchantRaw: f.bank.merchant }, "plaid-sync");
        txIds.set(f.name, t.transaction.id);
      }
      await runMatching(db, hh.householdId, { ledger: deps.ledger, actor: "matching", now: new Date("2026-10-20T15:00:00Z") });
    });
  });
  afterAll(async () => {
    await closePool();
  });

  it("parks Walmart lines of $25 or more in Needs receipt (the $17.67 one goes straight to review)", async () => {
    await inHh(hh, async (db) => {
      for (const f of fixtures) {
        const t = await loadTx(db, txIds.get(f.name)!);
        if (Math.abs(f.bank.amountCents) >= 2500) expect(t).toMatchObject({ state: "needs_receipt", receipt_status: "needed", category_id: "walmart-unsplit" });
        else expect(t.state).toBe("ready_for_review");
      }
    });
  });

  for (const f of fixtures) {
    it(`${f.name}: uploads, reads, matches and splits ${f.expected.splits.length} way(s) to the cent`, async () => {
      const bytes = bytesOf(f.imageText);
      const up = await inHh(hh, (db) => uploadReceipt(db, hh.householdId, hh.members.vanessa, { bytes, contentType: "image/jpeg", sha256: sha256Hex(bytes), capturedAt: `${f.read.date}T18:00:00-06:00`, offlineId: `q-${f.name}` }, deps.blobs));
      expect(up.created).toBe(true);
      const again = await inHh(hh, (db) => uploadReceipt(db, hh.householdId, hh.members.vanessa, { bytes, contentType: "image/jpeg", sha256: sha256Hex(bytes), capturedAt: `${f.read.date}T18:00:00-06:00` }, deps.blobs));
      expect(again).toMatchObject({ created: false, receipt: { id: up.receipt.id } });
      expect((await inHh(hh, (db) => readReceipt(db, hh.householdId, up.receipt.id, deps))).outcome).toBe("read");
      const m = await inHh(hh, (db) => matchReceiptToTransaction(db, hh.householdId, up.receipt.id));
      expect(m).toMatchObject({ outcome: "matched", transactionId: txIds.get(f.name) });
      await inHh(hh, async (db) => {
        const t = await loadTx(db, txIds.get(f.name)!);
        expect(t).toMatchObject({ state: "ready_for_review", receipt_status: "matched", receipt_id: up.receipt.id });
        const splits = await loadSplits(db, t.id);
        expect(splits.map((s) => ({ lineNo: s.line_no, categoryId: s.category_id, amountCents: s.amount_cents }))).toEqual(f.expected.splits);
        expect(splits.reduce((s, x) => s + x.amount_cents, 0)).toBe(f.bank.amountCents);
      });
    });
  }

  it("shows each split once as a one-tap confirmation; one tap approves it into HHAPP/RECEIPTS, one line per category", async () => {
    const qs = await inHh(hh, (db) => listQuestions(db, hh.householdId, hh.members.vanessa));
    for (const f of fixtures) {
      const q = qs.filter((x) => x.transactionId === txIds.get(f.name));
      expect(q).toHaveLength(1);
      expect(q[0]).toMatchObject({ kind: "confirm_split", defaultOptionId: "confirm" });
      expect(q[0]!.splits!.map((s) => s.amountCents)).toEqual(f.expected.splits.map((s) => s.amountCents));
      await inHh(hh, (db) => answerQuestion(db, hh.householdId, hh.members.vanessa, q[0]!.id, { optionId: "confirm", stepUp: false }));
      await inHh(hh, async (db) => {
        const t = await loadTx(db, txIds.get(f.name)!);
        expect(t).toMatchObject({ state: "approved", bc_batch: "RECEIPTS" });
        const ob = await db.query<{ payload: { lines: LedgerJournalLine[] } }>("select payload from outbox where aggregate_id = $1", [t.id]);
        const lines = ob.rows[0]!.payload.lines;
        expect(lines[0]).toMatchObject({ accountType: "Bank Account", accountNo: "CAPONE-CC", amountCents: f.bank.amountCents });
        expect(lines.slice(1).map((l) => -l.amountCents)).toEqual(f.expected.splits.map((s) => s.amountCents));
        expect(lines.slice(1).every((l) => l.dimensions.length >= 3)).toBe(true);
      });
    }
  });
});
