/**
 * The typed HTTP client, hand-written against the route names in services/api/src/app.ts and the DTOs in
 * @homestead/shared. Every call goes through `request`, which adds the sign-in headers, the step-up proof
 * when the call needs it, and turns the API's error envelope `{ error: string }` into typed errors.
 *
 * Route map (to be reconciled with services/api/openapi.yaml when it lands):
 *   GET  /v1/me                              -> MeResponse
 *   GET  /v1/accounts                        -> AccountSummary[]
 *   GET  /v1/budget/safe-to-spend            -> SafeToSpendView       (falls back to composing it client-side on 404)
 *   GET  /v1/questions                       -> Question[]
 *   POST /v1/questions/:id/answer            { optionId, categoryId? }
 *   GET  /v1/transactions?q&limit&needsAnswer&withReceipt&memberId -> { items, dataThrough }
 *   GET  /v1/transactions/:id                -> Transaction
 *   POST /v1/transactions/:id/correction     { categoryId, proposeRule? } -> CorrectionResult
 *   POST /v1/transactions/:id/business       { flag } -> Transaction
 *   POST /v1/receipts (multipart: file, sha256, capturedAt, clientId) -> ReceiptSummary; 409 duplicate
 *   GET  /v1/receipts/:id                    -> ReceiptDetail
 *   GET  /v1/paychecks/:id                   -> PaycheckSummary
 *   GET  /v1/budget?month=YYYY-MM            -> BudgetStatus
 *   POST /v1/budget/moves                    { fromCategoryId, toCategoryId, amountCents, note? } -> Approval
 *   GET  /v1/approvals                       -> Approval[]
 *   POST /v1/approvals/:id/decide            { decision } (step-up) -> Approval
 *   GET  /v1/goals                           -> Goal[]
 *   GET  /v1/bills                           -> BillsView
 *   POST /v1/ask                             { question } -> AskAnswer
 *   GET  /v1/alerts                          -> Alert[]
 *   POST /v1/devices/push-token              { token, platform, deviceName? }   (TODO: confirm in openapi.yaml)
 *   POST /v1/export                          (step-up) -> { requested: true }
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
  Goal,
  MeResponse,
  PaycheckSummary,
  PushTokenRegistration,
  Question,
  ReceiptSummary,
  SafeToSpendView,
  Transaction,
} from "@homestead/shared";
import { composeSafeToSpend } from "../model/safeToSpendVm";
import { todayIso } from "../model/format";
import {
  ApiError,
  DuplicateReceiptError,
  StepUpRequiredError,
  type AnswerInput,
  type BudgetMoveInput,
  type CorrectionInput,
  type HomesteadApi,
  type ReceiptDetail,
  type TransactionsPage,
  type TransactionsQuery,
  type UploadReceiptInput,
} from "./types";

export interface AuthHeaderSource {
  /** Headers that identify the member; with `stepUp`, the proof of a fresh local authentication too. */
  headers(opts?: { stepUp?: boolean }): Promise<Record<string, string>>;
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

  me(): Promise<MeResponse> {
    return this.request("GET", "/v1/me");
  }

  accounts(): Promise<readonly AccountSummary[]> {
    return this.request("GET", "/v1/accounts");
  }

  async safeToSpend(): Promise<SafeToSpendView> {
    try {
      return await this.request<SafeToSpendView>("GET", "/v1/budget/safe-to-spend");
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err;
      // No dedicated endpoint: compose it from accounts, goals and bills with the shared calculation.
      const [accounts, goals, bills, budget] = await Promise.all([this.accounts(), this.goals(), this.bills(), this.budget().catch(() => undefined)]);
      return composeSafeToSpend({ accounts, goals, bills: bills.bills, nextPaydayIso: bills.nextPaydayIso, todayIso: todayIso(), ...(budget ? { budget } : {}) });
    }
  }

  questions(): Promise<readonly Question[]> {
    return this.request("GET", "/v1/questions");
  }

  async answerQuestion(id: string, input: AnswerInput): Promise<void> {
    await this.request("POST", `/v1/questions/${encodeURIComponent(id)}/answer`, input);
  }

  transactions(query: TransactionsQuery = {}): Promise<TransactionsPage> {
    const qs = new URLSearchParams();
    if (query.q) qs.set("q", query.q);
    if (query.limit) qs.set("limit", String(query.limit));
    if (query.needsAnswer) qs.set("needsAnswer", "true");
    if (query.withReceipt) qs.set("withReceipt", "true");
    if (query.memberId) qs.set("memberId", query.memberId);
    const s = qs.toString();
    return this.request("GET", `/v1/transactions${s ? `?${s}` : ""}`);
  }

  transaction(id: string): Promise<Transaction> {
    return this.request("GET", `/v1/transactions/${encodeURIComponent(id)}`);
  }

  correctTransaction(id: string, input: CorrectionInput): Promise<CorrectionResult> {
    return this.request("POST", `/v1/transactions/${encodeURIComponent(id)}/correction`, input);
  }

  setBusinessFlag(id: string, flag: BusinessFlag): Promise<Transaction> {
    return this.request("POST", `/v1/transactions/${encodeURIComponent(id)}/business`, { flag });
  }

  async uploadReceipt(input: UploadReceiptInput): Promise<ReceiptSummary> {
    const form = new FormData();
    form.append("sha256", input.sha256);
    form.append("capturedAt", input.capturedAt);
    form.append("clientId", input.clientId);
    // React Native's FormData takes { uri, name, type } for a file part.
    form.append("file", { uri: input.fileUri, name: `${input.clientId}.jpg`, type: "image/jpeg" } as unknown as Blob);
    const headers = await this.opts.auth.headers();
    const res = await this.fetchWithTimeout(`${this.base}/v1/receipts`, { method: "POST", headers, body: form }, 60_000);
    if (res.status === 409) {
      const body = (await safeJson(res)) as { existingReceiptId?: string; receiptId?: string } | undefined;
      throw new DuplicateReceiptError(body?.existingReceiptId ?? body?.receiptId);
    }
    return this.handle<ReceiptSummary>(res);
  }

  receipt(id: string): Promise<ReceiptDetail> {
    return this.request("GET", `/v1/receipts/${encodeURIComponent(id)}`);
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

  approvals(): Promise<readonly Approval[]> {
    return this.request("GET", "/v1/approvals");
  }

  decideApproval(id: string, decision: ApprovalDecision): Promise<Approval> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/decide`, { decision }, { stepUp: true });
  }

  goals(): Promise<readonly Goal[]> {
    return this.request("GET", "/v1/goals");
  }

  bills(): Promise<BillsView> {
    return this.request("GET", "/v1/bills");
  }

  ask(question: string): Promise<AskAnswer> {
    return this.request("POST", "/v1/ask", { question });
  }

  alerts(): Promise<readonly Alert[]> {
    return this.request("GET", "/v1/alerts");
  }

  async registerPushToken(input: PushTokenRegistration): Promise<void> {
    // TODO(openapi): confirm the push-token route once services/api/openapi.yaml exists; a 404 is ignored so
    // the app keeps working against an API that has no push yet.
    try {
      await this.request("POST", "/v1/devices/push-token", input);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return;
      throw err;
    }
  }

  requestExport(): Promise<{ requested: true }> {
    return this.request("POST", "/v1/export", {}, { stepUp: true });
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
