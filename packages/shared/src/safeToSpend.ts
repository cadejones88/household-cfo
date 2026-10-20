/**
 * Safe to spend before the next paycheck (spec: "Alerts and quiet hours", last paragraph; Phase 1 D4).
 * cash in checking and savings
 *   - FUND_GOAL set-asides from BC
 *   - bills and minimums due before the next Henry's Fork payday
 *   - giving due on income already received
 *   - the liquidity floor once set
 * CTJ draws count only when they arrive.
 */
import type { Cents } from "./money.js";

export interface SafeToSpendInput {
  /** As of the balance timestamp; checking and savings only (cards and loans excluded). */
  cashCents: Cents;
  /** Balances by FUND_GOAL other than OPERATING, read from BC at the last poll. */
  setAsideCents: Cents;
  /** Obligations with a due date; the ones before `nextPaydayIso` are subtracted. */
  bills: readonly { dueDateIso: string; amountCents: Cents; paid?: boolean }[];
  /** Tithing and offerings owed on income already received and not yet paid. */
  givingDueCents: Cents;
  /** The approved minimum liquidity floor; 0 until set. */
  liquidityFloorCents: Cents;
  /** Today's date and the next payday, both YYYY-MM-DD in the household's time zone. */
  todayIso: string;
  nextPaydayIso: string;
  /** When the cash figure was read. Shown on every screen that uses the result. */
  balanceAsOf: string;
}

export interface SafeToSpendResult {
  safeCents: Cents;
  cashCents: Cents;
  setAsideCents: Cents;
  billsBeforePaydayCents: Cents;
  billsBeforePayday: readonly { dueDateIso: string; amountCents: Cents }[];
  givingDueCents: Cents;
  liquidityFloorCents: Cents;
  nextPaydayIso: string;
  daysUntilPayday: number;
  perDayCents: Cents;
  balanceAsOf: string;
  status: "on_track" | "watch" | "short";
}

export function safeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  if (input.nextPaydayIso < input.todayIso) throw new Error("nextPaydayIso must be on or after todayIso");
  const due = input.bills
    .filter((b) => !b.paid && b.dueDateIso >= input.todayIso && b.dueDateIso < input.nextPaydayIso)
    .map((b) => ({ dueDateIso: b.dueDateIso, amountCents: b.amountCents }))
    .sort((a, b) => a.dueDateIso.localeCompare(b.dueDateIso));
  const billsBeforePaydayCents = due.reduce((s, b) => s + b.amountCents, 0);
  const safeCents = input.cashCents - input.setAsideCents - billsBeforePaydayCents - input.givingDueCents - input.liquidityFloorCents;
  const daysUntilPayday = Math.max(1, daysBetween(input.todayIso, input.nextPaydayIso));
  const perDayCents = Math.floor(safeCents / daysUntilPayday);
  const status: SafeToSpendResult["status"] = safeCents < 0 ? "short" : safeCents < 20000 ? "watch" : "on_track";
  return {
    safeCents,
    cashCents: input.cashCents,
    setAsideCents: input.setAsideCents,
    billsBeforePaydayCents,
    billsBeforePayday: due,
    givingDueCents: input.givingDueCents,
    liquidityFloorCents: input.liquidityFloorCents,
    nextPaydayIso: input.nextPaydayIso,
    daysUntilPayday,
    perDayCents,
    balanceAsOf: input.balanceAsOf,
    status,
  };
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const b = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Next Henry's Fork payday: every other Friday from an anchor payday, in the household's calendar.
 * `anchorIso` is any known payday. Returns the first payday strictly after `todayIso` unless `includeToday`.
 */
export function nextBiweeklyPayday(todayIso: string, anchorIso: string, includeToday = false): string {
  const offset = daysBetween(anchorIso, todayIso);
  let k = Math.floor(offset / 14);
  let candidate = addDays(anchorIso, k * 14);
  while (candidate < todayIso || (!includeToday && candidate === todayIso)) {
    k += 1;
    candidate = addDays(anchorIso, k * 14);
  }
  return candidate;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days));
  return d.toISOString().slice(0, 10);
}
