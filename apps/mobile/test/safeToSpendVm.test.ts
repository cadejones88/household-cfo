import { describe, expect, it } from "vitest";
import type { AccountSummary, Bill, BudgetStatus, Goal } from "@homestead/shared";
import { buildSafeToSpendVm, composeSafeToSpend, forecastFromBudget } from "@/model/safeToSpendVm";
import type { SafeToSpendView } from "@/api/types";

const dt = { at: "2026-10-19T23:59:00-06:00", quality: "imported_pending" as const, pendingCount: 2 };

function view(over: Partial<SafeToSpendView> = {}): SafeToSpendView {
  return {
    safeCents: 44042,
    cashCents: 101202,
    setAsideCents: 30000,
    billsBeforePaydayCents: 27160,
    billsBeforePayday: [
      { name: "Verizon · phones", dueDateIso: "2026-10-20", amountCents: 15320 },
      { name: "Rocky Mountain Power", dueDateIso: "2026-10-22", amountCents: 11840 },
    ],
    givingDueCents: 0,
    liquidityFloorCents: 0,
    nextPaydayIso: "2026-10-23",
    daysUntilPayday: 3,
    perDayCents: 14680,
    balanceAsOf: "2026-10-19T23:59:00-06:00",
    status: "on_track",
    dataThrough: dt,
    ...over,
  };
}

describe("buildSafeToSpendVm", () => {
  it("reads as the prototype's hero card when on track", () => {
    const vm = buildSafeToSpendVm(view(), "2026-10-20");
    expect(vm.headline).toBe("$440.42 safe to spend");
    expect(vm.subline).toBe("after bills due before payday and money set aside");
    expect(vm.untilText).toBe("Until Fri, Oct 23");
    expect(vm.statusLabel).toBe("On track");
    expect(vm.asOf).toBe("as of today Oct 20 · bank data through Oct 19");
    expect(vm.parts.map((p) => p.text)).toEqual(["$1,012.02", "−$300.00", "−$271.60", "Not set yet"]);
    expect(vm.parts[2]?.label).toBe("Bills due before Oct 23");
    expect(vm.parts[3]?.label).toBe("Our minimum cushion");
    expect(vm.resultLabel).toBe("Safe to spend");
    expect(vm.perDayText).toBe("About $147 a day for 3 days");
    expect(vm.paydayText).toBe("Next payday Fri, Oct 23 · 3 days away");
    expect(vm.dataThroughText).toBe("Data through Oct 19 · 2 items pending");
    expect(vm.isShort).toBe(false);
    expect(vm.pendingCount).toBe(2);
  });

  it("never shows a bare red number when short: Short $…, Action needed, one small move", () => {
    const vm = buildSafeToSpendVm(view({ safeCents: -18000, status: "short" }), "2026-10-20");
    expect(vm.headline).toBe("Short $180.00");
    expect(vm.subline).toBe("before payday — one small move fixes it");
    expect(vm.statusLabel).toBe("Action needed");
    expect(vm.resultLabel).toBe("Short");
    expect(vm.perDayText).toBe("");
    expect(vm.forecast).toContain("One small move fixes it");
  });

  it("adds giving due and the floor as parts only when set, and flags stale data", () => {
    const vm = buildSafeToSpendVm(view({ givingDueCents: 38808, liquidityFloorCents: 50000, status: "watch", dataThrough: { ...dt, quality: "stale" } }), "2026-10-20");
    expect(vm.parts.map((p) => p.label)).toEqual(["Cash in checking and savings", "Set aside (emergency fund and sinking funds)", "Bills due before Oct 23", "Giving due on income already received", "Our minimum cushion"]);
    expect(vm.parts.map((p) => p.text).slice(3)).toEqual(["−$388.08", "−$500.00"]);
    expect(vm.statusLabel).toBe("Watch");
    expect(vm.asOf).toContain("may be out of date");
    expect(vm.dataThroughText).toBe("Data through Oct 19 · 2 items pending · may be out of date");
  });
});

