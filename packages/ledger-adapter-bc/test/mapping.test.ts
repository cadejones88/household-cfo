import { buildPaycheckLines, externalDocumentNo, idempotencyKey } from "@homestead/shared";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_CARD_PAYMENT_CLEARING,
  ACCOUNT_CTJ_PAID_PERSONAL,
  ACCOUNT_DUE_FROM_CTJ,
  ACCOUNT_TRANSFER_CLEARING,
  MappingError,
  mapTransactionToJournalLines,
  paycheckLinesToSplits,
  type AppTransactionForLedger,
} from "../src/mapping.js";

const DATE = "2026-10-20";
const doc = (k: string): string => externalDocumentNo(k, DATE);
const sum = (lines: readonly { amountCents: number }[]): number => lines.reduce((a, l) => a + l.amountCents, 0);
const dims = (line: { dimensionSetLines: { code: string; valueCode: string }[] }): Record<string, string> => Object.fromEntries(line.dimensionSetLines.map((d) => [d.code, d.valueCode]));

function spend(over: Partial<AppTransactionForLedger> = {}): AppTransactionForLedger {
  return {
    externalDocumentNo: doc(idempotencyKey.plaid("a1", "t1")),
    postingDate: DATE,
    description: "BROULIMS #12 REXBURG ID",
    amountCents: -8742,
    bankCard: "BEEHIVE-CHK",
    kind: "spend",
    businessFlag: "none",
    splits: [{ lineNo: 1, amountCents: -8742, glAccount: "603101", dims: {} }],
    comment: idempotencyKey.plaid("a1", "t1"),
    ...over,
  };
}

