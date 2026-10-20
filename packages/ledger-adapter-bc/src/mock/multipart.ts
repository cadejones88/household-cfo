/**
 * Request-side $batch parsing for the mock (the client builds the body in ../odata.ts). Handles the OData 4
 * multipart/mixed layout with one or more change sets and the JSON batch layout BC documents.
 */
import { randomUUID } from "node:crypto";

export interface InnerRequest {
  contentId: string | undefined;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Requests in the same change set / atomicity group succeed or fail together. */
  group: string | undefined;
}

export interface InnerResponse {
  contentId: string | undefined;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function boundaryOf(contentType: string): string | undefined {
  return /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
}

function splitParts(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const delimiter = `--${boundary}`;
  let idx = body.indexOf(delimiter);
  while (idx !== -1) {
    const lineEnd = body.indexOf("\n", idx);
    const marker = body.slice(idx, lineEnd === -1 ? body.length : lineEnd).trim();
    if (marker === `${delimiter}--`) break;
    const start = lineEnd + 1;
    const next = body.indexOf(delimiter, start);
    parts.push(body.slice(start, next === -1 ? body.length : next).replace(/\r?\n$/, ""));
    idx = next;
  }
  return parts;
}

function headersOf(block: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return h;
}

function parseHttpRequestPart(part: string, group: string | undefined): InnerRequest {
  const mimeEnd = part.search(/\r?\n\r?\n/);
  const mime = headersOf(mimeEnd === -1 ? part : part.slice(0, mimeEnd));
  const rest = mimeEnd === -1 ? "" : part.slice(mimeEnd).replace(/^\r?\n\r?\n/, "");
  const requestLine = rest.split(/\r?\n/, 1)[0] ?? "";
  const m = /^([A-Z]+)\s+(\S+)\s+HTTP\/\d\.\d/.exec(requestLine);
  if (!m) throw new Error(`Bad inner request line: ${requestLine}`);
  const after = rest.slice(requestLine.length).replace(/^\r?\n/, "");
  const headerEnd = after.search(/\r?\n\r?\n/);
  const headers = headersOf(headerEnd === -1 ? after : after.slice(0, headerEnd));
  const raw = headerEnd === -1 ? "" : after.slice(headerEnd).replace(/^\r?\n\r?\n/, "").trim();
  let body: unknown = undefined;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return { contentId: mime["content-id"], method: m[1] ?? "GET", url: m[2] ?? "", headers, body, group };
}

export function parseMultipartBatch(contentType: string, body: string): InnerRequest[] {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error("Missing multipart boundary");
  const out: InnerRequest[] = [];
  for (const part of splitParts(body, boundary)) {
    const headerEnd = part.search(/\r?\n\r?\n/);
    const h = headersOf(headerEnd === -1 ? part : part.slice(0, headerEnd));
    const ct = h["content-type"] ?? "";
    if (/multipart\/mixed/i.test(ct)) {
      const inner = boundaryOf(ct);
      if (!inner) throw new Error("Missing change-set boundary");
      const group = `changeset_${randomUUID()}`;
      for (const p of splitParts(part.slice(headerEnd), inner)) out.push(parseHttpRequestPart(p, group));
    } else {
      out.push(parseHttpRequestPart(part, undefined));
    }
  }
  return out;
}

export function parseJsonBatch(body: unknown): InnerRequest[] {
  const reqs = (body as { requests?: unknown[] } | undefined)?.requests;
  if (!Array.isArray(reqs)) throw new Error("JSON batch has no requests");
  return reqs.map((r) => {
    const o = r as { id?: string; atomicityGroup?: string; method?: string; url?: string; headers?: Record<string, string>; body?: unknown };
    return {
      contentId: o.id,
      method: o.method ?? "GET",
      url: o.url ?? "",
      headers: Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: o.body,
      group: o.atomicityGroup,
    };
  });
}

/** A multipart/mixed response with every inner response inside one change-set part. */
export function buildMultipartBatchResponse(responses: readonly InnerResponse[]): { contentType: string; body: string } {
  const batchBoundary = `batchresponse_${randomUUID()}`;
  const changesetBoundary = `changesetresponse_${randomUUID()}`;
  const CRLF = "\r\n";
  const inner = responses.map((r) => {
    const bodyText = r.body === undefined ? "" : JSON.stringify(r.body);
    const headers: Record<string, string> = { ...r.headers };
    if (bodyText) headers["Content-Type"] = "application/json; odata.metadata=minimal";
    return [
      `--${changesetBoundary}`,
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      ...(r.contentId ? [`Content-ID: ${r.contentId}`] : []),
      "",
      `HTTP/1.1 ${r.status} ${reason(r.status)}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      "",
      bodyText,
    ].join(CRLF);
  });
  const body = [`--${batchBoundary}`, `Content-Type: multipart/mixed; boundary=${changesetBoundary}`, "", ...inner, `--${changesetBoundary}--`, `--${batchBoundary}--`, ""].join(CRLF);
  return { contentType: `multipart/mixed; boundary=${batchBoundary}`, body };
}

export function buildJsonBatchResponse(responses: readonly InnerResponse[]): { contentType: string; body: string } {
  return {
    contentType: "application/json",
    body: JSON.stringify({
      responses: responses.map((r) => ({ id: r.contentId ?? null, status: r.status, headers: r.headers, ...(r.body === undefined ? {} : { body: r.body }) })),
    }),
  };
}

function reason(status: number): string {
  return { 200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict", 428: "Precondition Required", 500: "Internal Server Error", 503: "Service Unavailable" }[status] ?? "";
}