describe("composeSafeToSpend", () => {
  const accounts: AccountSummary[] = [
    { id: "chk", displayName: "Checking", institution: "Beehive", kind: "checking", mask: "4821", balanceCents: 61202, balanceAsOf: "2026-10-19T23:59:00-06:00", feedStatus: "ok" },
    { id: "chk2", displayName: "Checking 2", institution: "AFCU", kind: "checking", mask: "1190", balanceCents: 40000, balanceAsOf: "2026-10-19T20:00:00-06:00", feedStatus: "ok" },
    { id: "card", displayName: "Card", institution: "Capital One", kind: "card", mask: "7730", balanceCents: -1050800, feedStatus: "ok" },
  ];
  const goals: Goal[] = [
    { id: "g1", name: "Christmas", fundGoal: "SINK-GIFTS", currentCents: 18000, targetCents: 60000, dataThrough: dt },
    { id: "g2", name: "Car", fundGoal: "SINK-VEHICLE", currentCents: 12000, targetCents: 120000, dataThrough: dt },
    { id: "g3", name: "Capital One", fundGoal: "DEBT-TARGET", currentCents: 1050800, targetCents: 1092800, dataThrough: dt },
  ];
  const bills: Bill[] = [
    { id: "b1", name: "Verizon", dueDate: "2026-10-21", amountCents: 15320, isMinimum: false, beforePayday: true, paid: false },
    { id: "b2", name: "Power", dueDate: "2026-10-22", amountCents: 11840, isMinimum: false, beforePayday: true, paid: false },
    { id: "b5", name: "Due on payday", dueDate: "2026-10-23", amountCents: 9900, isMinimum: false, beforePayday: false, paid: false },
    { id: "b3", name: "Mortgage", dueDate: "2026-11-01", amountCents: 567039, isMinimum: false, beforePayday: false, paid: false },
    { id: "b4", name: "Paid already", dueDate: "2026-10-22", amountCents: 5000, isMinimum: false, beforePayday: true, paid: true },
  ];

  it("uses checking and savings only, set-asides from goals other than operating and debt, and bills before payday", () => {
    const v = composeSafeToSpend({ accounts, goals, bills, nextPaydayIso: "2026-10-23", todayIso: "2026-10-20" });
    expect(v.cashCents).toBe(101202);
    expect(v.setAsideCents).toBe(30000);
    expect(v.billsBeforePaydayCents).toBe(27160);
    expect(v.billsBeforePayday.map((b) => b.name)).toEqual(["Verizon", "Power"]);
    expect(v.safeCents).toBe(44042);
    expect(v.status).toBe("on_track");
    // The oldest balance timestamp is the one shown: the number is only as fresh as its weakest feed.
    expect(v.balanceAsOf).toBe("2026-10-19T20:00:00-06:00");
    expect(v.dataThrough.quality).toBe("imported_pending");
  });

  it("marks the result stale when a cash feed needs a re-link", () => {
    const stale = accounts.map((a) => (a.id === "chk" ? { ...a, feedStatus: "needs_relink" as const } : a));
    const v = composeSafeToSpend({ accounts: stale, goals, bills, nextPaydayIso: "2026-10-23", todayIso: "2026-10-20" });
    expect(v.dataThrough.quality).toBe("stale");
  });
});

describe("forecastFromBudget", () => {
  const budget = (lines: { b: number; f: number; name: string }[]): BudgetStatus => ({
    month: "2026-10",
    budgetName: "sample",
    isSample: true,
    lines: lines.map((l, i) => ({ categoryId: `c${i}`, name: l.name, budgetCents: l.b, spentCents: 0, leftCents: l.b, pace: "on_track", forecastCents: l.f })),
    dataThrough: dt,
  });
  it("says under, on, or over budget in one sentence", () => {
    expect(forecastFromBudget(budget([{ name: "Groceries", b: 190000, f: 178000 }]))).toBe("At this pace you'll finish the month about $120 under budget.");
    expect(forecastFromBudget(budget([{ name: "Groceries", b: 190000, f: 191000 }]))).toBe("At this pace you'll finish the month right on budget.");
    expect(forecastFromBudget(budget([{ name: "Groceries", b: 190000, f: 205000 }, { name: "Gas", b: 60000, f: 61000 }]))).toBe("At this pace you'd finish about $160 over budget. Groceries is the category to go easy on this week.");
    expect(forecastFromBudget(budget([]))).toBeUndefined();
  });
});
