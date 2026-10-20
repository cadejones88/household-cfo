/**
 * Maps an app-side transaction to the set of BC journal lines that make one balanced document.
 * Pure: no I/O, no dates from the clock. The adapter sends the result unchanged.
 *
 * Sign conventions
 *   App amounts are from the account's point of view: + money in, − money out (a card charge is −, a card payment
 *   received on the card is +). Splits carry the same sign and sum to the transaction amount.
 *   BC journal amounts are debit +, credit −. So a split of −3000 on Groceries becomes a +3000 line on 603101 and
 *   the bank line carries the transaction amount as is; the lines sum to zero.
 *
 * Cases from the spec (A2, A4, R2, R3)
 *   transfer between own accounts   bank line + clearing 115101 (nets to zero once the other side posts)
 *   card payment                    bank line + clearing 115201
 *   CTJ-paid personal bill          natural debit(s) + Cr 404102 (no household bank line), or, for a feed line such
 *                                   as a Capital One payment marked "paid by CTJ": Dr card + Cr 404102
 *   household-card charge marked    Dr 112101 (Due from CTJ) + Cr card; the splits' categories are not posted
 *   business (CTJ)
 *   lash business (Schedule C)      the natural 731xxx / 402101 lines as given; they carry DED-BUS from the chart
 *   bc_native                       never mapped: BC's own recurring journals post those (R7)
 */
import {
  account,
  bankCard,
  mergeDimensions,
  mustPostThroughBankCard,
  toBcDimensionSetLines,
  type BankCardCode,
  type BusinessFlag,
  type Cents,
  type DimensionSet,
  type PaycheckLine,
  type TransactionKind,
} from "@homestead/shared";
import { COMMENT_MAX, assertExternalDocNo, truncateDescription } from "./bcAdapter.js";
import type { JournalLineInput } from "./types.js";

export const ACCOUNT_DUE_FROM_CTJ = "112101";
export const ACCOUNT_TRANSFER_CLEARING = "115101";
export const ACCOUNT_CARD_PAYMENT_CLEARING = "115201";
export const ACCOUNT_CTJ_PAID_PERSONAL = "404102";

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

export interface AppSplitForLedger {
  lineNo: number;
  /** Same sign as the transaction amount; splits sum to it. */
  amountCents: Cents;
  glAccount: string;
  dims?: DimensionSet;
  description?: string;
}

export interface AppTransactionForLedger {
  /** 27 characters from externalDocumentNo(). */
  externalDocumentNo: string;
  postingDate: string;
  description: string;
  /** + into the account, − out of it. */
  amountCents: Cents;
  /** The household account the line belongs to. Absent only for a bill paid outside the household (paidBy "ctj"). */
  bankCard?: BankCardCode;
  kind: TransactionKind;
  businessFlag: BusinessFlag;
  splits: readonly AppSplitForLedger[];
  /** The bill or payment was paid by the firm: the funding side is 404102, not a household account. */
  paidBy?: "ctj";
  /** Transfers: the other household account when the pairing engine knows it. */
  counterpartyBankCard?: BankCardCode;
  /** Transfers: force the clearing account ("own" 115101, "card" 115201) when the counterparty is unknown. */
  clearing?: "own" | "card";
  /** Extra dimensions for the bank line, e.g. FUND_GOAL EMERG-3-6M on a savings deposit. */
  bankLineDims?: DimensionSet;
  /** Goes in BC's Comment (Text[250]); the worker puts the idempotency key here. */
  comment?: string;
}

export interface MappedDocument {
  externalDocumentNo: string;
  lines: JournalLineInput[];
  /** 115101 or 115201 when the document is a transfer. */
  clearingAccount?: string;
}

/** Turns buildPaycheckLines() output (BC-signed) into app-signed splits so a paycheck maps like any deposit. */
export function paycheckLinesToSplits(lines: readonly PaycheckLine[]): AppSplitForLedger[] {
  return lines.map((l, i) => ({ lineNo: i + 1, amountCents: -l.amountCents, glAccount: l.glAccount, dims: l.dims, description: l.description }));
}

