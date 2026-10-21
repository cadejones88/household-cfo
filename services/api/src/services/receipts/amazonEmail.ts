/**
 * Amazon order-confirmation intake (spec: "Receipts", Amazon paragraph): an order email forwarded to the
 * household's receipts address is parsed for the order number, date, items and total; each order becomes a
 * receipt (keyed by the SHA-256 of the email text) with lines, mapped and matched like a photographed receipt
 * against the per-shipment Amazon charges. The monthly "Request your data" export is the catch-up.
 *
 * The parser is fixture-based: it recognises the plain-text shapes in test/fixtures/amazon/*.txt
 * (order number line, "Order Total:", item lines "<description> $<price>" with an optional "Qty: n").
 */
import { normalizeDescription, parseCents, sha256Hex } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { loadCategories } from "../categories.js";
import type { ClaudeMapperPort } from "./claudeMapper.js";
import type { ReceiptRead } from "./documentIntelligence.js";
import { mapLines, matchReceiptToTransaction } from "./pipeline.js";
import { RECEIPT_COLS, type ReceiptRow } from "./upload.js";

export interface AmazonOrder {
  orderId: string;
  orderDate?: string;
  totalCents: number;
  items: { description: string; amountCents: number; qty?: number }[];
}

const ORDER_RE = /order\s*(?:#|number|no\.?)?\s*[:#]?\s*(\d{3}-\d{7}-\d{7})/gi;
// "Order Total" / "Grand Total" first; a bare "Total" only when it is not "Item Subtotal" (which comes first in the email).
const ORDER_TOTAL_RE = /(?:order|grand)\s+total\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})/i;
const TOTAL_RE = /(?<![a-z])total\s*[:：]?\s*\$?\s*([\d,]+\.\d{2})/i;
const DATE_RE = /(?:order\s+placed|placed\s+on|order\s+date)\s*[:：]?\s*([A-Za-z]+ \d{1,2}, \d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i;
const ITEM_RE = /^(?!.*\b(?:total|subtotal|shipping|tax|estimated|promotion|gift card)\b)(.{3,120}?)\s+(?:x\s*(\d+)\s+)?\$\s*([\d,]+\.\d{2})\s*$/i;
const QTY_RE = /qty[:\s]*(\d+)/i;

export function parseAmazonEmail(text: string): AmazonOrder[] {
  const chunks = splitByOrder(text);
  const out: AmazonOrder[] = [];
  for (const { orderId, body } of chunks) {
    const total = ORDER_TOTAL_RE.exec(body)?.[1] ?? TOTAL_RE.exec(body)?.[1];
    if (!total) continue;
    const order: AmazonOrder = { orderId, totalCents: parseCents(total), items: [] };
    const date = DATE_RE.exec(body)?.[1];
    if (date) order.orderDate = normalizeDate(date);
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const m = ITEM_RE.exec(lines[i]!);
      if (!m) continue;
      const item: AmazonOrder["items"][number] = { description: m[1]!.trim(), amountCents: parseCents(m[3]!) };
      const qty = m[2] ? Number(m[2]) : QTY_RE.exec(lines[i + 1] ?? "")?.[1] ? Number(QTY_RE.exec(lines[i + 1] ?? "")![1]) : undefined;
      if (qty && qty > 1) item.qty = qty;
      order.items.push(item);
    }
    if (order.items.length > 0) out.push(order);
  }
  return out;
}

function splitByOrder(text: string): { orderId: string; body: string }[] {
  const matches = [...text.matchAll(ORDER_RE)];
  if (matches.length === 0) return [];
  const seen = new Set<string>();
  const out: { orderId: string; body: string }[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const id = matches[i]![1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const start = matches[i]!.index ?? 0;
    const next = matches.slice(i + 1).find((m) => m[1] !== id);
    out.push({ orderId: id, body: text.slice(start, next?.index ?? text.length) });
  }
  return out;
}

function normalizeDate(s: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 10);
}

export interface AmazonIntakeResult {
  orderId: string;
  orderDate?: string;
  totalCents: number;
  items: AmazonOrder["items"];
  receiptId: string;
  matchedTransactionId?: string;
  created: boolean;
}

export async function intakeAmazonEmail(db: Queryable, householdId: string, memberId: string, text: string, mapper: ClaudeMapperPort, receivedAt: string, actor = "amazon-intake"): Promise<AmazonIntakeResult[]> {
  const orders = parseAmazonEmail(text);
  const out: AmazonIntakeResult[] = [];
  const cats = await loadCategories(db, householdId);
  for (const o of orders) {
    const digest = sha256Hex(`amazon:${o.orderId}:${o.totalCents}`);
    const existing = await db.query<ReceiptRow>(`select ${RECEIPT_COLS} from receipts where household_id = $1 and sha256 = $2`, [householdId, digest]);
    let rec = existing.rows[0];
    let created = false;
    if (!rec) {
      const read: ReceiptRead = { merchant: "Amazon", totalCents: o.totalCents, taxCents: 0, items: o.items.map((i) => ({ description: i.description, amountCents: i.amountCents, confidence: 0.95, ...(i.qty ? { qty: i.qty } : {}) })), fieldConfidence: { Total: 0.99 } };
      if (o.orderDate) read.date = o.orderDate;
      const itemsSum = o.items.reduce((s, i) => s + i.amountCents, 0);
      read.taxCents = Math.max(0, o.totalCents - itemsSum);
      const mapped = await mapLines(read, cats, mapper);
      const ins = await db.query<ReceiptRow>(
        `insert into receipts (household_id, member_id, blob_ref, sha256, captured_at, ocr_status, ocr_result, merchant, merchant_norm, total_cents, tax_cents, receipt_date, kind)
         values ($1,$2,$3,$4,$5,'read',$6,'Amazon',$7,$8,$9,$10,'receipt') returning ${RECEIPT_COLS}`,
        [householdId, memberId, `${householdId}/amazon/${o.orderId}`, digest, receivedAt, JSON.stringify({ ...read, source: "amazon_email", orderId: o.orderId }), normalizeDescription("Amazon"), o.totalCents, read.taxCents, o.orderDate ?? receivedAt.slice(0, 10)],
      );
      rec = ins.rows[0]!;
      created = true;
      for (const m of mapped) {
        await db.query("insert into receipt_lines (household_id, receipt_id, line_no, description, qty, amount_cents, suggested_category_id, suggested_confidence) values ($1,$2,$3,$4,$5,$6,$7,$8)", [householdId, rec.id, m.lineNo, m.description.slice(0, 200), m.qty ?? null, m.amountCents, m.categoryId, m.confidence]);
      }
      await audit(db, householdId, { actor, action: "receipt.amazon_email", entity: "receipt", entityId: rec.id, after: { orderId: o.orderId, items: o.items.length } });
    }
    const m = await matchReceiptToTransaction(db, householdId, rec.id, actor);
    const res: AmazonIntakeResult = { orderId: o.orderId, totalCents: o.totalCents, items: o.items, receiptId: rec.id, created };
    if (o.orderDate) res.orderDate = o.orderDate;
    if (m.transactionId) res.matchedTransactionId = m.transactionId;
    out.push(res);
  }
  return out;
}
