/**
 * The Home screen's safe-to-spend view model. Takes the API's SafeToSpendView (or composes one from accounts,
 * goals and bills with the shared calculation when the API has no dedicated endpoint) and produces the plain
 * words the hero card and its breakdown sheet show. Every number carries its data-through stamp.
 */
import { safeToSpend, type AccountSummary, type Bill, type BudgetStatus, type DataThrough, type Goal } from "@homestead/shared";
import type { SafeToSpendView } from "../api/types";
import { fmtDate, fmtShort, fmtStampDate, money, money0 } from "./format";
import type { StatusKey } from "../ui/theme";

export interface SafePart {
  label: string;
  /** Signed as shown: cash positive, deductions negative. */
  cents: number;
  text: string;
}

export interface SafeToSpendVm {
  /** "$440.42 safe to spend" or "Short $180.00" */
  headline: string;
  /** "after bills due before payday and money set aside" / "before payday — one small move fixes it" */
  subline: string;
  untilText: string;
  status: Exclude<StatusKey, "neutral">;
  statusLabel: "On track" | "Watch" | "Action needed";
  /** "as of today Oct 20 · bank data through Oct 19" */
  asOf: string;
  parts: SafePart[];
  resultLabel: "Safe to spend" | "Short";
  resultText: string;
  perDayText: string;
  /** "Next payday Fri, Oct 23 · 3 days away" */
  paydayText: string;
  /** "Data through Oct 19 · 2 items pending" (the brief's wording; Ask uses the same line) */
  dataThroughText: string;
  forecast: string;
  suggestion: string | undefined;
  isShort: boolean;
  pendingCount: number;
}

export function buildSafeToSpendVm(view: SafeToSpendView, todayIso: string): SafeToSpendVm {
  const isShort = view.safeCents < 0;
  const status = view.status === "on_track" ? "good" : view.status === "watch" ? "watch" : "action";
  const statusLabel = status === "good" ? "On track" : status === "watch" ? "Watch" : "Action needed";
  const parts: SafePart[] = [
    { label: "Cash in checking and savings", cents: view.cashCents, text: money(view.cashCents) },
    { label: "Set aside (emergency fund and sinking funds)", cents: -view.setAsideCents, text: money(-view.setAsideCents) },
    { label: `Bills due before ${fmtShort(view.nextPaydayIso)}`, cents: -view.billsBeforePaydayCents, text: money(-view.billsBeforePaydayCents) },
  ];
  if (view.givingDueCents > 0) parts.push({ label: "Giving due on income already received", cents: -view.givingDueCents, text: money(-view.givingDueCents) });
  // The floor is always listed so its absence is visible: "Not set yet" until the family approves one (spec: "once it is set").
  parts.push({ label: "Our minimum cushion", cents: -view.liquidityFloorCents, text: view.liquidityFloorCents > 0 ? money(-view.liquidityFloorCents) : "Not set yet" });
  const quality = view.dataThrough.quality;
  const stale = quality === "stale" || quality === "missing";
  return {
    headline: isShort ? `Short ${money(-view.safeCents)}` : `${money(view.safeCents)} safe to spend`,
    subline: isShort ? "before payday — one small move fixes it" : "after bills due before payday and money set aside",
    untilText: `Until ${fmtDate(view.nextPaydayIso)}`,
    status,
    statusLabel,
    asOf: `as of today ${fmtShort(todayIso)} · bank data through ${fmtStampDate(view.balanceAsOf)}${stale ? " · may be out of date" : ""}`,
    parts,
    resultLabel: isShort ? "Short" : "Safe to spend",
    resultText: money(view.safeCents),
    perDayText: isShort ? "" : `About ${money0(view.perDayCents)} a day for ${view.daysUntilPayday} day${view.daysUntilPayday === 1 ? "" : "s"}`,
    paydayText: `Next payday ${fmtDate(view.nextPaydayIso)} · ${view.daysUntilPayday} day${view.daysUntilPayday === 1 ? "" : "s"} away`,
    dataThroughText: dataThroughLine(view.dataThrough),
    forecast: view.forecast ?? defaultForecast(view),
    suggestion: view.suggestion,
    isShort,
    pendingCount: view.dataThrough.pendingCount,
  };
}

