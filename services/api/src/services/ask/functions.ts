/**
 * The six read-only functions behind Ask Homestead (spec: "Ask Homestead"). Each returns rows plus the date its
 * data runs through. The household filter is applied here, in code, before anything reaches the model. No
 * function writes anything.
 */
import { PLAIN_STATUS_WORDS, type Bill, type BudgetStatus, type DataThrough, type Goal, type PaycheckSummary } from "@homestead/shared";
import type { Queryable } from "../../db/index.js";
import { addDays } from "../../lib/dates.js";
import { budgetStatus } from "../budget.js";
import { upcomingBills } from "../bills.js";
import { listGoals } from "../goals.js";
import type { LedgerPort } from "../ledgerPort.js";
import { loadPaycheck, paycheckSummary } from "../paychecks/index.js";
import { computeSafeToSpend, type SafeToSpendView } from "../safeToSpend.js";
import { listTransactions, loadSplitsFor, toTransactionDto } from "../transactions.js";
import { plainStatus, type TransactionState } from "@homestead/shared";

export type AskFunctionName = "get_safe_to_spend" | "get_budget_status" | "search_transactions" | "get_bills" | "get_goals" | "get_paycheck";

export const ASK_FUNCTIONS: readonly AskFunctionName[] = ["get_safe_to_spend", "get_budget_status", "search_transactions", "get_bills", "get_goals", "get_paycheck"];

export interface AskContext {
  db: Queryable;
  householdId: string;
  memberId: string;
  ledger: LedgerPort;
  todayIso: string;
  now: Date;
}

export interface FunctionResult<T = unknown> {
  fn: AskFunctionName;
  rows: T;
  dataThrough: DataThrough;
}

export interface SearchArgs {
  query?: string;
  from?: string;
  to?: string;
  categoryId?: string;
}

export interface TransactionRowForAsk {
  id: string;
  date: string;
  merchant: string;
  amountCents: number;
  categoryId?: string;
  state: TransactionState;
  status: string;
  pending: boolean;
}

export async function getSafeToSpend(ctx: AskContext): Promise<FunctionResult<SafeToSpendView>> {
  const rows = await computeSafeToSpend(ctx.db, ctx.householdId, ctx.ledger, ctx.todayIso, ctx.now);
  return { fn: "get_safe_to_spend", rows, dataThrough: rows.dataThrough };
}

export async function getBudgetStatus(ctx: AskContext, month?: string): Promise<FunctionResult<BudgetStatus>> {
  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : ctx.todayIso.slice(0, 7);
  const rows = await budgetStatus(ctx.db, ctx.householdId, ctx.ledger, m, ctx.todayIso);
  return { fn: "get_budget_status", rows, dataThrough: rows.dataThrough };
}

export async function searchTransactions(ctx: AskContext, args: SearchArgs): Promise<FunctionResult<TransactionRowForAsk[]>> {
  const f: Parameters<typeof listTransactions>[2] = { limit: 50 };
  if (args.query) f.q = args.query;
  if (args.from) f.from = args.from;
  if (args.to) f.to = args.to;
  if (args.categoryId) f.categoryId = args.categoryId;
  const { rows } = await listTransactions(ctx.db, ctx.householdId, f);
  const splits = await loadSplitsFor(ctx.db, rows.map((r) => r.id));
  const out: TransactionRowForAsk[] = rows.map((r) => {
    const dto = toTransactionDto(r, splits.get(r.id) ?? []);
    const row: TransactionRowForAsk = { id: dto.id, date: dto.postedDate, merchant: dto.merchantRaw, amountCents: dto.amountCents, state: dto.state, status: PLAIN_STATUS_WORDS[plainStatus(dto.state)], pending: dto.pending };
    if (dto.categoryId) row.categoryId = dto.categoryId;
    return row;
  });
  const marks = await ctx.db.query<{ posted: string | null; recorded: string | null; pending: number }>(
    `select max(case when state in ('posted','reconciled') then updated_at end) as posted,
            max(case when state in ('approved','sent_to_bc','bc_draft_created') then updated_at end) as recorded,
            count(*) filter (where pending or state in ('imported','possible_duplicate','needs_receipt','needs_classification','ready_for_review'))::int as pending
       from transactions where household_id = $1`,
    [ctx.householdId],
  );
  const m = marks.rows[0];
  const at = [m?.posted, m?.recorded].filter((x): x is string => Boolean(x)).map((x) => new Date(x).toISOString()).sort().pop() ?? ctx.now.toISOString();
  return { fn: "search_transactions", rows: out, dataThrough: { at, quality: "posted_unreconciled", pendingCount: m?.pending ?? 0 } };
}

