/**
 * HTTP implementation of ConsoleApi. Written against services/api/openapi.yaml and reconciled (Oct 20, 2026) with
 * the routes as implemented in services/api/src/routes/*.ts, which return more than the OpenAPI documents (outbox
 * list and retry, subscription ids, draft sums, documentNo on exception resolution, the household in
 * /console/settings, receipt match candidates). The screens use the richer Console DTOs from @homestead/shared;
 * this client composes them from those routes. Where the API has no data yet (loan rollforwards, employer
 * templates, BC-side draft counts, statement numbers) the field is left empty and the screen says so; where the
 * API has no route that does the right thing (mapping changes) the call fails with `501 not_in_api` instead of
 * sending something that would be applied wrongly. README "API routes" lists every gap.
 *
 * Auth: `getAuthHeaders` supplies `Authorization: Bearer …` (Entra) or `x-dev-member` (AUTH_MODE=dev).
 * Step-up calls use `getStepUpHeaders`: a freshly issued token in Entra mode (the API checks `iat` within two
 * minutes and an MFA/passkey `amr`), or `x-step-up: true` in dev.
 */
import {
  BANK_CARD_LIST,
  CATEGORIES,
  CATEGORY_CATALOG_VERSION,
  DIMENSION_CODES,
  type AccountSummary,
  type AuditEntry,
  type AuthorityMatrix,
  type BankCardReconStatus,
  type BcBatch,
  type BcSubscriptionSummary,
  type BusinessFlag,
  type ConsoleMe,
  type ConsolePage,
  type ConsoleReceiptRow,
  type ConsoleTransactionRow,
  type DataThrough,
  type DimensionDictionaryEntry,
  type EmployerMapping,
  type MemberSummary,
  type ExceptionResolution,
  type FeedConnectionSummary,
  type HealthReport,
  type LoanRollforward,
  type MappingSet,
  type OutboxItem,
  type ReceiptSummary,
  type RuleSummary,
  type SyncRunSummary,
  type SyncStatus,
  type Transaction,
} from "@homestead/shared";
import { config } from "../config";
import { ApiError, type AccountLink, type ConsoleApi, type FeedAccounts, type LinkToken, type PageQuery } from "./types";

export type AuthHeaders = () => Promise<Record<string, string>>;
/** Step-up headers; `maxAuthAgeMinutes` widens or narrows how recent the sign-in must be (Entra mode). */
export type StepUpHeaders = (maxAuthAgeMinutes?: number) => Promise<Record<string, string>>;
export interface MemberInfo {
  id: string;
  displayName: string;
}

export interface HttpApiOptions {
  getAuthHeaders: AuthHeaders;
  /** Headers for a call that needs step-up. Default: the normal headers plus `x-step-up: true` (dev only). */
  getStepUpHeaders?: StepUpHeaders;
  member: () => MemberInfo;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  healthReportPath?: string;
}

// ---- Response shapes (only the fields the Console reads) --------------------------------------------------------

type ApiTransaction = Transaction & { exceptionReason?: string; duplicateOfId?: string; statusWord?: string; pairId?: string };

