/**
 * Transactions: import (idempotent by household + idempotency key), state transitions through the shared
 * state machine with an audit row per move, the outbox row written in the same database transaction when an
 * item becomes `approved`, BC read-back, exceptions, "This is wrong" corrections, the business flag and splits.
 *
 * Pending feed lines (Plaid) carry no BC key by design. The schema requires a non-null idempotency key, so a
 * pending row is stored with the key `pending:<plaid pending transaction id>`, `pending = true`, and never
 * leaves `imported`. `externalDocumentNo` rejects the `pending` prefix, so a pending row can never be sent to
 * BC. When the settled transaction arrives (Plaid's `pending_transaction_id`), the pending row is deleted and
 * the settled one is inserted with the real `plaid:` key (see `settlePending`).
 */
import {
  assertTransition,
  externalDocumentNo as makeExternalDocNo,
  plainStatus,
  tierOf,
  PLAIN_STATUS_WORDS,
  STATES_REQUIRING_BC_DOC,
  canTransition,
  type Actor,
  type BusinessFlag,
  type DimensionSet,
  type Transaction,
  type TransactionKind,
  type TransactionSplit,
  type TransactionState,
  normalizeDescription,
  mergeDimensions,
} from "@homestead/shared";
import { audit, enqueueOutbox, type Queryable } from "../db/index.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { loadCategories, categoryKind, type CategoryMap } from "./categories.js";
import { buildJournalLines } from "./journalLines.js";
import type { BcBatch } from "./ledgerPort.js";

