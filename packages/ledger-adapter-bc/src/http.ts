/**
 * Thin HTTP layer over fetch for Business Central: bearer token, JSON, @odata.nextLink paging, $batch, and the
 * error classification the retry policy depends on. No request or response body is ever logged here.
 */
import type { TokenProvider } from "./auth.js";
import { BcNonRetryableError, BcRetryableError, LedgerAdapterError, errorFromFetchFailure, isRetryableStatus, parseBcError } from "./errors.js";
import { buildJsonBatch, buildMultipartChangeset, parseJsonBatchResponse, parseMultipartBatchResponse, type BatchRequest, type BatchResponsePart } from "./odata.js";

export type BatchFormat = "multipart" | "json";

export interface BcHttpConfig {
  /** `https://api.businesscentral.dynamics.com/v2.0/{tenantId}/{environment}` (no trailing slash). */
  baseUrl: string;
  tokenProvider: TokenProvider;
  fetch?: typeof fetch;
  /** Per-request timeout; a timeout is retryable because every write reruns the pre-write check. */
  timeoutMs?: number;
  /** "json" (default): BC's documented transactional batch. "multipart" puts the requests in one change set, which BC refuses for more than one request. */
  batchFormat?: BatchFormat;
}

export interface BcResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export class BcHttp {
  readonly baseUrl: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  readonly batchFormat: BatchFormat;

  constructor(cfg: BcHttpConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.tokens = cfg.tokenProvider;
    this.fetchImpl = cfg.fetch ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    this.batchFormat = cfg.batchFormat ?? "json";
  }

  /** `${baseUrl}/api/v2.0`, `${baseUrl}/api/cadejonescpa/homestead/v1.0`, … */
  url(apiRoot: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const u = new URL(`${this.baseUrl}/${apiRoot.replace(/^\/+|\/+$/g, "")}/${path.replace(/^\/+/, "")}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async get<T>(url: string, extraHeaders?: Record<string, string>): Promise<BcResponse<T>> {
    return this.request<T>("GET", url, undefined, extraHeaders);
  }

  /** Follows @odata.nextLink until the collection is complete. */
  async getAll<T>(url: string, extraHeaders?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = url;
    let guard = 0;
    while (next && guard < 1000) {
      const res: BcResponse<{ value?: T[]; "@odata.nextLink"?: string }> = await this.get(next, extraHeaders);
      out.push(...(res.body.value ?? []));
      next = res.body["@odata.nextLink"];
      guard += 1;
    }
    return out;
  }

  async post<T>(url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<BcResponse<T>> {
    return this.request<T>("POST", url, body, extraHeaders);
  }

  async patch<T>(url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<BcResponse<T>> {
    return this.request<T>("PATCH", url, body, { "If-Match": "*", ...(extraHeaders ?? {}) });
  }

  async delete(url: string, extraHeaders?: Record<string, string>): Promise<BcResponse<unknown>> {
    return this.request<unknown>("DELETE", url, undefined, { "If-Match": "*", ...(extraHeaders ?? {}) });
  }

  /**
   * One change set, all or nothing. Returns the parsed inner responses in request order. A failed set throws the
   * classified error of the first failing part; a retryable transport failure throws BcRetryableError.
   */
  async batchChangeset(requests: readonly BatchRequest[], apiRoot = "api/v2.0"): Promise<BatchResponsePart[]> {
    // Each API route has its own $batch endpoint: api/v2.0/$batch, api/<publisher>/<group>/<version>/$batch. Inner
    // URLs are relative to that root, as in BC's own example ("companies(…)/journals(…)/journalLines"): BC does not
    // understand an absolute URL with the tenant in it (404 for the tenant segment, sandbox run 10/21/2026).
    const url = this.url(apiRoot, "$batch");
    const root = url.slice(0, url.length - "$batch".length);
    const relative = requests.map((r) => ({ ...r, url: r.url.startsWith(root) ? r.url.slice(root.length) : r.url }));
    const foreign = relative.find((r) => /^https?:\/\//i.test(r.url));
    if (foreign) throw new LedgerAdapterError(`A batch request must stay inside ${apiRoot}: ${foreign.url.split("?")[0]}`);
    const built = this.batchFormat === "json" ? buildJsonBatch(relative) : buildMultipartChangeset(relative);
    const res = await this.rawFetch("POST", url, built.body, {
      "Content-Type": built.contentType,
      Accept: "application/json",
      // Business Central: the batch runs in one transaction with this header (use-odata-batch doc).
      Isolation: "snapshot",
    });
    const text = await res.text();
    if (!res.ok) throw this.classify(res.status, res.headers, safeJson(text));
    const ct = res.headers.get("content-type") ?? "";
    const parts = /multipart\/mixed/i.test(ct) ? parseMultipartBatchResponse(ct, text) : parseJsonBatchResponse(safeJson(text));
    const failed = parts.find((p) => p.status >= 400 || p.status === 0);
    if (failed) throw this.classify(failed.status, new Headers(failed.headers), failed.body);
    // Order by Content-ID when the service returns ids; else keep wire order.
    const byId = new Map(parts.map((p) => [p.contentId, p] as const));
    const ordered = built.contentIds.map((id) => byId.get(id));
    return ordered.every((p): p is BatchResponsePart => p !== undefined) ? ordered : parts;
  }

  private async request<T>(method: string, url: string, body: unknown, extraHeaders?: Record<string, string>): Promise<BcResponse<T>> {
    const headers: Record<string, string> = { Accept: "application/json", ...(extraHeaders ?? {}) };
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    if (bodyText !== undefined) headers["Content-Type"] = "application/json";
    let res = await this.rawFetch(method, url, bodyText, headers);
    if (res.status === 401) {
      // One retry with a fresh token; a second 401 is a configuration problem, not a transient.
      this.tokens.invalidate();
      res = await this.rawFetch(method, url, bodyText, headers);
    }
    const text = await res.text();
    const parsed = safeJson(text);
    if (!res.ok) throw this.classify(res.status, res.headers, parsed);
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  private async rawFetch(method: string, url: string, body: string | undefined, headers: Record<string, string>): Promise<Response> {
    const token = await this.tokens.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("BC request timed out")), this.timeoutMs);
    try {
      const init: RequestInit = { method, headers: { ...headers, Authorization: `Bearer ${token}` }, signal: controller.signal };
      if (body !== undefined) init.body = body;
      return await this.fetchImpl(url, init);
    } catch (e) {
      throw errorFromFetchFailure(e);
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(status: number, headers: Headers, body: unknown): BcRetryableError | BcNonRetryableError {
    const bc = parseBcError(body);
    if (status === 0 || isRetryableStatus(status)) {
      const ra = headers.get("retry-after");
      const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
      return new BcRetryableError(status, bc, retryAfterMs);
    }
    return new BcNonRetryableError(status, bc);
  }
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
