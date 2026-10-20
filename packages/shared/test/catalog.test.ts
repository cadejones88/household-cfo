import { describe, expect, it } from "vitest";
import { BANK_CARD_LIST, CHART, account, isSpendingAccount, mustPostThroughBankCard } from "../src/chart.js";
import { CATEGORIES, category, householdCategories } from "../src/categories.js";
import { assertDimensionSet, toBcDimensionSetLines } from "../src/dimensions.js";
import { buildPaycheckLines } from "../src/paycheck.js";
import { splitReceipt, matchReceipt } from "../src/receipts.js";
import { amountBand, inBand, ruleBlockReasons, tierOf } from "../src/confidence.js";
import { daysBetween, nextBiweeklyPayday, safeToSpend } from "../src/safeToSpend.js";

describe("chart and categories", () => {
  it("has unique account numbers and every category points at a posting account", () => {
    const nos = CHART.map((a) => a.no);
    expect(new Set(nos).size).toBe(nos.length);
    for (const c of CATEGORIES) expect(account(c.glAccount).no).toBe(c.glAccount);
    const ids = CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("carries valid default dimensions on every account and category", () => {
    for (const a of CHART) assertDimensionSet(a.dims);
    for (const c of CATEGORIES) assertDimensionSet(c.dims);
  });
  it("never lets the app post to a bank-card G/L account directly", () => {
    for (const b of BANK_CARD_LIST) expect(mustPostThroughBankCard(b.glAccount)).toBe(true);
    expect(mustPostThroughBankCard("603101")).toBe(false);
  });
  it("excludes transfers, principal and noncash from spending", () => {
    expect(isSpendingAccount("603101")).toBe(true);
    expect(isSpendingAccount("501101")).toBe(true);
    expect(isSpendingAccount("115101")).toBe(false);
    expect(isSpendingAccount("271101")).toBe(false);
    expect(isSpendingAccount("404901")).toBe(false);
    expect(category("card-payment").isTransfer).toBe(true);
  });
  it("hides CFO-only categories from the household list", () => {
    expect(householdCategories().some((c) => c.id === "uncategorized")).toBe(false);
    expect(householdCategories().some((c) => c.id === "groceries")).toBe(true);
  });
  it("renders BC dimension set lines in a fixed order", () => {
    expect(toBcDimensionSetLines({ TAX_TREATMENT: "NONDEDUCT", SPEND_CLASS: "ESSENTIAL", FAMILY_AREA: "JOINT" })).toEqual([
      { code: "SPEND_CLASS", valueCode: "ESSENTIAL" },
      { code: "FAMILY_AREA", valueCode: "JOINT" },
      { code: "TAX_TREATMENT", valueCode: "NONDEDUCT" },
    ]);
    expect(() => assertDimensionSet({ SPEND_CLASS: "TRANSFER", TAX_TREATMENT: "NONDEDUCT" })).toThrow();
  });
});

describe("paycheck lines (T01 from the sandbox test)", () => {
  const components = [
    { kind: "regular" as const, label: "Regular", amountCents: 388077 },
    { kind: "fit" as const, label: "Federal withholding", amountCents: 29830 },
    { kind: "state_tax" as const, label: "Idaho withholding", amountCents: 15000 },
    { kind: "social_security" as const, label: "Social Security", amountCents: 24061 },
    { kind: "medicare" as const, label: "Medicare", amountCents: 5627 },
  ];
  it("ties gross to net and balances to zero", () => {
    const lines = buildPaycheckLines({ employer: "HFH", components, netCents: 313559, payDateIso: "2026-10-24" });
    expect(lines.find((l) => l.kind === "regular")?.amountCents).toBe(-388077);
    expect(lines.find((l) => l.glAccount === "701101")?.amountCents).toBe(29830);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(0);
  });
  it("refuses a stub that does not tie", () => {
    expect(() => buildPaycheckLines({ employer: "HFH", components, netCents: 300000, payDateIso: "2026-10-24" })).toThrow(/do not tie/);
  });
  it("posts bonus to gross wages with a BONUS comment until 401102 exists, then to 401102", () => {
    const withBonus = [...components, { kind: "bonus" as const, label: "Quarterly bonus", amountCents: 50000 }];
    const before = buildPaycheckLines({ employer: "HFH", components: withBonus, netCents: 363559, payDateIso: "2026-10-24", existingAccounts: new Set(["401101"]) });
    expect(before.find((l) => l.kind === "bonus")?.glAccount).toBe("401101");
    expect(before.find((l) => l.kind === "bonus")?.description).toMatch(/^BONUS/);
    const after = buildPaycheckLines({ employer: "HFH", components: withBonus, netCents: 363559, payDateIso: "2026-10-24", existingAccounts: new Set(["401101", "401102"]) });
    expect(after.find((l) => l.kind === "bonus")?.glAccount).toBe("401102");
  });
});

describe("receipt split and match", () => {
  it("prorates tax to the cent and merges same-category lines (T06)", () => {
    const r = splitReceipt({
      totalCents: 15079,
      taxCents: 842,
      receiptRequiredMerchant: true,
      lines: [
        { description: "Milk", amountCents: 4820, categoryId: "groceries", confidence: 0.99 },
        { description: "Bread", amountCents: 4000, categoryId: "groceries", confidence: 0.99 },
        { description: "Paper towels", amountCents: 3117, categoryId: "household-supplies", confidence: 0.99 },
        { description: "Toy", amountCents: 2300, categoryId: "general-merchandise", confidence: 0.95 },
      ],
    });
    expect(r.lines).toHaveLength(3);
    expect(r.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(15079);
    expect(r.needsConfirmation).toBe(true);
  });
  it("refuses a split that does not tie", () => {
    expect(() => splitReceipt({ totalCents: 1000, taxCents: 0, receiptRequiredMerchant: false, lines: [{ description: "x", amountCents: 999, categoryId: "other", confidence: 1 }] })).toThrow(/does not equal/);
  });
  it("matches one exact candidate and asks when two are plausible", () => {
    const base = { receiptDateIso: "2026-10-20", totalCents: 4213, merchantNorm: "broulims", tipPossible: false, daysBetween };
    const one = matchReceipt({ ...base, candidates: [{ transactionId: "t1", postedDate: "2026-10-21", amountCents: -4213, merchantNorm: "broulims rexburg", accountId: "a" }] });
    expect(one.matched?.transactionId).toBe("t1");
    const two = matchReceipt({
      ...base,
      candidates: [
        { transactionId: "t1", postedDate: "2026-10-21", amountCents: -4213, merchantNorm: "broulims rexburg", accountId: "a" },
        { transactionId: "t2", postedDate: "2026-10-21", amountCents: -4213, merchantNorm: "broulims rexburg", accountId: "a" },
      ],
    });
    expect(two.matched).toBeUndefined();
    expect(two.ambiguous).toBe(true);
    const far = matchReceipt({ ...base, candidates: [{ transactionId: "t3", postedDate: "2026-11-01", amountCents: -4213, merchantNorm: "broulims", accountId: "a" }] });
    expect(far.matched).toBeUndefined();
  });
});

describe("confidence and the drift guard", () => {
  it("tiers confidence", () => {
    expect(tierOf(0.99)).toBe("high");
    expect(tierOf(0.8)).toBe("medium");
    expect(tierOf(0.3)).toBe("low");
  });
  it("asks about a $600 charge at a $150 merchant", () => {
    const band = amountBand([15000, 15320, 14980]);
    expect(inBand(15200, band)).toBe(true);
    expect(inBand(60000, band)).toBe(false);
    expect(ruleBlockReasons({ amountCents: 60000, band, merchantOnWatchList: false, businessFlagged: false, receiptSplitPending: false, feedStaleHours: 2, householdAutoPostOn: true })).toEqual(["outside_band"]);
  });
  it("blocks when the switch is off or the feed is stale", () => {
    expect(ruleBlockReasons({ amountCents: 100, merchantOnWatchList: false, businessFlagged: false, receiptSplitPending: false, feedStaleHours: 72, householdAutoPostOn: false })).toEqual(["feed_stale", "autopost_off"]);
  });
});

describe("safe to spend", () => {
  it("subtracts set-asides, bills before payday, giving and the floor", () => {
    const r = safeToSpend({
      cashCents: 101202,
      setAsideCents: 30000,
      bills: [
        { dueDateIso: "2026-10-21", amountCents: 15320 },
        { dueDateIso: "2026-10-23", amountCents: 11840 },
        { dueDateIso: "2026-10-30", amountCents: 36300 },
        { dueDateIso: "2026-10-22", amountCents: 999, paid: true },
      ],
      givingDueCents: 0,
      liquidityFloorCents: 0,
      todayIso: "2026-10-20",
      nextPaydayIso: "2026-10-24",
      balanceAsOf: "2026-10-20T07:00:00-06:00",
    });
    expect(r.billsBeforePaydayCents).toBe(27160);
    expect(r.safeCents).toBe(101202 - 30000 - 27160);
    expect(r.daysUntilPayday).toBe(4);
    expect(r.status).toBe("on_track");
  });
  it("finds the next biweekly Friday payday", () => {
    expect(nextBiweeklyPayday("2026-10-20", "2026-10-10")).toBe("2026-10-24");
    expect(nextBiweeklyPayday("2026-10-24", "2026-10-10")).toBe("2026-11-07");
    expect(nextBiweeklyPayday("2026-10-24", "2026-10-10", true)).toBe("2026-10-24");
  });
});