export interface TxRow {
  id: string;
  household_id: string;
  account_id: string;
  source: Transaction["source"];
  source_ref: string;
  idempotency_key: string;
  posted_date: string;
  authorized_date: string | null;
  amount_cents: number;
  merchant_raw: string;
  merchant_norm: string;
  pending: boolean;
  state: TransactionState;
  category_id: string | null;
  dimension_set: DimensionSet;
  business_flag: BusinessFlag;
  kind: TransactionKind;
  confidence: number | null;
  rule_id: string | null;
  duplicate_of_id: string | null;
  pair_id: string | null;
  receipt_id: string | null;
  receipt_status: Transaction["receiptStatus"];
  bc_external_doc_no: string | null;
  bc_batch: BcBatch | null;
  bc_journal_id: string | null;
  bc_line_ids: string[] | null;
  bc_document_no: string | null;
  bc_entry_nos: number[] | null;
  bc_posting_date: string | null;
  bc_bank_ledger_entry_no: number | null;
  last_sync_at: string | null;
  sync_status: "pending" | "in_sync" | "difference" | "error" | null;
  sync_difference: string | null;
  exception_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SplitRow {
  id: string;
  transaction_id: string;
  line_no: number;
  amount_cents: number;
  category_id: string;
  gl_account: string;
  dimension_set: DimensionSet;
  description: string;
  receipt_line_id: string | null;
  bc_line_id: string | null;
}

const TX_COLUMNS = `id, household_id, account_id, source, source_ref, idempotency_key, to_char(posted_date,'YYYY-MM-DD') as posted_date,
  to_char(authorized_date,'YYYY-MM-DD') as authorized_date, amount_cents::bigint::int as amount_cents, merchant_raw, merchant_norm, pending, state,
  category_id, dimension_set, business_flag, kind, confidence::float as confidence, rule_id, duplicate_of_id, pair_id, receipt_id, receipt_status,
  bc_external_doc_no, bc_batch, bc_journal_id, bc_line_ids, bc_document_no, bc_entry_nos, to_char(bc_posting_date,'YYYY-MM-DD') as bc_posting_date,
  bc_bank_ledger_entry_no, last_sync_at, sync_status, sync_difference, exception_reason, created_at, updated_at`;

export async function loadTx(db: Queryable, id: string, forUpdate = false): Promise<TxRow> {
  const r = await db.query<TxRow>(`select ${TX_COLUMNS} from transactions where id = $1${forUpdate ? " for update" : ""}`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound("transaction");
  return row;
}

export async function findTxByKey(db: Queryable, householdId: string, key: string): Promise<TxRow | undefined> {
  const r = await db.query<TxRow>(`select ${TX_COLUMNS} from transactions where household_id = $1 and idempotency_key = $2`, [householdId, key]);
  return r.rows[0];
}

export async function loadSplits(db: Queryable, txId: string): Promise<SplitRow[]> {
  const r = await db.query<SplitRow>(
    "select id, transaction_id, line_no, amount_cents::bigint::int as amount_cents, category_id, gl_account, dimension_set, description, receipt_line_id, bc_line_id from transaction_splits where transaction_id = $1 order by line_no",
    [txId],
  );
  return r.rows;
}

export async function loadSplitsFor(db: Queryable, txIds: readonly string[]): Promise<Map<string, SplitRow[]>> {
  if (txIds.length === 0) return new Map();
  const r = await db.query<SplitRow>(
    "select id, transaction_id, line_no, amount_cents::bigint::int as amount_cents, category_id, gl_account, dimension_set, description, receipt_line_id, bc_line_id from transaction_splits where transaction_id = any($1) order by transaction_id, line_no",
    [txIds],
  );
  const out = new Map<string, SplitRow[]>();
  for (const s of r.rows) {
    const list = out.get(s.transaction_id) ?? [];
    list.push(s);
    out.set(s.transaction_id, list);
  }
  return out;
}

export function splitDto(s: SplitRow): TransactionSplit & { description: string } {
  const dto: TransactionSplit & { description: string } = { lineNo: s.line_no, amountCents: s.amount_cents, categoryId: s.category_id, glAccount: s.gl_account, dims: s.dimension_set, description: s.description };
  if (s.receipt_line_id) dto.receiptLineId = s.receipt_line_id;
  return dto;
}

export function toTransactionDto(row: TxRow, splits: readonly SplitRow[]): Transaction & { statusWord: string; pairId?: string; duplicateOfId?: string; exceptionReason?: string } {
  const status = plainStatus(row.state);
  const dto: Transaction & { statusWord: string; pairId?: string; duplicateOfId?: string; exceptionReason?: string } = {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    sourceRef: row.source_ref,
    idempotencyKey: row.idempotency_key,
    postedDate: row.posted_date,
    amountCents: row.amount_cents,
    merchantRaw: row.merchant_raw,
    merchantNorm: row.merchant_norm,
    pending: row.pending,
    state: row.state,
    status,
    statusWord: PLAIN_STATUS_WORDS[status],
    kind: row.kind,
    dims: row.dimension_set,
    businessFlag: row.business_flag,
    splits: splits.map(splitDto),
    receiptStatus: row.receipt_status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
  if (row.category_id) dto.categoryId = row.category_id;
  if (row.confidence !== null && row.confidence !== undefined) {
    dto.confidence = Number(row.confidence);
    dto.tier = tierOf(Number(row.confidence));
  }
  if (row.rule_id) dto.ruleId = row.rule_id;
  if (row.pair_id) dto.pairId = row.pair_id;
  if (row.duplicate_of_id) dto.duplicateOfId = row.duplicate_of_id;
  if (row.receipt_id) dto.receiptId = row.receipt_id;
  if (row.exception_reason) dto.exceptionReason = row.exception_reason;
  if (row.bc_external_doc_no) {
    const bc: NonNullable<Transaction["bc"]> = { externalDocumentNo: row.bc_external_doc_no };
    if (row.bc_journal_id) bc.journalId = row.bc_journal_id;
    if (row.bc_line_ids) bc.lineIds = row.bc_line_ids;
    if (row.bc_document_no) bc.documentNo = row.bc_document_no;
    if (row.bc_entry_nos) bc.entryNos = row.bc_entry_nos;
    if (row.bc_posting_date) bc.postingDate = row.bc_posting_date;
    if (row.bc_batch) bc.batch = row.bc_batch;
    if (row.last_sync_at) bc.lastSyncAt = toIso(row.last_sync_at);
    if (row.sync_status) bc.syncStatus = row.sync_status;
    if (row.sync_difference) bc.difference = row.sync_difference;
    dto.bc = bc;
  }
  return dto;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

// Import ------------------------------------------------------------------------------------------

export interface ImportInput {
  accountId: string;
  source: Transaction["source"];
  sourceRef: string;
  idempotencyKey: string;
  postedDate: string;
  authorizedDate?: string;
  amountCents: number;
  merchantRaw: string;
  /** A pending feed line: stored with a `pending:` key, never sent to BC. */
  pending?: boolean;
  kind?: TransactionKind;
  categoryId?: string;
  dimensionSet?: DimensionSet;
}

export interface ImportResult {
  transaction: TxRow;
  created: boolean;
}

/** Insert once per (household, key). A second import with the same key returns the existing row untouched. */
export async function importTransaction(db: Queryable, householdId: string, input: ImportInput, actor: string): Promise<ImportResult> {
  if (input.pending && !input.idempotencyKey.startsWith("pending:")) throw badRequest("pending_key", "A pending row must use a pending: key");
  if (!input.pending && input.idempotencyKey.startsWith("pending:")) throw badRequest("pending_key", "A settled row may not use a pending: key");
  if (!Number.isSafeInteger(input.amountCents)) throw badRequest("amount", "Amount must be integer cents");
  const r = await db.query<TxRow>(
    `insert into transactions (household_id, account_id, source, source_ref, idempotency_key, posted_date, authorized_date, amount_cents, merchant_raw, merchant_norm, pending, kind, category_id, dimension_set)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (household_id, idempotency_key) do nothing
     returning ${TX_COLUMNS}`,
    [
      householdId,
      input.accountId,
      input.source,
      input.sourceRef,
      input.idempotencyKey,
      input.postedDate,
      input.authorizedDate ?? null,
      input.amountCents,
      input.merchantRaw.slice(0, 200),
      normalizeDescription(input.merchantRaw),
      input.pending ?? false,
      input.kind ?? "spend",
      input.categoryId ?? null,
      JSON.stringify(input.dimensionSet ?? {}),
    ],
  );
  const row = r.rows[0];
  if (row) {
    await audit(db, householdId, { actor, action: "transaction.import", entity: "transaction", entityId: row.id, after: { idempotencyKey: row.idempotency_key, source: row.source, pending: row.pending } });
    return { transaction: row, created: true };
  }
  const existing = await findTxByKey(db, householdId, input.idempotencyKey);
  if (!existing) throw new Error("Import conflict without an existing row");
  return { transaction: existing, created: false };
}

/** Plaid "modified": a pending or not-yet-approved line changes amount, date or description. */
export async function updateImported(db: Queryable, householdId: string, key: string, patch: { amountCents?: number; postedDate?: string; merchantRaw?: string }, actor: string): Promise<TxRow | undefined> {
  const row = await findTxByKey(db, householdId, key);
  if (!row) return undefined;
  if (!["imported", "possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review"].includes(row.state)) {
    await audit(db, householdId, { actor, action: "transaction.modified_after_approval", entity: "transaction", entityId: row.id, after: { state: row.state } });
    return row;
  }
  await db.query(
    "update transactions set amount_cents = coalesce($2, amount_cents), posted_date = coalesce($3, posted_date), merchant_raw = coalesce($4, merchant_raw), merchant_norm = coalesce($5, merchant_norm) where id = $1",
    [row.id, patch.amountCents ?? null, patch.postedDate ?? null, patch.merchantRaw?.slice(0, 200) ?? null, patch.merchantRaw ? normalizeDescription(patch.merchantRaw) : null],
  );
  await audit(db, householdId, { actor, action: "transaction.modified", entity: "transaction", entityId: row.id, before: { amountCents: row.amount_cents, postedDate: row.posted_date }, after: patch });
  return loadTx(db, row.id);
}

/** The settled transaction arrived: remove the pending row (it has no BC key and nothing references it). */
export async function settlePending(db: Queryable, householdId: string, pendingKey: string, actor: string): Promise<boolean> {
  const r = await db.query<{ id: string }>("delete from transactions where household_id = $1 and idempotency_key = $2 and pending = true and state = 'imported' returning id", [householdId, pendingKey]);
  const id = r.rows[0]?.id;
  if (id) await audit(db, householdId, { actor, action: "transaction.pending_settled", entity: "transaction", entityId: id, before: { idempotencyKey: pendingKey } });
  return Boolean(id);
}

/** Plaid "removed" of a pending line: drop it. */
export async function dropPending(db: Queryable, householdId: string, pendingKey: string, actor: string): Promise<boolean> {
  return settlePending(db, householdId, pendingKey, actor);
}

// Transitions -------------------------------------------------------------------------------------

export interface TransitionOptions {
  patch?: Partial<Record<keyof TxRow, unknown>>;
  reason?: string;
  /** Member id or job name for the audit row; defaults to `who`. */
  actorId?: string;
}

const PATCHABLE = new Set<keyof TxRow>([
  "category_id",
  "dimension_set",
  "confidence",
  "rule_id",
  "kind",
  "duplicate_of_id",
  "pair_id",
  "receipt_id",
  "receipt_status",
  "bc_external_doc_no",
  "bc_batch",
  "bc_journal_id",
  "bc_line_ids",
  "bc_document_no",
  "bc_entry_nos",
  "bc_posting_date",
  "bc_bank_ledger_entry_no",
  "last_sync_at",
  "sync_status",
  "sync_difference",
  "exception_reason",
  "business_flag",
]);

/** Move a transaction along one arrow of the state machine, writing the audit row. */
export async function transition(db: Queryable, householdId: string, txId: string, to: TransactionState, who: Actor, opts: TransitionOptions = {}): Promise<TxRow> {
  const row = await loadTx(db, txId, true);
  if (row.pending) throw conflict("pending", "A pending line cannot change state until it settles");
  assertTransition(row.state, to, who);
  const patch = { ...(opts.patch ?? {}) } as Record<string, unknown>;
  const doc = (patch["bc_external_doc_no"] as string | undefined) ?? row.bc_external_doc_no;
  if (STATES_REQUIRING_BC_DOC.has(to) && !doc) throw conflict("bc_doc_required", `A transaction cannot enter ${to} without a BC External Document No.`);
  const sets: string[] = ["state = $2"];
  const params: unknown[] = [txId, to];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k as keyof TxRow)) throw new Error(`Column ${k} is not patchable through transition()`);
    params.push(k === "dimension_set" ? JSON.stringify(v ?? {}) : v);
    sets.push(`${k} = $${params.length}`);
  }
  await db.query(`update transactions set ${sets.join(", ")} where id = $1`, params);
  await audit(db, householdId, {
    actor: opts.actorId ?? who,
    action: "transaction.transition",
    entity: "transaction",
    entityId: txId,
    before: { state: row.state },
    after: { state: to, who, reason: opts.reason, ...scrubPatchForAudit(patch) },
  });
  return loadTx(db, txId);
}

function scrubPatchForAudit(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) if (!k.startsWith("merchant")) out[k] = v;
  return out;
}

