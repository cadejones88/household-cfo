/**
 * Alerts from the forecast (pure parts): bills uncovered within 3 days, cash short, materiality on duplicates and
 * out-of-pattern charges, re-link to the owner only, quiet hours 9 pm–7 am Mountain, fingerprint repeats only on a
 * change of more than $25 or a moved date, agreed actions pending keep an alert quiet.
 */
import { describe, expect, it } from "vitest";
import { evaluateAlerts, factsChanged, inQuietHours, instantAtLocal, isoWeek, quietHoursEnd, type AlertInputs } from "../src/services/alerts.js";

function inputs(over: Partial<AlertInputs> = {}): AlertInputs {
  return {
    todayIso: "2026-10-20",
    nowIso: "2026-10-20T15:00:00Z",
    nextPaydayIso: "2026-10-30",
    liquidityFloorCents: 0,
    accounts: [{ id: "chk", name: "America First checking", balanceCents: 100000, feedStaleHours: 2, feedId: "f1", feedOwnerMemberId: "cade", needsRelink: false }],
    bills: [],
    safeCents: 50000,
    overruns: [],
    duplicates: [],
    outOfPattern: [],
    receiptsMissing: [],
    deadLetters: [],
    pendingActionKeys: new Set(),
    ...over,
  };
}

describe("evaluateAlerts", () => {
  it("raises one action alert when a bill due within 3 days is not covered, and a cash-short alert for the account", () => {
    const out = evaluateAlerts(inputs({ bills: [{ id: "b1", name: "Frontier CU · F-350", accountId: "chk", dueDate: "2026-10-22", amountCents: 149609, isMinimum: false }] }));
    expect(out.map((a) => [a.kind, a.level, a.fingerprint])).toEqual([
      ["bill_uncovered", "action", "bill_uncovered:b1"],
      ["cash_short", "action", "cash_short:chk"],
    ]);
    expect(out[0]!.memberId).toBeNull();
  });

  it("stays quiet for a bill beyond 3 days, and while an agreed action is pending", () => {
    expect(evaluateAlerts(inputs({ bills: [{ id: "b1", name: "x", accountId: "chk", dueDate: "2026-10-25", amountCents: 999999, isMinimum: false }] }))).toEqual([]);
    const held = evaluateAlerts(inputs({ bills: [{ id: "b1", name: "x", accountId: "chk", dueDate: "2026-10-21", amountCents: 150000, isMinimum: false }], pendingActionKeys: new Set(["bill:b1", "cash_short:chk"]) }));
    expect(held).toEqual([]);
  });

  it("only alerts duplicates and out-of-pattern charges of $25 or more", () => {
    const out = evaluateAlerts(inputs({ duplicates: [{ transactionId: "t1", amountCents: -2499, merchant: "x" }, { transactionId: "t2", amountCents: -2500, merchant: "y" }], outOfPattern: [{ transactionId: "t3", amountCents: -60000, merchant: "Maverik" }] }));
    expect(out.map((a) => a.fingerprint)).toEqual(["possible_duplicate:t2", "out_of_pattern:t3"]);
  });

  it("sends a re-link card to the login's owner only (watch, no push)", () => {
    const out = evaluateAlerts(inputs({ accounts: [{ id: "chk", name: "Beehive", balanceCents: 100000, feedStaleHours: 1, feedId: "f1", feedOwnerMemberId: "vanessa", needsRelink: true }] }));
    expect(out).toEqual([expect.objectContaining({ kind: "needs_relink", level: "watch", memberId: "vanessa", fingerprint: "needs_relink:f1" })]);
  });

  it("watch level for overruns, safe-to-spend under the floor and a receipt missing 7+ days", () => {
    const out = evaluateAlerts(inputs({ overruns: [{ categoryId: "groceries", name: "Groceries", forecastCents: 180000, budgetCents: 150000 }], safeCents: -100, receiptsMissing: [{ transactionId: "t9", amountCents: -8103, merchant: "Walmart", daysWaiting: 8 }, { transactionId: "t8", amountCents: -5000, merchant: "Walmart", daysWaiting: 3 }] }));
    expect(out.map((a) => [a.kind, a.level])).toEqual([
      ["category_overrun", "watch"],
      ["safe_below_floor", "watch"],
      ["receipt_missing", "watch"],
    ]);
  });
});

describe("fingerprints and quiet hours", () => {
  it("repeats only when the facts move more than $25 or the date moves", () => {
    expect(factsChanged({ amountCents: 10000, dueDate: "2026-10-22" }, { amountCents: 12500, dueDate: "2026-10-22" })).toBe(false);
    expect(factsChanged({ amountCents: 10000, dueDate: "2026-10-22" }, { amountCents: 12501, dueDate: "2026-10-22" })).toBe(true);
    expect(factsChanged({ amountCents: 10000, dueDate: "2026-10-22" }, { amountCents: 10000, dueDate: "2026-10-23" })).toBe(true);
  });

  it("knows 9 pm to 7 am Mountain, across daylight saving", () => {
    const qh = { quietHours: { start: "21:00", end: "07:00" } };
    expect(inQuietHours(new Date("2026-10-21T04:30:00Z"), qh, "America/Boise")).toBe(true); // 22:30 MDT
    expect(inQuietHours(new Date("2026-10-21T13:30:00Z"), qh, "America/Boise")).toBe(false); // 07:30 MDT
    expect(inQuietHours(new Date("2026-12-21T13:30:00Z"), qh, "America/Boise")).toBe(true); // 06:30 MST
    expect(instantAtLocal("2026-10-21", 7 * 60, "America/Boise").toISOString()).toBe("2026-10-21T13:00:00.000Z");
    expect(instantAtLocal("2026-12-21", 7 * 60, "America/Boise").toISOString()).toBe("2026-12-21T14:00:00.000Z");
    expect(quietHoursEnd(new Date("2026-10-21T04:30:00Z"), qh, "America/Boise").toISOString()).toBe("2026-10-21T13:00:00.000Z");
  });

  it("names the weekly pulse by ISO week", () => {
    expect(isoWeek("2026-10-20")).toBe("2026-W43");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
  });
});
