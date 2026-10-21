/**
 * Integration: Ask Homestead returns numbers from the function rows (every dollar figure in the sentence is a value
 * in `used[].rows`), carries the earliest data-through, never hands the model an account mask or a key, and writes
 * nothing but its own conversation record.
 */
import { BANK_CARD_LIST, formatUsd, idempotencyKey } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ask, TemplateAskModel } from "../src/services/ask/orchestrate.js";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { approveTransaction, importTransaction, transition } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, count, describeDb, inHh, seeded } from "./helpers/db.js";

function numbersIn(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "number" && Number.isInteger(v)) out.add(formatUsd(Math.abs(v)));
  else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersIn(x, out));
  return out;
}

describeDb("Ask Homestead", () => {
  let hh: SeedResult;
  const model = new TemplateAskModel();
  const ledger = new InMemoryLedger();
  beforeAll(async () => {
    hh = await seeded("ask", { today: "2026-10-20" });
    await inHh(hh, async (db) => {
      await db.query("update accounts set balance_cents = 250000, balance_as_of = '2026-10-20T13:00:00Z' where household_id = $1 and kind in ('checking','savings')", [hh.householdId]);
      const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts["CAPONE-CC"]!, source: "plaid", sourceRef: "m1", idempotencyKey: idempotencyKey.plaid("capone", "m1"), postedDate: "2026-10-14", amountCents: -4517, merchantRaw: "MAVERIK #417" }, "test");
      await transition(db, hh.householdId, t.transaction.id, "needs_classification", "jobs");
      await transition(db, hh.householdId, t.transaction.id, "ready_for_review", "rule_engine");
      await approveTransaction(db, hh.householdId, t.transaction.id, "member", { categoryId: "fuel", actorId: hh.members.cade });
    });
  });
  afterAll(async () => {
    await closePool();
  });

  const ctx = (db: Parameters<typeof ask>[0]["db"]) => ({ db, householdId: hh.householdId, memberId: hh.members.vanessa, ledger, todayIso: "2026-10-20", now: new Date("2026-10-20T16:00:00Z") });

  for (const question of ["How much is safe to spend before payday?", "What bills are due?", "What did we spend at maverik last week?", "How is the emergency fund goal?", "Are we on track with the budget?"]) {
    it(`"${question}": every dollar figure in the answer comes from the rows`, async () => {
      const a = await inHh(hh, (db) => ask(ctx(db), model, question));
      expect(a.used.length).toBeGreaterThan(0);
      const allowed = numbersIn(a.used.map((u) => u.rows));
      const figures = a.answer.match(/\$[\d,]+\.\d{2}/g) ?? [];
      for (const f of figures) expect(allowed, `${f} in "${a.answer}"`).toContain(f);
      expect(a.dataThrough).toMatchObject({ at: expect.any(String), quality: expect.any(String) });
      expect(a.conversationId).toBeTruthy();
    });
  }

  it("hands the model only rows, category names and the question: no masks, no keys", async () => {
    const seen = JSON.stringify(model.calls);
    for (const b of BANK_CARD_LIST) if (b.mask.length >= 4) expect(seen).not.toContain(b.mask);
    expect(seen).not.toMatch(/plaid:|pending:|HHAPP-|access-/);
  });

  it("drafts a budget move for 'move $50 to groceries' and writes nothing else", async () => {
    const tables = ["transactions", "approvals", "outbox", "budget_revisions", "rules"];
    const before = await inHh(hh, async (db) => Promise.all(tables.map((t) => count(db, `select 1 from ${t} where household_id = $1`, [hh.householdId]))));
    const a = await inHh(hh, (db) => ask(ctx(db), model, "Please move $50 from eating out to groceries"));
    expect(a.draftAction).toEqual({ kind: "budget_move", fromCategoryId: "eating-out", toCategoryId: "groceries", amountCents: 5000 });
    const after = await inHh(hh, async (db) => Promise.all(tables.map((t) => count(db, `select 1 from ${t} where household_id = $1`, [hh.householdId]))));
    expect(after).toEqual(before);
    await inHh(hh, async (db) => {
      const c = await db.query<{ expires_at: Date; created_at: Date }>("select expires_at, created_at from ask_conversations where id = $1", [a.conversationId]);
      expect(Math.round((c.rows[0]!.expires_at.getTime() - c.rows[0]!.created_at.getTime()) / 86_400_000)).toBe(90);
    });
  });
});
