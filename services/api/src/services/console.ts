/**
 * The CFO Console's read models (Console functions 1–3, 4, 11, 12) and its two write actions: "post batch"
 * (which only enqueues; the API never posts to BC itself) and retrying a dead-lettered outbox row.
 */
import { BANK_CARD_LIST, CATEGORIES, DIMENSION_CODES, FAMILY_AREA, FUND_GOAL, PROJECT, SPEND_CLASS, TAX_TREATMENT, type AuditEntry, type DataThrough, type EmployerMapping, type OutboxItem, type PaycheckComponentKind } from "@homestead/shared";
import { listEmployers } from "./paychecks/index.js";
import { applyTemplate, linesForPaycheck } from "./paychecks/template.js";
import { audit, enqueueOutbox, type Queryable } from "../db/index.js";
import { conflict, notFound } from "../lib/errors.js";
import { hoursBetween } from "../lib/dates.js";
import { listFeeds } from "./bankData/plaid.js";
import { loadCategories } from "./categories.js";
import { getHousehold, ledgerConnection } from "./households.js";
import type { BcBatch } from "./ledgerPort.js";
import { listAccounts, listTransactions, loadSplitsFor, loadTx, toTransactionDto } from "./transactions.js";

const QUEUE_STATES = ["possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review", "exception"] as const;

export async function queues(db: Queryable, householdId: string, now: Date) {
  const counts: Record<string, number> = {};
  const r = await db.query<{ state: string; n: number }>("select state, count(*)::int as n from transactions where household_id = $1 and not pending and state = any($2) group by state", [householdId, [...QUEUE_STATES]]);
  for (const s of QUEUE_STATES) counts[s] = 0;
  for (const row of r.rows) counts[row.state] = row.n;
  const notedCount = await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and state <> 'exception' and exception_reason is not null and sync_status = 'difference'", [householdId]);
  counts["exception"] = (counts["exception"] ?? 0) + (notedCount.rows[0]?.n ?? 0);
  const rec = await db.query<{ n: number }>("select count(*)::int as n from receipts where household_id = $1 and kind = 'receipt' and (ocr_status in ('needs_review','failed') or (ocr_status = 'read' and matched_transaction_id is null))", [householdId]);
  counts["receipts"] = rec.rows[0]?.n ?? 0;
  const rules = await db.query<{ n: number }>("select count(*)::int as n from rules where household_id = $1 and state = 'proposed'", [householdId]);
  counts["rules"] = rules.rows[0]?.n ?? 0;
  const { rows } = await listTransactions(db, householdId, { states: ["possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review"], limit: 200 });
  const { rows: excStates } = await listTransactions(db, householdId, { states: ["exception"], limit: 200 });
  // Plus items noted with an exception reason where no state arrow exists (a line the bank removed before BC).
  const noted = await db.query<{ id: string }>("select id from transactions where household_id = $1 and state <> 'exception' and exception_reason is not null and sync_status = 'difference' order by posted_date desc limit 200", [householdId]);
  const exc = [...excStates];
  for (const { id } of noted.rows) exc.push(await loadTx(db, id));
  const splits = await loadSplitsFor(db, [...rows, ...exc].map((t) => t.id));
  const marks = await db.query<{ at: string | null; pending: number }>(
    "select max(updated_at) as at, count(*) filter (where pending or state in ('imported','possible_duplicate','needs_receipt','needs_classification','ready_for_review'))::int as pending from transactions where household_id = $1",
    [householdId],
  );
  const dataThrough: DataThrough = { at: marks.rows[0]?.at ? new Date(marks.rows[0].at).toISOString() : now.toISOString(), quality: "imported_pending", pendingCount: marks.rows[0]?.pending ?? 0 };
  return { counts, transactions: rows.map((t) => toTransactionDto(t, splits.get(t.id) ?? [])), exceptions: exc.map((t) => toTransactionDto(t, splits.get(t.id) ?? [])), dataThrough };
}

export interface BatchCounts {
  batch: BcBatch;
  approved: number;
  sentToBc: number;
  draftCreated: number;
  posted: number;
  exceptions: number;
  deadLettered: number;
  draftSumCents: number;
}

