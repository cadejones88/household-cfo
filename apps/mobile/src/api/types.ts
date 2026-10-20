/**
 * The API surface the phone uses, reconciled against services/api/openapi.yaml (Oct 20, 2026). DTOs come from
 * @homestead/shared; the view types below exist only in the app (the API has no /me, no safe-to-spend route and
 * no member-facing alerts/export yet; see README "OpenAPI reconciliation").
 */
import type {
  AccountSummary,
  Alert,
  Approval,
  ApprovalDecision,
  AskAnswer,
  Bill,
  BudgetStatus,
  BusinessFlag,
  DataThrough,
  Goal,
  MemberSummary,
  PaycheckSummary,
  Question,
  ReceiptSummary,
  Transaction,
  TransactionSplit,
} from "@homestead/shared";

export interface HouseholdSummary {
  id: string;
  name: string;
  timezone: string;
  /** Quiet hours in local 24h "HH:MM"; default 21:00–07:00 Mountain. */
  quietHours: { start: string; end: string };
  nextPaydayIso?: string;
}

/** Who is signed in. The API has no /me route yet; the HTTP client derives this from the sign-in and the seed. */
export interface Me {
  member: MemberSummary;
  household: HouseholdSummary;
  members: readonly MemberSummary[];
}

/** Safe to spend as the app shows it: the shared calculation plus its data-through stamp. */
export interface SafeToSpendView {
  safeCents: number;
  cashCents: number;
  setAsideCents: number;
  billsBeforePaydayCents: number;
  billsBeforePayday: readonly { name?: string; dueDateIso: string; amountCents: number }[];
  givingDueCents: number;
  liquidityFloorCents: number;
  nextPaydayIso: string;
  daysUntilPayday: number;
  perDayCents: number;
  balanceAsOf: string;
  status: "on_track" | "watch" | "short";
  /** One plain sentence about the month, rendered from the budget's forecast column. */
  forecast?: string;
  /** When the result is short: the one small move that fixes it, phrased for a person. */
  suggestion?: string;
  dataThrough: DataThrough;
}

export interface AccountsResponse {
  accounts: readonly AccountSummary[];
  dataThrough: DataThrough;
}

export interface TransactionsQuery {
  q?: string;
  from?: string;
  to?: string;
  categoryId?: string;
  accountId?: string;
  status?: Transaction["status"];
  kind?: Transaction["kind"];
  limit?: number;
  cursor?: string;
}

export interface TransactionsPage {
  transactions: readonly Transaction[];
  next?: string;
  dataThrough: DataThrough;
}

export interface QuestionsResponse {
  questions: readonly Question[];
  dataThrough: DataThrough;
}

export interface AnswerInput {
  optionId: string;
  categoryId?: string;
  splits?: readonly SplitInput[];
  note?: string;
}

export interface AnswerResponse {
  transaction?: Transaction;
  approval?: Approval;
  nextQuestion?: Question;
}

export interface SplitInput {
  amountCents: number;
  categoryId: string;
  description?: string;
}

export interface CorrectionInput {
  categoryId: string;
  splits?: readonly SplitInput[];
  reason?: string;
}

export interface CorrectionResponse {
  transaction: Transaction;
  /** Present when the item was already posted: a correction request for Cade. */
  correctionRequestId?: string;
}

export interface ReceiptLineView {
  lineNo: number;
  description: string;
  qty?: number;
  amountCents: number;
  suggestedCategoryId?: string;
  suggestedConfidence?: number;
}

/** openapi: ReceiptDetail. */
export interface ReceiptDetail extends ReceiptSummary {
  lines?: readonly ReceiptLineView[];
  split?: { lines: readonly TransactionSplit[]; needsConfirmation: boolean };
  transaction?: Transaction;
}

export interface UploadReceiptInput {
  /** file:// URI of the compressed JPEG on the phone. */
  fileUri: string;
  sha256: string;
  capturedAt: string;
  /** The device queue id (openapi: offlineId). */
  offlineId: string;
  bytes: number;
}

export interface UploadReceiptResult {
  receipt: ReceiptSummary;
  /** 200 "same photo already held" rather than 201 "stored". */
  alreadyHeld: boolean;
}

export interface BudgetMoveInput {
  fromCategoryId: string;
  toCategoryId: string;
  amountCents: number;
  month?: string;
  note?: string;
}

export interface BillsResponse {
  bills: readonly Bill[];
  nextPayday: string;
  dataThrough: DataThrough;
}

export interface GoalsResponse {
  goals: readonly Goal[];
  dataThrough: DataThrough;
}

export interface AskHistoryItem {
  id: string;
  question: string;
  answer: string;
  dataThrough: string;
  createdAt: string;
}

export interface RuleProposalInput {
  merchantNorm: string;
  categoryId: string;
  name: string;
}

export interface PushTokenRegistration {
  token: string;
  platform: "ios" | "android";
  deviceName?: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? `${code} (${status})`);
    this.name = "ApiError";
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
  me(): Promise<Me>;
  accounts(): Promise<AccountsResponse>;
  /** Composed client-side with the shared calculation until the API exposes get_safe_to_spend. */
  safeToSpend(): Promise<SafeToSpendView>;
  questions(): Promise<QuestionsResponse>;
  /** `stepUp` for approve_budget_move / approve_rule questions. */
  answerQuestion(id: string, input: AnswerInput, opts?: { stepUp?: boolean }): Promise<AnswerResponse>;
  transactions(query?: TransactionsQuery): Promise<TransactionsPage>;
  transaction(id: string): Promise<Transaction>;
  correctTransaction(id: string, input: CorrectionInput): Promise<CorrectionResponse>;
  /** "Do this every time for <merchant>?" opens a rule proposal for the other spouse (POST /v1/rules). */
  proposeRule(input: RuleProposalInput): Promise<{ id: string }>;
  setBusinessFlag(id: string, flag: BusinessFlag): Promise<Transaction>;
  uploadReceipt(input: UploadReceiptInput): Promise<UploadReceiptResult>;
  receipt(id: string): Promise<ReceiptDetail>;
  paychecks(): Promise<readonly PaycheckSummary[]>;
  paycheck(id: string): Promise<PaycheckSummary>;
  budget(month?: string): Promise<BudgetStatus>;
  proposeBudgetMove(input: BudgetMoveInput): Promise<Approval>;
  approvals(state?: "open" | "decided" | "all"): Promise<readonly Approval[]>;
  /** Needs step-up: the HTTP client sends the proof the auth layer provides. */
  decideApproval(id: string, decision: ApprovalDecision, note?: string): Promise<Approval>;
  goals(): Promise<GoalsResponse>;
  bills(): Promise<BillsResponse>;
  ask(question: string): Promise<AskAnswer>;
  askHistory(): Promise<readonly AskHistoryItem[]>;
  alerts(): Promise<readonly Alert[]>;
  registerPushToken(input: PushTokenRegistration): Promise<void>;
  /** Needs step-up. Not in the API yet: the client reports `available: false` on 404. */
  requestExport(): Promise<{ requested: boolean; available: boolean }>;
}
