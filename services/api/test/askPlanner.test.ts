/** Ask Homestead's code-side pieces: the keyword planner, drafted moves (never executed), the template answer. */
import { describe, expect, it } from "vitest";
import { draftActionFor, earliest, planCalls, renderTemplate } from "../src/services/ask/orchestrate.js";

const cats = [
  { id: "groceries", name: "Groceries" },
  { id: "eating-out", name: "Eating out" },
  { id: "fuel", name: "Fuel" },
];

describe("planCalls", () => {
  it("picks read-only functions from the question's words", () => {
    expect(planCalls("How much is safe to spend before payday?", "2026-10-20", cats).map((c) => c.fn)).toEqual(["get_safe_to_spend"]);
    expect(planCalls("Are we on track with the budget in September?", "2026-10-20", cats)).toEqual([{ fn: "get_budget_status", args: { month: "2026-09" } }]);
    expect(planCalls("What bills are due?", "2026-10-20", cats).map((c) => c.fn)).toEqual(["get_bills"]);
    expect(planCalls("How is the emergency fund goal?", "2026-10-20", cats).map((c) => c.fn)).toEqual(["get_goals"]);
    expect(planCalls("Show my last paycheck withholding", "2026-10-20", cats).map((c) => c.fn)).toEqual(["get_paycheck"]);
    const s = planCalls("What did we spend at maverik last week?", "2026-10-20", cats);
    expect(s).toEqual([{ fn: "search_transactions", args: { query: "maverik", from: "2026-10-13", to: "2026-10-20" } }]);
    expect(planCalls("hello", "2026-10-20", cats).map((c) => c.fn)).toEqual(["get_safe_to_spend", "get_budget_status"]);
  });
});

describe("draftActionFor", () => {
  it('turns "move $50 to groceries" into a drafted budget move, and nothing else', () => {
    expect(draftActionFor("Move $50 to groceries", cats)).toEqual({ kind: "budget_move", fromCategoryId: "", toCategoryId: "groceries", amountCents: 5000 });
    expect(draftActionFor("move 25.50 from eating out to groceries", cats)).toEqual({ kind: "budget_move", fromCategoryId: "eating-out", toCategoryId: "groceries", amountCents: 2550 });
    expect(draftActionFor("how much did we spend on groceries", cats)).toBeUndefined();
    expect(draftActionFor("move it to somewhere", cats)).toBeUndefined();
  });
});

describe("renderTemplate and earliest", () => {
  it("writes sentences from the rows only", () => {
    const text = renderTemplate({ question: "q", categoryNames: [], results: [{ fn: "get_bills", dataThrough: { at: "2026-10-20T00:00:00Z", quality: "posted_unreconciled", pendingCount: 0 }, rows: { nextPayday: "2026-10-30", bills: [{ name: "Verizon · phones", amountCents: 15320, dueDate: "2026-10-23", beforePayday: true, paid: false }] } }] });
    expect(text).toBe("1 bill before payday on 2026-10-30: Verizon · phones $153.20 on 2026-10-23.");
  });
  it("reports the earliest data-through and the weakest quality", () => {
    const d = earliest([{ at: "2026-10-20T10:00:00Z", quality: "posted_unreconciled", pendingCount: 2 }, { at: "2026-10-19T08:00:00Z", quality: "estimated", pendingCount: 5 }], new Date());
    expect(d).toEqual({ at: "2026-10-19T08:00:00Z", quality: "estimated", pendingCount: 5 });
  });
});