/** Update mirror columns without a state change (read-back details, sync status). */
export async function patchTx(db: Queryable, householdId: string, txId: string, patch: Partial<Record<keyof TxRow, unknown>>, actor: string, action = "transaction.patch"): Promise<TxRow> {
  const sets: string[] = [];
  const params: unknown[] = [txId];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k as keyof TxRow)) throw new Error(`Column ${k} is not patchable`);
    params.push(k === "dimension_set" ? JSON.stringify(v ?? {}) : v);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return loadTx(db, txId);
  await db.query(`update transactions set ${sets.join(", ")} where id = $1`, params);
  await audit(db, householdId, { actor, action, entity: "transaction", entityId: txId, after: scrubPatchForAudit(patch as Record<string, unknown>) });
  return loadTx(db, txId);
}

// Splits ------------------------------------------------------------------------------------------

export interface SplitInput {
  amountCents: number;
  categoryId: string;
  description?: string;
  receiptLineId?: string;
  dims?: DimensionSet;
}

const EDITABLE_STATES: readonly TransactionState[] = ["imported", "possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review", "approved", "exception"];

/** Replace the splits; they must sum to the amount. Allowed until the item is published to the BC worker. */
export async function setSplits(db: Queryable, householdId: string, txId: string, splits: readonly SplitInput[], actor: string, cats?: CategoryMap): Promise<SplitRow[]> {
  const row = await loadTx(db, txId, true);
  if (!EDITABLE_STATES.includes(row.state)) throw conflict("not_editable", "This item is already on its way to the books; ask for a correction instead.");
  if (splits.length === 0) throw badRequest("splits", "At least one split is needed");
  const sum = splits.reduce((s, x) => s + x.amountCents, 0);
  if (sum !== row.amount_cents) throw badRequest("splits_sum", "The split lines must add up to the amount", { sum, amountCents: row.amount_cents });
  const categories = cats ?? (await loadCategories(db, householdId));
  await db.query("delete from transaction_splits where transaction_id = $1", [txId]);
  let n = 1;
  for (const s of splits) {
    const c = categories.get(s.categoryId);
    if (!c) throw badRequest("category", `Unknown category ${s.categoryId}`);
    await db.query(
      "insert into transaction_splits (household_id, transaction_id, line_no, amount_cents, category_id, gl_account, dimension_set, description, receipt_line_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [householdId, txId, n, s.amountCents, s.categoryId, c.gl_account, JSON.stringify(mergeDimensions(c.dimension_defaults, s.dims)), (s.description ?? "").slice(0, 100), s.receiptLineId ?? null],
    );
    n += 1;
  }
  const first = splits[0]!;
  const categoryId = splits.length === 1 ? first.categoryId : row.category_id ?? first.categoryId;
  await db.query("update transactions set category_id = $2 where id = $1", [txId, categoryId]);
  await audit(db, householdId, { actor, action: "transaction.splits", entity: "transaction", entityId: txId, after: { lines: splits.map((s) => ({ categoryId: s.categoryId })) } });
  return loadSplits(db, txId);
}

