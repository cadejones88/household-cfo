/**
 * The journal lines of one BC document (A2, A4): the bank side through the bank card, every G/L line with its
 * dimensions, transfers and card payments through the clearing accounts, the CTJ business flag both ways, lash.
 */
import { externalDocumentNo, idempotencyKey, isSpendingAccount } from "@homestead/shared";
import { describe, expect, it } from "vitest";
import { buildJournalLines, netByAccount, type LineSource } from "../src/services/journalLines.js";
import { catalogMap } from "./helpers/catalog.js";

const cats = catalogMap();
function src(amountCents: number, over: Partial<LineSource> = {}): LineSource {
  const key = idempotencyKey.plaid("acct-1", `t${Math.abs(amountCents)}`);
  return { idempotencyKey: key, externalDocumentNo: externalDocumentNo(key, "2026-10-15"), postedDate: "2026-10-15", amountCents, merchantRaw: "TEST MERCHANT", businessFlag: "none", kind: "spend", dimensionSet: {}, ...over };
}
const split = (amountCents: number, categoryId: string) => ({ lineNo: 1, amountCents, categoryId, glAccount: cats.get(categoryId)!.gl_account, dimensionSet: {}, description: "" });
const sum = (ls: { amountCents: number }[]) => ls.reduce((s, l) => s + l.amountCents, 0);

describe("buildJournalLines", () => {
  it("posts a card charge as Cr bank card, Dr the category account with the full dimension set", () => {
    const lines = buildJournalLines(src(-4517), [split(-4517, "fuel")], { bcBankAccountCode: "CAPONE-CC", bcGlAccount: "201101", displayName: "Capital One" }, cats);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountType: "Bank Account", accountNo: "CAPONE-CC", amountCents: -4517 });
    expect(lines[1]).toMatchObject({ accountType: "G/L Account", accountNo: "604101", amountCents: 4517 });
    expect(lines[1]!.dimensions.map((d) => d.code)).toEqual(expect.arrayContaining(["SPEND_CLASS", "FAMILY_AREA", "TAX_TREATMENT"]));
    expect(sum(lines)).toBe(0);
    expect(new Set(lines.map((l) => l.externalDocumentNo)).size).toBe(1);
  });

  it("A2: a transfer and a card payment post through 115101 and 115201, which net to zero across both sides", () => {
    const out = buildJournalLines(src(-50000), [split(-50000, "transfer-own")], { bcBankAccountCode: "BEEHIVE-CHK", bcGlAccount: "101101", displayName: "Beehive" }, cats);
    const inn = buildJournalLines(src(50000, { idempotencyKey: idempotencyKey.plaid("acct-2", "t-in"), externalDocumentNo: externalDocumentNo(idempotencyKey.plaid("acct-2", "t-in"), "2026-10-15") }), [split(50000, "transfer-own")], { bcBankAccountCode: "BEEHIVE-SAV", bcGlAccount: "102101", displayName: "Savings" }, cats);
    const payOut = buildJournalLines(src(-36300), [split(-36300, "card-payment")], { bcBankAccountCode: "AFCU-CHK", bcGlAccount: "101201", displayName: "AFCU" }, cats);
    const payIn = buildJournalLines(src(36300, { idempotencyKey: idempotencyKey.plaid("acct-3", "t-pay"), externalDocumentNo: externalDocumentNo(idempotencyKey.plaid("acct-3", "t-pay"), "2026-10-15") }), [split(36300, "card-payment")], { bcBankAccountCode: "CAPONE-CC", bcGlAccount: "201101", displayName: "Capital One" }, cats);
    const net = netByAccount([...out, ...inn, ...payOut, ...payIn]);
    expect(net.get("115101")).toBe(0);
    expect(net.get("115201")).toBe(0);
    // Nothing lands on a spending account.
    for (const l of [...out, ...inn, ...payOut, ...payIn]) if (l.accountType === "G/L Account") expect(isSpendingAccount(l.accountNo)).toBe(false);
  });

  it("A4: a Capital One payment paid by CTJ posts Cr 404102 with the natural debit on the card", () => {
    const lines = buildJournalLines(src(36300, { businessFlag: "ctj" }), [split(36300, "card-payment")], { bcBankAccountCode: "CAPONE-CC", bcGlAccount: "201101", displayName: "Capital One" }, cats);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.accountType === "Bank Account")).toMatchObject({ accountNo: "CAPONE-CC", amountCents: 36300 });
    expect(lines.find((l) => l.accountNo === "404102")).toMatchObject({ amountCents: -36300, comment: "BUSINESS CTJ" });
  });

  it("A4 reverse: a household-card charge marked business posts Dr 112101 and Cr the card; the category is not posted", () => {
    const lines = buildJournalLines(src(-12999, { businessFlag: "ctj" }), [split(-12999, "electronics")], { bcBankAccountCode: "CAPONE-CC", bcGlAccount: "201101", displayName: "Capital One" }, cats);
    expect(lines.map((l) => l.accountNo)).toEqual(["CAPONE-CC", "112101"]);
    expect(lines[1]!.amountCents).toBe(12999);
    expect(lines.some((l) => l.accountNo === "609101")).toBe(false);
  });

  it("lash business: money out lands in the lash Schedule C accounts with DED-BUS and FAMILY_AREA VANESSA", () => {
    const lines = buildJournalLines(src(-2599, { businessFlag: "lash" }), [split(-2599, "beauty")], { bcBankAccountCode: "BEEHIVE-CHK", bcGlAccount: "101101", displayName: "Beehive" }, cats);
    const g = lines.find((l) => l.accountType === "G/L Account")!;
    expect(g.accountNo).toBe("731301");
    expect(Object.fromEntries(g.dimensions.map((d) => [d.code, d.valueCode]))).toMatchObject({ FAMILY_AREA: "VANESSA", TAX_TREATMENT: "DED-BUS" });
  });

  it("refuses splits that do not equal the amount, and an account with no BC mapping", () => {
    expect(() => buildJournalLines(src(-1000), [split(-900, "fuel")], { bcBankAccountCode: "CAPONE-CC", bcGlAccount: null, displayName: "x" }, cats)).toThrow(/do not equal/);
    expect(() => buildJournalLines(src(-1000), [split(-1000, "fuel")], { bcBankAccountCode: null, bcGlAccount: null, displayName: "x" }, cats)).toThrow(/no BC bank card/);
  });
});
