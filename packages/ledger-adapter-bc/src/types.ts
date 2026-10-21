/**
 * The ledger adapter contract. Business Central is the first implementation (see bcAdapter.ts); nothing in this
 * file names a BC entity, so a second ledger would implement the same interface against its own API.
 *
 * Money is integer cents at this boundary; the BC implementation converts to two-decimal numbers on the wire.
 * Dates are YYYY-MM-DD strings. Timestamps are ISO 8601.
 */
import type { BankCardCode, BcDimensionSetLine, Cents, DimensionSet } from "@homestead/shared";

export interface LedgerAccount {
  id: string;
  number: string;
  displayName: string;
  /** "Posting" accounts are the only ones the app may write to. */
  category: string;
  subCategory: string;
  accountType: string;
  blocked: boolean;
  directPosting: boolean;
  lastModifiedDateTime?: string;
}

export interface LedgerDimensionValue {
  id: string;
  code: string;
  displayName: string;
}

export interface LedgerDimension {
  id: string;
  code: string;
  displayName: string;
  values: LedgerDimensionValue[];
}

export interface LedgerBankAccount {
  id: string;
  number: string;
  displayName: string;
  /** The G/L account the bank card posts to (BC: the bank account posting group's G/L account). */
  glAccount?: string;
  blocked: boolean;
  balance?: number;
  lastModifiedDateTime?: string;
}

/** One line the adapter writes. All lines of one transaction share the externalDocumentNumber. */
export interface JournalLineInput {
  accountType: "G/L Account" | "Bank Account";
  accountNumber: string;
  postingDate: string;
  /** Debit positive, credit negative. */
  amountCents: Cents;
  /** Truncated to 100 characters by the adapter (BC: Description is Text[100]). */
  description: string;
  /** 27 characters from `externalDocumentNo()` in @homestead/shared. */
  externalDocumentNumber: string;
  /** BC: Comment is Text[250]. */
  comment?: string;
  /** The full dimension set; the adapter sends it as dimensionSetLines because only the two globals travel on the line. */
  dimensionSetLines: BcDimensionSetLine[];
}

export interface CreateJournalLinesRequest {
  /** The journal batch code inside the household template, e.g. FEEDS, RECEIPTS, AUTOPOST. */
  journalCode: string;
  lines: readonly JournalLineInput[];
}

export interface WrittenJournalLine {
  id: string;
  lineNumber: number;
  documentNumber: string;
  externalDocumentNumber: string;
  accountNumber: string;
  amountCents: Cents;
  postingDate: string;
  /** The batch the line sits in (the target batch, or another one when the connector finds it elsewhere). */
  journalCode?: string;
}

export type CreateJournalLinesResult =
  /** The lines were written by this call. */
  | { outcome: "written"; journalId: string; lines: WrittenJournalLine[] }
  /** The pre-write check found the document already in the target batch; nothing was written. */
  | { outcome: "already_in_journal"; journalId: string; lines: WrittenJournalLine[] }
  /** The pre-write check found the document already posted; nothing was written. */
  | { outcome: "already_posted"; entries: LedgerEntryRef[] };

export interface LedgerEntryRef {
  entryNumber: number;
  documentNumber: string;
  postingDate: string;
  accountNumber: string;
  amountCents: Cents;
}

export interface ExternalDocLookup {
  externalDocumentNo: string;
  /** Draft lines found: in the target batch when one was named, else in any batch of the household template. */
  journalLines: WrittenJournalLine[];
  /** Posted G/L entries found. */
  ledgerEntries: LedgerEntryRef[];
  /** "connector" when answered by hhJournalLineCheck, "odata" when answered by the two standard filters. */
  answeredBy: "connector" | "odata";
  /** True when the ledger side could not be checked (no connector and no document number known). */
  ledgerCheckIncomplete: boolean;
}

export interface LedgerEntry extends LedgerEntryRef {
  id: string;
  description: string;
  debitCents: Cents;
  creditCents: Cents;
  dimensions: DimensionSet;
  dimensionSetLines: BcDimensionSetLine[];
  externalDocumentNumber?: string;
}

/** A document the app owns, as the ledger holds it: a draft line or a posted entry (for the nightly completeness poll). */
export interface AppDocumentRow {
  externalDocumentNumber: string;
  source: "journal" | "ledger";
  /** The batch the draft sits in, or the batch a posted entry came from. */
  journalCode?: string;
  lineId?: string;
  lineNumber?: number;
  entryNumber?: number;
  documentNumber: string;
  postingDate: string;
  accountType: string;
  accountNumber: string;
  amountCents: Cents;
  sourceCode?: string;
  reasonCode?: string;
}