// Approval and the outbox ----------------------------------------------------------------------

export interface ApproveOptions {
  categoryId?: string;
  splits?: readonly SplitInput[];
  ruleId?: string;
  confidence?: number;
  /** Decided by rules.ts: AUTOPOST only under an approved auto-post rule with the household switch on. */
  batch?: BcBatch;
  actorId?: string;
  reason?: string;
}

/**
 * Approve: set the classification, compute the External Document No. and the journal lines, move to `approved`
 * and write the `send_to_bc` outbox row in the same database transaction (spec: "Write path").
 */
export async function approveTransaction(db: Queryable, householdId: string, txId: string, who: Actor, opts: ApproveOptions = {}): Promise<TxRow> {
  const cats = await loadCategories(db, householdId);
  let row = await loadTx(db, txId, true);
  if (row.pending) throw conflict("pending", "A pending line cannot be approved until it settles");
  if (opts.splits) await setSplits(db, householdId, txId, opts.splits, opts.actorId ?? who, cats);
  else if (opts.categoryId) await setSplits(db, householdId, txId, [{ amountCents: row.amount_cents, categoryId: opts.categoryId }], opts.actorId ?? who, cats);
  let splits = await loadSplits(db, txId);
  if (splits.length === 0) {
    if (!row.category_id) throw badRequest("category_required", "Pick a category before approving");
    splits = await setSplits(db, householdId, txId, [{ amountCents: row.amount_cents, categoryId: row.category_id }], opts.actorId ?? who, cats);
  }
  row = await loadTx(db, txId, true);
  const kind = inferKind(row, splits, cats);
  const externalDocumentNo = row.bc_external_doc_no ?? makeExternalDocNo(row.idempotency_key, row.posted_date);
  const batch: BcBatch = opts.batch ?? (row.receipt_status === "matched" || row.source === "receipt" ? "RECEIPTS" : "FEEDS");
  const lines = await linesFor(db, { ...row, bc_external_doc_no: externalDocumentNo, kind }, splits, cats);
  const patch: Partial<Record<keyof TxRow, unknown>> = {
    bc_external_doc_no: externalDocumentNo,
    bc_batch: batch,
    kind,
    category_id: splits.length === 1 ? splits[0]!.category_id : row.category_id ?? splits[0]!.category_id,
    sync_status: "pending",
  };
  if (opts.ruleId !== undefined) patch.rule_id = opts.ruleId;
  if (opts.confidence !== undefined) patch.confidence = opts.confidence;
  const updated = await transition(db, householdId, txId, "approved", who, { patch, actorId: opts.actorId ?? who, reason: opts.reason ?? "approved" });
  await enqueueOutbox(db, householdId, {
    aggregate: "transaction",
    aggregateId: txId,
    operation: "send_to_bc",
    payload: { transactionId: txId, idempotencyKey: row.idempotency_key, externalDocumentNo, batch, lines },
  });
  return updated;
}

