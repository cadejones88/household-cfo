/**
 * Integration: alerts from the forecast with fingerprints (one open alert each, repeated only when the facts move
 * more than $25), resolved when the facts go away, quiet while an agreed action is pending, allowances never
 * alerting, quiet hours 9 pm–7 am Mountain with the approved critical kinds, the 7 am digest, the weekly pulse.
 */
import { idempotencyKey } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { InMemoryNotifier, deliverAlerts, evaluateAlerts, gatherAlertInputs, listAlerts, upsertAlerts, weeklyPulse } from "../src/services/alerts.js";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { approveTransaction, importTransaction, transition } from "../src/services/transactions.js";
import type { Queryable } from "../src/db/index.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, describeDb, inHh, seeded } from "./helpers/db.js";

const at = (local: string) => new Date(`${local}-06:00`); // MDT in October

describeDb("alerts", () => {
  let hh: SeedResult;
  const ledger = new InMemoryLedger();
  beforeAll(async () => {
    hh = await seeded("alerts", { today: "2026-10-20" });
    await inHh(hh, async (db) => {
      await setBalances(db, 1000); // ten cash accounts: $100 in all, against a $222 minimum due on the 22nd
      let i = 0;
      for (const [cat, amt] of [["groceries", -60000], ["groceries", -60000], ["allowance-cade", -20000]] as const) {
        i += 1;
        const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts["BEEHIVE-CHK"]!, source: "plaid", sourceRef: `a${i}`, idempotencyKey: idempotencyKey.plaid("chk", `a${i}`), postedDate: "2026-10-1" + i, amountCents: amt, merchantRaw: cat === "groceries" ? "BROULIMS" : "ARCADE" }, "test");
        await transition(db, hh.householdId, t.transaction.id, "needs_classification", "jobs");
        await transition(db, hh.householdId, t.transaction.id, "ready_for_review", "rule_engine");
        await approveTransaction(db, hh.householdId, t.transaction.id, "member", { categoryId: cat, actorId: hh.members.cade });
      }
    });
  });
  afterAll(async () => {
    await closePool();
  });

  async function setBalances(db: Queryable, eachCents: number): Promise<void> {
    await db.query("update accounts set balance_cents = case when kind in ('card','line') then -50000 else $2 end, balance_as_of = '2026-10-20T14:00:00Z' where household_id = $1", [hh.householdId, eachCents]);
  }
  async function evaluate(now: Date) {
    return inHh(hh, async (db) => {
      const cands = evaluateAlerts(await gatherAlertInputs(db, hh.householdId, ledger, now));
      return { cands, counts: await upsertAlerts(db, hh.householdId, cands) };
    });
  }

  it("raises the forecast alerts once per fingerprint; allowances never alert", async () => {
    const { cands, counts } = await evaluate(at("2026-10-20T09:00:00"));
    const fps = cands.map((c) => c.fingerprint);
    expect(fps).toContain(`bill_uncovered:${hh.bills["America First Visa · minimum"]}`);
    expect(fps).toContain("cash_short:household");
    expect(fps).toContain("category_overrun:groceries");
    expect(fps.some((f) => f.includes("allowance"))).toBe(false);
    expect(counts.created).toBe(cands.length);
    const again = await evaluate(at("2026-10-20T10:00:00"));
    expect(again.counts).toMatchObject({ created: 0, changed: 0, unchanged: cands.length, resolved: 0 });
    const open = await inHh(hh, (db) => listAlerts(db, hh.householdId, { openOnly: true }));
    expect(new Set(open.map((a) => a.fingerprint)).size).toBe(open.length);
  });

  it("repeats only when the facts move more than $25, and resolves when they go away", async () => {
    await inHh(hh, (db) => setBalances(db, 1300)); // ten cash accounts up $3 each: the short moves $30
    const moved = await evaluate(at("2026-10-20T11:00:00"));
    expect(moved.counts.changed).toBe(2); // cash_short and safe_below_floor both moved $30; the bill alert did not
    const redelivered = await inHh(hh, (db) => listAlerts(db, hh.householdId, { openOnly: true }));
    expect(redelivered.filter((a) => a.delivered_at === null).map((a) => a.kind).sort()).toEqual(expect.arrayContaining(["cash_short", "safe_below_floor"]));
    await inHh(hh, (db) => setBalances(db, 1301));
    expect((await evaluate(at("2026-10-20T11:30:00"))).counts.changed).toBe(0); // ten cents is not news
    await inHh(hh, (db) => setBalances(db, 2_000_000));
    const calm = await evaluate(at("2026-10-20T12:00:00"));
    expect(calm.counts.resolved).toBeGreaterThanOrEqual(2);
    expect(calm.cands.some((c) => c.kind === "cash_short" || c.kind === "bill_uncovered")).toBe(false);
  });

  it("goes quiet while an agreed action is pending (an open approval naming the bill)", async () => {
    await inHh(hh, async (db) => {
      await setBalances(db, 1000);
      await db.query("insert into approvals (household_id, kind, payload, requested_by) values ($1,'correction',$2,$3)", [hh.householdId, JSON.stringify({ billId: hh.bills["America First Visa · minimum"], holdFingerprint: "cash_short:household", note: "hold the card payment until payday" }), hh.members.cade]);
    });
    const { cands } = await evaluate(at("2026-10-20T13:00:00"));
    expect(cands.some((c) => c.kind === "bill_uncovered" || c.fingerprint === "cash_short:household")).toBe(false);
    await inHh(hh, (db) => db.query("update approvals set decided_by = $2, decision = 'declined', decided_at = now() where household_id = $1 and decided_by is null", [hh.householdId, hh.members.vanessa]));
    expect((await evaluate(at("2026-10-20T13:30:00"))).cands.some((c) => c.kind === "bill_uncovered")).toBe(true);
  });

  it("delivers: action alerts push at once; inside quiet hours only the approved critical kinds; watch alerts wait for the 7 am digest", async () => {
    await inHh(hh, (db) => db.query("update alerts set delivered_at = null where household_id = $1", [hh.householdId]));
    const night = new InMemoryNotifier();
    const n = await inHh(hh, (db) => deliverAlerts(db, hh.householdId, night, at("2026-10-20T22:30:00")));
    expect(night.sent.map((s) => s.alert.kind)).toEqual(["cash_short"]); // the critical kind breaks quiet hours
    expect(n.held).toBeGreaterThan(0);
    expect(night.sent[0]!.memberIds).toHaveLength(2);
    const morning = new InMemoryNotifier();
    const m = await inHh(hh, (db) => deliverAlerts(db, hh.householdId, morning, at("2026-10-21T07:05:00")));
    const digest = morning.sent.find((s) => s.alert.kind === "daily_digest");
    expect(digest?.alert.body).toMatch(/Groceries is on pace to go over/);
    expect(m.digested).toBeGreaterThan(0);
    expect(morning.sent.filter((s) => s.alert.kind === "daily_digest")).toHaveLength(1);
    const later = new InMemoryNotifier();
    await inHh(hh, (db) => deliverAlerts(db, hh.householdId, later, at("2026-10-21T09:00:00")));
    expect(later.sent).toEqual([]);
  });

  it("builds the weekly pulse with safe-to-spend, bills, the top watch lines and what rules posted", async () => {
    const p = await inHh(hh, (db) => weeklyPulse(db, hh.householdId, ledger, at("2026-10-25T19:00:00")));
    expect(p).toMatchObject({ kind: "weekly_pulse", level: "pulse", fingerprint: "weekly_pulse:2026-W43" });
    expect(p.body).toMatch(/Safe to spend before 2026-10-30/);
    expect(p.body).toMatch(/No rule posted anything without you this week/);
  });
});