/** "Data through Oct 19 · 2 items pending" — the stamp under every number (DataThrough in @homestead/shared). */
export function dataThroughLine(dt: DataThrough): string {
  const stale = dt.quality === "stale" || dt.quality === "missing" ? " · may be out of date" : "";
  const pending = dt.pendingCount > 0 ? ` · ${dt.pendingCount} item${dt.pendingCount === 1 ? "" : "s"} pending` : "";
  return `Data through ${fmtStampDate(dt.at)}${pending}${stale}`;
}

function defaultForecast(view: SafeToSpendView): string {
  if (view.safeCents < 0) return "Bills land before payday and cash won't cover them. One small move fixes it.";
  if (view.status === "watch") return "It's tight until payday. Go easy on the flexible categories this week.";
  return `Every bill before payday is covered, with ${money0(view.safeCents)} to spare.`;
}

/**
 * Compose the view from the pieces when the API has no safe-to-spend endpoint: cash in checking and savings,
 * FUND_GOAL balances other than operating (goals), bills before the next payday. Giving due and the floor are
 * zero until the household's settings carry them.
 */
export function composeSafeToSpend(opts: {
  accounts: readonly AccountSummary[];
  goals: readonly Goal[];
  bills: readonly Bill[];
  nextPaydayIso: string;
  todayIso: string;
  givingDueCents?: number;
  liquidityFloorCents?: number;
  budget?: BudgetStatus;
}): SafeToSpendView {
  const cashAccounts = opts.accounts.filter((a) => a.kind === "checking" || a.kind === "savings");
  const cashCents = cashAccounts.reduce((s, a) => s + (a.balanceCents ?? 0), 0);
  const balanceAsOf = cashAccounts.map((a) => a.balanceAsOf ?? "").filter(Boolean).sort()[0] ?? new Date(0).toISOString();
  const setAsideCents = opts.goals.filter((g) => g.fundGoal !== "OPERATING" && g.fundGoal !== "DEBT-TARGET").reduce((s, g) => s + Math.max(0, g.currentCents), 0);
  const r = safeToSpend({
    cashCents,
    setAsideCents,
    bills: opts.bills.map((b) => ({ dueDateIso: b.dueDate, amountCents: b.amountCents, paid: b.paid })),
    givingDueCents: opts.givingDueCents ?? 0,
    liquidityFloorCents: opts.liquidityFloorCents ?? 0,
    todayIso: opts.todayIso,
    nextPaydayIso: opts.nextPaydayIso,
    balanceAsOf,
  });
  const pending = Math.max(opts.budget?.dataThrough.pendingCount ?? 0, 0);
  const dataThrough: DataThrough = {
    at: balanceAsOf,
    quality: cashAccounts.some((a) => a.feedStatus === "stale" || a.feedStatus === "needs_relink") ? "stale" : "imported_pending",
    pendingCount: pending,
  };
  const view: SafeToSpendView = withBillNames({ ...r, dataThrough }, opts.bills);
  const forecast = opts.budget ? forecastFromBudget(opts.budget) : undefined;
  return forecast === undefined ? view : { ...view, forecast };
}

/** Put the bill names on the breakdown's bills-before-payday lines (matched by due date and amount). */
export function withBillNames(view: SafeToSpendView, bills: readonly Bill[]): SafeToSpendView {
  const names = new Map(bills.map((b) => [`${b.dueDate}|${b.amountCents}`, b.name]));
  return {
    ...view,
    billsBeforePayday: view.billsBeforePayday.map((b) => {
      if (b.name !== undefined) return b;
      const name = names.get(`${b.dueDateIso}|${b.amountCents}`);
      return name === undefined ? b : { ...b, name };
    }),
  };
}

/** "At this pace you'll finish the month about $120 under budget." from the budget's forecast column. */
export function forecastFromBudget(budget: BudgetStatus): string | undefined {
  const lines = budget.lines.filter((l) => l.budgetCents > 0);
  if (lines.length === 0) return undefined;
  const diff = lines.reduce((s, l) => s + (l.budgetCents - l.forecastCents), 0);
  if (Math.abs(diff) < 2500) return "At this pace you'll finish the month right on budget.";
  if (diff > 0) return `At this pace you'll finish the month about ${money0(diff)} under budget.`;
  const worst = [...lines].sort((a, b) => a.budgetCents - a.forecastCents - (b.budgetCents - b.forecastCents))[0];
  return `At this pace you'd finish about ${money0(-diff)} over budget. ${worst ? `${worst.name} is the category to go easy on this week.` : ""}`.trim();
}