/** The journal lines of one transaction, for the outbox payload. */
export async function linesFor(db: Queryable, row: TxRow, splits: readonly SplitRow[], cats: CategoryMap) {
  if (!row.bc_external_doc_no) throw new Error("linesFor needs the External Document No.");
  const acct = await loadAccount(db, row.account_id);
  return buildJournalLines(
    { idempotencyKey: row.idempotency_key, externalDocumentNo: row.bc_external_doc_no, postedDate: row.posted_date, amountCents: row.amount_cents, merchantRaw: row.merchant_raw, businessFlag: row.business_flag, kind: row.kind, dimensionSet: row.dimension_set },
    splits.map((s) => ({ lineNo: s.line_no, amountCents: s.amount_cents, categoryId: s.category_id, glAccount: s.gl_account, dimensionSet: s.dimension_set, description: s.description })),
    { bcBankAccountCode: acct.bc_bank_account_code, bcGlAccount: acct.bc_gl_account, displayName: acct.display_name },
    cats,
  );
}

export function inferKind(row: TxRow, splits: readonly SplitRow[], cats: CategoryMap): TransactionKind {
  if (row.kind === "paycheck" || row.kind === "bc_native" || row.kind === "loan_payment") return row.kind;
  const kinds = new Set(splits.map((s) => categoryKind(cats.get(s.category_id)!)));
  if (kinds.size === 1 && kinds.has("transfer")) return "transfer";
  if (kinds.has("income") && !kinds.has("spend")) return "income";
  return "spend";
}