export async function postingStatus(db: Queryable, householdId: string): Promise<{ batches: BatchCounts[]; autoPostEnabled: boolean; outboxDue: number; lastPollAt?: string; lastWebhookAt?: string }> {
  const r = await db.query<{ bc_batch: BcBatch; state: string; n: number; s: number }>(
    "select bc_batch, state, count(*)::int as n, coalesce(sum(abs(amount_cents)),0)::bigint::int as s from transactions where household_id = $1 and bc_batch is not null and state in ('approved','sent_to_bc','bc_draft_created','posted','exception') group by bc_batch, state",
    [householdId],
  );
  const dead = await db.query<{ aggregate_id: string }>("select aggregate_id from outbox where household_id = $1 and dead_lettered and completed_at is null and aggregate = 'transaction'", [householdId]);
  const deadByBatch = new Map<BcBatch, number>();
  if (dead.rows.length) {
    const tx = await db.query<{ bc_batch: BcBatch | null }>("select bc_batch from transactions where id = any($1)", [dead.rows.map((d) => d.aggregate_id)]);
    for (const t of tx.rows) if (t.bc_batch) deadByBatch.set(t.bc_batch, (deadByBatch.get(t.bc_batch) ?? 0) + 1);
  }
  const batches: BatchCounts[] = (["FEEDS", "RECEIPTS", "AUTOPOST"] as const).map((b) => {
    const get = (state: string) => r.rows.find((x) => x.bc_batch === b && x.state === state);
    return { batch: b, approved: get("approved")?.n ?? 0, sentToBc: get("sent_to_bc")?.n ?? 0, draftCreated: get("bc_draft_created")?.n ?? 0, posted: get("posted")?.n ?? 0, exceptions: get("exception")?.n ?? 0, deadLettered: deadByBatch.get(b) ?? 0, draftSumCents: get("bc_draft_created")?.s ?? 0 };
  });
  const conn = await ledgerConnection(db, householdId);
  const due = await db.query<{ n: number }>("select count(*)::int as n from outbox where household_id = $1 and completed_at is null and not dead_lettered", [householdId]);
  const out: { batches: BatchCounts[]; autoPostEnabled: boolean; outboxDue: number; lastPollAt?: string; lastWebhookAt?: string } = { batches, autoPostEnabled: conn?.auto_post_enabled ?? false, outboxDue: due.rows[0]?.n ?? 0 };
  if (conn?.last_poll_at) out.lastPollAt = new Date(conn.last_poll_at).toISOString();
  if (conn?.last_webhook_at) out.lastWebhookAt = new Date(conn.last_webhook_at).toISOString();
  return out;
}

/**
 * "Post batch": the API only enqueues `post_batch`. The autopost job posts AUTOPOST when the household switch is
 * on; FEEDS and RECEIPTS have no posting right under the HH-APP permission set, so the request is recorded and
 * Cade posts them under his own BC sign-in (authority matrix: "Post approved drafts in BC — Cade — BC sign-in").
 */
export async function requestPostBatch(db: Queryable, householdId: string, batch: BcBatch, memberId: string): Promise<{ batch: BcBatch; outboxId: string; queuedAt: string; lineCount: number; enqueued: boolean; message: string }> {
  const conn = await ledgerConnection(db, householdId);
  const drafts = await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and bc_batch = $2 and state = 'bc_draft_created'", [householdId, batch]);
  const lineCount = drafts.rows[0]?.n ?? 0;
  const enqueued = batch === "AUTOPOST" && (conn?.auto_post_enabled ?? false);
  const outboxId = await enqueueOutbox(db, householdId, { aggregate: "household", aggregateId: householdId, operation: "post_batch", payload: { batch, requestedBy: memberId, enqueued, draftCount: lineCount } });
  await audit(db, householdId, { actor: memberId, action: enqueued ? "post.enqueued" : "post.requested", entity: "batch", entityId: batch, after: { outboxId, draftCount: lineCount } });
  const message = enqueued
    ? `${lineCount} draft line(s) in HHAPP/AUTOPOST will be posted by the auto-post job and read back by External Document No.`
    : batch === "AUTOPOST"
      ? "Auto-posting is switched off for this household; the request is recorded and nothing is posted."
      : `Recorded. HHAPP/${batch} is posted under Cade's own BC sign-in (the app credential has no posting right there); the read-back marks the lines Posted.`;
  return { batch, outboxId, queuedAt: new Date().toISOString(), lineCount, enqueued, message };
}

