/**
 * Budget status per category (spec: Ask function `get_budget_status`; E6 "Budget read from BC, sample label until
 * approved"). The budget comes from the ledger port's `readBudget` once a budget name is approved in settings; until
 * then the seeded sample revision is shown with `isSample: true`. Spending is posted plus recorded (approved and
 * on its way to BC) lines in the month; transfers, card payments, BC-native payments and paychecks never count.
 */
import { CATEGORIES, type BudgetLine, type BudgetStatus, type DataThrough } from "@homestead/shared";
import type { Queryable } from "../db/index.js";
import { daysInMonth, monthEnd, monthStart } from "../lib/dates.js";
import { loadCategories } from "./categories.js";
import { getSettings, ledgerConnection } from "./households.js";
import type { LedgerPort } from "./ledgerPort.js";

const COUNTED_STATES = ["approved", "sent_to_bc", "bc_draft_created", "posted", "reconciled"];

export interface SpendingByCategory {
  byCategory: Map<string, number>;
  lastPostedAt?: string;
  lastRecordedAt?: string;
  pendingCount: number;
}

/** Spending in a month by category: splits where present, otherwise the transaction's own category. */
export async function spendingByCategory(db: Queryable, householdId: string, month: string): Promise<SpendingByCategory> {
  const from = monthStart(month);
  const to = monthEnd(month);
  const r = await db.query<{ category_id: string; cents: number }>(
    `with lines as (
       select coalesce(s.category_id, t.category_id) as category_id, coalesce(s.amount_cents, t.amount_cents) as amount_cents
         from transactions t left join transaction_splits s on s.transaction_id = t.id
        where t.household_id = $1 and not t.pending and t.state = any($2) and t.kind in ('spend','income') and t.business_flag = 'none'
          and t.posted_date between $3::date and $4::date)
     select category_id, coalesce(sum(-amount_cents),0)::bigint::int as cents from lines where category_id is not null group by category_id`,
    [householdId, COUNTED_STATES, from, to],
  );
  const byCategory = new Map<string, number>();
  for (const row of r.rows) byCategory.set(row.category_id, row.cents);
  const marks = await db.query<{ posted: string | null; recorded: string | null; pending: number }>(
    `select max(case when state in ('posted','reconciled') then updated_at end) as posted,
            max(case when state in ('approved','sent_to_bc','bc_draft_created') then updated_at end) as recorded,
            count(*) filter (where pending or state in ('imported','possible_duplicate','needs_receipt','needs_classification','ready_for_review'))::int as pending
       from transactions where household_id = $1 and posted_date between $2::date and $3::date`,
    [householdId, from, to],
  );
  const m = marks.rows[0];
  const out: SpendingByCategory = { byCategory, pendingCount: m?.pending ?? 0 };
  if (m?.posted) out.lastPostedAt = new Date(m.posted).toISOString();
  if (m?.recorded) out.lastRecordedAt = new Date(m.recorded).toISOString();
  return out;
}

export interface BudgetSource {
  name: string;
  isSample: boolean;
  revisionNo?: number;
  /** categoryId -> monthly amount in cents */
  amounts: Map<string, number>;
  asOf?: string;
}

/** The approved budget from BC when a name is approved; otherwise the newest sample revision in budget_revisions. */
export async function loadBudget(db: Queryable, householdId: string, ledger: LedgerPort, month: string): Promise<BudgetSource> {
  const settings = await getSettings(db, householdId);
  const cats = await loadCategories(db, householdId);
  const byGl = new Map<string, string>();
  for (const c of CATEGORIES) if (!byGl.has(c.glAccount)) byGl.set(c.glAccount, c.id);
  for (const c of cats.values()) if (!byGl.has(c.gl_account)) byGl.set(c.gl_account, c.id);
  if (settings.budget.approvedName) {
    const entries = await ledger.readBudget(settings.budget.approvedName);
    const amounts = new Map<string, number>();
    let revisionNo: number | undefined;
    for (const e of entries) {
      if (!e.date.startsWith(month)) continue;
      const catId = byGl.get(e.glAccount);
      if (!catId) continue;
      amounts.set(catId, (amounts.get(catId) ?? 0) + e.amountCents);
      const rev = Number(e.description);
      if (Number.isInteger(rev) && (revisionNo === undefined || rev > revisionNo)) revisionNo = rev;
    }
    const conn = await ledgerConnection(db, householdId);
    const out: BudgetSource = { name: settings.budget.approvedName, isSample: false, amounts };
    if (revisionNo !== undefined) out.revisionNo = revisionNo;
    if (conn?.last_poll_at) out.asOf = new Date(conn.last_poll_at).toISOString();
    return out;
  }
  const r = await db.query<{ revision_no: number; lines: { categoryId?: string; account?: string; amount_cents: number; period?: string }[]; created_at: string }>(
    "select revision_no, lines, created_at from budget_revisions where household_id = $1 and bc_budget_name = $2 order by revision_no desc limit 1",
    [householdId, settings.budget.sampleName],
  );
  const row = r.rows[0];
  const amounts = new Map<string, number>();
  for (const l of row?.lines ?? []) {
    if (l.period && l.period !== "monthly" && !l.period.startsWith(month)) continue;
    const catId = l.categoryId ?? (l.account ? byGl.get(l.account) : undefined);
    if (!catId) continue;
    amounts.set(catId, (amounts.get(catId) ?? 0) + l.amount_cents);
  }
  const out: BudgetSource = { name: settings.budget.sampleName, isSample: true, amounts };
  if (row) {
    out.revisionNo = row.revision_no;
    out.asOf = new Date(row.created_at).toISOString();
  }
  return out;
}

