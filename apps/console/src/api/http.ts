/**
 * HTTP implementation of ConsoleApi, written against services/api/openapi.yaml (Oct 20, 2026).
 *
 * The screens use the richer Console DTOs from @homestead/shared; this client composes them from the routes the
 * API actually documents. Where the API has no route yet (outbox listing and retry, receipt match from the
 * Console, loan rollforwards, employer templates) the method throws ApiError 501 `not_in_api` so the screen says
 * so instead of guessing. See README "API routes" for the full mismatch list.
 *
 * Auth: `getAuthHeaders` supplies `Authorization: Bearer …` (Entra) or `x-dev-member` (AUTH_MODE=dev). Step-up
 * sends `x-step-up: true` in dev; with Entra a fresh token's `amr` claim carries it.
 */
import {
  BANK_CARD_LIST,
  CATEGORIES,
  CATEGORY_CATALOG_VERSION,
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
  type ExceptionResolution,
  type FeedConnectionSummary,
  type HealthReport,
  type MappingProposal,
  type MappingSet,
  type ReceiptSummary,
  type RuleSummary,
  type SyncRunSummary,
  type SyncStatus,
  type Transaction,
} from "@homestead/shared";
import { config } from "../config";
import { ApiError, type ConsoleApi, type PageQuery } from "./types";

export type AuthHeaders = () => Promise<Record<string, string>>;
export interface MemberInfo {
  id: string;
  displayName: string;
}