export async function reconciliationStatus(db: Queryable, householdId: string) {
  const accounts = await listAccounts(db, householdId);
  const conn = await ledgerConnection(db, householdId);
  const r = await db.query<{ account_id: string; posted: number; reconciled: number; bc_native: number; differences: number }>(
    `select account_id,
            count(*) filter (where state = 'posted')::int as posted,
            count(*) filter (where state = 'reconciled')::int as reconciled,
            count(*) filter (where kind = 'bc_native' and state = 'reconciled')::int as bc_native,
            count(*) filter (where sync_status = 'difference' or state = 'exception')::int as differences
       from transactions where household_id = $1 group by account_id`,
    [householdId],
  );
  const byAcct = new Map(r.rows.map((x) => [x.account_id, x]));
  return {
    accounts: accounts.map((a) => {
      const s = byAcct.get(a.id);
      const row: Record<string, unknown> = { accountId: a.id, displayName: a.display_name, posted: s?.posted ?? 0, reconciled: s?.reconciled ?? 0, bcNative: s?.bc_native ?? 0, differences: s?.differences ?? 0, mask: a.mask, institution: a.institution };
      if (a.bc_bank_account_code) row["bcBankAccountCode"] = a.bc_bank_account_code;
      if (a.bc_gl_account) row["glAccount"] = a.bc_gl_account;
      if (conn?.last_poll_at) row["lastPollAt"] = new Date(conn.last_poll_at).toISOString();
      return row;
    }),
  };
}

/** Employer templates as the Console shows them: each component kind with the G/L account and dimensions it posts to. */
export async function employerMappings(db: Queryable, householdId: string): Promise<EmployerMapping[]> {
  const employers = await listEmployers(db, householdId);
  const members = await db.query<{ id: string; display_name: string }>("select id, display_name from members where household_id = $1", [householdId]);
  const nameOf = new Map(members.rows.map((m) => [m.id, m.display_name]));
  return employers.map((e) => {
    // A nominal net run through the template gives each component's account without touching a real paycheck.
    const nominal = 100_000;
    const lines = linesForPaycheck(e.code, applyTemplate(e.template, nominal), nominal, "2026-01-01").filter((l) => l.kind !== "net");
    const out: EmployerMapping = {
      id: e.id,
      code: e.code,
      name: e.name,
      memberName: nameOf.get(e.member_id) ?? "",
      descriptorPattern: e.descriptor_pattern,
      grossAccount: e.bc_gross_account,
      bonusAccount: e.bc_bonus_account,
      components: lines.map((l) => ({ kind: l.kind as PaycheckComponentKind, label: l.description, glAccount: l.glAccount, dims: l.dims })),
    };
    if (e.last_stub_at) out.lastStubAt = new Date(e.last_stub_at).toISOString();
    return out;
  });
}

export async function mappings(db: Queryable, householdId: string) {
  const cats = await loadCategories(db, householdId);
  const accounts = await listAccounts(db, householdId);
  const cardByCode = new Map<string, (typeof BANK_CARD_LIST)[number]>(BANK_CARD_LIST.map((b) => [b.code, b]));
  return {
    catalogVersion: Math.max(1, ...[...cats.values()].map((c) => c.version)),
    categories: [...cats.values()].map((c) => ({ id: c.id, name: c.name, group: c.group, glAccount: c.gl_account, dims: c.dimension_defaults, isAllowance: c.is_allowance, isTransfer: c.is_transfer, householdVisible: c.household_visible, version: c.version })),
    accounts: accounts.map((a) => ({ id: a.id, displayName: a.display_name, institution: a.institution, kind: a.kind, mask: a.mask, bcBankAccountCode: a.bc_bank_account_code ?? undefined, bcGlAccount: a.bc_gl_account ?? (a.bc_bank_account_code ? cardByCode.get(a.bc_bank_account_code)?.glAccount : undefined), feedStatus: a.feed_connection_id ? "ok" : "none", isRestricted: a.is_restricted })),
    dimensions: { [DIMENSION_CODES.SPEND_CLASS]: [...SPEND_CLASS], [DIMENSION_CODES.FUND_GOAL]: [...FUND_GOAL], [DIMENSION_CODES.FAMILY_AREA]: [...FAMILY_AREA], [DIMENSION_CODES.TAX_TREATMENT]: [...TAX_TREATMENT], [DIMENSION_CODES.PROJECT]: [...PROJECT] },
    catalogCategories: CATEGORIES.length,
    employers: await employerMappings(db, householdId),
  };
}