export interface AppDocumentFilter {
  externalDocumentNo?: string;
  /** e.g. "HHAPP-" for everything the app might own, or "HHAPP-PAY-" for one source. */
  externalDocumentNoStartsWith?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  source?: "journal" | "ledger";
  journalCode?: string;
}

export interface BankLedgerEntry {
  entryNumber: number;
  bankAccountNumber: string;
  postingDate: string;
  amountCents: Cents;
  documentNumber: string;
  externalDocumentNumber: string;
  open: boolean;
  statementNumber: string;
  statementLineNumber: number;
  closedAtDate?: string;
  reversed: boolean;
}

export interface BankLedgerEntryFilter {
  bankAccountNumber?: string;
  externalDocumentNumber?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  open?: boolean;
  top?: number;
}

export interface BudgetEntryInput {
  glAccount: string;
  date: string;
  amountCents: Cents;
  /** The revision number, e.g. "REV 3", goes in Description per the spec. */
  description: string;
  dimensions: DimensionSet;
}

export interface WriteBudgetEntriesResult {
  budgetName: string;
  entryNumbers: number[];
}

export interface BudgetReadLine {
  entryNumber: number;
  budgetName: string;
  glAccount: string;
  date: string;
  amountCents: Cents;
  description: string;
  dimensions: DimensionSet;
}

export interface BudgetRead {
  budgetName: string;
  lines: BudgetReadLine[];
}

export interface BudgetReadOptions {
  dateFrom?: string;
  dateTo?: string;
  glAccount?: string;
}

export type WebhookResource = "generalLedgerEntries" | "journals";

/** BC's subscription entity (api/v2.0 subscriptions); its key is subscriptionId (resources/dynamics_subscriptions). */
export interface WebhookSubscription {
  subscriptionId: string;
  resource: string;
  notificationUrl: string;
  clientState?: string;
  expirationDateTime: string;
  lastModifiedDateTime?: string;
}

export interface CreateSubscriptionRequest {
  resource: WebhookResource;
  notificationUrl: string;
  /** The shared secret BC echoes in every notification. Read from Key Vault by name by the caller; never logged. */
  clientState: string;
}

export interface SubscriptionsApi {
  create(req: CreateSubscriptionRequest): Promise<WebhookSubscription>;
  renew(subscriptionId: string, clientState: string): Promise<WebhookSubscription>;
  delete(subscriptionId: string): Promise<void>;
  list(): Promise<WebhookSubscription[]>;
}

export interface LedgerAdapter {
  listAccounts(): Promise<LedgerAccount[]>;
  listDimensions(): Promise<LedgerDimension[]>;
  listBankAccounts(): Promise<LedgerBankAccount[]>;
  /**
   * Pre-write check: drafts plus posted entries for one External Document No. With `journalCode` the draft side is
   * the target batch; without it, every batch of the household template.
   */
  findByExternalDocumentNo(externalDocumentNo: string, journalCode?: string): Promise<ExternalDocLookup>;
  /** Writes all lines of one transaction atomically, after rerunning the pre-write check. */
  createJournalLines(req: CreateJournalLinesRequest): Promise<CreateJournalLinesResult>;
  /** Posts every line in the batch. */
  postBatch(journalCode: string): Promise<void>;
  readGlEntriesByExternalDocNo(externalDocumentNo: string): Promise<LedgerEntry[]>;
  /** Every draft line and posted entry the app owns in a range: the nightly poll's count-and-sum comparison. */
  listAppDocuments(filter: AppDocumentFilter): Promise<AppDocumentRow[]>;
  readBankLedgerEntries(filter: BankLedgerEntryFilter): Promise<BankLedgerEntry[]>;
  writeBudgetEntries(budgetName: string, entries: readonly BudgetEntryInput[]): Promise<WriteBudgetEntriesResult>;
  readBudget(budgetName: string, opts?: BudgetReadOptions): Promise<BudgetRead>;
  subscriptions: SubscriptionsApi;
  webhookSupportedResources(): Promise<string[]>;
}

/** Re-exported so callers of the mapping can name a household bank card without importing shared twice. */
export type { BankCardCode };