describe("mapTransactionToJournalLines", () => {
  it("maps a grocery spend to a debit on 603101 and the bank line, with the chart's dimensions", () => {
    const d = mapTransactionToJournalLines(spend());
    expect(d.lines).toHaveLength(2);
    expect(sum(d.lines)).toBe(0);
    const [gl, bank] = d.lines;
    expect(gl).toMatchObject({ accountType: "G/L Account", accountNumber: "603101", amountCents: 8742, externalDocumentNumber: d.externalDocumentNo, postingDate: DATE });
    expect(dims(gl!)).toEqual({ SPEND_CLASS: "ESSENTIAL", FAMILY_AREA: "JOINT", TAX_TREATMENT: "NONDEDUCT" });
    expect(bank).toMatchObject({ accountType: "Bank Account", accountNumber: "BEEHIVE-CHK", amountCents: -8742 });
    expect(dims(bank!)).toEqual({ FUND_GOAL: "OPERATING", FAMILY_AREA: "JOINT", TAX_TREATMENT: "TAXABLE" });
    expect(gl?.comment).toBe("plaid:a1:t1");
  });

  it("keeps a three-way split per line and lets split dimensions override the chart defaults", () => {
    const d = mapTransactionToJournalLines(
      spend({
        amountCents: -4250,
        bankCard: "CAPONE-CC",
        splits: [
          { lineNo: 1, amountCents: -3000, glAccount: "603101", dims: { PROJECT: "XMAS-2026" } },
          { lineNo: 2, amountCents: -1250, glAccount: "603301", dims: { FAMILY_AREA: "KIDS" }, description: "paper towels" },
        ],
      }),
    );
    expect(d.lines.map((l) => [l.accountNumber, l.amountCents])).toEqual([
      ["603101", 3000],
      ["603301", 1250],
      ["CAPONE-CC", -4250],
    ]);
    expect(dims(d.lines[0]!).PROJECT).toBe("XMAS-2026");
    expect(dims(d.lines[1]!).FAMILY_AREA).toBe("KIDS");
    expect(d.lines[1]?.description).toBe("paper towels");
    expect(sum(d.lines)).toBe(0);
  });

  it("refuses splits that do not sum to the amount, zero lines, and accounts that must post through a bank card", () => {
    expect(() => mapTransactionToJournalLines(spend({ splits: [{ lineNo: 1, amountCents: -8000, glAccount: "603101" }] }))).toThrow(/Splits sum/);
    expect(() => mapTransactionToJournalLines(spend({ splits: [{ lineNo: 1, amountCents: -8742, glAccount: "101101" }] }))).toThrow(/bank card/);
    expect(() => mapTransactionToJournalLines(spend({ splits: [{ lineNo: 1, amountCents: -8742, glAccount: "999999" }] }))).toThrow(/Unknown posting account/);
    expect(() => mapTransactionToJournalLines(spend({ amountCents: 0, splits: [] }))).toThrow(MappingError);
    expect(() => mapTransactionToJournalLines(spend({ kind: "bc_native" }))).toThrow(/recurring journals/);
    expect(() => mapTransactionToJournalLines(spend({ bankCard: undefined }))).toThrow(/paidBy/);
  });

  it("transfer between own accounts goes through 115101 on each side and nets to zero", () => {
    const out = mapTransactionToJournalLines(spend({ kind: "transfer", amountCents: -50000, splits: [], bankCard: "BEEHIVE-CHK", counterpartyBankCard: "AFCU-SAV", bankLineDims: {} }));
    const back = mapTransactionToJournalLines(spend({ externalDocumentNo: doc(idempotencyKey.plaid("a2", "t2")), kind: "transfer", amountCents: 50000, splits: [], bankCard: "AFCU-SAV", counterpartyBankCard: "BEEHIVE-CHK", bankLineDims: { FUND_GOAL: "EMERG-3-6M" } }));
    expect(out.clearingAccount).toBe(ACCOUNT_TRANSFER_CLEARING);
    expect(out.lines.map((l) => [l.accountNumber, l.amountCents])).toEqual([
      ["115101", 50000],
      ["BEEHIVE-CHK", -50000],
    ]);
    expect(back.lines.map((l) => [l.accountNumber, l.amountCents])).toEqual([
      ["115101", -50000],
      ["AFCU-SAV", 50000],
    ]);
    expect(dims(out.lines[0]!)).toEqual({ SPEND_CLASS: "TRANSFER", FAMILY_AREA: "JOINT", TAX_TREATMENT: "TAXFREE" });
    expect(dims(back.lines[1]!).FUND_GOAL).toBe("EMERG-3-6M");
    const clearingNet = out.lines[0]!.amountCents + back.lines[0]!.amountCents;
    expect(clearingNet).toBe(0);
  });

  it("card payment goes through 115201; the card side needs no counterparty to know it", () => {
    const fromChecking = mapTransactionToJournalLines(spend({ kind: "transfer", amountCents: -30000, splits: [], bankCard: "AFCU-CHK", counterpartyBankCard: "CAPONE-CC" }));
    const onCard = mapTransactionToJournalLines(spend({ kind: "transfer", amountCents: 30000, splits: [], bankCard: "CAPONE-CC" }));
    expect(fromChecking.clearingAccount).toBe(ACCOUNT_CARD_PAYMENT_CLEARING);
    expect(onCard.clearingAccount).toBe(ACCOUNT_CARD_PAYMENT_CLEARING);
    expect(fromChecking.lines[0]).toMatchObject({ accountNumber: "115201", amountCents: 30000 });
    expect(onCard.lines[0]).toMatchObject({ accountNumber: "115201", amountCents: -30000 });
    expect(onCard.lines[1]).toMatchObject({ accountType: "Bank Account", accountNumber: "CAPONE-CC", amountCents: 30000 });
    expect(() => mapTransactionToJournalLines(spend({ kind: "transfer", amountCents: -30000, splits: [], bankCard: "AFCU-CHK" }))).toThrow(/counterpartyBankCard or clearing/);
    expect(mapTransactionToJournalLines(spend({ kind: "transfer", amountCents: -30000, splits: [], bankCard: "AFCU-CHK", clearing: "card" })).clearingAccount).toBe("115201");
    expect(() => mapTransactionToJournalLines(spend({ kind: "transfer", bankCard: "AFCU-CHK", clearing: "own" }))).toThrow(/no category splits/);
  });

  it("A4: a Capital One payment marked paid by CTJ credits 404102 against the card (the natural debit)", () => {
    const d = mapTransactionToJournalLines(spend({ kind: "transfer", amountCents: 50000, splits: [], bankCard: "CAPONE-CC", paidBy: "ctj" }));
    expect(d.lines.map((l) => [l.accountType, l.accountNumber, l.amountCents])).toEqual([
      ["G/L Account", ACCOUNT_CTJ_PAID_PERSONAL, -50000],
      ["Bank Account", "CAPONE-CC", 50000],
    ]);
    expect(dims(d.lines[0]!)).toEqual({ FAMILY_AREA: "CADE", TAX_TREATMENT: "BASIS-ADJ" });
    expect(d.clearingAccount).toBeUndefined();
  });

  it("A4: a personal bill the firm paid with no household account posts the natural expense and Cr 404102", () => {
    const d = mapTransactionToJournalLines(spend({ bankCard: undefined, paidBy: "ctj", amountCents: -18900, splits: [{ lineNo: 1, amountCents: -18900, glAccount: "602101" }] }));
    expect(d.lines.map((l) => [l.accountNumber, l.amountCents])).toEqual([
      ["602101", 18900],
      [ACCOUNT_CTJ_PAID_PERSONAL, -18900],
    ]);
    expect(d.lines.every((l) => l.accountType === "G/L Account")).toBe(true);
    expect(sum(d.lines)).toBe(0);
  });

  it("A4 reverse: a household-card charge marked business posts Dr 112101, not the categories", () => {
    const d = mapTransactionToJournalLines(spend({ bankCard: "AFCU-VISA", businessFlag: "ctj", amountCents: -12000, splits: [{ lineNo: 1, amountCents: -12000, glAccount: "613301" }] }));
    expect(d.lines.map((l) => [l.accountNumber, l.amountCents])).toEqual([
      [ACCOUNT_DUE_FROM_CTJ, 12000],
      ["AFCU-VISA", -12000],
    ]);
    expect(dims(d.lines[0]!)).toEqual({ FAMILY_AREA: "JOINT", TAX_TREATMENT: "BASIS-ADJ" });
    expect(() => mapTransactionToJournalLines(spend({ businessFlag: "ctj", paidBy: "ctj" }))).toThrow(/both/);
  });

  it("lash business charges keep their natural Schedule C lines with DED-BUS", () => {
    const d = mapTransactionToJournalLines(spend({ bankCard: "AFCU-VISA", businessFlag: "lash", amountCents: -6500, splits: [{ lineNo: 1, amountCents: -6500, glAccount: "731101" }] }));
    expect(d.lines[0]).toMatchObject({ accountNumber: "731101", amountCents: 6500 });
    expect(dims(d.lines[0]!)).toMatchObject({ TAX_TREATMENT: "DED-BUS", FAMILY_AREA: "VANESSA", SPEND_CLASS: "COMMITTED" });
  });

  it("income credits the income account and debits the bank", () => {
    const d = mapTransactionToJournalLines(spend({ kind: "income", bankCard: "VENMO", amountCents: 7500, splits: [{ lineNo: 1, amountCents: 7500, glAccount: "402201" }] }));
    expect(d.lines.map((l) => [l.accountNumber, l.amountCents])).toEqual([
      ["402201", -7500],
      ["VENMO", 7500],
    ]);
  });

  it("maps a paycheck by component into one document that ties to net pay", () => {
    const lines = buildPaycheckLines({
      employer: "HFH",
      payDateIso: DATE,
      netCents: 250_000 - 30_000 - 12_000 - 15_500 - 3_625 - 20_000,
      existingAccounts: new Set(["401101", "401102"]),
      components: [
        { kind: "regular", label: "Regular", amountCents: 200_000 },
        { kind: "bonus", label: "Bonus", amountCents: 50_000 },
        { kind: "fit", label: "Federal", amountCents: 30_000 },
        { kind: "state_tax", label: "Idaho", amountCents: 12_000 },
        { kind: "social_security", label: "OASDI", amountCents: 15_500 },
        { kind: "medicare", label: "Medicare", amountCents: 3_625 },
        { kind: "benefit", label: "Health", amountCents: 20_000, glAccountOverride: "605301" },
      ],
    });
    const net = 250_000 - 30_000 - 12_000 - 15_500 - 3_625 - 20_000;
    const d = mapTransactionToJournalLines(spend({ externalDocumentNo: doc(idempotencyKey.paycheck("hfh", DATE, net)), kind: "paycheck", bankCard: "BEEHIVE-CHK", amountCents: net, splits: paycheckLinesToSplits(lines) }));
    expect(sum(d.lines)).toBe(0);
    expect(d.lines.find((l) => l.accountNumber === "401101")?.amountCents).toBe(-200_000);
    expect(d.lines.find((l) => l.accountNumber === "401102")?.amountCents).toBe(-50_000);
    expect(d.lines.find((l) => l.accountNumber === "701201")?.amountCents).toBe(12_000);
    expect(d.lines[d.lines.length - 1]).toMatchObject({ accountType: "Bank Account", accountNumber: "BEEHIVE-CHK", amountCents: net });
  });

  it("truncates descriptions to 100 characters and comments to 250", () => {
    const long = "x".repeat(300);
    const d = mapTransactionToJournalLines(spend({ description: long, comment: long }));
    expect(d.lines.every((l) => l.description.length === 100)).toBe(true);
    expect(d.lines.every((l) => l.comment?.length === 250)).toBe(true);
  });

  it("rejects a malformed external document number or date", () => {
    expect(() => mapTransactionToJournalLines(spend({ externalDocumentNo: "HHAPP-XXX-20261020-ABCDEF12" }))).toThrow(/External Document No/);
    expect(() => mapTransactionToJournalLines(spend({ postingDate: "20261020" }))).toThrow(/YYYY-MM-DD/);
  });
});