interface QueuesResponse {
  counts?: Record<string, number>;
  transactions?: ApiTransaction[];
  receipts?: ReceiptSummary[];
  rules?: RuleSummary[];
  exceptions?: ApiTransaction[];
  dataThrough?: DataThrough;
}
interface PostingResponse {
  batches?: { batch: BcBatch; approved?: number; sentToBc?: number; draftCreated?: number; posted?: number; exceptions?: number; deadLettered?: number; draftSumCents?: number; bcDraftCount?: number; bcDraftLines?: number; bcDraftSumCents?: number }[];
  autoPostEnabled?: boolean;
  outboxDue?: number;
  lastPollAt?: string;
  lastWebhookAt?: string;
  /** When the API read the BC batches live; `bcUnavailable` when BC did not answer. */
  bcCheckedAt?: string;
  bcUnavailable?: boolean;
}
interface PostBatchResponse {
  batch?: BcBatch;
  outboxId?: string;
  queuedAt?: string;
  lineCount?: number;
  draftCount?: number;
  enqueued?: boolean;
  message?: string;
}
interface ConnectionsResponse {
  feeds?: { id: string; provider: "plaid" | "file" | "simplefin"; institutionName?: string; ownerMemberId?: string; ownerName?: string; status?: FeedConnectionSummary["status"]; needsRelink?: boolean; lastSyncedAt?: string; staleHours?: number; accountCount?: number; cursorPresent?: boolean }[];
  ledger?: { environment?: string; companyId?: string; autoPostEnabled?: boolean; lastPollAt?: string; lastWebhookAt?: string; apiReachable?: boolean; checkedAt?: string };
  webhooks?: { resource: string; subscriptionId?: string; expiresAt?: string; lastRenewedAt?: string; needsRenewal?: boolean }[];
  outbox?: { due?: number; deadLettered?: number; oldestPendingAt?: string };
}
interface MeResponse {
  member?: MemberSummary;
  household?: { id: string; name: string; timezone: string; settingsVersion?: number };
  ledger?: { tenantId?: string; environment?: string; companyId?: string; journalTemplate?: string; autoPostEnabled?: boolean };
}
interface SettingsResponse {
  version?: number;
  settings?: Record<string, unknown> & { authorityMatrix?: unknown[] };
  household?: { id: string; name: string; timezone: string; currency: string };
  history?: { version: number; effectiveFrom: string; approvedBy: string[] }[];
}
interface MatrixResponse {
  version?: number;
  rows?: { action: string; who: string; stepUp: string; notes: string; settingKeys?: string[]; tbd?: boolean }[];
  approvedAt?: string;
  approvedBy?: string[];
  settingsVersion?: number;
  autoPostRules?: { ruleNo: string; name: string; state: RuleSummary["state"]; mayAutoPost: boolean; testPassedAt?: string }[];
}
interface ReconResponse {
  accounts?: {
    accountId: string;
    displayName?: string;
    bcBankAccountCode?: string;
    glAccount?: string;
    mask?: string;
    institution?: string;
    posted?: number;
    reconciled?: number;
    bcNative?: number;
    differences?: number;
    lastPollAt?: string;
    /** From BC's bank ledger entries (HH App Connector), last 120 days; absent when BC was not read. */
    openCount?: number;
    openSumCents?: number;
    bcReconciledCount?: number;
    lastStatementNo?: string;
    reconciledThrough?: string;
    bankLedger?: "unavailable";
  }[];
  /** Loan rollforwards for the current month from BC's G/L; absent without a ledger, `loansUnavailable` when BC did not answer. */
  loans?: LoanRollforward[];
  loansUnavailable?: boolean;
}
interface MappingsResponse {
  catalogVersion?: number;
  categories?: { id: string; name: string; group: string; glAccount: string; dims?: Record<string, string>; isAllowance?: boolean; isTransfer?: boolean; householdVisible?: boolean; version?: number }[];
  accounts?: (AccountSummary & { bcBankAccountCode?: string; bcGlAccount?: string })[];
  dimensions?: Record<string, string[]>;
  employers?: EmployerMapping[];
}
interface SyncResponse {
  runs?: SyncRunSummary[];
}
interface ReceiptDetailResponse extends ReceiptSummary {
  candidates?: { transactionId: string; score: number }[];
}

// ---- Helpers -----------------------------------------------------------------------------------------------------

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

function slice<T>(items: readonly T[], q: PageQuery | undefined, defaultSize = 50): { items: T[]; page: number; pageSize: number } {
  const pageSize = q?.pageSize ?? defaultSize;
  const page = q?.page ?? 1;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize };
}

function pageOf<T>(items: readonly T[], q: PageQuery | undefined, dataThrough: DataThrough): ConsolePage<T> {
  const s = slice(items, q);
  return { items: s.items, total: items.length, page: s.page, pageSize: s.pageSize, dataThrough };
}

const nowThrough = (quality: DataThrough["quality"], pendingCount = 0): DataThrough => ({ at: new Date().toISOString(), quality, pendingCount });

/** The question id the API uses for a transaction's open question (services/api/src/services/questions.ts). */
export const txQuestionId = (transactionId: string): string => `tx:${transactionId}`;

/** BC dimension slots as the setup design assigns them (packages/shared dimensions; BC test finding 1). */
const DIMENSION_SLOTS: Record<string, DimensionDictionaryEntry["slot"]> = {
  [DIMENSION_CODES.SPEND_CLASS]: "global1",
  [DIMENSION_CODES.FUND_GOAL]: "global2",
  [DIMENSION_CODES.FAMILY_AREA]: "shortcut3",
  [DIMENSION_CODES.TAX_TREATMENT]: "shortcut4",
  [DIMENSION_CODES.PROJECT]: "shortcut5",
};

const LINK_SAVE_WINDOW_MINUTES = 45;

