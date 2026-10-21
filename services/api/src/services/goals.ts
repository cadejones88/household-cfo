/**
 * Goals from BC FUND_GOAL balances (spec: Ask function `get_goals`; E6 "Goals from FUND_GOAL"). The targets come
 * from household settings (sample until the Constitution's numbers are approved); the current balance is the sum
 * of the cash accounts' G/L entries carrying that FUND_GOAL value at the last poll.
 */
import type { DataThrough, Goal } from "@homestead/shared";
import type { Queryable } from "../db/index.js";
import { hoursBetween } from "../lib/dates.js";
import { getSettings, ledgerConnection } from "./households.js";
import type { LedgerPort } from "./ledgerPort.js";
import { setAsidesFromLedger } from "./safeToSpend.js";

export async function listGoals(db: Queryable, householdId: string, ledger: LedgerPort, now = new Date()): Promise<{ goals: Goal[]; dataThrough: DataThrough }> {
  const settings = await getSettings(db, householdId);
  const conn = await ledgerConnection(db, householdId);
  const { byGoal } = await setAsidesFromLedger(ledger);
  const at = conn?.last_poll_at ? new Date(conn.last_poll_at).toISOString() : now.toISOString();
  const quality: DataThrough["quality"] = !conn?.last_poll_at ? "missing" : hoursBetween(conn.last_poll_at, now) > 36 ? "stale" : "posted_unreconciled";
  const dataThrough: DataThrough = { at, quality, pendingCount: 0 };
  const goals: Goal[] = settings.goals.map((g) => {
    const goal: Goal = { id: g.id, name: g.name, fundGoal: g.fundGoal, currentCents: Math.max(0, byGoal.get(g.fundGoal) ?? 0), targetCents: g.targetCents, dataThrough };
    if (g.nextMilestone) goal.nextMilestone = g.nextMilestone;
    if (g.isSample) goal.isSample = true;
    return goal;
  });
  return { goals, dataThrough };
}