export function mapTransactionToJournalLines(tx: AppTransactionForLedger): MappedDocument {
  assertExternalDocNo(tx.externalDocumentNo);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.postingDate)) throw new MappingError(`postingDate must be YYYY-MM-DD, got ${tx.postingDate}`);
  if (!Number.isSafeInteger(tx.amountCents) || tx.amountCents === 0) throw new MappingError("Transaction amount must be a non-zero integer number of cents");
  if (tx.kind === "bc_native") throw new MappingError("BC-native transactions are posted by BC's recurring journals; the app never writes lines for them");
  if (tx.paidBy === "ctj" && tx.businessFlag === "ctj") throw new MappingError("A transaction cannot be both paid by CTJ and a household charge due from CTJ");

  const comment = tx.comment === undefined ? undefined : tx.comment.slice(0, COMMENT_MAX);
  const base = { postingDate: tx.postingDate, externalDocumentNumber: tx.externalDocumentNo };
  const glLine = (no: string, amountCents: Cents, dims: DimensionSet | undefined, description: string): JournalLineInput => {
    if (mustPostThroughBankCard(no)) throw new MappingError(`Account ${no} is a bank card's G/L account; post it through the bank account card`);
    const acct = account(no); // throws for a non-posting account
    const merged = mergeDimensions(acct.dims, dims);
    const line: JournalLineInput = {
      ...base,
      accountType: "G/L Account",
      accountNumber: no,
      amountCents,
      description: truncateDescription(description),
      dimensionSetLines: toBcDimensionSetLines(merged),
    };
    if (comment !== undefined) line.comment = comment;
    return line;
  };
  const bankLine = (code: BankCardCode, amountCents: Cents): JournalLineInput => {
    const card = bankCard(code);
    const merged = mergeDimensions(account(card.glAccount).dims, tx.bankLineDims);
    const line: JournalLineInput = {
      ...base,
      accountType: "Bank Account",
      accountNumber: card.code,
      amountCents,
      description: truncateDescription(tx.description),
      dimensionSetLines: toBcDimensionSetLines(merged),
    };
    if (comment !== undefined) line.comment = comment;
    return line;
  };

  // The side the money came from or went to.
  let funding: JournalLineInput;
  if (tx.bankCard) {
    funding = bankLine(tx.bankCard, tx.amountCents);
  } else if (tx.paidBy === "ctj") {
    funding = glLine(ACCOUNT_CTJ_PAID_PERSONAL, tx.amountCents, undefined, tx.description);
  } else {
    throw new MappingError("A transaction needs a household bank card, or paidBy 'ctj' for a bill the firm paid");
  }

  // The other side.
  let counter: JournalLineInput[];
  let clearingAccount: string | undefined;
  if (tx.kind === "transfer") {
    if (tx.splits.length > 0) throw new MappingError("A transfer has no category splits");
    if (!tx.bankCard) throw new MappingError("A transfer needs the household account it was seen on");
    if (tx.paidBy === "ctj") {
      counter = [glLine(ACCOUNT_CTJ_PAID_PERSONAL, -tx.amountCents, undefined, tx.description)];
    } else {
      clearingAccount = clearingAccountFor(tx);
      counter = [glLine(clearingAccount, -tx.amountCents, undefined, tx.description)];
    }
  } else if (tx.businessFlag === "ctj") {
    if (!tx.bankCard) throw new MappingError("A charge due from CTJ must be on a household account");
    counter = [glLine(ACCOUNT_DUE_FROM_CTJ, -tx.amountCents, undefined, tx.description)];
  } else {
    if (tx.splits.length === 0) throw new MappingError("A spend or income transaction needs at least one split");
    if (tx.bankCard && tx.paidBy === "ctj") throw new MappingError("A split transaction on a household account cannot also be paid by CTJ");
    let sum = 0;
    counter = tx.splits.map((s) => {
      if (!Number.isSafeInteger(s.amountCents) || s.amountCents === 0) throw new MappingError(`Split ${s.lineNo} must be a non-zero integer number of cents`);
      sum += s.amountCents;
      return glLine(s.glAccount, -s.amountCents, s.dims, s.description ?? tx.description);
    });
    if (sum !== tx.amountCents) throw new MappingError(`Splits sum to ${sum} but the transaction is ${tx.amountCents}`);
  }

  const lines = [...counter, funding];
  const total = lines.reduce((acc, l) => acc + l.amountCents, 0);
  if (total !== 0) throw new MappingError(`Mapped lines sum to ${total}, not zero`);
  const doc: MappedDocument = { externalDocumentNo: tx.externalDocumentNo, lines };
  if (clearingAccount) doc.clearingAccount = clearingAccount;
  return doc;
}

function clearingAccountFor(tx: AppTransactionForLedger): string {
  if (tx.clearing === "own") return ACCOUNT_TRANSFER_CLEARING;
  if (tx.clearing === "card") return ACCOUNT_CARD_PAYMENT_CLEARING;
  const isCardSide = (code: BankCardCode | undefined): boolean => {
    if (!code) return false;
    const k = bankCard(code).kind;
    return k === "card" || k === "line";
  };
  if (tx.counterpartyBankCard) return isCardSide(tx.counterpartyBankCard) || isCardSide(tx.bankCard) ? ACCOUNT_CARD_PAYMENT_CLEARING : ACCOUNT_TRANSFER_CLEARING;
  if (isCardSide(tx.bankCard)) return ACCOUNT_CARD_PAYMENT_CLEARING;
  throw new MappingError("A transfer seen on a deposit account needs counterpartyBankCard or clearing to pick 115101 vs 115201");
}