export async function connectionHealth(db: Queryable, householdId: string, now: Date) {
  const feeds = await listFeeds(db, householdId);
  const conn = await ledgerConnection(db, householdId);
  const accountCounts = await db.query<{ feed_connection_id: string; n: number }>("select feed_connection_id, count(*)::int as n from accounts where household_id = $1 and feed_connection_id is not null group by feed_connection_id", [householdId]);
  const countBy = new Map(accountCounts.rows.map((x) => [x.feed_connection_id, x.n]));
  const members = await db.query<{ id: string; display_name: string }>("select id, display_name from members where household_id = $1", [householdId]);
  const nameOf = new Map(members.rows.map((m) => [m.id, m.display_name]));
  const subs = await db.query<{ resource: string; subscription_id: string; expires_at: string; last_renewed_at: string | null }>("select resource, subscription_id, expires_at, last_renewed_at from bc_webhook_subscriptions where household_id = $1", [householdId]);
  const outbox = await db.query<{ due: number; dead: number; oldest: string | null }>("select count(*) filter (where completed_at is null and not dead_lettered)::int as due, count(*) filter (where dead_lettered and completed_at is null)::int as dead, min(created_at) filter (where completed_at is null and not dead_lettered) as oldest from outbox where household_id = $1", [householdId]);
  const o = outbox.rows[0];
  return {
    feeds: feeds.map((f) => {
      const stale = f.last_synced_at ? hoursBetween(f.last_synced_at, now) : undefined;
      const row: Record<string, unknown> = { id: f.id, provider: f.provider, institutionName: f.institution_name ?? "", ownerMemberId: f.owner_member_id, ownerName: nameOf.get(f.owner_member_id) ?? "", status: f.needs_relink ? "needs_relink" : stale !== undefined && stale > 48 && f.status === "ok" ? "stale" : f.status, needsRelink: f.needs_relink, accountCount: countBy.get(f.id) ?? 0, cursorPresent: Boolean(f.cursor) };
      if (f.last_synced_at) row["lastSyncedAt"] = new Date(f.last_synced_at).toISOString();
      if (stale !== undefined) row["staleHours"] = Math.round(stale * 10) / 10;
      return row;
    }),
    ledger: { environment: conn?.bc_environment ?? "", companyId: conn?.bc_company_id ?? "", autoPostEnabled: conn?.auto_post_enabled ?? false, ...(conn?.last_poll_at ? { lastPollAt: new Date(conn.last_poll_at).toISOString() } : {}), ...(conn?.last_webhook_at ? { lastWebhookAt: new Date(conn.last_webhook_at).toISOString() } : {}) },
    webhooks: subs.rows.map((s) => ({ resource: s.resource, subscriptionId: s.subscription_id, expiresAt: new Date(s.expires_at).toISOString(), ...(s.last_renewed_at ? { lastRenewedAt: new Date(s.last_renewed_at).toISOString() } : {}), needsRenewal: new Date(s.expires_at).getTime() - now.getTime() < 24 * 3_600_000 })),
    outbox: { due: o?.due ?? 0, deadLettered: o?.dead ?? 0, ...(o?.oldest ? { oldestPendingAt: new Date(o.oldest).toISOString() } : {}) },
  };
}

export async function auditPage(db: Queryable, householdId: string, q: { limit: number; before?: string; entity?: string; entityId?: string }): Promise<{ entries: AuditEntry[]; next?: string }> {
  const where = ["household_id = $1"];
  const params: unknown[] = [householdId];
  if (q.before) {
    params.push(q.before);
    where.push(`at < $${params.length}`);
  }
  if (q.entity) {
    params.push(q.entity);
    where.push(`entity = $${params.length}`);
  }
  if (q.entityId) {
    params.push(q.entityId);
    where.push(`entity_id = $${params.length}`);
  }
  params.push(q.limit + 1);
  const r = await db.query<{ id: string; actor: string; action: string; entity: string; entity_id: string; before: unknown; after: unknown; at: string }>(`select id, actor, action, entity, entity_id, before, after, at from audit_log where ${where.join(" and ")} order by at desc limit $${params.length}`, params);
  const rows = r.rows.slice(0, q.limit);
  const entries: AuditEntry[] = rows.map((x) => {
    const e: AuditEntry = { id: x.id, actor: x.actor, action: x.action, entity: x.entity, entityId: x.entity_id, at: new Date(x.at).toISOString() };
    if (x.before !== null && x.before !== undefined) e.before = x.before;
    if (x.after !== null && x.after !== undefined) e.after = x.after;
    return e;
  });
  const out: { entries: AuditEntry[]; next?: string } = { entries };
  if (r.rows.length > q.limit && rows.length) out.next = new Date(rows[rows.length - 1]!.at).toISOString();
  return out;
}

