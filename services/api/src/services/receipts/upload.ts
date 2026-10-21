/**
 * Receipt upload (spec: "Receipts", step 2): the app sends the image with its SHA-256; the API recomputes it,
 * refuses a mismatch, returns the existing receipt for a hash it already holds for the household (the same
 * photo twice, an offline replay), and stores the blob in the household's container under its key. The
 * database holds the blob reference, never the bytes.
 */
import { sha256Hex, type ReceiptSummary } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { badRequest, notFound } from "../../lib/errors.js";
import type { BlobStore } from "../ports.js";

export interface ReceiptRow {
  id: string;
  member_id: string;
  blob_ref: string;
  sha256: string;
  captured_at: string;
  uploaded_at: string;
  ocr_status: ReceiptSummary["ocrStatus"];
  ocr_result: Record<string, unknown> | null;
  merchant: string | null;
  merchant_norm: string | null;
  total_cents: number | null;
  tax_cents: number | null;
  tip_cents: number | null;
  receipt_date: string | null;
  matched_transaction_id: string | null;
  match_confidence: number | null;
  kind: "receipt" | "pay_stub" | "statement";
  offline_id: string | null;
  created_at: string;
}

export const RECEIPT_COLS = `id, member_id, blob_ref, sha256, captured_at, uploaded_at, ocr_status, ocr_result, merchant, merchant_norm, total_cents::bigint::int as total_cents,
  tax_cents::bigint::int as tax_cents, tip_cents::bigint::int as tip_cents, to_char(receipt_date,'YYYY-MM-DD') as receipt_date, matched_transaction_id,
  match_confidence::float as match_confidence, kind, offline_id, created_at`;

export async function loadReceipt(db: Queryable, id: string): Promise<ReceiptRow> {
  const r = await db.query<ReceiptRow>(`select ${RECEIPT_COLS} from receipts where id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound("receipt");
  return row;
}

export async function listReceipts(db: Queryable, householdId: string, opts: { limit?: number; memberId?: string; ocrStatus?: ReceiptSummary["ocrStatus"]; unmatchedOnly?: boolean; kind?: ReceiptRow["kind"] } = {}): Promise<ReceiptRow[]> {
  const where = ["household_id = $1"];
  const params: unknown[] = [householdId];
  if (opts.memberId) {
    params.push(opts.memberId);
    where.push(`member_id = $${params.length}`);
  }
  if (opts.ocrStatus) {
    params.push(opts.ocrStatus);
    where.push(`ocr_status = $${params.length}`);
  }
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.unmatchedOnly) where.push("matched_transaction_id is null");
  params.push(Math.min(opts.limit ?? 50, 200));
  const r = await db.query<ReceiptRow>(`select ${RECEIPT_COLS} from receipts where ${where.join(" and ")} order by uploaded_at desc limit $${params.length}`, params);
  return r.rows;
}

export function toReceiptSummary(r: ReceiptRow): ReceiptSummary {
  const dto: ReceiptSummary = {
    id: r.id,
    capturedAt: new Date(r.captured_at).toISOString(),
    uploadedAt: new Date(r.uploaded_at).toISOString(),
    sha256: r.sha256,
    ocrStatus: r.ocr_status,
    kind: r.kind,
    syncState: "synced",
  };
  if (r.offline_id) dto.offlineId = r.offline_id;
  if (r.merchant) dto.merchant = r.merchant;
  if (r.total_cents !== null) dto.totalCents = r.total_cents;
  if (r.tax_cents !== null) dto.taxCents = r.tax_cents;
  if (r.receipt_date) dto.receiptDate = r.receipt_date;
  if (r.matched_transaction_id) dto.matchedTransactionId = r.matched_transaction_id;
  if (r.match_confidence !== null) dto.matchConfidence = Number(r.match_confidence);
  return dto;
}

export interface UploadInput {
  bytes: Uint8Array;
  contentType: string;
  /** The hex digest the device computed. */
  sha256: string;
  capturedAt: string;
  offlineId?: string;
  kind?: ReceiptRow["kind"];
}

export interface UploadResult {
  receipt: ReceiptRow;
  created: boolean;
}

const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/webp", "application/pdf"]);
export const MAX_RECEIPT_BYTES = 15 * 1024 * 1024;

export async function uploadReceipt(db: Queryable, householdId: string, memberId: string, input: UploadInput, blobs: BlobStore): Promise<UploadResult> {
  if (input.bytes.length === 0) throw badRequest("empty", "The file is empty");
  if (input.bytes.length > MAX_RECEIPT_BYTES) throw badRequest("too_large", "The file is larger than 15 MB");
  if (!ALLOWED_TYPES.has(input.contentType)) throw badRequest("content_type", "Send a JPEG, PNG, HEIC, WebP or PDF");
  const digest = sha256Hex(input.bytes);
  if (digest !== input.sha256.toLowerCase()) throw badRequest("sha256_mismatch", "The file does not match the hash the device sent");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(input.capturedAt) || Number.isNaN(Date.parse(input.capturedAt))) throw badRequest("captured_at", "capturedAt must be an ISO timestamp");
  const existing = await db.query<ReceiptRow>(`select ${RECEIPT_COLS} from receipts where household_id = $1 and sha256 = $2`, [householdId, digest]);
  if (existing.rows[0]) {
    if (input.offlineId && !existing.rows[0].offline_id) await db.query("update receipts set offline_id = $2 where id = $1", [existing.rows[0].id, input.offlineId]);
    return { receipt: existing.rows[0], created: false };
  }
  const kind = input.kind ?? (input.contentType === "application/pdf" ? "pay_stub" : "receipt");
  const blobRef = `${householdId}/${kind === "receipt" ? "receipts" : kind === "pay_stub" ? "stubs" : "statements"}/${digest}`;
  await blobs.put(blobRef, input.bytes, input.contentType);
  const r = await db.query<ReceiptRow>(
    `insert into receipts (household_id, member_id, blob_ref, sha256, captured_at, kind, offline_id) values ($1,$2,$3,$4,$5,$6,$7) returning ${RECEIPT_COLS}`,
    [householdId, memberId, blobRef, digest, input.capturedAt, kind, input.offlineId ?? null],
  );
  const row = r.rows[0]!;
  await audit(db, householdId, { actor: memberId, action: "receipt.uploaded", entity: "receipt", entityId: row.id, after: { kind, sha256: digest.slice(0, 12) } });
  return { receipt: row, created: true };
}