export function createHttpApi(opts: HttpApiOptions): ConsoleApi {
  const baseUrl = (opts.baseUrl ?? config.apiBaseUrl).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const stepUpHeaders: StepUpHeaders = opts.getStepUpHeaders ?? (async () => ({ ...(await opts.getAuthHeaders()), "x-step-up": "true" }));

  /** `stepUp`: true for the standard recent-sign-in window, or a number of minutes for a wider one. */
  async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, stepUp: boolean | number = false): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(await (stepUp === false ? opts.getAuthHeaders() : stepUpHeaders(typeof stepUp === "number" ? stepUp : undefined))) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = json as { error?: string; message?: string } | undefined;
      throw new ApiError(res.status, typeof e?.error === "string" ? e.error : `http_${res.status}`, typeof e?.message === "string" ? e.message : undefined);
    }
    return json as T;
  }
  const get = <T>(path: string) => call<T>("GET", path);
  const post = <T>(path: string, body: unknown = {}, stepUp: boolean | number = false) => call<T>("POST", path, body, stepUp);

  // Short-lived caches so the queue tabs, the sidebar badges and the overview share one /console/queues read.
  let queuesCache: { at: number; p: Promise<QueuesResponse> } | undefined;
  const queues = (): Promise<QueuesResponse> => {
    if (!queuesCache || Date.now() - queuesCache.at > 5_000) {
      const p = get<QueuesResponse>("/v1/console/queues");
      queuesCache = { at: Date.now(), p };
      p.catch(() => {
        if (queuesCache?.p === p) queuesCache = undefined;
      });
    }
    return queuesCache.p;
  };
  const bust = () => {
    queuesCache = undefined;
  };
  let accountsCache: { at: number; p: Promise<AccountSummary[]> } | undefined;
  const accounts = (): Promise<AccountSummary[]> => {
    if (!accountsCache || Date.now() - accountsCache.at > 60_000) {
      const p = get<{ accounts?: AccountSummary[] }>("/v1/accounts").then((r) => r.accounts ?? []);
      accountsCache = { at: Date.now(), p };
      p.catch(() => {
        if (accountsCache?.p === p) accountsCache = undefined;
      });
    }
    return accountsCache.p;
  };
  const categoryName = (id: string | undefined) => (id ? CATEGORIES.find((c) => c.id === id)?.name : undefined);

  async function enrich(t: ApiTransaction): Promise<ConsoleTransactionRow> {
    const acct = (await accounts().catch(() => [] as AccountSummary[])).find((a) => a.id === t.accountId);
    const row: ConsoleTransactionRow = { ...t, accountName: acct?.displayName ?? t.accountId, accountMask: acct?.mask ?? "" };
    const cn = categoryName(t.categoryId);
    if (cn) row.categoryName = cn;
    if (t.duplicateOfId) row.duplicateOfId = t.duplicateOfId;
    // The Exceptions list also carries lines with a noted reason but another state (services/console.ts queues).
    if (t.state === "exception" || t.exceptionReason) {
      row.exception = {
        reason: t.exceptionReason ?? t.bc?.difference ?? "Exception (no reason recorded)",
        appSide: { idempotencyKey: t.idempotencyKey, externalDocumentNo: t.bc?.externalDocumentNo, lineIds: t.bc?.lineIds, state: t.state, amountCents: t.amountCents },
        bcSide: t.bc ? { documentNo: t.bc.documentNo, entryNos: t.bc.entryNos, postingDate: t.bc.postingDate, note: t.bc.difference } : undefined,
        raisedAt: t.updatedAt,
        raisedBy: "jobs",
      };
    }
    return row;
  }

  async function transactionById(id: string, fromQueue: readonly ApiTransaction[]): Promise<ApiTransaction | undefined> {
    const hit = fromQueue.find((t) => t.id === id);
    if (hit) return hit;
    return get<ApiTransaction>(`/v1/transactions/${encodeURIComponent(id)}`).catch(() => undefined);
  }

  const api: ConsoleApi = {
    // GET /v1/me: the signed-in member, the household and the BC connection (ids only, never a credential).
    async me(): Promise<ConsoleMe> {
      const r = await get<MeResponse>("/v1/me");
      const m = opts.member();
      return {
        member: r.member ?? { id: m.id, displayName: m.displayName, role: "member" },
        household: { id: r.household?.id ?? "", name: r.household?.name ?? "Household", timezone: r.household?.timezone ?? config.timeZone, settingsVersion: r.household?.settingsVersion ?? 1 },
        ledger: {
          tenantId: r.ledger?.tenantId || config.bc.tenant,
          environment: r.ledger?.environment || config.bc.environment,
          companyId: r.ledger?.companyId ?? "",
          journalTemplate: r.ledger?.journalTemplate || config.bc.journalTemplate,
          autoPostEnabled: r.ledger?.autoPostEnabled ?? false,
        },
      };
    },

    async transactions(queue, q) {
      const r = await queues();
      const list = queue === "exception" ? (r.exceptions ?? []) : (r.transactions ?? []).filter((t) => t.state === queue);
      const sorted = [...list].sort((a, b) => (a.postedDate < b.postedDate ? 1 : a.postedDate > b.postedDate ? -1 : 0));
      const s = slice(sorted, q);
      const rows = await Promise.all(s.items.map((t) => enrich(t)));
      return { items: rows, total: sorted.length, page: s.page, pageSize: s.pageSize, dataThrough: r.dataThrough ?? nowThrough("imported_pending") };
    },

    // Approving is the same act as a spouse's "Looks right" on the phone: the question `tx:<id>` answered with
    // `confirm` (services/api/src/services/questions.ts, ready_for_review). It approves with the category or
    // split already on the line and is not logged as a correction, so rule statistics stay honest.
    async approveTransactions(ids) {
      const r = await queues();
      const skipped: { id: string; reason: string }[] = [];
      let approved = 0;
      for (const id of ids) {
        const t = (r.transactions ?? []).find((x) => x.id === id);
        if (!t) {
          skipped.push({ id, reason: "not in the queue any more" });
          continue;
        }
        if (t.state !== "ready_for_review") {
          skipped.push({ id, reason: `state is ${t.state.replace(/_/g, " ")}` });
          continue;
        }
        if (!t.categoryId && t.splits.length === 0) {
          skipped.push({ id, reason: "no category chosen" });
          continue;
        }
        try {
          await post(`/v1/questions/${encodeURIComponent(txQuestionId(id))}/answer`, { optionId: "confirm" });
          approved += 1;
        } catch (err) {
          skipped.push({ id, reason: err instanceof ApiError ? (err.message || err.code) : String(err) });
        }
      }
      bust();
      return { approved, skipped };
    },

    // "This is wrong": before BC the line changes in place (and a ready_for_review line is approved with the new
    // values); after BC the API opens a correction request for Cade instead and returns `correctionRequestId`.
    async correctTransaction(id, input) {
      const r = await post<{ transaction: ApiTransaction; correctionRequestId?: string }>(`/v1/transactions/${encodeURIComponent(id)}/correct`, { categoryId: input.categoryId, ...(input.note ? { reason: input.note } : {}) });
      if (input.makeRule && !r.correctionRequestId) {
        const t = r.transaction;
        const abs = Math.abs(t.amountCents);
        const pad = Math.max(500, Math.round(abs * 0.05));
        // Same match shape as the API's own proposals (services/api/src/services/rules.ts proposeRulesFromHistory).
        await post("/v1/rules", {
          kind: "merchant",
          name: `${t.merchantNorm} → ${categoryName(input.categoryId) ?? input.categoryId}`.slice(0, 120),
          match: { merchantNorm: t.merchantNorm, band: { minCents: Math.max(0, abs - pad), maxCents: abs + pad }, direction: t.amountCents < 0 ? "out" : "in" },
          action: { categoryId: input.categoryId },
          mayAutoPost: false,
        });
      }
      bust();
      const row = await enrich(r.transaction);
      return r.correctionRequestId ? { ...row, correctionRequestId: r.correctionRequestId } : row;
    },

    async setBusinessFlag(id, flag: BusinessFlag) {
      const t = await post<ApiTransaction>(`/v1/transactions/${encodeURIComponent(id)}/business`, { flag });
      bust();
      return enrich(t);
    },

    // Possible duplicates are answered through the question API; the question id is `tx:<transaction id>`.
    async resolveDuplicate(id, decision) {
      const r = await post<{ transaction?: ApiTransaction }>(`/v1/questions/${encodeURIComponent(txQuestionId(id))}/answer`, { optionId: decision === "same_thing" ? "same_thing" : "not_repeat" });
      bust();
      if (r.transaction) return enrich(r.transaction);
      return enrich(await get<ApiTransaction>(`/v1/transactions/${encodeURIComponent(id)}`));
    },

    async resolveException(id, resolution: ExceptionResolution) {
      const body =
        resolution.to === "posted"
          ? { to: "posted", entryNos: resolution.bcEntryNos, ...(resolution.bcDocumentNo ? { documentNo: resolution.bcDocumentNo } : {}), ...(resolution.bcPostingDate ? { postingDate: resolution.bcPostingDate } : {}), note: resolution.note }
          : { to: "ready_for_review", note: resolution.note };
      const t = await post<ApiTransaction>(`/v1/console/exceptions/${encodeURIComponent(id)}/resolve`, body, true);
      bust();
      return enrich(t);
    },

    // Receipts come with the queues read; the candidates the matcher could not choose between come from each
    // receipt's detail (GET /v1/receipts/{id} → candidates[{ transactionId, score }]), fetched for the page shown.
    async receipts(status, q) {
      const r = await queues();
      const all = (r.receipts ?? []).filter((x) => (status === "unmatched" ? x.ocrStatus === "read" && !x.matchedTransactionId : x.ocrStatus === "needs_review" || x.ocrStatus === "failed"));
      const s = slice(all, q);
      const queueTx = [...(r.transactions ?? []), ...(r.exceptions ?? [])];
      const items = await Promise.all(
        s.items.map(async (rec): Promise<ConsoleReceiptRow> => {
          const row: ConsoleReceiptRow = { ...rec, memberName: (rec as ReceiptSummary & { memberName?: string }).memberName || "—" };
          if (status !== "unmatched") return row;
          const detail = await get<ReceiptDetailResponse>(`/v1/receipts/${encodeURIComponent(rec.id)}`).catch(() => undefined);
          const cands = detail?.candidates ?? [];
          if (cands.length === 0) return row;
          const resolved = await Promise.all(
            cands.map(async (c) => {
              const t = await transactionById(c.transactionId, queueTx);
              return t ? { transactionId: t.id, postedDate: t.postedDate, amountCents: t.amountCents, merchant: t.merchantRaw, confidence: c.score } : undefined;
            }),
          );
          return { ...row, candidates: resolved.filter((x): x is NonNullable<typeof x> => x !== undefined) };
        }),
      );
      return { items, total: all.length, page: s.page, pageSize: s.pageSize, dataThrough: r.dataThrough ?? nowThrough("imported_pending") };
    },

    async matchReceipt(receiptId, transactionId) {
      const r = await post<ReceiptSummary & { transaction?: Transaction }>(`/v1/receipts/${encodeURIComponent(receiptId)}/match`, { transactionId });
      bust();
      const { transaction: _matched, ...summary } = r;
      return { ...summary, memberName: "—" };
    },

    async rules(state, q) {
      const r = await get<{ rules?: RuleSummary[] }>(`/v1/rules${qs({ state })}`);
      return pageOf(r.rules ?? [], q, nowThrough("posted_unreconciled"));
    },

    // The API has approve and retire (both step-up); declining a proposal retires it with the reason.
    async decideRule(id, decision, note) {
      if (decision === "approve") return post<RuleSummary>(`/v1/rules/${encodeURIComponent(id)}/approve`, note ? { approvalNote: note } : {}, true);
      return post<RuleSummary>(`/v1/rules/${encodeURIComponent(id)}/retire`, { reason: note ?? (decision === "decline" ? "declined in the Console" : "retired in the Console") }, true);
    },

    async syncStatus(): Promise<SyncStatus> {
      const [posting, conn, runs, postAudit] = await Promise.all([
        get<PostingResponse>("/v1/console/posting"),
        get<ConnectionsResponse>("/v1/console/connections"),
        get<SyncResponse>(`/v1/console/sync${qs({ limit: 100 })}`).catch(() => ({ runs: [] }) as SyncResponse),
        get<{ entries?: AuditEntry[] }>(`/v1/console/audit${qs({ entity: "batch", limit: 50 })}`).catch(() => ({ entries: [] })),
      ]);
      // BC-side draft counts and sums are read live by the API from the batch (bcDraftCount/bcDraftSumCents); the
      // API's `exceptions` per batch is the difference count the poll raised.
      const lastRequest = (batch: BcBatch) => (postAudit.entries ?? []).filter((e) => e.entityId === batch && (e.action === "post.requested" || e.action === "post.enqueued")).map((e) => e.at).sort().at(-1);
      const batches = (["FEEDS", "RECEIPTS", "AUTOPOST"] as BcBatch[]).map((batch) => {
        const b = posting.batches?.find((x) => x.batch === batch);
        const lastPostRequestedAt = lastRequest(batch);
        return {
          batch,
          appDraftCount: b?.draftCreated ?? 0,
          appDraftSumCents: b?.draftSumCents ?? 0,
          inFlightCount: (b?.approved ?? 0) + (b?.sentToBc ?? 0),
          differenceCount: b?.exceptions ?? 0,
          ...(b?.bcDraftCount !== undefined ? { bcDraftCount: b.bcDraftCount } : {}),
          ...(b?.bcDraftSumCents !== undefined ? { bcDraftSumCents: b.bcDraftSumCents } : {}),
          ...(lastPostRequestedAt ? { lastPostRequestedAt } : {}),
        };
      });
      const lastPollAt = posting.lastPollAt ?? conn.ledger?.lastPollAt;
      const lastPollRun = (runs.runs ?? []).filter((x) => x.kind === "bc_poll").sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
      return {
        batches,
        lastWebhookAt: posting.lastWebhookAt ?? conn.ledger?.lastWebhookAt,
        lastPollAt,
        ...(lastPollRun ? { lastPollStatus: lastPollRun.status } : {}),
        outbox: { depth: posting.outboxDue ?? conn.outbox?.due ?? 0, deadLetters: conn.outbox?.deadLettered ?? 0, oldestPendingAt: conn.outbox?.oldestPendingAt },
        subscriptions: toSubscriptions(conn.webhooks),
        autoPostEnabled: posting.autoPostEnabled ?? conn.ledger?.autoPostEnabled ?? false,
        dataThrough: lastPollAt ? { at: lastPollAt, quality: "posted_unreconciled", pendingCount: posting.outboxDue ?? 0 } : nowThrough("missing", posting.outboxDue ?? 0),
      };
    },

    // The API only enqueues (AUTOPOST, when the switch is on) or records the request (FEEDS, RECEIPTS: Cade posts
    // in BC under his own sign-in). Either way it writes an outbox row and an audit entry.
    async postBatch(batch: BcBatch) {
      const r = await post<PostBatchResponse>("/v1/console/posting/post-batch", { batch }, true);
      return {
        batch: r.batch ?? batch,
        outboxId: r.outboxId ?? "",
        queuedAt: r.queuedAt ?? new Date().toISOString(),
        lineCount: r.lineCount ?? r.draftCount ?? 0,
        ...(r.enqueued !== undefined ? { enqueued: r.enqueued } : {}),
        ...(r.message ? { message: r.message } : {}),
      };
    },

    async reconciliation() {
      const [r, accts] = await Promise.all([get<ReconResponse>("/v1/console/reconciliation"), accounts().catch(() => [] as AccountSummary[])]);
      const bankCards: BankCardReconStatus[] = BANK_CARD_LIST.map((card) => {
        const a = r.accounts?.find((x) => x.bcBankAccountCode === card.code);
        const summary = accts.find((x) => x.bcBankAccountCode === card.code || (a && x.id === a.accountId));
        const differences = a?.differences ?? 0;
        const fromBc = a !== undefined && a.bankLedger !== "unavailable" && a.openCount !== undefined;
        return {
          code: card.code,
          name: card.name,
          glAccount: card.glAccount,
          institution: card.institution,
          mask: card.mask,
          // From BC's bank ledger when the API could read it; otherwise the app's posted-not-reconciled count.
          openCount: fromBc ? (a.openCount ?? 0) : Math.max(0, a?.posted ?? 0),
          reconciledCount: fromBc ? (a.bcReconciledCount ?? a.reconciled ?? 0) : (a?.reconciled ?? 0),
          openSumCents: fromBc ? (a.openSumCents ?? 0) : 0,
          ...(a?.lastStatementNo ? { lastStatementNo: a.lastStatementNo } : {}),
          ...(a?.reconciledThrough ? { reconciledThrough: a.reconciledThrough, lastStatementDate: a.reconciledThrough } : {}),
          differences: differences > 0 ? [{ postedDate: (a?.lastPollAt ?? new Date().toISOString()).slice(0, 10), amountCents: 0, note: `${differences} line${differences === 1 ? "" : "s"} differ (see the Exceptions queue)` }] : [],
          feedStatus: summary?.feedStatus ?? "none",
        };
      });
      const latest = r.accounts?.map((a) => a.lastPollAt).filter((x): x is string => Boolean(x)).sort().at(-1);
      // Loan rollforwards (the two Frontier loans and PennyMac) come from BC's G/L; when BC was not read the page says
      // so. Open sums and statements are missing only where BC's bank ledger was not read.
      const bcRead = (r.accounts ?? []).some((a) => a.openCount !== undefined && a.bankLedger !== "unavailable");
      const loans = r.loans ?? [];
      type Missing = "openSum" | "statements" | "differenceLines" | "loans";
      const missing: Missing[] = [...(bcRead ? [] : (["openSum", "statements"] as Missing[])), "differenceLines", ...(r.loans && !r.loansUnavailable ? [] : (["loans"] as Missing[]))];
      return {
        bankCards,
        loans,
        dataThrough: latest ? { at: latest, quality: "posted_unreconciled", pendingCount: 0 } : nowThrough("missing"),
        missing,
      };
    },

    async mappings(): Promise<MappingSet> {
      const m = await get<MappingsResponse>("/v1/console/mappings");
      const byCode = new Map((m.accounts ?? []).filter((a) => a.bcBankAccountCode).map((a) => [a.bcBankAccountCode, a]));
      return {
        catalogVersion: m.catalogVersion ?? CATEGORY_CATALOG_VERSION,
        categories: (m.categories ?? []).map((c) => ({ id: c.id, name: c.name, group: c.group, glAccount: c.glAccount, dims: c.dims ?? {}, spendClass: c.dims?.["SPEND_CLASS"], isAllowance: c.isAllowance ?? false, isTransfer: c.isTransfer ?? false, householdVisible: c.householdVisible ?? true, version: c.version ?? 1 })),
        dimensions: Object.entries(m.dimensions ?? {}).map(([code, values]) => ({ code, name: code.replace(/_/g, " ").toLowerCase(), slot: DIMENSION_SLOTS[code] ?? "shortcut5", values: values.map((v) => ({ code: v, name: v })) })),
        bankCards: BANK_CARD_LIST.map((b) => {
          const a = byCode.get(b.code);
          return { code: b.code, glAccount: b.glAccount, name: b.name, kind: b.kind, institution: b.institution, mask: b.mask, accountId: a?.id, feedProvider: a?.feedStatus === "file_only" ? "file" : a && a.feedStatus !== "none" ? "plaid" : undefined };
        }),
        // The household's employer templates; when absent (an older API) the page shows the shared catalog's mapping.
        employers: m.employers ?? [],
        pendingProposals: [],
        dataThrough: nowThrough("posted_unreconciled"),
      };
    },

    // POST /v1/console/mappings/proposals: an approval the other spouse decides; on approval the API versions the
    // category and applies the new account and dimensions.
    async proposeMapping(input) {
      const r = await post<{ id: string }>("/v1/console/mappings/proposals", { categoryId: input.categoryId, glAccount: input.glAccount, dims: input.dims, reason: input.reason });
      bust();
      return { approvalId: r.id };
    },

    async authority(): Promise<AuthorityMatrix> {
      const [matrix, settings] = await Promise.all([get<MatrixResponse>("/v1/console/authority-matrix"), get<SettingsResponse>("/v1/console/settings")]);
      const values = { ...(settings.settings ?? {}) };
      delete values.authorityMatrix;
      const history = settings.history ?? [];
      const current = history.find((h) => h.version === (settings.version ?? 1));
      return {
        version: matrix.version ?? settings.version ?? 1,
        approvedAt: matrix.approvedAt,
        approvedBy: matrix.approvedBy,
        rows: (matrix.rows ?? []).map((r) => {
          const keys = r.settingKeys ?? r.notes.match(/I-\d\d/g) ?? undefined;
          return { ...r, tbd: r.tbd ?? (/TBD/.test(r.notes) || /TBD/.test(r.who)), ...(keys && keys.length ? { settingKeys: keys } : {}) };
        }),
        settings: { version: settings.version ?? 1, effectiveFrom: current?.effectiveFrom ?? history.at(-1)?.effectiveFrom ?? new Date().toISOString(), values, history },
        autoPostRules: matrix.autoPostRules ?? [],
        // Settings and rule states are recorded facts with nothing pending; the matrix is static until re-approved.
        dataThrough: nowThrough("posted_reconciled"),
      };
    },

    async connections() {
      const conn = await get<ConnectionsResponse>("/v1/console/connections");
      const feeds: FeedConnectionSummary[] = (conn.feeds ?? []).map((f) => ({
        id: f.id,
        provider: f.provider,
        institutionName: f.institutionName || f.id,
        ...(f.ownerMemberId ? { ownerMemberId: f.ownerMemberId } : {}),
        ownerName: f.ownerName || f.ownerMemberId || "—",
        status: f.status ?? "ok",
        needsRelink: f.needsRelink ?? f.status === "needs_relink",
        lastSyncedAt: f.lastSyncedAt,
        accountCount: f.accountCount ?? 0,
        cursorPresent: f.cursorPresent ?? false,
      }));
      const newestSync = feeds.map((f) => f.lastSyncedAt).filter((x): x is string => Boolean(x)).sort().at(-1);
      return {
        feeds,
        subscriptions: toSubscriptions(conn.webhooks),
        // The API makes one short read-only call to BC (the dimension list) to say whether it answers right now.
        ledger: {
          lastPollAt: conn.ledger?.lastPollAt,
          lastWebhookAt: conn.ledger?.lastWebhookAt,
          ...(conn.ledger?.apiReachable !== undefined ? { apiReachable: conn.ledger.apiReachable } : {}),
          checkedAt: conn.ledger?.checkedAt ?? new Date().toISOString(),
        },
        dataThrough: newestSync ? { at: newestSync, quality: "imported_pending", pendingCount: conn.outbox?.due ?? 0 } : nowThrough("missing", conn.outbox?.due ?? 0),
      };
    },

    async syncRuns(q) {
      const r = await get<SyncResponse>(`/v1/console/sync${qs({ limit: 500 })}`);
      const items = (r.runs ?? []).filter((x) => (!q?.kind || x.kind === q.kind) && (!q?.status || x.status === q.status));
      return pageOf(items, q, nowThrough("imported_pending"));
    },

    // GET /v1/console/outbox?state=due|dead|done|all (routes/console.ts; not in openapi.yaml yet).
    async outbox(q) {
      const state = q?.deadLettered === true ? "dead" : q?.deadLettered === false ? "due" : "all";
      const r = await get<{ items?: (OutboxItem & { operation?: string })[] }>(`/v1/console/outbox${qs({ state, limit: 500 })}`);
      return pageOf(
        (r.items ?? []).map((o) => ({ ...o, operation: o.operation ?? "" })),
        q,
        nowThrough("imported_pending"),
      );
    },

    // POST /v1/console/outbox/{id}/retry (step-up): back to due with attempts reset; the worker's pre-write check keeps it safe.
    async retryOutbox(id) {
      const o = await post<OutboxItem & { operation?: string }>(`/v1/console/outbox/${encodeURIComponent(id)}/retry`, {}, true);
      return { ...o, operation: o.operation ?? "" };
    },

    // The API pages by a `before` cursor and filters by entity and entity id; the Console asks for page × pageSize
    // rows (at most 500) and slices, which is fine at household scale. The API filters by actor too.
    async audit(q) {
      const pageSize = q?.pageSize ?? 25;
      const pageNo = q?.page ?? 1;
      const r = await get<{ entries?: AuditEntry[]; next?: string }>(`/v1/console/audit${qs({ limit: Math.min(500, pageSize * pageNo), entity: q?.entity, entityId: q?.entityId, actor: q?.actor })}`);
      const entries = r.entries ?? [];
      const items = entries.slice((pageNo - 1) * pageSize, pageNo * pageSize);
      return { items, total: entries.length + (r.next ? 1 : 0), page: pageNo, pageSize, dataThrough: nowThrough("posted_unreconciled") };
    },

    async healthReport() {
      // Static file next to the app, written by the nightly acceptance job; not an API call.
      const res = await doFetch(opts.healthReportPath ?? config.healthReportPath, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as HealthReport & { generatedAt: string | null };
      return json.generatedAt ? json : null;
    },

    // ---- Bank logins (routes/accounts.ts) ----------------------------------------------------------------------
    householdAccounts: () => accounts(),

    // Before Plaid Link opens: a sign-in inside the standard window (a redirect now loses nothing).
    async confirmStepUp() {
      await stepUpHeaders();
    },

    bankLinkToken: () => post<LinkToken>("/v1/accounts/link-token", {}),

    // The save after Link allows 45 minutes since the sign-in checked before Link opened, so a slow bank sign-in
    // never sends the person away (and loses the one-time public token) at the last step.
    async linkBank(input) {
      const r = await post<{ feedConnectionId: string; itemId: string }>("/v1/accounts/link", input, LINK_SAVE_WINDOW_MINUTES);
      accountsCache = undefined;
      return r;
    },

    feedLinkToken: (feedId) => post<LinkToken>(`/v1/accounts/feeds/${encodeURIComponent(feedId)}/link-token`, {}),

    feedReconnected: (feedId) => post<{ syncQueued: boolean }>(`/v1/accounts/feeds/${encodeURIComponent(feedId)}/reconnected`, {}),

    feedAccounts: (feedId) => get<FeedAccounts>(`/v1/accounts/feeds/${encodeURIComponent(feedId)}/accounts`),

    async setFeedAccounts(feedId, links: readonly AccountLink[]) {
      const r = await call<{ attached: number; detached: number; syncQueued: boolean }>("PUT", `/v1/accounts/feeds/${encodeURIComponent(feedId)}/accounts`, { accounts: links }, true);
      accountsCache = undefined;
      return r;
    },

    async unlinkFeed(feedId) {
      await post(`/v1/accounts/feeds/${encodeURIComponent(feedId)}/unlink`, {}, true);
      accountsCache = undefined;
    },
  };
  return api;
}

function toSubscriptions(webhooks: ConnectionsResponse["webhooks"]): BcSubscriptionSummary[] {
  const soon = Date.now() + 24 * 3_600_000;
  return (webhooks ?? []).map((w) => ({
    resource: w.resource,
    subscriptionId: w.subscriptionId ?? "—",
    expiresAt: w.expiresAt ?? "",
    lastRenewedAt: w.lastRenewedAt,
    needsRenewal: w.needsRenewal ?? (!w.expiresAt || Date.parse(w.expiresAt) < soon),
  }));
}