export function paceOf(budgetCents: number, spentCents: number, forecastCents: number): BudgetLine["pace"] {
  if (budgetCents <= 0) return spentCents > 0 ? "over" : "on_track";
  if (spentCents > budgetCents) return "over";
  if (forecastCents > budgetCents) return "watch";
  return "on_track";
}

/** Straight-line pace: spent so far scaled to the whole month, never below what is already spent. */
export function forecastFor(spentCents: number, dayOfMonth: number, days: number): number {
  if (dayOfMonth <= 0) return spentCents;
  return Math.max(spentCents, Math.round((spentCents * days) / Math.min(dayOfMonth, days)));
}

export async function budgetStatus(db: Queryable, householdId: string, ledger: LedgerPort, month: string, todayIso: string): Promise<BudgetStatus> {
  const cats = await loadCategories(db, householdId);
  const budget = await loadBudget(db, householdId, ledger, month);
  const spend = await spendingByCategory(db, householdId, month);
  const days = daysInMonth(month);
  const dayOfMonth = todayIso.startsWith(month) ? Number(todayIso.slice(8, 10)) : todayIso > month ? days : 0;
  const lines: BudgetLine[] = [];
  const ids = new Set<string>([...budget.amounts.keys(), ...spend.byCategory.keys()]);
  for (const id of ids) {
    const c = cats.get(id);
    if (!c || c.is_transfer || c.group === "Income" || c.group === "Transfers") continue;
    const budgetCents = budget.amounts.get(id) ?? 0;
    const spentCents = spend.byCategory.get(id) ?? 0;
    if (budgetCents === 0 && spentCents === 0) continue;
    const forecastCents = forecastFor(spentCents, dayOfMonth, days);
    const line: BudgetLine = {
      categoryId: id,
      name: c.name,
      budgetCents,
      spentCents,
      leftCents: budgetCents - spentCents,
      pace: paceOf(budgetCents, spentCents, forecastCents),
      forecastCents,
      group: c.group,
      isAllowance: c.is_allowance,
      isCommitted: c.spend_class === "COMMITTED" || c.spend_class === "ESSENTIAL",
    };
    lines.push(line);
  }
  lines.sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.name.localeCompare(b.name));
  const totals = lines.reduce((t, l) => ({ budgetCents: t.budgetCents + l.budgetCents, spentCents: t.spentCents + l.spentCents, leftCents: t.leftCents + l.leftCents }), { budgetCents: 0, spentCents: 0, leftCents: 0 });
  const at = [spend.lastPostedAt, spend.lastRecordedAt, budget.asOf].filter((x): x is string => Boolean(x)).sort().pop() ?? new Date().toISOString();
  const quality: DataThrough["quality"] = budget.isSample ? "estimated" : spend.lastRecordedAt && (!spend.lastPostedAt || spend.lastRecordedAt > spend.lastPostedAt) ? "posted_unreconciled" : "posted_unreconciled";
  const out: BudgetStatus = { month, budgetName: budget.name, isSample: budget.isSample, lines, totals, dataThrough: { at, quality, pendingCount: spend.pendingCount } };
  if (budget.revisionNo !== undefined) out.revisionNo = budget.revisionNo;
  return out;
}