export interface AccountRow {
  id: string;
  kind: string;
  institution: string;
  display_name: string;
  mask: string;
  bc_bank_account_code: string | null;
  bc_gl_account: string | null;
  feed_connection_id: string | null;
  plaid_account_id: string | null;
  is_restricted: boolean;
  balance_cents: number | null;
  balance_as_of: string | null;
}

export async function loadAccount(db: Queryable, id: string): Promise<AccountRow> {
  const r = await db.query<AccountRow>("select id, kind, institution, display_name, mask, bc_bank_account_code, bc_gl_account, feed_connection_id, plaid_account_id, is_restricted, balance_cents::bigint::int as balance_cents, balance_as_of from accounts where id = $1", [id]);
  const row = r.rows[0];
  if (!row) throw notFound("account");
  return row;
}

export async function listAccounts(db: Queryable, householdId: string): Promise<AccountRow[]> {
  const r = await db.query<AccountRow>("select id, kind, institution, display_name, mask, bc_bank_account_code, bc_gl_account, feed_connection_id, plaid_account_id, is_restricted, balance_cents::bigint::int as balance_cents, balance_as_of from accounts where household_id = $1 order by display_name", [householdId]);
  return r.rows;
}

// Read-back and exceptions --------------------------------------------------------------------------

/** The BC worker wrote (or found) the draft lines. */
export async function recordDraftCreated(db: Queryable, householdId: string, txId: string, found: { journalId: string; lineIds: readonly string[] }, actor: string): Promise<TxRow> {
  return transition(db, householdId, txId, "bc_draft_created", "bc_worker", {
    actorId: actor,
    patch: { bc_journal_id: found.journalId, bc_line_ids: [...found.lineIds], sync_status: "in_sync", last_sync_at: new Date().toISOString() },
  });
}

/** G/L entries read back by webhook or poll. */
export async function recordPosted(db: Queryable, householdId: string, txId: string, posted: { entryNos: readonly number[]; documentNo?: string; postingDate: string }, who: Actor, actor: string): Promise<TxRow> {
  const patch: Partial<Record<keyof TxRow, unknown>> = { bc_entry_nos: [...posted.entryNos], bc_posting_date: posted.postingDate, sync_status: "in_sync", last_sync_at: new Date().toISOString(), bc_line_ids: null };
  if (posted.documentNo) patch.bc_document_no = posted.documentNo;
  return transition(db, householdId, txId, "posted", who, { actorId: actor, patch });
}

export async function recordReconciled(db: Queryable, householdId: string, txId: string, bankEntryNo: number, who: Actor, actor: string): Promise<TxRow> {
  return transition(db, householdId, txId, "reconciled", who, { actorId: actor, patch: { bc_bank_ledger_entry_no: bankEntryNo, last_sync_at: new Date().toISOString() } });
}

/**
 * Raise an exception. Along an allowed arrow the state changes; otherwise the reason is recorded on the row
 * (sync_status `difference`) so the Console's exception queue shows it without faking a transition.
 */
