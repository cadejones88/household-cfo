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
  createdAt: string;
}

export interface ReceiptSummary {
  id: Id;
  capturedAt: string;
  uploadedAt?: string;
  sha256: string;
  ocrStatus: "queued" | "read" | "failed" | "needs_review";
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
}

export interface BudgetStatus {
  month: string; // YYYY-MM
  /** "sample" until the household budget is approved and loaded in BC. */
  budgetName: string;
  isSample: boolean;
  lines: readonly BudgetLine[];
  dataThrough: DataThrough;
}

export interface Goal {
  id: string;
  name: string;
  fundGoal: string;
  currentCents: Cents;
  targetCents: Cents;
  nextMilestone?: string;
  dataThrough: DataThrough;
}

export interface Bill {
  id: Id;
  name: string;
  dueDate: string;
  amountCents: Cents;
  accountId?: Id;
  isMinimum: boolean;
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
  createdAt: string;
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
}
