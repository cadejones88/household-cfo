/**
 * The receipt pipeline after upload (spec: "Receipts", steps 3–8):
 *   read (Document Intelligence prebuilt-receipt) -> map lines (Claude on Foundry: descriptions, amounts, the
 *   merchant and the category list only) -> split with tax prorated to the cent -> match a bank line on the same
 *   account within -3..+5 days -> the matched line's splits are written and it moves on through the state machine.
 * Two plausible candidates go to a person (Console receipt queue). A Walmart, club or Amazon line still without a
 * receipt after 10 days posts to its unallocated account with "estimated split".
 */
import { RECEIPT_REQUIRED_MERCHANTS, daysBetween, matchReceipt, normalizeDescription, splitReceipt, SplitDoesNotTieError, type MatchCandidate, type TransactionSplit } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { addDays } from "../../lib/dates.js";
import { loadCategories, type CategoryMap } from "../categories.js";
import { classifyOne } from "../classify.js";
import { getSettings, ledgerConnection } from "../households.js";
import type { BlobStore } from "../ports.js";
import { listRules } from "../rules.js";
import { loadSplits, loadTx, patchTx, setSplits, splitDto, transition, type SplitInput, type TxRow } from "../transactions.js";
import type { ClaudeMapperPort } from "./claudeMapper.js";
import type { DocumentIntelligencePort, ReceiptRead } from "./documentIntelligence.js";
import { loadReceipt, type ReceiptRow } from "./upload.js";

export interface ReceiptPorts {
  blobs: BlobStore;
  docIntel: DocumentIntelligencePort;
  mapper: ClaudeMapperPort;
}

export interface ReceiptLineRow {
  id: string;
  line_no: number;
  description: string;
  qty: number | null;
  amount_cents: number;
  suggested_category_id: string | null;
  suggested_confidence: number | null;
}

export async function loadReceiptLines(db: Queryable, receiptId: string): Promise<ReceiptLineRow[]> {
  const r = await db.query<ReceiptLineRow>("select id, line_no, description, qty::float as qty, amount_cents::bigint::int as amount_cents, suggested_category_id, suggested_confidence::float as suggested_confidence from receipt_lines where receipt_id = $1 order by line_no", [receiptId]);
  return r.rows;
}

export type ReadOutcome = "read" | "failed" | "needs_review";

/** Step 3 and 4: read the image and map its lines. Idempotent: a receipt already read is not read again. */
export async function readReceipt(db: Queryable, householdId: string, receiptId: string, ports: ReceiptPorts, actor = "ocr"): Promise<{ outcome: ReadOutcome; read?: ReceiptRead }> {
  const rec = await loadReceipt(db, receiptId);
  if (rec.kind !== "receipt") return { outcome: rec.ocr_status === "read" ? "read" : "needs_review" };
  if (rec.ocr_status === "read" && rec.ocr_result) return { outcome: "read", read: rec.ocr_result as unknown as ReceiptRead };
  const blob = await ports.blobs.get(rec.blob_ref);
  if (!blob) {
    await db.query("update receipts set ocr_status = 'failed' where id = $1", [receiptId]);
    return { outcome: "failed" };
  }
  let read: ReceiptRead;
  try {
    read = await ports.docIntel.analyzeReceipt(blob.bytes, blob.contentType);
  } catch (e) {
    await db.query("update receipts set ocr_status = 'failed' where id = $1", [receiptId]);
    await audit(db, householdId, { actor, action: "receipt.read_failed", entity: "receipt", entityId: receiptId, after: { error: (e as Error).name } });
    return { outcome: "failed" };
  }
  const cats = await loadCategories(db, householdId);
  const mapped = await mapLines(read, cats, ports.mapper);
  await db.query("delete from receipt_lines where receipt_id = $1", [receiptId]);
  for (const m of mapped) {
    await db.query("insert into receipt_lines (household_id, receipt_id, line_no, description, qty, amount_cents, suggested_category_id, suggested_confidence) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
      householdId,
      receiptId,
      m.lineNo,
      m.description.slice(0, 200),
      m.qty ?? null,
      m.amountCents,
      m.categoryId,
      m.confidence,
    ]);
  }
  const total = read.totalCents ?? (read.items.reduce((s, i) => s + i.amountCents, 0) + (read.taxCents ?? 0));
  const status: ReadOutcome = read.items.length === 0 || total <= 0 ? "needs_review" : "read";
  await db.query("update receipts set ocr_status = $2, ocr_result = $3, merchant = $4, merchant_norm = $5, total_cents = $6, tax_cents = $7, tip_cents = $8, receipt_date = $9 where id = $1", [
    receiptId,
    status,
    JSON.stringify(read),
    read.merchant?.slice(0, 200) ?? null,
    read.merchant ? normalizeDescription(read.merchant) : null,
    total,
    read.taxCents ?? 0,
    read.tipCents ?? null,
    read.date ?? null,
  ]);
  await audit(db, householdId, { actor, action: "receipt.read", entity: "receipt", entityId: receiptId, after: { status, lines: mapped.length } });
  return { outcome: status, read };
}