export interface OutboxRow {
  id: string;
  aggregate: OutboxItem["aggregate"] | "household";
  aggregate_id: string;
  operation: string;
  payload: Record<string, unknown>;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  dead_lettered: boolean;
  published_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export const OUTBOX_COLS = "id, aggregate, aggregate_id, operation, payload, attempts, next_attempt_at, last_error, dead_lettered, published_at, completed_at, created_at";

export function toOutboxItem(o: OutboxRow): OutboxItem & { operation: string } {
  const dto: OutboxItem & { operation: string } = { id: o.id, aggregate: o.aggregate as OutboxItem["aggregate"], aggregateId: o.aggregate_id, operation: o.operation, attempts: o.attempts, nextAttemptAt: new Date(o.next_attempt_at).toISOString(), deadLettered: o.dead_lettered, createdAt: new Date(o.created_at).toISOString() };
  if (o.last_error) dto.lastError = o.last_error;
  if (o.published_at) dto.publishedAt = new Date(o.published_at).toISOString();
  if (o.completed_at) dto.completedAt = new Date(o.completed_at).toISOString();
  return dto;
}

export async function listOutbox(db: Queryable, householdId: string, opts: { state?: "due" | "dead" | "done" | "all"; limit?: number } = {}): Promise<OutboxRow[]> {
  const where = ["household_id = $1"];
  if (opts.state === "due") where.push("completed_at is null and not dead_lettered");
  else if (opts.state === "dead") where.push("dead_lettered and completed_at is null");
  else if (opts.state === "done") where.push("completed_at is not null");
  const r = await db.query<OutboxRow>(`select ${OUTBOX_COLS} from outbox where ${where.join(" and ")} order by created_at desc limit $2`, [householdId, Math.min(opts.limit ?? 100, 500)]);
  return r.rows;
}

/** Cade retries a dead-lettered row: it goes back to due with a fresh attempt counter; the pre-write check keeps it safe. */
export async function retryOutbox(db: Queryable, householdId: string, outboxId: string, memberId: string): Promise<OutboxRow> {
  const r = await db.query<OutboxRow>(`select ${OUTBOX_COLS} from outbox where id = $1 and household_id = $2`, [outboxId, householdId]);
  const row = r.rows[0];
  if (!row) throw notFound("outbox row");
  if (!row.dead_lettered || row.completed_at) throw conflict("not_dead_lettered", "Only a dead-lettered row can be retried");
  if (row.aggregate === "transaction" && row.operation === "send_to_bc") {
    const t = await db.query<{ state: string }>("select state from transactions where id = $1", [row.aggregate_id]);
    if (t.rows[0]?.state === "exception") {
      // Exception -> Ready for review is Cade's resolution; approving it again writes a fresh outbox row.
      throw conflict("resolve_exception_first", "This item is an exception. Resolve it to ready for review and approve it again; that sends it once more.");
    }
  }
  await db.query("update outbox set dead_lettered = false, attempts = 0, next_attempt_at = now(), published_at = null, last_error = null where id = $1", [outboxId]);
  if (row.aggregate === "transaction" && row.operation === "send_to_bc") {
    // The transaction sits in exception; the worker's pre-write check decides whether BC already has it.
    await db.query("update transactions set sync_status = 'pending' where id = $1 and state = 'exception'", [row.aggregate_id]);
  }
  await audit(db, householdId, { actor: memberId, action: "outbox.retried", entity: "outbox", entityId: outboxId, after: { operation: row.operation } });
  return (await db.query<OutboxRow>(`select ${OUTBOX_COLS} from outbox where id = $1`, [outboxId])).rows[0]!;
}

export async function settingsView(db: Queryable, householdId: string) {
  const hh = await getHousehold(db, householdId);
  const history = await db.query<{ version: number; effective_from: string; approved_by: string[] }>("select version, effective_from, approved_by from household_setting_versions where household_id = $1 order by version", [householdId]);
  return {
    version: hh.settings_version,
    settings: hh.settings,
    household: { id: hh.id, name: hh.name, timezone: hh.timezone, currency: hh.currency },
    history: history.rows.map((h) => ({ version: h.version, effectiveFrom: new Date(h.effective_from).toISOString(), approvedBy: h.approved_by })),
  };
}
