/**
 * API contract types shared by the phone app, the Console and the API. Money is integer cents; dates are
 * YYYY-MM-DD strings; timestamps are ISO 8601 strings. Every read that shows a number carries `dataThrough`.
 */
import type { DimensionSet } from "./dimensions.js";
import type { SourceKind } from "./idempotency.js";
import type { Cents } from "./money.js";
import type { PlainStatus, TransactionState } from "./states.js";
import type { ConfidenceTier } from "./confidence.js";
import type { PaycheckComponentKind } from "./paycheck.js";

export type Id = string; // uuid

export type BusinessFlag = "none" | "ctj" | "lash";
export type TransactionKind = "spend" | "income" | "transfer" | "loan_payment" | "paycheck" | "bc_native";
export type DataQuality = "posted_reconciled" | "posted_unreconciled" | "imported_pending" | "estimated" | "stale" | "missing";

export interface DataThrough {
  /** The timestamp the numbers run through. */
  at: string;
  quality: DataQuality;
  /** Transactions still waiting for a person or for BC. */
  pendingCount: number;
}

export interface MemberSummary {
  id: Id;
  displayName: string;
  role: "member" | "adviser";
}

export interface AccountSummary {
  id: Id;
  displayName: string;
  institution: string;
  kind: "checking" | "savings" | "card" | "loan" | "mortgage" | "wallet" | "cash" | "share" | "line";
  mask: string;
  bcBankAccountCode?: string;
  bcGlAccount?: string;
  balanceCents?: Cents;
  balanceAsOf?: string;
  feedStatus: "ok" | "stale" | "needs_relink" | "file_only" | "none";
  /** The bank login that feeds this account, when one does. */
  feedConnectionId?: Id;
  /** Excluded from safe-to-spend (openapi: isRestricted). */
  isRestricted?: boolean;
}

export interface TransactionSplit {
  lineNo: number;
  amountCents: Cents;
  categoryId: string;
  glAccount: string;
  dims: DimensionSet;
  receiptLineId?: Id;
}

