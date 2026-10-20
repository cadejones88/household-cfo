/**
 * The API surface the phone uses. DTOs come from @homestead/shared; route names follow services/api/src/app.ts
 * (accounts, transactions, questions, receipts, paychecks, budget, goals, bills, ask, approvals, rules).
 * services/api/openapi.yaml did not exist when this was written: see README "OpenAPI reconciliation".
 */
import type {
  AccountSummary,
  Alert,
  Approval,
  ApprovalDecision,
  AskAnswer,
  BillsView,
  BudgetStatus,
  BusinessFlag,
  CorrectionResult,
  DataThrough,
  Goal,
  MeResponse,
  PaycheckSummary,
  PushTokenRegistration,
  Question,
  ReceiptSummary,
  SafeToSpendView,
  Transaction,
} from "@homestead/shared";

export interface TransactionsQuery {
  q?: string;
  limit?: number;
  /** Only items in "Needs a quick answer". */
  needsAnswer?: boolean;
  /** Only items with a matched receipt. */
  withReceipt?: boolean;
  /** Only items captured or paid by this member. */
  memberId?: string;
}

export interface TransactionsPage {
  items: readonly Transaction[];
  dataThrough: DataThrough;
}

export interface ReceiptLineView {
  lineNo: number;
  description: string;
  amountCents: number;
  categoryId?: string;
  categoryName?: string;
}

/** A receipt after the server read it: the match/split card's data. */
export interface ReceiptDetail extends ReceiptSummary {
  lines: readonly ReceiptLineView[];
  /** Split by category after tax proration (shared splitReceipt). */
  split: readonly { categoryId: string; categoryName: string; amountCents: number }[];
  suggestedCategoryId?: string;
  suggestedCategoryName?: string;
  /** A signed URL for the stored image, short-lived; the app prefers its own local copy when it has one. */
  imageUrl?: string;
}

export interface UploadReceiptInput {
  /** file:// URI of the compressed JPEG on the phone. */
  fileUri: string;
  sha256: string;
  capturedAt: string;
  clientId: string;
  bytes: number;
}

export interface AnswerInput {
  optionId: string;
  categoryId?: string;
}

export interface CorrectionInput {
  categoryId: string;
  /** "Do this every time for <merchant>?" becomes a rule proposal for the other spouse, never a rule. */
  proposeRule?: boolean;
}

export interface BudgetMoveInput {
  fromCategoryId: string;
  toCategoryId: string;
  amountCents: number;
  note?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? `${code} (${status})`);
    this.name = "ApiError";
  }
}

/** 409 from POST /v1/receipts: the household already holds this hash. */
export class DuplicateReceiptError extends ApiError {
  constructor(public readonly existingReceiptId?: string) {
    super(409, "duplicate_receipt", "You already snapped this one");
    this.name = "DuplicateReceiptError";
  }
}

/** 403 step_up_required: the action needs a fresh Face ID. */
export class StepUpRequiredError extends ApiError {
  constructor() {
    super(403, "step_up_required", "Confirm it's you first");
    this.name = "StepUpRequiredError";
  }
}

export interface HomesteadApi {
  me(): Promise<MeResponse>;
  accounts(): Promise<readonly AccountSummary[]>;
  safeToSpend(): Promise<SafeToSpendView>;
  questions(): Promise<readonly Question[]>;
  answerQuestion(id: string, input: AnswerInput): Promise<void>;
  transactions(query?: TransactionsQuery): Promise<TransactionsPage>;
  transaction(id: string): Promise<Transaction>;
  correctTransaction(id: string, input: CorrectionInput): Promise<CorrectionResult>;
  setBusinessFlag(id: string, flag: BusinessFlag): Promise<Transaction>;
  uploadReceipt(input: UploadReceiptInput): Promise<ReceiptSummary>;
  receipt(id: string): Promise<ReceiptDetail>;
  paycheck(id: string): Promise<PaycheckSummary>;
  budget(month?: string): Promise<BudgetStatus>;
  proposeBudgetMove(input: BudgetMoveInput): Promise<Approval>;
  approvals(): Promise<readonly Approval[]>;
  /** Needs step-up: the HTTP client sends the step-up proof the auth layer provides. */
  decideApproval(id: string, decision: ApprovalDecision): Promise<Approval>;
  goals(): Promise<readonly Goal[]>;
  bills(): Promise<BillsView>;
  ask(question: string): Promise<AskAnswer>;
  alerts(): Promise<readonly Alert[]>;
  registerPushToken(input: PushTokenRegistration): Promise<void>;
  /** Needs step-up. */
  requestExport(): Promise<{ requested: true }>;
}