export async function getBills(ctx: AskContext, until?: string): Promise<FunctionResult<{ bills: Bill[]; nextPayday: string }>> {
  const r = await upcomingBills(ctx.db, ctx.householdId, ctx.todayIso, until ?? addDays(ctx.todayIso, 35));
  return { fn: "get_bills", rows: { bills: r.bills, nextPayday: r.nextPayday }, dataThrough: { at: r.calendarVersionAt, quality: "posted_unreconciled", pendingCount: 0 } };
}

export async function getGoals(ctx: AskContext): Promise<FunctionResult<Goal[]>> {
  const r = await listGoals(ctx.db, ctx.householdId, ctx.ledger, ctx.now);
  return { fn: "get_goals", rows: r.goals, dataThrough: r.dataThrough };
}

export async function getPaycheck(ctx: AskContext, id?: string): Promise<FunctionResult<PaycheckSummary | undefined>> {
  let paycheckId = id;
  if (!paycheckId) {
    const r = await ctx.db.query<{ id: string }>("select id from paychecks where household_id = $1 order by pay_date desc limit 1", [ctx.householdId]);
    paycheckId = r.rows[0]?.id;
  }
  if (!paycheckId) return { fn: "get_paycheck", rows: undefined, dataThrough: { at: ctx.now.toISOString(), quality: "missing", pendingCount: 0 } };
  const p = await loadPaycheck(ctx.db, paycheckId);
  const s = await paycheckSummary(ctx.db, ctx.householdId, p);
  const tx = p.transaction_id ? await ctx.db.query<{ state: TransactionState; updated_at: string }>("select state, updated_at from transactions where id = $1", [p.transaction_id]) : undefined;
  const state = tx?.rows[0]?.state;
  const quality: DataThrough["quality"] = p.estimated ? "estimated" : state === "posted" || state === "reconciled" ? "posted_unreconciled" : "imported_pending";
  return { fn: "get_paycheck", rows: s, dataThrough: { at: tx?.rows[0]?.updated_at ? new Date(tx.rows[0].updated_at).toISOString() : new Date(p.created_at).toISOString(), quality, pendingCount: state && state !== "posted" && state !== "reconciled" ? 1 : 0 } };
}

/** Run one named function with loosely typed arguments (the planner's output). */
export async function runFunction(ctx: AskContext, fn: AskFunctionName, args: Record<string, unknown> = {}): Promise<FunctionResult> {
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
  switch (fn) {
    case "get_safe_to_spend":
      return getSafeToSpend(ctx);
    case "get_budget_status":
      return getBudgetStatus(ctx, str("month"));
    case "search_transactions": {
      const a: SearchArgs = {};
      const q = str("query");
      const from = str("from");
      const to = str("to");
      const cat = str("categoryId");
      if (q) a.query = q;
      if (from) a.from = from;
      if (to) a.to = to;
      if (cat) a.categoryId = cat;
      return searchTransactions(ctx, a);
    }
    case "get_bills":
      return getBills(ctx, str("until"));
    case "get_goals":
      return getGoals(ctx);
    case "get_paycheck":
      return getPaycheck(ctx, str("id"));
  }
}
