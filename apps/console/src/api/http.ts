/**
 * HTTP implementation of ConsoleApi against services/api. Routes are under /v1; console-only routes under
 * /v1/console. The `getAuthHeaders` callback supplies either `Authorization: Bearer …` (Entra) or
 * `x-dev-member` (AUTH_MODE=dev on the API). Step-up for approvals sends `x-step-up: true` in dev; with Entra
 * the fresh token's `amr` claim carries it.
 */
import type { BcBatch, BusinessFlag, ExceptionResolution, HealthReport, MappingProposal } from "@homestead/shared";
import { config } from "../config";
import { ApiError, type ConsoleApi, type PageQuery } from "./types";

export type AuthHeaders = () => Promise<Record<string, string>>;

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

function pageParams(q: PageQuery | undefined): Record<string, number | undefined> {
  return { page: q?.page, pageSize: q?.pageSize };
}

export function createHttpApi(getAuthHeaders: AuthHeaders, baseUrl = config.apiBaseUrl): ConsoleApi {
  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", ...(await getAuthHeaders()), ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "omit" });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const code = typeof (json as { error?: string })?.error === "string" ? (json as { error: string }).error : `http_${res.status}`;
      throw new ApiError(res.status, code, (json as { message?: string })?.message);
    }
    return json as T;
  }
  const get = <T>(path: string) => call<T>("GET", path);
  const post = <T>(path: string, body?: unknown, stepUp = false) => call<T>("POST", path, body ?? {}, stepUp ? { "x-step-up": "true" } : {});

  return {
    me: () => get("/v1/me"),

    transactions: (queue, q) => get(`/v1/console/transactions${qs({ queue, ...pageParams(q) })}`),
    approveTransactions: (ids) => post("/v1/console/transactions/approve", { ids }),
    correctTransaction: (id, input) => post(`/v1/transactions/${id}/correct`, input),
    setBusinessFlag: (id, flag: BusinessFlag) => post(`/v1/transactions/${id}/business-flag`, { flag }),
    resolveDuplicate: (id, decision) => post(`/v1/transactions/${id}/duplicate`, { decision }),
    resolveException: (id, resolution: ExceptionResolution) => post(`/v1/console/exceptions/${id}/resolve`, resolution, true),
    receipts: (status, q) => get(`/v1/console/receipts${qs({ status, ...pageParams(q) })}`),
    matchReceipt: (receiptId, transactionId) => post(`/v1/receipts/${receiptId}/match`, { transactionId }),
    rules: (state, q) => get(`/v1/rules${qs({ state, ...pageParams(q) })}`),
    decideRule: (id, decision, note) => post(`/v1/rules/${id}/${decision}`, { note }, true),

    syncStatus: () => get("/v1/console/sync"),
    postBatch: (batch: BcBatch) => post("/v1/console/sync/post-batch", { batch }, true),

    reconciliation: () => get("/v1/console/reconciliation"),

    mappings: () => get("/v1/console/mappings"),
    proposeMapping: (input: MappingProposal) => post("/v1/console/mappings/proposals", input),

    authority: () => get("/v1/console/authority"),

    connections: () => get("/v1/console/connections"),
    syncRuns: (q) => get(`/v1/console/sync-runs${qs({ kind: q?.kind, status: q?.status, ...pageParams(q) })}`),
    outbox: (q) => get(`/v1/console/outbox${qs({ deadLettered: q?.deadLettered, ...pageParams(q) })}`),
    retryOutbox: (id) => post(`/v1/console/outbox/${id}/retry`),
    audit: (q) => get(`/v1/console/audit${qs({ entity: q?.entity, entityId: q?.entityId, actor: q?.actor, ...pageParams(q) })}`),

    healthReport: async () => {
      // Static file next to the app, written by the nightly acceptance job; not an API call.
      const res = await fetch(config.healthReportPath, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as HealthReport & { generatedAt: string | null };
      return json.generatedAt ? json : null;
    },
  };
}
