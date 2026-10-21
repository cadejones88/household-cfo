/**
 * Integration (homestead_e3): the transaction state machine with an audit row per move, the outbox row written in
 * the same database transaction as `approved`, pending Plaid rows replaced on settlement, corrections before and
 * after the item is with BC, exceptions and their resolution, splits.
 */
import { IllegalTransitionError, externalDocumentNo, idempotencyKey } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { approveTransaction, correctTransaction, importTransaction, loadTx, raiseException, resolveException, setBusinessFlag, setSplits, settlePending, transition, type TxRow } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, count, describeDb, inHh, seeded } from "./helpers/db.js";

describeDb("state machine, audit and outbox", () => {
  let hh: SeedResult;
  let n = 0;
  beforeAll(async () => {
    hh = await seeded("sm", { today: "2026-10-20" });
  });
  afterAll(async () => {
    await closePool();
  });

  async function newTx(over: { amountCents?: number; merchant?: string; account?: string; date?: string } = {}): Promise<TxRow> {
    n += 1;
    const account = hh.accounts[over.account ?? "CAPONE-CC"]!;
    return inHh(hh, async (db) => (await importTransaction(db, hh.householdId, { accountId: account, source: "plaid", sourceRef: `t-${n}`, idempotencyKey: idempotencyKey.plaid(`acct-${account.slice(0, 6)}`, `t-${n}`), postedDate: over.date ?? "2026-10-15", amountCents: over.amountCents ?? -4517, merchantRaw: over.merchant ?? "MAVERIK #417" }, "test")).transaction);
  }

  it("imports once per key; a second import returns the same row without a second audit row", async () => {
    const t = await newTx();
    await inHh(hh, async (db) => {
      const again = await importTransaction(db, hh.householdId, { accountId: t.account_id, source: "plaid", sourceRef: "x", idempotencyKey: t.idempotency_key, postedDate: "2026-10-16", amountCents: -1, merchantRaw: "OTHER" }, "test");
      expect(again.created).toBe(false);
      expect(again.transaction.id).toBe(t.id);
      expect(again.transaction.amount_cents).toBe(-4517);
      expect(await count(db, "select 1 from audit_log where entity_id = $1 and action = 'transaction.import'", [t.id])).toBe(1);
    });
  });

  it("moves along the arrows with one audit row per move, and writes the send_to_bc outbox row with `approved`", async () => {
    const t = await newTx();
    await inHh(hh, async (db) => {
      await transition(db, hh.householdId, t.id, "needs_classification", "jobs", { actorId: "matching" });
      await transition(db, hh.householdId, t.id, "ready_for_review", "rule_engine", { actorId: "matching", patch: { confidence: 0.8, category_id: "fuel" } });
      const approved = await approveTransaction(db, hh.householdId, t.id, "member", { actorId: hh.members.vanessa });
      expect(approved.state).toBe("approved");
      expect(approved.bc_external_doc_no).toBe(externalDocumentNo(t.idempotency_key, "2026-10-15"));
      expect(approved.bc_batch).toBe("FEEDS");
      const moves = await db.query<{ actor: string; before: { state: string }; after: { state: string } }>("select actor, before, after from audit_log where entity_id = $1 and action = 'transaction.transition' order by at, id", [t.id]);
      expect(moves.rows.map((m) => `${m.before.state}->${m.after.state}`)).toEqual(["imported->needs_classification", "needs_classification->ready_for_review", "ready_for_review->approved"]);
      expect(moves.rows[2]!.actor).toBe(hh.members.vanessa);
      const ob = await db.query<{ operation: string; payload: { externalDocumentNo: string; batch: string; lines: { accountNo: string; amountCents: number }[] } }>("select operation, payload from outbox where aggregate_id = $1", [t.id]);
      expect(ob.rows).toHaveLength(1);
      expect(ob.rows[0]!.operation).toBe("send_to_bc");
      expect(ob.rows[0]!.payload.externalDocumentNo).toBe(approved.bc_external_doc_no);
      expect(ob.rows[0]!.payload.lines.map((l) => [l.accountNo, l.amountCents])).toEqual([["CAPONE-CC", -4517], ["604101", 4517]]);
    });
  });

  it("rolls back the state change and the outbox row together", async () => {
    const t = await newTx();
    await inHh(hh, async (db) => {
      await transition(db, hh.householdId, t.id, "needs_classification", "jobs");
      await transition(db, hh.householdId, t.id, "ready_for_review", "rule_engine", { patch: { category_id: "fuel" } });
    });
    await expect(
      inHh(hh, async (db) => {
        await approveTransaction(db, hh.householdId, t.id, "member", { actorId: hh.members.cade });
        throw new Error("crash after approve");
      }),
    ).rejects.toThrow("crash after approve");
    await inHh(hh, async (db) => {
      expect((await loadTx(db, t.id)).state).toBe("ready_for_review");
      expect(await count(db, "select 1 from outbox where aggregate_id = $1", [t.id])).toBe(0);
    });
  });

  it("refuses moves the state machine does not have, and actors not allowed on an arrow", async () => {
    const t = await newTx();
    await inHh(hh, async (db) => {
      await expect(transition(db, hh.householdId, t.id, "posted", "cade")).rejects.toBeInstanceOf(IllegalTransitionError);
      await expect(transition(db, hh.householdId, t.id, "needs_classification", "member")).rejects.toBeInstanceOf(IllegalTransitionError);
    });
  });

  it("stores a pending Plaid line under pending:<id>, never moves it, and replaces it when the settled line arrives", async () => {
    const acct = hh.accounts["BEEHIVE-CHK"]!;
    await inHh(hh, async (db) => {
      const p = await importTransaction(db, hh.householdId, { accountId: acct, source: "plaid", sourceRef: "pend-1", idempotencyKey: "pending:pend-1", postedDate: "2026-10-18", amountCents: -2000, merchantRaw: "SODALICIOUS", pending: true }, "plaid-sync");
      expect(p.transaction.pending).toBe(true);
      await expect(transition(db, hh.householdId, p.transaction.id, "needs_classification", "jobs")).rejects.toMatchObject({ code: "pending" });
      await expect(importTransaction(db, hh.householdId, { accountId: acct, source: "plaid", sourceRef: "x", idempotencyKey: "plaid:a:x", postedDate: "2026-10-18", amountCents: -1, merchantRaw: "x", pending: true }, "t")).rejects.toMatchObject({ code: "pending_key" });
      expect(await settlePending(db, hh.householdId, "pending:pend-1", "plaid-sync")).toBe(true);
      expect(await count(db, "select 1 from transactions where idempotency_key = 'pending:pend-1'")).toBe(0);
      expect(await settlePending(db, hh.householdId, "pending:pend-1", "plaid-sync")).toBe(false);
    });
  });

  it("'This is wrong' before publishing replaces the waiting outbox row in place; after, it opens a correction for Cade", async () => {
    const t = await newTx({ merchant: "SINCLAIR" });
    await inHh(hh, async (db) => {
      await transition(db, hh.householdId, t.id, "needs_classification", "jobs");
      await transition(db, hh.householdId, t.id, "ready_for_review", "rule_engine", { patch: { category_id: "fuel" } });
      await approveTransaction(db, hh.householdId, t.id, "member", { actorId: hh.members.cade });
      const r = await correctTransaction(db, hh.householdId, t.id, { categoryId: "treats", reason: "it was snacks" }, hh.members.vanessa);
      expect(r.correctionRequestId).toBeUndefined();
      expect(r.transaction.state).toBe("approved");
      const ob = await db.query<{ payload: { lines: { accountNo: string }[] } }>("select payload from outbox where aggregate_id = $1", [t.id]);
      expect(ob.rows).toHaveLength(1);
      expect(ob.rows[0]!.payload.lines.map((l) => l.accountNo)).toEqual(["CAPONE-CC", "603701"]);
      await db.query("update outbox set published_at = now() where aggregate_id = $1", [t.id]);
      await transition(db, hh.householdId, t.id, "sent_to_bc", "relay");
      const after = await correctTransaction(db, hh.householdId, t.id, { categoryId: "fuel" }, hh.members.vanessa);
      expect(after.correctionRequestId).toBeTruthy();
      const apr = await db.query<{ kind: string; payload: { externalDocumentNo: string } }>("select kind, payload from approvals where id = $1", [after.correctionRequestId]);
      expect(apr.rows[0]).toMatchObject({ kind: "correction", payload: { externalDocumentNo: t.bc_external_doc_no ?? expect.any(String) } });
    });
  });

  it("raises an exception along an allowed arrow, notes one where there is none, and Cade resolves both", async () => {
    const t = await newTx();
    const u = await newTx({ merchant: "CHEVRON" });
    await inHh(hh, async (db) => {
      await transition(db, hh.householdId, t.id, "needs_classification", "jobs");
      await transition(db, hh.householdId, t.id, "ready_for_review", "rule_engine", { patch: { category_id: "fuel" } });
      await approveTransaction(db, hh.householdId, t.id, "member", { actorId: hh.members.cade });
      await transition(db, hh.householdId, t.id, "sent_to_bc", "relay");
      const ex = await raiseException(db, hh.householdId, t.id, "BC refused the write (BadRequest)", "bc_worker", "bc-worker", { sync_status: "error" });
      expect(ex).toMatchObject({ state: "exception", exception_reason: "BC refused the write (BadRequest)" });
      const back = await resolveException(db, hh.householdId, t.id, { to: "ready_for_review", note: "fixed the account" }, hh.members.cade);
      expect(back).toMatchObject({ state: "ready_for_review", exception_reason: null, bc_line_ids: null });

      await transition(db, hh.householdId, u.id, "needs_classification", "jobs");
      const noted = await raiseException(db, hh.householdId, u.id, "The bank removed this transaction after it was recorded", "bc_worker", "plaid-sync");
      expect(noted).toMatchObject({ state: "needs_classification", sync_status: "difference" });
      const cleared = await resolveException(db, hh.householdId, u.id, { to: "ready_for_review", note: "bank put it back" }, hh.members.cade);
      expect(cleared).toMatchObject({ state: "ready_for_review", exception_reason: null });
      await expect(resolveException(db, hh.householdId, u.id, { to: "posted", note: "x", entryNos: [1] }, hh.members.cade)).rejects.toMatchObject({ code: "not_exception" });
    });
  });

  it("splits must add up to the amount; the business flag before BC changes the lines (CTJ owes us)", async () => {
    const t = await newTx({ amountCents: -12999, merchant: "BEST BUY" });
    await inHh(hh, async (db) => {
      await expect(setSplits(db, hh.householdId, t.id, [{ amountCents: -10000, categoryId: "electronics" }], hh.members.cade)).rejects.toMatchObject({ code: "splits_sum" });
      await setSplits(db, hh.householdId, t.id, [{ amountCents: -9999, categoryId: "electronics" }, { amountCents: -3000, categoryId: "software" }], hh.members.cade);
      await setBusinessFlag(db, hh.householdId, t.id, "ctj", hh.members.cade);
      await transition(db, hh.householdId, t.id, "needs_classification", "jobs");
      await transition(db, hh.householdId, t.id, "ready_for_review", "rule_engine");
      await approveTransaction(db, hh.householdId, t.id, "member", { actorId: hh.members.vanessa });
      const ob = await db.query<{ payload: { lines: { accountNo: string; amountCents: number }[] } }>("select payload from outbox where aggregate_id = $1", [t.id]);
      expect(ob.rows[0]!.payload.lines.map((l) => [l.accountNo, l.amountCents])).toEqual([["CAPONE-CC", -12999], ["112101", 12999]]);
    });
  });
});