// Shapes from openapi.yaml (only the fields the Console reads).
interface QueuesResponse {
  counts?: Record<string, number>;
  transactions?: Transaction[];
  receipts?: ReceiptSummary[];
  rules?: RuleSummary[];
  exceptions?: Transaction[];
  dataThrough?: DataThrough;
}
interface PostingResponse {
  batches?: { batch: BcBatch; approved?: number; sentToBc?: number; draftCreated?: number; posted?: number; exceptions?: number; deadLettered?: number }[];
  autoPostEnabled?: boolean;
  outboxDue?: number;
}
interface ConnectionsResponse {
  feeds?: { id: string; provider: "plaid" | "file" | "simplefin"; institutionName?: string; ownerMemberId?: string; status?: FeedConnectionSummary["status"]; needsRelink?: boolean; lastSyncedAt?: string; staleHours?: number }[];
  ledger?: { environment?: string; companyId?: string; autoPostEnabled?: boolean; lastPollAt?: string; lastWebhookAt?: string };
  webhooks?: { resource: string; expiresAt?: string; lastRenewedAt?: string }[];
  outbox?: { due?: number; deadLettered?: number };
}
interface SettingsResponse {
  version?: number;
  settings?: Record<string, unknown> & { authorityMatrix?: unknown[] };
}
interface MatrixResponse {
  version?: number;
  rows?: { action: string; who: string; stepUp: string; notes: string }[];
}
interface ReconResponse {
  accounts?: { accountId: string; displayName?: string; bcBankAccountCode?: string; posted?: number; reconciled?: number; bcNative?: number; differences?: number; lastPollAt?: string }[];
}
interface MappingsResponse {
  categories?: { id: string; name: string; group: string; glAccount: string; dims?: Record<string, string>; isAllowance?: boolean; isTransfer?: boolean; householdVisible?: boolean }[];
  accounts?: AccountSummary[];
  dimensions?: Record<string, string[]>;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

function page<T>(items: readonly T[], q: PageQuery | undefined, dataThrough: DataThrough): ConsolePage<T> {
  const pageSize = q?.pageSize ?? 50;
  const pageNo = q?.page ?? 1;
  const start = (pageNo - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page: pageNo, pageSize, dataThrough };
}

const nowThrough = (quality: DataThrough["quality"], pendingCount = 0): DataThrough => ({ at: new Date().toISOString(), quality, pendingCount });

function notInApi(what: string): never {
  throw new ApiError(501, "not_in_api", `${what} is not in services/api/openapi.yaml yet; see apps/console/README.md "API routes".`);
}

export function createHttpApi(getAuthHeaders: AuthHeaders, member: () => MemberInfo, baseUrl = config.apiBaseUrl): ConsoleApi {
  async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(await getAuthHeaders()), ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
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
      throw new ApiError(res.status, typeof e?.error === "string" ? e.error : `http_${res.status}`, e?.message);
    }
    return json as T;
  }
  const get = <T>(path: string) => call<T>("GET", path);
  const post = <T>(path: string, body?: unknown, stepUp = false) => call<T>("POST", path, body ?? {}, stepUp ? { "x-step-up": "true" } : {});

  // Short-lived caches so the five queue tabs and the sidebar badges share one /console/queues read.
  let queuesCache: { at: number; p: Promise<QueuesResponse> } | undefined;
  const queues = (): Promise<QueuesResponse> => {
    if (!queuesCache || Date.now() - queuesCache.at > 5_000) queuesCache = { at: Date.now(), p: get<QueuesResponse>("/v1/console/queues") };
    return queuesCache.p;
  };
  const bust = () => {
    queuesCache = undefined;
  };
  let accountsCache: { at: number; p: Promise<AccountSummary[]> } | undefined;
  const accounts = (): Promise<AccountSummary[]> => {
    if (!accountsCache || Date.now() - accountsCache.at > 60_000) accountsCache = { at: Date.now(), p: get<{ accounts?: AccountSummary[] }>("/v1/accounts").then((r) => r.accounts ?? []) };
    return accountsCache.p;
  };
  const categoryName = (id: string | undefined) => (id ? CATEGORIES.find((c) => c.id === id)?.name : undefined);

  async function enrich(t: Transaction & { exceptionReason?: string; duplicateOfId?: string }): Promise<ConsoleTransactionRow> {
    const acct = (await accounts()).find((a) => a.id === t.accountId);
    const row: ConsoleTransactionRow = { ...t, accountName: acct?.displayName ?? t.accountId, accountMask: acct?.mask ?? "" };
    const cn = categoryName(t.categoryId);
    if (cn) row.categoryName = cn;
    if (t.duplicateOfId) row.duplicateOfId = t.duplicateOfId;
    if (t.state === "exception") {
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

  const api: ConsoleApi = {
    async me(): Promise<ConsoleMe> {
      const [conn, settings] = await Promise.all([get<ConnectionsResponse>("/v1/console/connections"), get<SettingsResponse>("/v1/console/settings")]);
      const m = member();
      return {
        member: { id: m.id, displayName: m.displayName, role: "member" },
        household: { id: "", name: "Household", timezone: config.timeZone, settingsVersion: settings.version ?? 1 },
        ledger: {
          tenantId: config.bc.tenant,
          environment: conn.ledger?.environment ?? config.bc.environment,
          companyId: conn.ledger?.companyId ?? "",
          journalTemplate: config.bc.journalTemplate,
          autoPostEnabled: conn.ledger?.autoPostEnabled ?? false,
        },
      };
    },

    async transactions(queue, q) {
      const r = await queues();
      const list = queue === "exception" ? (r.exceptions ?? []) : (r.transactions ?? []).filter((t) => t.state === queue);
      const rows = await Promise.all(list.map((t) => enrich(t)));
      return page(rows, q, r.dataThrough ?? nowThrough("imported_pending"));
    },

    // openapi.yaml has no bulk approve; /transactions/{id}/correct "approves with the new values", so approving is
    // a correct with the category the item already has.
    async approveTransactions(ids) {
      const r = await queues();
      const skipped: { id: string; reason: string }[] = [];
      let approved = 0;
      for (const id of ids) {
        const t = (r.transactions ?? []).find((x) => x.id === id);
        if (!t) {
          skipped.push({ id, reason: "not in the queue" });
          continue;
        }
        if (!t.categoryId) {
          skipped.push({ id, reason: "no category chosen" });
          continue;
        }
        try {
          await post(`/v1/transactions/${id}/correct`, { categoryId: t.categoryId, reason: "Console approval" });
          approved += 1;
        } catch (err) {
          skipped.push({ id, reason: err instanceof ApiError ? err.code : String(err) });
        }
      }
      bust();
      return { approved, skipped };
    },

    async correctTransaction(id, input) {
      const r = await post<{ transaction: Transaction; correctionRequestId?: string }>(`/v1/transactions/${id}/correct`, { categoryId: input.categoryId, reason: input.note });
      if (input.makeRule) {
        const t = r.transaction;
        const abs = Math.abs(t.amountCents);
        const pad = Math.max(500, Math.round(abs * 0.05));
        await post("/v1/rules", {
          kind: "merchant",
          name: `${t.merchantNorm} → ${categoryName(input.categoryId) ?? input.categoryId}`,
          match: { merchantNorm: t.merchantNorm, band: { minCents: Math.max(0, abs - pad), maxCents: abs + pad }, direction: t.amountCents < 0 ? "out" : "in" },
          action: { categoryId: input.categoryId },
          mayAutoPost: false,
        });
      }
      bust();
      return enrich(r.transaction);
    },

    async setBusinessFlag(id, flag: BusinessFlag) {
      const t = await post<Transaction>(`/v1/transactions/${id}/business`, { flag });
      bust();
      return enrich(t);
    },

    // Possible duplicates are answered through the question API; the question id is `tx:<transaction id>`.
    async resolveDuplicate(id, decision) {
      const r = await post<{ transaction?: Transaction }>(`/v1/questions/${encodeURIComponent(`tx:${id}`)}/answer`, { optionId: decision === "same_thing" ? "same_thing" : "not_repeat" });
      bust();
      if (r.transaction) return enrich(r.transaction);
      const t = (await queues()).transactions?.find((x) => x.id === id);
      if (!t) throw new ApiError(404, "not_found");
      return enrich(t);
    },

    async resolveException(id, resolution: ExceptionResolution) {
      const body = resolution.to === "posted" ? { to: "posted", entryNos: resolution.bcEntryNos, postingDate: resolution.bcPostingDate, note: resolution.note } : { to: "ready_for_review", note: resolution.note };
      const t = await post<Transaction>(`/v1/console/exceptions/${id}/resolve`, body, true);
      bust();
      return enrich(t);
    },

    async receipts(status, q) {
      const r = await queues();
      const all = (r.receipts ?? []).map<ConsoleReceiptRow>((x) => ({ ...x, memberName: "—" }));
      const items = all.filter((x) => (status === "unmatched" ? !x.matchedTransactionId && x.ocrStatus === "read" : x.ocrStatus === "needs_review" || x.ocrStatus === "failed"));
      return page(items, q, r.dataThrough ?? nowThrough("imported_pending"));
    },

    matchReceipt: () => notInApi("Matching a receipt from the Console (POST /v1/receipts/{id}/match)"),

    async rules(state, q) {
      const r = await get<{ rules?: RuleSummary[] }>(`/v1/rules${qs({ state })}`);
      return page(r.rules ?? [], q, nowThrough("posted_unreconciled"));
    },

    // openapi.yaml has approve and retire; "decline" of a proposal is a retire.
    async decideRule(id, decision, note) {
      if (decision === "approve") return post<RuleSummary>(`/v1/rules/${id}/approve`, { approvalNote: note }, true);
      return post<RuleSummary>(`/v1/rules/${id}/retire`, {}, true);
    },

    async syncStatus(): Promise<SyncStatus> {
      const [posting, conn] = await Promise.all([get<PostingResponse>("/v1/console/posting"), get<ConnectionsResponse>("/v1/console/connections")]);
      const batches = (["FEEDS", "RECEIPTS", "AUTOPOST"] as BcBatch[]).map((batch) => {
        const b = posting.batches?.find((x) => x.batch === batch);
        return {
          batch,
          appDraftCount: b?.draftCreated ?? 0,
          appDraftSumCents: 0,
          inFlightCount: (b?.approved ?? 0) + (b?.sentToBc ?? 0),
          differenceCount: b?.exceptions ?? 0,
        };
      });
      return {
        batches,
        lastWebhookAt: conn.ledger?.lastWebhookAt,
        lastPollAt: conn.ledger?.lastPollAt,
        outbox: { depth: posting.outboxDue ?? conn.outbox?.due ?? 0, deadLetters: conn.outbox?.deadLettered ?? 0 },
        subscriptions: toSubscriptions(conn.webhooks),
        autoPostEnabled: posting.autoPostEnabled ?? conn.ledger?.autoPostEnabled ?? false,
        dataThrough: nowThrough(conn.ledger?.lastPollAt ? "posted_unreconciled" : "missing"),
      };
    },

    async postBatch(batch: BcBatch) {
      const r = await post<{ batch: BcBatch; enqueued?: boolean; draftCount?: number; message?: string }>("/v1/console/posting/post-batch", { batch }, true);
      return { batch: r.batch ?? batch, outboxId: r.enqueued ? "enqueued" : "recorded", queuedAt: new Date().toISOString(), lineCount: r.draftCount ?? 0, enqueued: r.enqueued, message: r.message };
    },

    async reconciliation() {
      const r = await get<ReconResponse>("/v1/console/reconciliation");
      const bankCards: BankCardReconStatus[] = BANK_CARD_LIST.map((card) => {
        const a = r.accounts?.find((x) => x.bcBankAccountCode === card.code);
        return {
          code: card.code,
          name: card.name,
          glAccount: card.glAccount,
          institution: card.institution,
          mask: card.mask,
          openCount: Math.max(0, (a?.posted ?? 0) - (a?.reconciled ?? 0)),
          reconciledCount: a?.reconciled ?? 0,
          openSumCents: 0,
          differences: a?.differences ? [{ postedDate: (a.lastPollAt ?? new Date().toISOString()).slice(0, 10), amountCents: 0, note: `${a.differences} difference${a.differences === 1 ? "" : "s"} at the last poll (see Exceptions)` }] : [],
          feedStatus: a ? "ok" : "none",
        };
      });
      const latest = r.accounts?.map((a) => a.lastPollAt).filter(Boolean).sort().at(-1);
      // Loan rollforwards (the Frontier loans and PennyMac) are not in openapi.yaml yet.
      return { bankCards, loans: [], dataThrough: { at: latest ?? new Date().toISOString(), quality: latest ? "posted_unreconciled" : "missing", pendingCount: 0 } };
    },

    async mappings(): Promise<MappingSet> {
      const [m, approvals] = await Promise.all([get<MappingsResponse>("/v1/console/mappings"), get<{ approvals?: { id: string; kind: string; payload: Record<string, unknown>; requestedByName?: string; requestedBy: string; requestedAt: string }[] }>("/v1/approvals?state=open").catch(() => ({ approvals: [] }))]);
      const byCode = new Map((m.accounts ?? []).map((a) => [a.bcBankAccountCode, a]));
      return {
        catalogVersion: CATEGORY_CATALOG_VERSION,
        categories: (m.categories ?? []).map((c) => ({ id: c.id, name: c.name, group: c.group, glAccount: c.glAccount, dims: c.dims ?? {}, spendClass: c.dims?.["SPEND_CLASS"], isAllowance: c.isAllowance ?? false, isTransfer: c.isTransfer ?? false, householdVisible: c.householdVisible ?? true, version: 1 })),
        dimensions: Object.entries(m.dimensions ?? {}).map(([code, values], i) => ({ code, name: code.replace("_", " ").toLowerCase(), slot: (["global1", "global2", "shortcut3", "shortcut4", "shortcut5"] as const)[i] ?? "shortcut5", values: values.map((v) => ({ code: v, name: v })) })),
        bankCards: BANK_CARD_LIST.map((b) => {
          const a = byCode.get(b.code);
          return { code: b.code, glAccount: b.glAccount, name: b.name, kind: b.kind, institution: b.institution, mask: b.mask, accountId: a?.id, feedProvider: a?.feedStatus === "file_only" ? "file" : a && a.feedStatus !== "none" ? "plaid" : undefined };
        }),
        employers: [], // not in openapi.yaml yet
        pendingProposals: (approvals.approvals ?? []).filter((a) => a.kind === "settings" && a.payload["kind"] === "mapping").map((a) => ({ approvalId: a.id, categoryId: String(a.payload["categoryId"] ?? ""), requestedBy: a.requestedByName ?? a.requestedBy, requestedAt: a.requestedAt })),
        dataThrough: nowThrough("posted_unreconciled"),
      };
    },

    // A mapping change is a settings approval (kind `settings`, payload.kind `mapping`) decided by the other spouse.
    async proposeMapping(input: MappingProposal) {
      const r = await post<{ id: string }>("/v1/approvals", { kind: "settings", payload: { kind: "mapping", ...input } });
      return { approvalId: r.id };
    },

    async authority(): Promise<AuthorityMatrix> {
      const [matrix, settings, rules] = await Promise.all([get<MatrixResponse>("/v1/console/authority-matrix"), get<SettingsResponse>("/v1/console/settings"), get<{ rules?: RuleSummary[] }>("/v1/rules?state=all").catch(() => ({ rules: [] }))]);
      const values = { ...(settings.settings ?? {}) };
      delete values.authorityMatrix;
      return {
        version: matrix.version ?? settings.version ?? 1,
        rows: (matrix.rows ?? []).map((r) => ({ ...r, tbd: /TBD/.test(r.notes) || /TBD/.test(r.who), settingKeys: /I-\d\d/.test(r.notes) ? r.notes.match(/I-\d\d/g) ?? undefined : undefined })),
        settings: { version: settings.version ?? 1, effectiveFrom: new Date().toISOString(), values, history: [] },
        autoPostRules: (rules.rules ?? []).filter((r) => r.ruleNo).map((r) => ({ ruleNo: r.ruleNo!, name: r.name, state: r.state, mayAutoPost: r.mayAutoPost, testPassedAt: r.testPassedAt })),
        // Settings and rule states are posted records with nothing pending; the matrix is static until re-approved.
        dataThrough: nowThrough("posted_reconciled"),
      };
    },

    async connections() {
      const conn = await get<ConnectionsResponse>("/v1/console/connections");
      const feeds: FeedConnectionSummary[] = (conn.feeds ?? []).map((f) => ({
        id: f.id,
        provider: f.provider,
        institutionName: f.institutionName ?? f.id,
        ownerName: f.ownerMemberId ?? "—",
        status: f.status ?? "ok",
        needsRelink: f.needsRelink ?? f.status === "needs_relink",
        lastSyncedAt: f.lastSyncedAt,
        accountCount: 0,
        cursorPresent: f.provider === "plaid",
      }));
      return {
        feeds,
        subscriptions: toSubscriptions(conn.webhooks),
        ledger: { lastPollAt: conn.ledger?.lastPollAt, lastWebhookAt: conn.ledger?.lastWebhookAt, apiReachable: true, checkedAt: new Date().toISOString() },
        dataThrough: nowThrough("imported_pending"),
      };
    },

    async syncRuns(q) {
      const r = await get<{ runs?: SyncRunSummary[] }>(`/v1/console/sync${qs({ limit: 200 })}`);
      const items = (r.runs ?? []).filter((x) => (!q?.kind || x.kind === q.kind) && (!q?.status || x.status === q.status));
      return page(items, q, nowThrough("imported_pending"));
    },

    outbox: () => notInApi("Listing the outbox (GET /v1/console/outbox)"),
    retryOutbox: () => notInApi("Retrying a dead-lettered outbox row (POST /v1/console/outbox/{id}/retry)"),

    // The API pages by `before` cursor; the Console asks for page*pageSize and slices, which is fine at household scale.
    async audit(q) {
      const pageSize = q?.pageSize ?? 25;
      const pageNo = q?.page ?? 1;
      const r = await get<{ entries?: AuditEntry[]; next?: string }>(`/v1/console/audit${qs({ limit: Math.min(500, pageSize * pageNo), entity: q?.entity, entityId: q?.entityId })}`);
      const entries = r.entries ?? [];
      const items = entries.slice((pageNo - 1) * pageSize, pageNo * pageSize);
      return { items, total: entries.length + (r.next ? pageSize : 0), page: pageNo, pageSize, dataThrough: nowThrough("posted_unreconciled") };
    },

    async healthReport() {
      // Static file next to the app, written by the nightly acceptance job; not an API call.
      const res = await fetch(config.healthReportPath, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as HealthReport & { generatedAt: string | null };
      return json.generatedAt ? json : null;
    },
  };
  return api;
}

function toSubscriptions(webhooks: ConnectionsResponse["webhooks"]): BcSubscriptionSummary[] {
  const soon = Date.now() + 24 * 3_600_000;
  return (webhooks ?? []).map((w) => ({
    resource: w.resource,
    subscriptionId: "—",
    expiresAt: w.expiresAt ?? "",
    lastRenewedAt: w.lastRenewedAt,
    needsRenewal: !w.expiresAt || Date.parse(w.expiresAt) < soon,
  }));
}