export async function raiseException(db: Queryable, householdId: string, txId: string, reason: string, who: Actor, actor: string, extra: Partial<Record<keyof TxRow, unknown>> = {}): Promise<TxRow> {
  const row = await loadTx(db, txId, true);
  if (canTransition(row.state, "exception", who)) {
    return transition(db, householdId, txId, "exception", who, { actorId: actor, reason, patch: { exception_reason: reason, sync_status: "difference", ...extra } });
  }
  return patchTx(db, householdId, txId, { exception_reason: reason, sync_status: "difference", ...extra }, actor, "transaction.exception_noted");
}

/** Cade resolves an exception, recording the keys on both sides. */
export async function resolveException(db: Queryable, householdId: string, txId: string, resolution: { to: "ready_for_review" | "posted"; note: string; entryNos?: readonly number[]; documentNo?: string; postingDate?: string }, actor: string): Promise<TxRow> {
  const row = await loadTx(db, txId, true);
  if (row.state !== "exception") throw conflict("not_exception", "This item is not an exception");
  if (resolution.to === "posted") {
    if (!resolution.entryNos?.length) throw badRequest("entry_nos", "Resolving to posted needs the BC entry numbers");
    const patch: Partial<Record<keyof TxRow, unknown>> = { bc_entry_nos: [...resolution.entryNos], bc_posting_date: resolution.postingDate ?? row.posted_date, exception_reason: null, sync_status: "in_sync", sync_difference: null, last_sync_at: new Date().toISOString() };
    if (resolution.documentNo) patch.bc_document_no = resolution.documentNo;
    return transition(db, householdId, txId, "posted", "cade", { actorId: actor, reason: resolution.note, patch });
  }
  return transition(db, householdId, txId, "ready_for_review", "cade", { actorId: actor, reason: resolution.note, patch: { exception_reason: null, sync_status: null, sync_difference: null, bc_line_ids: null, bc_journal_id: null } });
}

// Corrections and the business flag -------------------------------------------------------------

const BEFORE_BC: readonly TransactionState[] = ["imported", "possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review"];

async function outboxUnpublished(db: Queryable, txId: string): Promise<{ id: string } | undefined> {
  const r = await db.query<{ id: string }>("select id from outbox where aggregate = 'transaction' and aggregate_id = $1 and operation = 'send_to_bc' and published_at is null and completed_at is null and not dead_lettered order by created_at desc limit 1", [txId]);
  return r.rows[0];
}

export interface CorrectionInput {
  categoryId?: string;
  splits?: readonly SplitInput[];
  businessFlag?: BusinessFlag;
  reason?: string;
}

export interface CorrectionResult {
  transaction: TxRow;
  correctionRequestId?: string;
}

/**
 * "This is wrong". Before the item is published to the BC worker the classification changes in place (and the
 * item is approved with the new values by the member). After that, a correction request is opened for Cade,
 * who reverses and reposts in BC with reason CORRECT.
 */
