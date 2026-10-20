/**
 * OData helpers: literal quoting and the $batch multipart/mixed format built by hand.
 *
 * Format per OData 4.0 part 1 section 11.7 (Batch Requests): the batch body is multipart/mixed; a change set is a
 * nested multipart/mixed part whose children are application/http parts, each with Content-Transfer-Encoding: binary
 * and a Content-ID. A change set is atomic: if any request in it fails, the whole set is rolled back and the
 * service returns one error response for the set (or an error part for the failing request).
 * Business Central documents the $batch endpoint at
 * https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/use-odata-batch, which shows
 * the JSON batch body and the `Isolation: snapshot` header that makes the batch one transaction; the multipart form
 * is the OData standard the same endpoint accepts. Both are built here; multipart is the default.
 * VERIFY on the sandbox: (1) inner request URLs are sent absolute (`https://…/api/v2.0/companies(...)/…`), which the
 * OData spec always allows; (2) BC honors the change-set atomicity with the Isolation header present.
 */
import { randomUUID } from "node:crypto";

export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function odataDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`Expected YYYY-MM-DD, got ${isoDate}`);
  return isoDate;
}

export interface BatchRequest {
  method: "POST" | "PATCH" | "DELETE" | "GET";
  /** Absolute URL of the inner request. */
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface BatchResponsePart {
  contentId: string | undefined;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

export interface BuiltBatch {
  contentType: string;
  body: string;
  contentIds: string[];
}

const CRLF = "\r\n";

/** One change set holding every request, so the whole set lands or nothing does. */
export function buildMultipartChangeset(requests: readonly BatchRequest[]): BuiltBatch {
  const batchBoundary = `batch_${randomUUID()}`;
  const changesetBoundary = `changeset_${randomUUID()}`;
  const contentIds: string[] = [];
  const parts: string[] = [];
  requests.forEach((r, i) => {
    const contentId = String(i + 1);
    contentIds.push(contentId);
    const headers: Record<string, string> = { Accept: "application/json", ...(r.headers ?? {}) };
    const bodyText = r.body === undefined ? "" : JSON.stringify(r.body);
    if (bodyText) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join(CRLF);
    parts.push(
      [
        `--${changesetBoundary}`,
        "Content-Type: application/http",
        "Content-Transfer-Encoding: binary",
        `Content-ID: ${contentId}`,
        "",
        `${r.method} ${r.url} HTTP/1.1`,
        headerLines,
        "",
        bodyText,
      ].join(CRLF),
    );
  });
  const body = [
    `--${batchBoundary}`,
    `Content-Type: multipart/mixed; boundary=${changesetBoundary}`,
    "",
    ...parts,
    `--${changesetBoundary}--`,
    `--${batchBoundary}--`,
    "",
  ].join(CRLF);
  return { contentType: `multipart/mixed; boundary=${batchBoundary}`, body, contentIds };
}

/** The JSON batch body BC's own documentation shows; every request shares one atomicity group. */
export function buildJsonBatch(requests: readonly BatchRequest[]): BuiltBatch {
  const contentIds = requests.map((_, i) => String(i + 1));
  const body = {
    requests: requests.map((r, i) => ({
      id: contentIds[i],
      atomicityGroup: "homestead",
      method: r.method,
      url: r.url,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(r.headers ?? {}) },
      ...(r.body === undefined ? {} : { body: r.body }),
    })),
  };
  return { contentType: "application/json", body: JSON.stringify(body), contentIds };
}

function boundaryOf(contentType: string): string | undefined {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return m?.[2];
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
    const end = next === -1 ? body.length : next;
    parts.push(body.slice(start, end).replace(/\r?\n$/, ""));
    idx = next;
  }
  return parts;
}

function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return headers;
}

function parseHttpPart(part: string): BatchResponsePart {
  // Part = MIME headers, blank line, then "HTTP/1.1 <status> <reason>", response headers, blank line, body.
  const mimeEnd = part.search(/\r?\n\r?\n/);
  const mimeHeaders = parseHeaderBlock(mimeEnd === -1 ? part : part.slice(0, mimeEnd));
  const rest = mimeEnd === -1 ? "" : part.slice(mimeEnd).replace(/^\r?\n\r?\n/, "");
  const statusLine = rest.split(/\r?\n/, 1)[0] ?? "";
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  const afterStatus = rest.slice(statusLine.length).replace(/^\r?\n/, "");
  const headerEnd = afterStatus.search(/\r?\n\r?\n/);
  const headers = parseHeaderBlock(headerEnd === -1 ? afterStatus : afterStatus.slice(0, headerEnd));
  const rawBody = headerEnd === -1 ? "" : afterStatus.slice(headerEnd).replace(/^\r?\n\r?\n/, "").trim();
  let body: unknown = undefined;
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }
  }
  return {
    contentId: mimeHeaders["content-id"] ?? headers["content-id"],
    status: statusMatch ? Number(statusMatch[1]) : 0,
    headers,
    body,
    rawBody,
  };
}

/** Parses a multipart/mixed batch response, flattening nested change-set responses. */
export function parseMultipartBatchResponse(contentType: string, body: string): BatchResponsePart[] {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new Error("Batch response has no multipart boundary");
  const out: BatchResponsePart[] = [];
  for (const part of splitParts(body, boundary)) {
    const headerEnd = part.search(/\r?\n\r?\n/);
    const partHeaders = parseHeaderBlock(headerEnd === -1 ? part : part.slice(0, headerEnd));
    const ct = partHeaders["content-type"] ?? "";
    if (/multipart\/mixed/i.test(ct)) {
      const inner = boundaryOf(ct);
      if (!inner) throw new Error("Change-set response has no boundary");
      for (const innerPart of splitParts(part.slice(headerEnd), inner)) out.push(parseHttpPart(innerPart));
    } else {
      out.push(parseHttpPart(part));
    }
  }
  return out;
}

export function parseJsonBatchResponse(body: unknown): BatchResponsePart[] {
  const responses = (body as { responses?: unknown[] } | undefined)?.responses;
  if (!Array.isArray(responses)) throw new Error("JSON batch response has no responses array");
  return responses.map((r) => {
    const o = r as { id?: unknown; status?: unknown; headers?: Record<string, string>; body?: unknown };
    return {
      contentId: typeof o.id === "string" ? o.id : undefined,
      status: typeof o.status === "number" ? o.status : 0,
      headers: Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: o.body,
      rawBody: o.body === undefined ? "" : JSON.stringify(o.body),
    };
  });
}