export interface MappedReceiptLine {
  lineNo: number;
  description: string;
  qty?: number;
  amountCents: number;
  categoryId: string;
  confidence: number;
}

/** The model sees only descriptions, amounts, the merchant and the category list with examples. */
export async function mapLines(read: ReceiptRead, cats: CategoryMap, mapper: ClaudeMapperPort): Promise<MappedReceiptLine[]> {
  const lines = read.items.map((it, i) => ({ lineNo: i + 1, description: it.description, amountCents: it.amountCents }));
  if (lines.length === 0) return [];
  const categories = [...cats.values()].filter((c) => c.household_visible && !c.is_transfer && c.group !== "Income").map((c) => ({ id: c.id, name: c.name, examples: c.examples }));
  const mapped = await mapper.mapLines({ merchant: read.merchant ?? "", lines, categories });
  const byLine = new Map(mapped.map((m) => [m.lineNo, m]));
  return lines.map((l, i) => {
    const m = byLine.get(l.lineNo);
    const item = read.items[i]!;
    const out: MappedReceiptLine = { lineNo: l.lineNo, description: l.description, amountCents: l.amountCents, categoryId: m && cats.has(m.categoryId) ? m.categoryId : "general-merchandise", confidence: m ? Math.min(m.confidence, item.confidence + 0.1) : 0.3 };
    if (item.qty !== undefined) out.qty = item.qty;
    return out;
  });
}

export interface ProposedSplit {
  lines: (TransactionSplit & { description: string })[];
  needsConfirmation: boolean;
  ties: boolean;
}

/** Step 5: the split the receipt proposes (tax prorated, same-category lines merged), or ties=false. */
export async function proposeSplit(db: Queryable, householdId: string, rec: ReceiptRow, cats?: CategoryMap): Promise<ProposedSplit | undefined> {
  const lines = await loadReceiptLines(db, rec.id);
  if (lines.length === 0 || rec.total_cents === null) return undefined;
  const categories = cats ?? (await loadCategories(db, householdId));
  const receiptRequired = RECEIPT_REQUIRED_MERCHANTS.some((m) => m.pattern.test(rec.merchant ?? ""));
  try {
    const r = splitReceipt({
      totalCents: rec.total_cents,
      taxCents: (rec.tax_cents ?? 0) + (rec.tip_cents ?? 0),
      lines: lines.map((l) => ({ description: l.description, amountCents: l.amount_cents, categoryId: l.suggested_category_id ?? "general-merchandise", confidence: Number(l.suggested_confidence ?? 0.3) })),
      receiptRequiredMerchant: receiptRequired,
    });
    return {
      lines: r.lines.map((l) => {
        const c = categories.get(l.categoryId);
        return { lineNo: l.lineNo, amountCents: -l.amountCents, categoryId: l.categoryId, glAccount: c?.gl_account ?? "", dims: c?.dimension_defaults ?? {}, description: l.description };
      }),
      needsConfirmation: r.needsConfirmation,
      ties: true,
    };
  } catch (e) {
    if (e instanceof SplitDoesNotTieError) return { lines: [], needsConfirmation: true, ties: false };
    throw e;
  }
}

export type MatchOutcome = "matched" | "ambiguous" | "no_candidate" | "not_ready";

/**
 * The merchant as the matcher compares it: one key per receipt-required chain ("WAL-MART #1868", "Walmart",
 * "WM SUPERCENTER" are all Walmart), otherwise the normalized name without spaces ("broulim s" = "broulims").
 */
