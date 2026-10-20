/**
 * Turns a transaction and its splits into the journal lines of one BC document (spec: "Business Central API
 * mapping"). The bank side posts through the Bank Account card; every G/L line carries the full dimension set.
 *
 * Business flag treatment (A4):
 *   ctj, money out of a household account or card  -> Dr 112101 "Due from (to) CTJ" (CTJ owes us), Cr bank card
 *   ctj, money in (CTJ paid a personal bill)        -> Dr bank card (natural debit), Cr 404102 "Business-Paid Personal Items"
 *   lash, money out                                 -> the lash Schedule C account (731xxx), FAMILY_AREA VANESSA, DED-BUS
 *   lash, money in                                  -> Cr 402101 lash income
 *
 * `packages/ledger-adapter-bc/mapping.ts` builds the same lines for the real adapter; this copy feeds the outbox
 * payload and the A2/A4 tests, so the two must agree (the coordinator's wiring test checks both).
 */
import { account as chartAccount, mergeDimensions, toBcDimensionSetLines, type BusinessFlag, type DimensionSet } from "@homestead/shared";
import type { LedgerJournalLine } from "./ledgerPort.js";
import type { CategoryMap } from "./categories.js";

export interface LineSource {
  idempotencyKey: string;
  externalDocumentNo: string;
  postedDate: string;
  amountCents: number;
  merchantRaw: string;
  businessFlag: BusinessFlag;
  kind: string;
  dimensionSet: DimensionSet;
}

export interface SplitSource {
  lineNo: number;
  amountCents: number;
  categoryId: string;
  glAccount: string;
  dimensionSet: DimensionSet;
  description: string;
}

export interface AccountSource {
  bcBankAccountCode: string | null;
  bcGlAccount: string | null;
  displayName: string;
}

const DUE_FROM_CTJ = "112101";
const CTJ_PAID_PERSONAL = "404102";
const LASH_OTHER = "731301";
const LASH_INCOME = "402101";

export function buildJournalLines(tx: LineSource, splits: readonly SplitSource[], acct: AccountSource, cats: CategoryMap): LedgerJournalLine[] {
  if (splits.length === 0) throw new Error("A transaction needs at least one split before it can be sent to BC");
  const sum = splits.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== tx.amountCents) throw new Error(`Splits (${sum}) do not equal the transaction amount (${tx.amountCents})`);
  const description = (tx.merchantRaw || "Homestead").slice(0, 100);
  const base = { postingDate: tx.postedDate, documentDate: tx.postedDate, externalDocumentNo: tx.externalDocumentNo };

  const lines: LedgerJournalLine[] = [];
  // Bank side: money in is a debit to the bank card, money out a credit.
  if (acct.bcBankAccountCode) {
    lines.push({ ...base, lineNo: 10000, accountType: "Bank Account", accountNo: acct.bcBankAccountCode, amountCents: tx.amountCents, description, dimensions: [] });
  } else if (acct.bcGlAccount) {
    const a = chartAccount(acct.bcGlAccount);
    lines.push({ ...base, lineNo: 10000, accountType: "G/L Account", accountNo: acct.bcGlAccount, amountCents: tx.amountCents, description, dimensions: toBcDimensionSetLines(a.dims) });
  } else {
    throw new Error(`Account ${acct.displayName} has no BC bank card or G/L account`);
  }

  const moneyOut = tx.amountCents < 0;
  let n = 20000;
  if (tx.businessFlag === "ctj") {
    const glNo = moneyOut ? DUE_FROM_CTJ : CTJ_PAID_PERSONAL;
    const dims = mergeDimensions(chartAccount(glNo).dims, tx.dimensionSet);
    lines.push({ ...base, lineNo: n, accountType: "G/L Account", accountNo: glNo, amountCents: -tx.amountCents, description: `${moneyOut ? "CTJ business" : "Paid by CTJ"}: ${description}`.slice(0, 100), dimensions: toBcDimensionSetLines(dims), comment: "BUSINESS CTJ" });
    return lines;
  }
  for (const s of splits) {
    let glNo = s.glAccount;
    let dims = mergeDimensions(cats.get(s.categoryId)?.dimension_defaults, s.dimensionSet, tx.dimensionSet);
    if (tx.businessFlag === "lash") {
      const cat = cats.get(s.categoryId);
      if (moneyOut) {
        if (cat?.group !== "Lash business") glNo = LASH_OTHER;
      } else if (cat?.gl_account !== LASH_INCOME) {
        glNo = LASH_INCOME;
      }
      dims = mergeDimensions(chartAccount(glNo).dims, { FAMILY_AREA: "VANESSA", TAX_TREATMENT: moneyOut ? "DED-BUS" : "TAXABLE" });
    }
    const line: LedgerJournalLine = {
      ...base,
      lineNo: n,
      accountType: "G/L Account",
      accountNo: glNo,
      amountCents: -s.amountCents,
      description: (s.description || description).slice(0, 100),
      dimensions: toBcDimensionSetLines(dims),
    };
    if (tx.businessFlag === "lash") line.comment = "BUSINESS LASH";
    lines.push(line);
    n += 10000;
  }
  const check = lines.reduce((s, l) => s + l.amountCents, 0);
  if (check !== 0) throw new Error(`Document does not balance (${check})`);
  return lines;
}

/** Net of the clearing accounts across a set of documents (A2: 115101 and 115201 net to zero for a pair). */
export function netByAccount(lines: readonly LedgerJournalLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lines) {
    const key = l.accountType === "Bank Account" ? `BANK:${l.accountNo}` : l.accountNo;
    out.set(key, (out.get(key) ?? 0) + l.amountCents);
  }
  return out;
}
