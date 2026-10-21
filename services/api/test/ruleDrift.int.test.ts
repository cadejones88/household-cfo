/**
 * Integration: rules learn only from approved classifications, and the drift guard holds. Approved Maverik fuel
 * lines propose a merchant rule with an amount band; once approved it files a normal fill-up by itself, but a $600
 * charge at the same merchant is asked, not filed. Disagreeing or allowance history proposes nothing; ten small
 * approved purchases make an R6-shaped small-merchant proposal.
 */
import { idempotencyKey } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runMatching } from "../src/services/classify.js";
import { DEFAULT_SETTINGS } from "../src/services/households.js";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { listQuestions } from "../src/services/questions.js";
import { approveRule, listRules, proposeRulesFromHistory } from "../src/services/rules.js";
import { approveTransaction, importTransaction, loadTx, transition } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, describeDb, inHh, seeded } from "./helpers/db.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describeDb("rule learning and the drift guard", () => {
  let hh: SeedResult;
  const ledger = new InMemoryLedger();
  let seq = 0;
  beforeAll(async () => {
    hh = await seeded("drift");
  });
  afterAll(async () => {
    await closePool();
  });

  async function approved(merchant: string, amountCents: number, categoryId: string, daysBack: number): Promise<void> {
    await inHh(hh, async (db) => {
      seq += 1;
      const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts["BEEHIVE-CHK"]!, source: "plaid", sourceRef: `h${seq}`, idempotencyKey: idempotencyKey.plaid("chk", `h${seq}`), postedDate: daysAgo(daysBack), amountCents, merchantRaw: merchant }, "test");
      await transition(db, hh.householdId, t.transaction.id, "needs_classification", "jobs");
      await transition(db, hh.householdId, t.transaction.id, "ready_for_review", "rule_engine");
      await approveTransaction(db, hh.householdId, t.transaction.id, "member", { categoryId, actorId: hh.members.vanessa });
    });
  }

  async function fresh(merchant: string, amountCents: number): Promise<string> {
    return inHh(hh, async (db) => {
      seq += 1;
      const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts["BEEHIVE-CHK"]!, source: "plaid", sourceRef: `n${seq}`, idempotencyKey: idempotencyKey.plaid("chk", `n${seq}`), postedDate: daysAgo(1), amountCents, merchantRaw: merchant }, "plaid-sync");
      await runMatching(db, hh.householdId, { ledger, actor: "matching" });
      return t.transaction.id;
    });
  }

  it("proposes a merchant rule from three consistent approvals, with the band of the approved amounts", async () => {
    for (const [amt, back] of [[-4200, 40], [-4517, 30], [-5100, 20], [-3900, 10]] as const) await approved("MAVERIK #417", amt, "fuel", back);
    await approved("CAFE RIO", -2400, "eating-out", 15);
    await approved("CAFE RIO", -2600, "treats", 12);
    await approved("CAFE RIO", -2500, "eating-out", 9);
    for (const back of [14, 7, 3]) await approved("ARCADE TOKENS", -1500, "allowance-cade", back);
    const proposed = await inHh(hh, (db) => proposeRulesFromHistory(db, hh.householdId, DEFAULT_SETTINGS));
    expect(proposed.map((r) => [r.kind, r.match.merchantNorm, r.action.categoryId, r.state, r.may_auto_post])).toEqual([["merchant", "maverik", "fuel", "proposed", false]]);
    expect(proposed[0]!.match.band).toEqual({ minCents: 3400, maxCents: 5600 });
    // Running it again proposes nothing new.
    expect(await inHh(hh, (db) => proposeRulesFromHistory(db, hh.householdId, DEFAULT_SETTINGS))).toEqual([]);
  });

  it("an approved rule files a normal fill-up; a $600 charge at the same merchant is asked, not filed", async () => {
    await inHh(hh, async (db) => {
      const rule = (await listRules(db, hh.householdId, "proposed")).find((r) => r.match.merchantNorm === "maverik")!;
      await approveRule(db, hh.householdId, rule.id, hh.members.cade);
    });
    const normal = await fresh("MAVERIK #417", -4800);
    const drift = await fresh("MAVERIK #417", -60000);
    await inHh(hh, async (db) => {
      expect(await loadTx(db, normal)).toMatchObject({ state: "approved", category_id: "fuel", bc_batch: "FEEDS" });
      const d = await loadTx(db, drift);
      expect(d.state).toBe("ready_for_review");
      expect(Number(d.confidence)).toBeLessThan(0.7);
      const q = (await listQuestions(db, hh.householdId, hh.members.vanessa)).find((x) => x.transactionId === drift)!;
      expect(q.kind).toBe("pick_category");
      expect(q.prompt).toBe("Where does $600.00 at MAVERIK #417 go?");
    });
  });

  it("ten approved small purchases at one merchant, all under $25, make an R6-shaped proposal", async () => {
    for (let i = 0; i < 10; i += 1) await approved("SODALICIOUS REXBURG", -(450 + i * 25), "treats", 5 + i);
    const proposed = await inHh(hh, (db) => proposeRulesFromHistory(db, hh.householdId, DEFAULT_SETTINGS));
    expect(proposed.map((r) => [r.kind, r.match.merchantNorm, r.match.maxCents, r.match.minApprovedCount])).toEqual([["small_merchant", "sodalicious rexburg", 2500, 10]]);
  });
});
