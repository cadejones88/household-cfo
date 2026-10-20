/**
 * The typed HTTP client, hand-written against services/api/openapi.yaml (Oct 20, 2026). Every call goes through
 * `request`, which adds the sign-in headers, the step-up proof when the call needs it, and turns the API's error
 * envelope `{ error, message }` into typed errors.
 *
 * Routes used (all under /v1; envelopes as the OpenAPI document gives them):
 *   GET  /accounts                       -> { accounts, dataThrough }
 *   GET  /transactions?q&status&kind&limit&cursor -> { transactions, next, dataThrough }
 *   GET  /transactions/:id               -> Transaction
 *   POST /transactions/:id/correct       { categoryId, splits?, reason? } -> { transaction, correctionRequestId? }
 *   POST /transactions/:id/business      { flag } -> Transaction
 *   GET  /questions                      -> { questions, dataThrough }
 *   POST /questions/:id/answer           { optionId, categoryId?, splits?, note? } -> { transaction?, approval?, nextQuestion? }
 *   POST /receipts (multipart: file, sha256, capturedAt, offlineId, kind) -> 201 ReceiptSummary | 200 same photo already held
 *   GET  /receipts/:id                   -> ReceiptDetail
 *   GET  /paychecks, /paychecks/:id
 *   GET  /budget?month                   -> BudgetStatus
 *   POST /budget/moves                   -> 201 Approval
 *   GET  /approvals?state                -> { approvals }
 *   POST /approvals/:id/decide           { decision, note? } (step-up) -> Approval
 *   POST /rules                          { kind: merchant, name, match, action } -> 201 Rule   ("do this every time")
 *   GET  /goals                          -> { goals, dataThrough }
 *   GET  /bills?until                    -> { bills, nextPayday, dataThrough }
 *   POST /ask, GET /ask/history
 *
 * Not in the OpenAPI document (handled with fallbacks, listed in README "OpenAPI reconciliation"):
 *   GET /me (derived from the sign-in), GET /budget/safe-to-spend (composed client-side), GET /alerts (tries
 *   /console/alerts, else empty), POST /devices/push-token (TODO; 404 ignored), POST /export (404 -> "not yet").
 */
import type { Alert, Approval, ApprovalDecision, AskAnswer, BudgetStatus, BusinessFlag, MemberSummary, PaycheckSummary, Transaction } from "@homestead/shared";
import { composeSafeToSpend } from "../model/safeToSpendVm";
import { todayIso } from "../model/format";
import {
  ApiError,
  StepUpRequiredError,
  type AccountsResponse,
  type AnswerInput,
  type AnswerResponse,
  type AskHistoryItem,
  type BillsResponse,
  type BudgetMoveInput,
  type CorrectionInput,
  type CorrectionResponse,
  type GoalsResponse,
  type HomesteadApi,
  type Me,
  type PushTokenRegistration,
  type QuestionsResponse,
  type ReceiptDetail,
  type RuleProposalInput,
  type SafeToSpendView,
  type TransactionsPage,
  type TransactionsQuery,
  type UploadReceiptInput,
  type UploadReceiptResult,
} from "./types";

export interface AuthHeaderSource {
  /** Headers that identify the member; with `stepUp`, the proof of a fresh local authentication too. */
  headers(opts?: { stepUp?: boolean }): Promise<Record<string, string>>;
  /** The signed-in member as the sign-in knows them (dev seed name, or the id token's claims). */
  currentMember(): MemberSummary;
  /** Called on 401 so the session can be refreshed or ended. */
  onUnauthorized?(): void;
}

export interface HttpApiOptions {
  baseUrl: string;
  auth: AuthHeaderSource;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class HttpApi implements HomesteadApi {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpApiOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async me(): Promise<Me> {
    // No /me route in the OpenAPI document. The member comes from the sign-in; the other spouse's name comes
    // from approvals (requestedByName) when one exists; the payday from /bills.
    const member = this.opts.auth.currentMember();
    const [approvals, bills] = await Promise.all([this.approvals("all").catch(() => [] as readonly Approval[]), this.bills().catch(() => undefined)]);
    const others = new Map<string, MemberSummary>();
    for (const a of approvals) {
      if (a.requestedBy !== member.id && a.requestedByName) others.set(a.requestedBy, { id: a.requestedBy, displayName: a.requestedByName, role: "member" });
    }
    return {
      member,
      household: { id: "household", name: "Our household", timezone: "America/Boise", quietHours: { start: "21:00", end: "07:00" }, ...(bills ? { nextPaydayIso: bills.nextPayday } : {}) },
      members: [member, ...others.values()],
    };
  }

  accounts(): Promise<AccountsResponse> {
    return this.request("GET", "/v1/accounts");
  }

  async safeToSpend(): Promise<SafeToSpendView> {
    const [accounts, goals, bills, budget] = await Promise.all([this.accounts(), this.goals(), this.bills(), this.budget().catch(() => undefined)]);
    return composeSafeToSpend({ accounts: accounts.accounts, goals: goals.goals, bills: bills.bills, nextPaydayIso: bills.nextPayday, todayIso: todayIso(), ...(budget ? { budget } : {}) });
  }

  questions(): Promise<QuestionsResponse> {
    return this.request("GET", "/v1/questions");
  }

  answerQuestion(id: string, input: AnswerInput, opts: { stepUp?: boolean } = {}): Promise<AnswerResponse> {
    return this.request("POST", `/v1/questions/${encodeURIComponent(id)}/answer`, input, opts);
  }

  transactions(query: TransactionsQuery = {}): Promise<TransactionsPage> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return this.request("GET", `/v1/transactions${s ? `?${s}` : ""}`);
  }