export interface Transaction {
  id: Id;
  accountId: Id;
  source: SourceKind;
  sourceRef: string;
  idempotencyKey: string;
  postedDate: string;
  amountCents: Cents;
  merchantRaw: string;
  merchantNorm: string;
  pending: boolean;
  state: TransactionState;
  status: PlainStatus;
  /** The plain words for `status` (openapi: statusWord). */
  statusWord?: string;
  kind: TransactionKind;
  categoryId?: string;
  dims: DimensionSet;
  businessFlag: BusinessFlag;
  confidence?: number;
  tier?: ConfidenceTier;
  ruleId?: Id;
  splits: TransactionSplit[];
  receiptId?: Id;
  receiptStatus: "none" | "needed" | "matched" | "estimated";
  /** The other side of a transfer or card payment (openapi). */
  pairId?: Id;
  duplicateOfId?: Id;
  exceptionReason?: string;
  bc?: {
    externalDocumentNo: string;
    journalId?: string;
    lineIds?: string[];
    documentNo?: string;
    entryNos?: number[];
    postingDate?: string;
    batch?: "FEEDS" | "RECEIPTS" | "AUTOPOST";
    lastSyncAt?: string;
    syncStatus?: "pending" | "in_sync" | "difference" | "error";
    /** When BC and the app disagree, BC wins and this says how. */
    difference?: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** One item in "Needs your answer". The question is phrased for the person who sees it. */
export type QuestionKind =
  | "confirm_category" // medium confidence: one tap
  | "pick_category" // low confidence
  | "confirm_split" // Walmart/club receipt $25+
  | "possible_duplicate"
  | "needs_receipt"
  | "approve_budget_move"
  | "approve_rule"
  | "paycheck_component";

export interface Question {
  id: Id;
  kind: QuestionKind;
  transactionId?: Id;
  approvalId?: Id;
  /** Plain words, including why it is asked and what the answer changes. */
  prompt: string;
  why: string;
  options: readonly { id: string; label: string; categoryId?: string }[];
  defaultOptionId?: string;
  amountCents?: Cents;
  merchant?: string;
  date?: string;
  /** For confirm_split: the proposed split (openapi: splits). */
  splits?: readonly TransactionSplit[];
  createdAt: string;
}

export interface ReceiptSummary {
  id: Id;
  capturedAt: string;
  uploadedAt?: string;
  sha256: string;
  ocrStatus: "queued" | "read" | "failed" | "needs_review";
  kind?: "receipt" | "pay_stub" | "statement";
  /** The device queue id echoed back (openapi: offlineId). */
  offlineId?: string;
  merchant?: string;
  totalCents?: Cents;
  taxCents?: Cents;
  receiptDate?: string;
  matchedTransactionId?: Id;
  matchConfidence?: number;
  syncState: "not_synced" | "uploading" | "synced";
}

export interface PaycheckSummary {
  id: Id;
  employer: "HFH" | "CTJ";
  payDate: string;
  netCents: Cents;
  source: "stub_pdf" | "stub_image" | "template";
  estimated: boolean;
  components: readonly { kind: PaycheckComponentKind; label: string; amountCents: Cents; glAccount: string }[];
  transactionId?: Id;
}

export interface BudgetLine {
  categoryId: string;
  name: string;
  budgetCents: Cents;
  spentCents: Cents;
  leftCents: Cents;
  pace: "on_track" | "watch" | "over";
  forecastCents: Cents;
  /** openapi: group, isAllowance. Allowances never alert (I-10). `isCommitted` is the app's hint for "fixed" lines. */
  group?: string;
  isAllowance?: boolean;
  isCommitted?: boolean;
}

export interface BudgetStatus {
  month: string; // YYYY-MM
  /** "sample" until the household budget is approved and loaded in BC. */
  budgetName: string;
  isSample: boolean;
  revisionNo?: number;
  lines: readonly BudgetLine[];
  totals?: { budgetCents: Cents; spentCents: Cents; leftCents: Cents };
  dataThrough: DataThrough;
}

export interface Goal {
  id: string;
  name: string;
  fundGoal: string;
  currentCents: Cents;
  targetCents: Cents;
  nextMilestone?: string;
  /** Target not approved yet (openapi: isSample). */
  isSample?: boolean;
  dataThrough: DataThrough;
}

export interface Bill {
  id: Id;
  name: string;
  dueDate: string;
  amountCents: Cents;
  accountId?: Id;
  categoryId?: string;
  isMinimum: boolean;
  isBcNative?: boolean;
  autopay?: boolean;
  beforePayday: boolean;
  paid: boolean;
}

export interface Alert {
  id: Id;
  kind: string;
  level: "action" | "watch" | "pulse";
  fingerprint: string;
  title: string;
  body: string;
  memberId?: Id;
  createdAt: string;
  deliveredAt?: string;
  snoozedUntil?: string;
  resolvedAt?: string;
}

export interface AuditEntry {
  id: Id;
  actor: string;
  action: string;
  entity: string;
  entityId: Id;
  at: string;
  before?: unknown;
  after?: unknown;
}

export interface AskAnswer {
  answer: string;
  dataThrough: DataThrough;
  /** The function rows the sentence was rendered from; the app shows numbers from here, never from the text. */
  used: readonly { fn: string; rows: unknown }[];
  /** A drafted budget move or other action that opens the normal approval screen. Never executed by Ask. */
  draftAction?: { kind: "budget_move"; fromCategoryId: string; toCategoryId: string; amountCents: Cents };
  conversationId?: Id;
}

// ---------------------------------------------------------------------------------------------------
// Console DTOs (E7). Added by the Console build; the API's /v1/console routes return these shapes.
// Add fields, never change existing ones.
// ---------------------------------------------------------------------------------------------------

/** A page of anything the Console lists. Every list carries its data-through line. */
export interface ConsolePage<T> {
  items: readonly T[];
  total: number;
  page: number;
  pageSize: number;
  dataThrough: DataThrough;
}

/** The household the signed-in member belongs to, as the Console header shows it. */
export interface ConsoleMe {
  member: MemberSummary;
  household: { id: Id; name: string; timezone: string; settingsVersion: number };
  /** The BC connection, without any credential: used for deep links into BC. */
  ledger: { tenantId: string; environment: string; companyId: string; journalTemplate: string; autoPostEnabled: boolean };
}

/** Queue filter for Console function 1. */
export type ConsoleTransactionQueue = "possible_duplicate" | "needs_receipt" | "needs_classification" | "ready_for_review" | "exception";

/** A transaction in the Console queue, with the account's display name and the household category name. */
export interface ConsoleTransactionRow extends Transaction {
  accountName: string;
  accountMask: string;
  categoryName?: string;
  /** For exceptions: why, and the keys on both sides. */
  exception?: ExceptionDetail;
  /** For possible duplicates: the transaction it may repeat. */
  duplicateOfId?: Id;
}

export interface ExceptionDetail {
  reason: string;
  /** What the app holds: idempotency key, External Document No., line IDs if any. */
  appSide: { idempotencyKey: string; externalDocumentNo?: string; lineIds?: readonly string[]; state: TransactionState; amountCents: Cents };
  /** What BC reported, if anything: document, entry numbers, posting date, count and sum on BC's side. */
  bcSide?: { documentNo?: string; entryNos?: readonly number[]; postingDate?: string; lineCount?: number; sumCents?: Cents; note?: string };
  raisedAt: string;
  raisedBy: string;
}

export type ExceptionResolution =
  | { to: "ready_for_review"; note: string }
  | { to: "posted"; note: string; bcEntryNos: readonly number[]; bcDocumentNo?: string; bcPostingDate?: string };

export interface ConsoleReceiptRow extends ReceiptSummary {
  memberName: string;
  /** Candidate bank lines the matcher found but could not decide between. */
  candidates?: readonly { transactionId: Id; postedDate: string; amountCents: Cents; merchant: string; confidence: number }[];
}

export interface RuleSummary {
  id: Id;
  ruleNo?: string;
  kind: "merchant" | "transfer" | "card_payment" | "recurring_bill" | "paycheck" | "loan_payment" | "bc_native" | "small_merchant";
  name: string;
  match: Record<string, unknown>;
  action: Record<string, unknown>;
  mayAutoPost: boolean;
  state: "proposed" | "approved" | "retired";
  proposedBy: string;
  proposedByName?: string;
  approvedBy?: Id;
  approvedAt?: string;
  effectiveFrom?: string;
  version: number;
  testPassedAt?: string;
  /** Approved classifications this rule has explained, and how many were later corrected. */
  stats?: { fired: number; corrected: number };
}

export type BcBatch = "FEEDS" | "RECEIPTS" | "AUTOPOST";

export interface BatchStatus {
  batch: BcBatch;
  journalId?: string;
  /** Lines the app believes are drafts in this batch (state bc_draft_created). */
  appDraftCount: number;
  appDraftSumCents: Cents;
  /** Lines BC reported in the batch at the last poll. */
  bcDraftCount?: number;
  bcDraftSumCents?: Cents;
  /** Approved but not yet written (sent_to_bc) and waiting in the outbox. */
  inFlightCount: number;
  /** Transactions whose draft was found changed or missing in BC. */
  differenceCount: number;
  lastPostRequestedAt?: string;
  lastPostedAt?: string;
}

export interface SyncStatus {
  batches: readonly BatchStatus[];
  lastWebhookAt?: string;
  lastPollAt?: string;
  lastPollStatus?: "ok" | "failed" | "running";
  outbox: { depth: number; deadLetters: number; oldestPendingAt?: string };
  subscriptions: readonly BcSubscriptionSummary[];
  autoPostEnabled: boolean;
  dataThrough: DataThrough;
}

export interface PostBatchResult {
  batch: BcBatch;
  /** The outbox row created. The API only enqueues: posting runs with Cade's BC sign-in or the AUTOPOST job. */
  outboxId: Id;
  queuedAt: string;
  lineCount: number;
  /** openapi.yaml: true when enqueued for the AUTOPOST job; false when the request was recorded for Cade to post in BC. */
  enqueued?: boolean;
  message?: string;
}

export interface BankCardReconStatus {
  code: string;
  name: string;
  glAccount: string;
  institution: string;
  mask: string;
  openCount: number;
  reconciledCount: number;
  openSumCents: Cents;
  lastStatementNo?: string;
  lastStatementDate?: string;
  reconciledThrough?: string;
  /** Lines the app shows as posted that BC's bank ledger says are still open after the statement date, or vice versa. */
  differences: readonly { transactionId?: Id; bankLedgerEntryNo?: number; postedDate: string; amountCents: Cents; note: string }[];
  feedStatus: AccountSummary["feedStatus"];
}

export interface LoanRollforward {
  id: string;
  name: string;
  lender: string;
  mask: string;
  glAccount: string;
  openingCents: Cents;
  principalCents: Cents;
  interestCents: Cents;
  feesCents: Cents;
  escrowCents?: Cents;
  closingCents: Cents;
  /** The BC-native recurring-journal entry matched this month, if any. */
  matchedEntryNo?: number;
  matchedAt?: string;
  period: string; // YYYY-MM
  nextDueDate?: string;
}

export interface ReconciliationStatus {
  bankCards: readonly BankCardReconStatus[];
  loans: readonly LoanRollforward[];
  dataThrough: DataThrough;
  /** Parts the source could not supply, so the screen shows "not available" instead of a zero. */
  missing?: readonly ("openSum" | "statements" | "differenceLines" | "loans")[];
}

export interface CategoryMapping {
  id: string;
  name: string;
  group: string;
  glAccount: string;
  glAccountName?: string;
  dims: DimensionSet;
  spendClass?: string;
  isAllowance: boolean;
  isTransfer: boolean;
  householdVisible: boolean;
  version: number;
  retiredAt?: string;
}

export interface DimensionDictionaryEntry {
  code: string;
  name: string;
  slot: "global1" | "global2" | "shortcut3" | "shortcut4" | "shortcut5";
  values: readonly { code: string; name: string; blocked?: boolean }[];
}

export interface BankCardMapping {
  code: string;
  glAccount: string;
  name: string;
  kind: string;
  institution: string;
  mask: string;
  accountId?: Id;
  feedProvider?: "plaid" | "file" | "simplefin";
}

export interface EmployerMapping {
  id: Id;
  code: "HFH" | "CTJ";
  name: string;
  memberName: string;
  descriptorPattern: string;
  grossAccount: string;
  bonusAccount: string;
  /** Component kind → G/L account from the employer template. */
  components: readonly { kind: PaycheckComponentKind; label: string; glAccount: string; dims: DimensionSet }[];
  lastStubAt?: string;
}

export interface MappingSet {
  catalogVersion: number;
  categories: readonly CategoryMapping[];
  dimensions: readonly DimensionDictionaryEntry[];
  bankCards: readonly BankCardMapping[];
  employers: readonly EmployerMapping[];
  /** Mapping proposals waiting for the other spouse. */
  pendingProposals: readonly { approvalId: Id; categoryId: string; requestedBy: string; requestedAt: string }[];
  dataThrough: DataThrough;
}

export interface MappingProposal {
  categoryId: string;
  glAccount: string;
  dims: DimensionSet;
  reason: string;
}

export interface AuthorityRow {
  action: string;
  who: string;
  stepUp: string;
  notes: string;
  /** Settings keys this row reads from (for example I-09). */
  settingKeys?: readonly string[];
  /** True while a threshold in this row is still TBD. */
  tbd?: boolean;
}

export interface AuthorityMatrix {
  version: number;
  approvedAt?: string;
  approvedBy?: readonly string[];
  rows: readonly AuthorityRow[];
  settings: {
    version: number;
    effectiveFrom: string;
    values: Record<string, unknown>;
    history: readonly { version: number; effectiveFrom: string; approvedBy: readonly string[] }[];
  };
  autoPostRules: readonly { ruleNo: string; name: string; state: RuleSummary["state"]; mayAutoPost: boolean; testPassedAt?: string }[];
  /** When the settings version and rule states were read (the matrix itself is static until re-approved). */
  dataThrough?: DataThrough;
}

export interface FeedConnectionSummary {
  id: Id;
  provider: "plaid" | "file" | "simplefin";
  institutionName: string;
  /** The member who connected the login; only they can reconnect, change or remove it. */
  ownerMemberId?: Id;
  ownerName: string;
  status: "ok" | "stale" | "needs_relink" | "disabled";
  needsRelink: boolean;
  lastSyncedAt?: string;
  accountCount: number;
  cursorPresent: boolean;
}

export interface BcSubscriptionSummary {
  resource: string;
  subscriptionId: string;
  expiresAt: string;
  lastRenewedAt?: string;
  /** Expires inside 24 hours or already expired. */
  needsRenewal: boolean;
}

export interface SyncRunSummary {
  id: Id;
  kind:
    | "plaid"
    | "bc_poll"
    | "bc_webhook"
    | "webhook_renewal"
    | "autopost"
    | "ocr"
    | "file_import"
    | "alerts"
    // Added with migration 0003 (the jobs that record runs beyond the original eight).
    | "matching"
    | "outbox_relay"
    | "bc_worker"
    | "bc_readback"
    | "paycheck_fallback"
    | "receipt_fallback"
    | "rule_proposals";
  startedAt: string;
  finishedAt?: string;
  status: "running" | "ok" | "failed";
  counts: Record<string, number>;
  /** Scrubbed already: no amounts, masks, merchants, tokens. */
  error?: string;
}

export interface OutboxItem {
  id: Id;
  /** `household` carries household-level operations such as `post_batch` (services/api/src/db/index.ts OutboxInput). */
  aggregate: "transaction" | "budget_revision" | "receipt" | "paycheck" | "household";
  aggregateId: Id;
  operation: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  deadLettered: boolean;
  publishedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface ConnectionHealth {
  feeds: readonly FeedConnectionSummary[];
  subscriptions: readonly BcSubscriptionSummary[];
  ledger: { lastPollAt?: string; lastWebhookAt?: string; apiReachable?: boolean; checkedAt?: string };
  dataThrough: DataThrough;
}

/** What the nightly acceptance job writes to the Console's health page (a static JSON file for now). */
export interface HealthReport {
  generatedAt: string;
  commit?: string;
  environment: string;
  acceptance: readonly { id: string; name: string; status: "pass" | "fail" | "skipped"; durationMs?: number; note?: string }[];
  resilience?: readonly { id: string; name: string; status: "pass" | "fail" | "skipped"; note?: string }[];
  nightlyPoll?: { ranAt: string; differences: number };
}

/* ---- Added for E6 (phone app), mirroring services/api/openapi.yaml. Add-only. ---- */

export type ApprovalKind = "budget_move" | "correction" | "rule" | "business_flag" | "auto_post_rule" | "settings";
export type ApprovalDecision = "approved" | "declined";

/** One request the other spouse decides (openapi: Approval). `payload` keys depend on `kind`. */
export interface Approval {
  id: Id;
  kind: ApprovalKind;
  payload: {
    fromCategoryId?: string;
    toCategoryId?: string;
    amountCents?: Cents;
    month?: string;
    note?: string;
    transactionId?: Id;
    categoryId?: string;
    merchant?: string;
    [key: string]: unknown;
  };
  requestedBy: Id;
  requestedByName?: string;
  decidedBy?: Id;
  decision?: ApprovalDecision;
  stepUpVerified: boolean;
  requestedAt: string;
  decidedAt?: string;
  /** Plain words for what approving does. */
  effect?: string;
}
