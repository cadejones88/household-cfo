/**
 * Safe to spend with real inputs (spec: "Alerts and quiet hours", last paragraph; A7):
 *   cash in checking, savings, share, wallet and cash accounts that are not restricted (balances with timestamps)
 *   − FUND_GOAL set-asides read from BC (every FUND_GOAL other than OPERATING on the cash accounts)
 *   − bills and minimums due before the next Henry's Fork payday
 *   − giving due on income already received and not yet paid
 *   − the liquidity floor once set.
 * CTJ draws count only when they arrive. Every result carries the balance timestamp it was computed from.
 */
import { safeToSpend as sharedSafeToSpend, type DataThrough, type SafeToSpendResult } from "@homestead/shared";
import type { Queryable } from "../db/index.js";
import { hoursBetween, monthEnd, monthStart } from "../lib/dates.js";
import { upcomingBills } from "./bills.js";
import { getSettings, ledgerConnection } from "./households.js";
import type { LedgerPort } from "./ledgerPort.js";
import { listAccounts } from "./transactions.js";

export interface SafeToSpendInputs {
  cashCents: number;
  balanceAsOf: string | undefined;
  accountsWithoutBalance: number;
  setAsideCents: number;
  setAsideAsOf: string | undefined;
  givingDueCents: number;
}

const CASH_KINDS = new Set(["checking", "savings", "share", "wallet", "cash"]);

/** Sum of FUND_GOAL balances other than OPERATING on the cash accounts, from the ledger's G/L entries. */
export async function setAsidesFromLedger(ledger: LedgerPort): Promise<{ byGoal: Map<string, number>; totalCents: number }> {
  const entries = await ledger.readGlEntriesByExternalDocNo({ accountNoPrefix: "10" });
  const byGoal = new Map<string, number>();
  for (const e of entries) {
    const fg = e.dimensions.find((d) => d.code === "FUND_GOAL")?.valueCode;
    if (!fg || fg === "OPERATING") continue;
    byGoal.set(fg, (byGoal.get(fg) ?? 0) + e.amountCents);
  }
  let totalCents = 0;
  for (const v of byGoal.values()) totalCents += Math.max(0, v);
  return { byGoal, totalCents };
}

/** Tithing owed on income received this month (paychecks, posted or recorded) less giving already paid this month. */
export async function givingDue(db: Queryable, householdId: string, todayIso: string, givingRate: number): Promise<number> {
  const month = todayIso.slice(0, 7);
  const income = await db.query<{ s: number }>(
    `select coalesce(sum(amount_cents),0)::bigint::int as s from transactions
      where household_id = $1 and kind = 'paycheck' and not pending and state in ('approved','sent_to_bc','bc_draft_created','posted','reconciled')
        and posted_date between $2::date and $3::date`,
    [householdId, monthStart(month), monthEnd(month)],
  );
  const paid = await db.query<{ s: number }>(
    `select coalesce(sum(-t.amount_cents),0)::bigint::int as s from transactions t
      join categories c on c.household_id = t.household_id and c.id = t.category_id
      where t.household_id = $1 and c."group" = 'Giving' and not t.pending and t.state not in ('dropped','possible_duplicate')
        and t.posted_date between $2::date and $3::date`,
    [householdId, monthStart(month), monthEnd(month)],
  );
  const gross = income.rows[0]?.s ?? 0;
  const owed = Math.round(gross * givingRate);
  return Math.max(0, owed - (paid.rows[0]?.s ?? 0));
}

export async function gatherInputs(db: Queryable, householdId: string, ledger: LedgerPort, todayIso: string): Promise<SafeToSpendInputs> {
  const settings = await getSettings(db, householdId);
  const accounts = await listAccounts(db, householdId);
  let cashCents = 0;
  let balanceAsOf: string | undefined;
  let accountsWithoutBalance = 0;
  for (const a of accounts) {
    if (!CASH_KINDS.has(a.kind) || a.is_restricted) continue;
    if (a.balance_cents === null || a.balance_cents === undefined) {
      accountsWithoutBalance += 1;
      continue;
    }
    cashCents += a.balance_cents;
    const at = a.balance_as_of ? new Date(a.balance_as_of).toISOString() : undefined;
    if (at && (!balanceAsOf || at < balanceAsOf)) balanceAsOf = at;
  }
  const setAside = await setAsidesFromLedger(ledger);
  const conn = await ledgerConnection(db, householdId);
  const out: SafeToSpendInputs = {
    cashCents,
    balanceAsOf,
    accountsWithoutBalance,
    setAsideCents: setAside.totalCents,
    setAsideAsOf: conn?.last_poll_at ? new Date(conn.last_poll_at).toISOString() : undefined,
    givingDueCents: await givingDue(db, householdId, todayIso, settings.givingRate),
  };
  return out;
}

export interface SafeToSpendView extends SafeToSpendResult {
  dataThrough: DataThrough;
  setAsideAsOf?: string;
  accountsWithoutBalance: number;
}

export async function computeSafeToSpend(db: Queryable, householdId: string, ledger: LedgerPort, todayIso: string, now = new Date()): Promise<SafeToSpendView> {
  const settings = await getSettings(db, householdId);
  const inputs = await gatherInputs(db, householdId, ledger, todayIso);
  const bills = await upcomingBills(db, householdId, todayIso);
  const result = sharedSafeToSpend({
    cashCents: inputs.cashCents,
    setAsideCents: inputs.setAsideCents,
    bills: bills.bills.map((b) => ({ dueDateIso: b.dueDate, amountCents: b.amountCents, paid: b.paid })),
    givingDueCents: inputs.givingDueCents,
    liquidityFloorCents: settings.liquidityFloorCents,
    todayIso,
    nextPaydayIso: bills.nextPayday,
    balanceAsOf: inputs.balanceAsOf ?? now.toISOString(),
  });
  const pending = await db.query<{ n: number }>(
    "select count(*)::int as n from transactions where household_id = $1 and (pending or state in ('imported','possible_duplicate','needs_receipt','needs_classification','ready_for_review'))",
    [householdId],
  );
  const stale = !inputs.balanceAsOf || hoursBetween(inputs.balanceAsOf, now) > 48;
  const quality: DataThrough["quality"] = !inputs.balanceAsOf && inputs.accountsWithoutBalance > 0 ? "missing" : stale ? "stale" : "imported_pending";
  const view: SafeToSpendView = {
    ...result,
    dataThrough: { at: inputs.balanceAsOf ?? now.toISOString(), quality, pendingCount: pending.rows[0]?.n ?? 0 },
    accountsWithoutBalance: inputs.accountsWithoutBalance,
  };
  if (inputs.setAsideAsOf) view.setAsideAsOf = inputs.setAsideAsOf;
  return view;
}