  transaction(id: string): Promise<Transaction> {
    return this.request("GET", `/v1/transactions/${encodeURIComponent(id)}`);
  }

  correctTransaction(id: string, input: CorrectionInput): Promise<CorrectionResponse> {
    return this.request("POST", `/v1/transactions/${encodeURIComponent(id)}/correct`, input);
  }

  proposeRule(input: RuleProposalInput): Promise<{ id: string }> {
    return this.request("POST", "/v1/rules", {
      kind: "merchant",
      name: input.name,
      match: { merchantNorm: input.merchantNorm, direction: "out" },
      action: { categoryId: input.categoryId },
      mayAutoPost: false,
    });
  }

  setBusinessFlag(id: string, flag: BusinessFlag): Promise<Transaction> {
    return this.request("POST", `/v1/transactions/${encodeURIComponent(id)}/business`, { flag });
  }

  async uploadReceipt(input: UploadReceiptInput): Promise<UploadReceiptResult> {
    const form = new FormData();
    form.append("sha256", input.sha256);
    form.append("capturedAt", input.capturedAt);
    form.append("offlineId", input.offlineId);
    form.append("kind", "receipt");
    // React Native's FormData takes { uri, name, type } for a file part.
    form.append("file", { uri: input.fileUri, name: `${input.offlineId}.jpg`, type: "image/jpeg" } as unknown as Blob);
    const headers = await this.opts.auth.headers();
    const res = await this.fetchWithTimeout(`${this.base}/v1/receipts`, { method: "POST", headers, body: form }, 60_000);
    const receipt = await this.handle<UploadReceiptResult["receipt"]>(res);
    return { receipt, alreadyHeld: res.status === 200 };
  }

  receipt(id: string): Promise<ReceiptDetail> {
    return this.request("GET", `/v1/receipts/${encodeURIComponent(id)}`);
  }

  async paychecks(): Promise<readonly PaycheckSummary[]> {
    const r = await this.request<{ paychecks: readonly PaycheckSummary[] }>("GET", "/v1/paychecks");
    return r.paychecks;
  }

  paycheck(id: string): Promise<PaycheckSummary> {
    return this.request("GET", `/v1/paychecks/${encodeURIComponent(id)}`);
  }

  budget(month?: string): Promise<BudgetStatus> {
    return this.request("GET", `/v1/budget${month ? `?month=${encodeURIComponent(month)}` : ""}`);
  }

  proposeBudgetMove(input: BudgetMoveInput): Promise<Approval> {
    return this.request("POST", "/v1/budget/moves", input);
  }

  async approvals(state: "open" | "decided" | "all" = "open"): Promise<readonly Approval[]> {
    const r = await this.request<{ approvals: readonly Approval[] }>("GET", `/v1/approvals?state=${state}`);
    return r.approvals;
  }

  decideApproval(id: string, decision: ApprovalDecision, note?: string): Promise<Approval> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/decide`, note ? { decision, note } : { decision }, { stepUp: true });
  }

  goals(): Promise<GoalsResponse> {
    return this.request("GET", "/v1/goals");
  }

  bills(): Promise<BillsResponse> {
    return this.request("GET", "/v1/bills");
  }

  ask(question: string): Promise<AskAnswer> {
    return this.request("POST", "/v1/ask", { question });
  }

  async askHistory(): Promise<readonly AskHistoryItem[]> {
    const r = await this.request<{ conversations?: readonly AskHistoryItem[] }>("GET", "/v1/ask/history");
    return r.conversations ?? [];
  }

  async alerts(): Promise<readonly Alert[]> {
    // No member-facing alerts route yet; the console one is scoped to the household by RLS. Empty when refused.
    try {
      const r = await this.request<{ alerts?: readonly Alert[] }>("GET", "/v1/console/alerts");
      return r.alerts ?? [];
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return [];
      throw err;
    }
  }

  async registerPushToken(input: PushTokenRegistration): Promise<void> {
    // TODO(openapi): no push-token route yet. A 404 is ignored so the app keeps working against today's API.
    try {
      await this.request("POST", "/v1/devices/push-token", input);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return;
      throw err;
    }
  }

  async requestExport(): Promise<{ requested: boolean; available: boolean }> {
    // TODO(openapi): no export route yet (spec: "Audit and export"). Reported as unavailable on 404.
    try {
      await this.request("POST", "/v1/export", {}, { stepUp: true });
      return { requested: true, available: true };
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { requested: false, available: false };
      throw err;
    }
  }

  private async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown, opts: { stepUp?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(await this.opts.auth.headers(opts.stepUp ? { stepUp: true } : undefined)) };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchWithTimeout(`${this.base}${path}`, init, this.timeoutMs);
    return this.handle<T>(res);
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchFn(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async handle<T>(res: Response): Promise<T> {
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
    const body = (await safeJson(res)) as { error?: string; message?: string } | undefined;
    const code = body?.error ?? `http_${res.status}`;
    if (res.status === 401) this.opts.auth.onUnauthorized?.();
    if (res.status === 403 && code === "step_up_required") throw new StepUpRequiredError();
    throw new ApiError(res.status, code, body?.message);
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}
