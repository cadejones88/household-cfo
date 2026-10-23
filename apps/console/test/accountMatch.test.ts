/**
 * Suggestions for which household account a bank account feeds: kind and mask must both fit and the match must be
 * unique (narrowed by institution); credit-union member numbers leave ties to the person; no account twice; accounts
 * another login feeds are never suggested and block saving.
 */
import { describe, expect, it } from "vitest";
import { BANK_CARD_LIST, type AccountSummary } from "@homestead/shared";
import { institutionKey, kindsFor, mappingProblems, maskAgrees, rankCandidates, suggestMatches } from "../src/lib/accountMatch";
import type { BankLoginAccount } from "../src/api/types";

const household: AccountSummary[] = BANK_CARD_LIST.map((b) => ({ id: b.code, displayName: b.name, institution: b.institution, kind: b.kind as AccountSummary["kind"], mask: b.mask, feedStatus: "none", bcBankAccountCode: b.code }));
const acct = (id: string, type: string, subtype: string, mask: string | null, name = id): BankLoginAccount => ({ plaidAccountId: id, name, type, subtype, mask });

describe("account matching", () => {
  it("maps Plaid types to household kinds", () => {
    expect(kindsFor({ type: "depository", subtype: "checking" })).toEqual(["checking"]);
    expect(kindsFor({ type: "depository", subtype: "savings" })).toEqual(["savings", "share"]);
    expect(kindsFor({ type: "credit", subtype: "credit card" })).toEqual(["card", "line"]);
    expect(kindsFor({ type: "loan", subtype: "mortgage" })).toEqual(["mortgage", "line"]);
    expect(kindsFor({ type: "investment", subtype: "401k" })).toEqual([]);
  });

  it("agrees masks across suffixes and member numbers, never on blanks", () => {
    expect(maskAgrees("6450", "6450")).toBe(true);
    expect(maskAgrees("9010", "6289-010")).toBe(true);
    expect(maskAgrees("6289", "6289-010")).toBe(true);
    expect(maskAgrees("1221", "1221")).toBe(true);
    expect(maskAgrees("0001", "6450")).toBe(false);
    expect(maskAgrees(null, "6450")).toBe(false);
    expect(maskAgrees("6450", "")).toBe(false);
  });

  it("names institutions by their first significant word", () => {
    expect(institutionKey("America First Credit Union")).toBe("america");
    expect(institutionKey("America First CU")).toBe("america");
    expect(institutionKey("Beehive Federal Credit Union")).toBe("beehive");
    expect(institutionKey(null)).toBe("");
  });

  it("suggests only unique fits: Capital One's card yes; America First's line (ties with the Visa on 1221) left to the person", () => {
    const s = suggestMatches([acct("cap", "credit", "credit card", "6450")], household, { institutionName: "Capital One" });
    expect(s).toEqual({ cap: "CAPONE-CC" });
    const afcu = suggestMatches([acct("chk", "depository", "checking", "1221"), acct("sav", "depository", "savings", "1221"), acct("visa", "credit", "credit card", "1221"), acct("odl", "credit", "line of credit", "1221")], household, { institutionName: "America First Credit Union" });
    expect(afcu).toEqual({ chk: "AFCU-CHK", sav: "AFCU-SAV", visa: "", odl: "" });
  });

  it("never suggests another bank's account when the bank is known", () => {
    expect(suggestMatches([acct("hsa", "depository", "hsa", "9001")], household, { institutionName: "First Platypus Bank" })).toEqual({ hsa: "" });
    expect(suggestMatches([acct("sav", "depository", "savings", "9001")], household, { institutionName: "Beehive Federal Credit Union" })).toEqual({ sav: "BEEHIVE-SAV" });
  });

  it("never suggests one household account twice, nor one another login feeds", () => {
    expect(suggestMatches([acct("a", "depository", "checking", "1221"), acct("b", "depository", "checking", "1221")], household, { institutionName: "America First CU" })).toEqual({ a: "", b: "" });
    const connectedVia = new Map([["CAPONE-CC", { feedId: "f-other", institutionName: "Capital One" }]]);
    expect(suggestMatches([acct("cap", "credit", "credit card", "6450")], household, { connectedVia })).toEqual({ cap: "" });
    expect(suggestMatches([acct("cap", "credit", "credit card", "6450")], household, { connectedVia, feedConnectionId: "f-other" })).toEqual({ cap: "CAPONE-CC" });
  });

  it("ranks candidates with fitting kinds and masks first", () => {
    const r = rankCandidates(acct("share", "depository", "savings", "7003"), household, { institutionName: "Frontier Credit Union" });
    expect(r[0]!.id).toBe("FRONTIER-SH");
    expect(r.length).toBe(household.length);
  });

  it("blocks saving when an account is chosen twice or is fed by another login", () => {
    const connectedVia = new Map([["CAPONE-CC", { feedId: "f-other", institutionName: "Capital One" }]]);
    expect(mappingProblems({ a: "AFCU-CHK", b: "AFCU-CHK" }, household)).toEqual(["America First checking is chosen for 2 bank accounts; pick one."]);
    expect(mappingProblems({ a: "CAPONE-CC" }, household, { connectedVia })).toEqual(["Capital One card is already connected through Capital One. Remove that login first."]);
    expect(mappingProblems({ a: "CAPONE-CC", b: "" }, household, { connectedVia, feedConnectionId: "f-other" })).toEqual([]);
  });
});