export async function correctTransaction(db: Queryable, householdId: string, txId: string, input: CorrectionInput, memberId: string): Promise<CorrectionResult> {
  const row = await loadTx(db, txId, true);
  if (row.pending) throw conflict("pending", "Wait until this line settles");
  if (!input.categoryId && !input.splits && input.businessFlag === undefined) throw badRequest("nothing_to_change", "Say what should change");
  const pendingOutbox = row.state === "approved" ? await outboxUnpublished(db, txId) : undefined;
  if (BEFORE_BC.includes(row.state) || (row.state === "approved" && pendingOutbox)) {
    if (input.businessFlag !== undefined) await patchTx(db, householdId, txId, { business_flag: input.businessFlag }, memberId, "transaction.business_flag");
    if (row.state === "approved" && pendingOutbox) {
      // Approved but not yet published: the state stays `approved`; the splits and the waiting outbox row's
      // lines are replaced in place so there is still exactly one outbox row for the item.
      const cats = await loadCategories(db, householdId);
      if (input.splits) await setSplits(db, householdId, txId, input.splits, memberId, cats);
      else if (input.categoryId) await setSplits(db, householdId, txId, [{ amountCents: row.amount_cents, categoryId: input.categoryId }], memberId, cats);
      const fresh = await loadTx(db, txId);
      const splits = await loadSplits(db, txId);
      const lines = await linesFor(db, fresh, splits, cats);
      await db.query("update outbox set payload = $2 where id = $1", [
        pendingOutbox.id,
        JSON.stringify({ transactionId: txId, idempotencyKey: fresh.idempotency_key, externalDocumentNo: fresh.bc_external_doc_no, batch: fresh.bc_batch, lines }),
      ]);
      await db.query("update transactions set kind = $2, category_id = $3 where id = $1", [txId, inferKind(fresh, splits, cats), splits.length === 1 ? splits[0]!.category_id : fresh.category_id]);
      await audit(db, householdId, { actor: memberId, action: "transaction.correction_before_posting", entity: "transaction", entityId: txId, before: { categoryId: row.category_id }, after: { categoryId: input.categoryId, reason: input.reason } });
      return { transaction: await loadTx(db, txId) };
    }
    if (input.splits) await setSplits(db, householdId, txId, input.splits, memberId);
    else if (input.categoryId) await setSplits(db, householdId, txId, [{ amountCents: row.amount_cents, categoryId: input.categoryId }], memberId);
    await audit(db, householdId, { actor: memberId, action: "transaction.correction", entity: "transaction", entityId: txId, before: { categoryId: row.category_id, businessFlag: row.business_flag }, after: { categoryId: input.categoryId, businessFlag: input.businessFlag, reason: input.reason } });
    if (row.state === "ready_for_review" && (input.categoryId || input.splits)) {
      const approved = await approveTransaction(db, householdId, txId, "member", { actorId: memberId, reason: "corrected and approved" });
      return { transaction: approved };
    }
    return { transaction: await loadTx(db, txId) };
  }
  // Already with BC: a correction request for Cade.
  const r = await db.query<{ id: string }>(
    "insert into approvals (household_id, kind, payload, requested_by) values ($1, 'correction', $2, $3) returning id",
    [householdId, JSON.stringify({ transactionId: txId, categoryId: input.categoryId, splits: input.splits, businessFlag: input.businessFlag, reason: input.reason, state: row.state, externalDocumentNo: row.bc_external_doc_no }), memberId],
  );
  const id = r.rows[0]!.id;
  await audit(db, householdId, { actor: memberId, action: "correction.requested", entity: "approval", entityId: id, after: { transactionId: txId, reason: input.reason } });
  return { transaction: row, correctionRequestId: id };
}

export async function setBusinessFlag(db: Queryable, householdId: string, txId: string, flag: BusinessFlag, memberId: string): Promise<CorrectionResult> {
  return correctTransaction(db, householdId, txId, { businessFlag: flag }, memberId);
}

// Listing -------------------------------------------------------------------------------------

export interface ListFilter {
  from?: string;
  to?: string;
  q?: string;
  categoryId?: string;
  accountId?: string;
  states?: readonly TransactionState[];
  kind?: TransactionKind;
  limit?: number;
  /** `<posted_date>|<id>` from the previous page. */
  cursor?: string;
  includePending?: boolean;
}

export async function listTransactions(db: Queryable, householdId: string, f: ListFilter = {}): Promise<{ rows: TxRow[]; next?: string }> {
  const where: string[] = ["household_id = $1"];
  const params: unknown[] = [householdId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (f.from) add("posted_date >= ?", f.from);
  if (f.to) add("posted_date <= ?", f.to);
  if (f.q) add("merchant_norm like ?", `%${normalizeDescription(f.q)}%`);
  if (f.categoryId) add("(category_id = ? or id in (select transaction_id from transaction_splits where category_id = $" + (params.length + 1) + "))", f.categoryId);
  if (f.accountId) add("account_id = ?", f.accountId);
  if (f.states?.length) add("state = any(?)", [...f.states]);
  if (f.kind) add("kind = ?", f.kind);
  if (f.cursor) {
    const [d, id] = f.cursor.split("|");
    params.push(d, id);
    where.push(`(posted_date, id) < ($${params.length - 1}, $${params.length})`);
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  params.push(limit + 1);
  const r = await db.query<TxRow>(`select ${TX_COLUMNS} from transactions where ${where.join(" and ")} order by posted_date desc, id desc limit $${params.length}`, params);
  const rows = r.rows.slice(0, limit);
  const out: { rows: TxRow[]; next?: string } = { rows };
  if (r.rows.length > limit) {
    const last = rows[rows.length - 1]!;
    out.next = `${last.posted_date}|${last.id}`;
  }
  return out;
}