export function merchantKey(norm: string): string {
  const chain = RECEIPT_REQUIRED_MERCHANTS.find((m) => m.pattern.test(norm) || m.pattern.test(norm.replace(/\s+/g, "")));
  if (chain) return chain.unsplitCategory;
  return norm.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Step 6: candidates are bank lines on any household account within -3..+5 days whose amount equals the total (2% for tips). */
export async function matchReceiptToTransaction(db: Queryable, householdId: string, receiptId: string, actor = "matching"): Promise<{ outcome: MatchOutcome; transactionId?: string; candidates?: { transactionId: string; score: number }[] }> {
  const rec = await loadReceipt(db, receiptId);
  if (rec.matched_transaction_id) return { outcome: "matched", transactionId: rec.matched_transaction_id };
  if (rec.ocr_status !== "read" || rec.total_cents === null) return { outcome: "not_ready" };
  const receiptDate = rec.receipt_date ?? new Date(rec.captured_at).toISOString().slice(0, 10);
  const rows = await db.query<{ id: string; posted_date: string; amount_cents: number; merchant_norm: string; account_id: string }>(
    `select id, to_char(posted_date,'YYYY-MM-DD') as posted_date, amount_cents::bigint::int as amount_cents, merchant_norm, account_id from transactions
      where household_id = $1 and not pending and receipt_id is null and amount_cents < 0 and kind = 'spend'
        and state in ('imported','needs_receipt','needs_classification','ready_for_review','possible_duplicate')
        and posted_date between $2::date and $3::date
        and abs(amount_cents) between $4 and $5`,
    [householdId, addDays(receiptDate, -3), addDays(receiptDate, 5), Math.floor(rec.total_cents * 0.97), Math.ceil(rec.total_cents * 1.03)],
  );
  const candidates: MatchCandidate[] = rows.rows.map((r) => ({ transactionId: r.id, postedDate: r.posted_date, amountCents: r.amount_cents, merchantNorm: merchantKey(r.merchant_norm), accountId: r.account_id }));
  const result = matchReceipt({ receiptDateIso: receiptDate, totalCents: rec.total_cents, merchantNorm: merchantKey(rec.merchant_norm ?? rec.merchant ?? ""), tipPossible: (rec.tip_cents ?? 0) > 0 || /restaurant|grill|cafe|pizza|diner/i.test(rec.merchant ?? ""), candidates, daysBetween });
  const scored = result.candidates.map((c) => ({ transactionId: c.candidate.transactionId, score: c.score }));
  if (result.matched) {
    await linkReceipt(db, householdId, rec, result.matched.transactionId, result.confidence, actor);
    return { outcome: "matched", transactionId: result.matched.transactionId, candidates: scored };
  }
  if (result.ambiguous) {
    await db.query("update receipts set ocr_status = 'needs_review', ocr_result = ocr_result || $2::jsonb where id = $1", [receiptId, JSON.stringify({ candidates: scored })]);
    await audit(db, householdId, { actor, action: "receipt.ambiguous", entity: "receipt", entityId: receiptId, after: { candidates: scored.length } });
    return { outcome: "ambiguous", candidates: scored };
  }
  return { outcome: "no_candidate", candidates: scored };
}

/** A person (Console) picks the bank line for a receipt the matcher could not decide. */
export async function matchReceiptManually(db: Queryable, householdId: string, receiptId: string, transactionId: string, actor: string): Promise<void> {
  const rec = await loadReceipt(db, receiptId);
  if (rec.matched_transaction_id) return;
  await db.query("update receipts set ocr_status = 'read' where id = $1 and ocr_status = 'needs_review'", [receiptId]);
  await linkReceipt(db, householdId, { ...rec, ocr_status: "read" }, transactionId, 1, actor);
}

/** Step 7 prelude: link the receipt, write the splits, and move the line on through the state machine. */
export async function linkReceipt(db: Queryable, householdId: string, rec: ReceiptRow, transactionId: string, confidence: number, actor: string): Promise<TxRow> {
  const tx = await loadTx(db, transactionId, true);
  await db.query("update receipts set matched_transaction_id = $2, match_confidence = $3 where id = $1", [rec.id, transactionId, confidence]);
  await patchTx(db, householdId, transactionId, { receipt_id: rec.id, receipt_status: "matched" }, actor, "transaction.receipt_matched");
  const cats = await loadCategories(db, householdId);
  const split = await proposeSplit(db, householdId, { ...rec, total_cents: rec.total_cents }, cats);
  if (split?.ties && split.lines.length > 0 && Math.abs(rec.total_cents ?? 0) === Math.abs(tx.amount_cents)) {
    const inputs: SplitInput[] = split.lines.map((l) => ({ amountCents: l.amountCents, categoryId: l.categoryId, description: l.description }));
    await setSplits(db, householdId, transactionId, inputs, actor, cats);
  } else if (split && !split.ties) {
    await audit(db, householdId, { actor, action: "receipt.split_does_not_tie", entity: "receipt", entityId: rec.id, after: { transactionId } });
  }
  let current = await loadTx(db, transactionId);
  if (current.state === "needs_receipt") current = await transition(db, householdId, transactionId, "needs_classification", "jobs", { actorId: actor, reason: "receipt matched" });
  if (current.state === "imported") current = await transition(db, householdId, transactionId, "needs_classification", "jobs", { actorId: actor, reason: "receipt matched" });
  if (current.state === "needs_classification") {
    const rules = await listRules(db, householdId);
    const settings = await getSettings(db, householdId);
    const conn = await ledgerConnection(db, householdId);
    await classifyOne(db, householdId, current, { rules, settings, autoPostOn: conn?.auto_post_enabled ?? false, cats, actor });
  }
  await audit(db, householdId, { actor, action: "receipt.matched", entity: "receipt", entityId: rec.id, after: { transactionId, confidence, lines: split?.lines.length ?? 0 } });
  return loadTx(db, transactionId);
}

/** Receipts read but not yet matched: try again against lines that arrived since (the matching job). */
export async function matchUnmatchedReceipts(db: Queryable, householdId: string, actor = "matching"): Promise<{ matched: number; ambiguous: number; waiting: number }> {
  const r = await db.query<{ id: string }>("select id from receipts where household_id = $1 and kind = 'receipt' and ocr_status = 'read' and matched_transaction_id is null and uploaded_at > now() - interval '30 days'", [householdId]);
  const counts = { matched: 0, ambiguous: 0, waiting: 0 };
  for (const { id } of r.rows) {
    const m = await matchReceiptToTransaction(db, householdId, id, actor);
    if (m.outcome === "matched") counts.matched += 1;
    else if (m.outcome === "ambiguous") counts.ambiguous += 1;
    else counts.waiting += 1;
  }
  return counts;
}

/** Step 8: no receipt after 10 days. The line posts to its unallocated account (603201/603401/603801); the app shows "estimated split". */
export async function applyReceiptFallbacks(db: Queryable, householdId: string, todayIso: string, actor = "receipt_fallback"): Promise<string[]> {
  const r = await db.query<{ id: string }>("select id from transactions where household_id = $1 and state = 'needs_receipt' and kind <> 'paycheck' and posted_date <= $2::date", [householdId, addDays(todayIso, -10)]);
  const done: string[] = [];
  const cats = await loadCategories(db, householdId);
  const rules = await listRules(db, householdId);
  const settings = await getSettings(db, householdId);
  const conn = await ledgerConnection(db, householdId);
  for (const { id } of r.rows) {
    const tx = await loadTx(db, id);
    const unsplit = RECEIPT_REQUIRED_MERCHANTS.find((m) => m.pattern.test(tx.merchant_raw))?.unsplitCategory ?? tx.category_id ?? "uncategorized";
    const moved = await transition(db, householdId, id, "needs_classification", "jobs", { actorId: actor, reason: "10 days without a receipt: estimated split", patch: { receipt_status: "estimated", category_id: unsplit } });
    await classifyOne(db, householdId, moved, { rules, settings, autoPostOn: conn?.auto_post_enabled ?? false, cats, actor });
    done.push(id);
  }
  return done;
}

export interface ReceiptDetail {
  lines: { lineNo: number; description: string; qty?: number; amountCents: number; suggestedCategoryId?: string; suggestedConfidence?: number }[];
  split?: { lines: (TransactionSplit & { description: string })[]; needsConfirmation: boolean };
  candidates?: { transactionId: string; score: number }[];
}

export async function receiptDetail(db: Queryable, householdId: string, rec: ReceiptRow): Promise<ReceiptDetail> {
  const lines = (await loadReceiptLines(db, rec.id)).map((l) => {
    const o: ReceiptDetail["lines"][number] = { lineNo: l.line_no, description: l.description, amountCents: l.amount_cents };
    if (l.qty !== null) o.qty = Number(l.qty);
    if (l.suggested_category_id) o.suggestedCategoryId = l.suggested_category_id;
    if (l.suggested_confidence !== null) o.suggestedConfidence = Number(l.suggested_confidence);
    return o;
  });
  const out: ReceiptDetail = { lines };
  if (rec.matched_transaction_id) {
    const splits = await loadSplits(db, rec.matched_transaction_id);
    if (splits.length) out.split = { lines: splits.map(splitDto), needsConfirmation: false };
  } else {
    const p = await proposeSplit(db, householdId, rec);
    if (p?.ties) out.split = { lines: p.lines, needsConfirmation: p.needsConfirmation };
  }
  const cands = (rec.ocr_result as { candidates?: { transactionId: string; score: number }[] } | null)?.candidates;
  if (cands?.length) out.candidates = cands;
  return out;
}
