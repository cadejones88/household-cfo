/**
 * A7 (integration, property-style): safe-to-spend excludes restricted funds and FUND_GOAL set-asides and covers every
 * bill due before the next Henry's Fork payday. 60 random households-days (seeded, reproducible) are checked against
 * an independent oracle written from the spec's sentence, not from the shared function.
 */
import { toBcDimensionSetLines } from "@homestead/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { computeSafeToSpend } from "../src/services/safeToSpend.js";
import type { SeedResult } from "../src/db/seed.js";
import type { Queryable } from "../src/db/index.js";
import { closePool, describeDb, rolledBack, seeded, setSettings } from "./helpers/db.js";

/** mulberry32: a tiny seeded PRNG so a failure can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const day = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function dueIn(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay(y, m))).padStart(2, "0")}`;
}

interface Scenario {
  today: string;
  anchor: string;
  balances: Record<string, number>;
  restrictedCode: string;
  goals: { code: string; fundGoal: string; cents: number }[];
  bills: { dueDay: number; amountCents: number; paidThrough: string | null }[];
  floor: number;
}

function scenario(r: () => number, i: number): Scenario {
  const today = day("2026-10-01", Math.floor(r() * 90));
  const anchor = day("2026-10-16", -14 * Math.floor(r() * 4) + Math.floor(r() * 14));
  const cents = (max: number) => Math.floor(r() * max);
  const bills = Array.from({ length: Math.floor(r() * 7) }, () => ({ dueDay: 1 + Math.floor(r() * 31), amountCents: 1000 + cents(200000), paidThrough: r() < 0.3 ? today : null }));
  const fundGoals = ["EMERG-1M", "SINK-GIFTS", "SINK-VEHICLE", "OPERATING"];
  const goals = Array.from({ length: Math.floor(r() * 4) }, () => ({ code: r() < 0.5 ? "BEEHIVE-SAV" : "AFCU-SAV", fundGoal: fundGoals[Math.floor(r() * fundGoals.length)]!, cents: cents(300000) - (r() < 0.2 ? 400000 : 0) }));
  return {
    today,
    anchor,
    balances: { "BEEHIVE-CHK": cents(500000) - 50000, "AFCU-CHK": cents(800000), "BEEHIVE-SAV": cents(300000), "MACU-SAV": cents(900000), "CAPONE-CC": -cents(300000) },
    restrictedCode: i % 2 === 0 ? "MACU-SAV" : "BEEHIVE-SAV",
    goals,
    bills,
    floor: r() < 0.5 ? 0 : cents(100000),
  };
}

/** The spec, written out: cash − set-asides − bills before payday − giving due − floor. */
function oracle(s: Scenario): { safe: number; nextPayday: string; bills: number } {
  let k = 0;
  let payday = s.anchor;
  while (payday <= s.today) payday = day(s.anchor, 14 * ++k);
  while (day(payday, -14) > s.today) payday = day(payday, -14);
  const cash = Object.entries(s.balances).filter(([c]) => c !== "CAPONE-CC" && c !== s.restrictedCode).reduce((a, [, v]) => a + v, 0);
  const byGoal = new Map<string, number>();
  for (const g of s.goals) if (g.fundGoal !== "OPERATING") byGoal.set(g.fundGoal, (byGoal.get(g.fundGoal) ?? 0) + g.cents);
  const setAside = [...byGoal.values()].reduce((a, v) => a + Math.max(0, v), 0);
  let bills = 0;
  const y = Number(s.today.slice(0, 4));
  const m = Number(s.today.slice(5, 7));
  for (const b of s.bills) {
    for (const [yy, mm] of [[y, m], m === 12 ? [y + 1, 1] : [y, m + 1]] as const) {
      const due = dueIn(yy, mm, b.dueDay);
      if (due >= s.today && due < payday && !(b.paidThrough && b.paidThrough >= due)) bills += b.amountCents;
    }
  }
  return { safe: cash - setAside - bills - 0 - s.floor, nextPayday: payday, bills };
}

async function apply(db: Queryable, hh: SeedResult, s: Scenario): Promise<InMemoryLedger> {
  await setSettings(db, hh.householdId, { paydayAnchor: s.anchor, liquidityFloorCents: s.floor });
  for (const [code, cents] of Object.entries(s.balances)) {
    await db.query("update accounts set balance_cents = $2, balance_as_of = $3, is_restricted = $4 where id = $1", [hh.accounts[code], cents, `${s.today}T12:00:00Z`, code === s.restrictedCode]);
  }
  await db.query("delete from bills where household_id = $1", [hh.householdId]);
  for (const b of s.bills) {
    await db.query("insert into bills (household_id, name, account_id, amount_cents, due_day, next_due_date, cadence, paid_through) values ($1,'bill',$2,$3,$4,$5,'monthly',$6)", [hh.householdId, hh.accounts["AFCU-CHK"], b.amountCents, b.dueDay, s.today, b.paidThrough]);
  }
  const ledger = new InMemoryLedger();
  for (const g of s.goals) {
    const gl = g.code === "BEEHIVE-SAV" ? "102101" : "102201";
    ledger.addForeignGlEntry({ postingDate: "2026-09-30", accountNo: gl, amountCents: g.cents, documentNo: "OB-1", externalDocumentNo: "", dimensions: toBcDimensionSetLines({ FUND_GOAL: g.fundGoal as "EMERG-1M" }) });
  }
  return ledger;
}

describeDb("A7: safe-to-spend", () => {
  let hh: SeedResult;
  beforeAll(async () => {
    hh = await seeded("a7", { today: "2026-10-20" });
  });
  afterAll(async () => {
    await closePool();
  });

  it("matches the oracle over 60 random days, bill calendars, paydays, set-asides and restricted accounts", async () => {
    const r = rng(20261020);
    for (let i = 0; i < 60; i += 1) {
      const s = scenario(r, i);
      const o = oracle(s);
      const got = await rolledBack(hh, async (db) => computeSafeToSpend(db, hh.householdId, await apply(db, hh, s), s.today, new Date(`${s.today}T15:00:00Z`)));
      expect({ i, safe: got.safeCents, nextPayday: got.nextPaydayIso, bills: got.billsBeforePaydayCents }).toEqual({ i, safe: o.safe, nextPayday: o.nextPayday, bills: o.bills });
      expect(got.nextPaydayIso > s.today).toBe(true);
      expect(got.dataThrough.at).toBe(`${s.today}T12:00:00.000Z`);
    }
  });

  it("money in a restricted account or set aside under a FUND_GOAL never raises safe-to-spend", async () => {
    const r = rng(7);
    const s = scenario(r, 0);
    const base = await rolledBack(hh, async (db) => computeSafeToSpend(db, hh.householdId, await apply(db, hh, s), s.today));
    const richer = await rolledBack(hh, async (db) => computeSafeToSpend(db, hh.householdId, await apply(db, hh, { ...s, balances: { ...s.balances, [s.restrictedCode]: (s.balances[s.restrictedCode] ?? 0) + 1_000_000 } }), s.today));
    expect(richer.safeCents).toBe(base.safeCents);
    const savedMore = await rolledBack(hh, async (db) => computeSafeToSpend(db, hh.householdId, await apply(db, hh, { ...s, goals: [...s.goals, { code: "BEEHIVE-SAV", fundGoal: "SINK-TRAVEL", cents: 50000 }] }), s.today));
    expect(savedMore.safeCents).toBe(base.safeCents - 50000);
  });
});
