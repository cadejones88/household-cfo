/**
 * The outbox relay and the BC worker (spec: "Idempotency and retries").
 *
 * Relay: due outbox rows are published to the queue (pointers only; the row is the truth) and a `send_to_bc` row
 * moves its transaction approved -> sent_to_bc. In-process now; Service Bus later behind the same QueuePort.
 *
 * Worker: consumes `send_to_bc` (pre-write check by External Document No., then createJournalLines as one
 * changeset, then line ids stored -> bc_draft_created), `write_budget_revision` (HH App Connector), `post_batch`
 * (AUTOPOST only, with the household switch on), `plaid_sync` and `bc_readback` requests. 408/429/5xx retry on
 * the schedule 1, 2, 4, 8, 16 minutes then hourly for a day; anything else dead-letters and raises an Exception.
 */
import {
  LedgerError,
  audit,
  isRetryableStatus,
  listFeeds,
  loadTx,
  raiseException,
  recordDraftCreated,
  recordPosted,
  syncFeed,
  transition,
  type BcBatch,
  type Deps,
  type LedgerJournalLine,
  type OutboxRow,
  type Queryable,
  OUTBOX_COLS,
} from "@homestead/api";
import { readBackHousehold } from "./readback.js";

export const OUTBOX_TOPIC = "homestead-outbox";

/** Minutes until the next attempt after `attempts` failures; undefined = dead-letter. */
export function retryDelayMinutes(attempts: number): number | undefined {
  const schedule = [1, 2, 4, 8, 16];
  if (attempts <= schedule.length) return schedule[attempts - 1];
  if (attempts <= schedule.length + 24) return 60;
  return undefined;
}

export async function dueOutboxRows(db: Queryable, householdId: string, now: Date, onlyPublished: boolean, limit = 200): Promise<OutboxRow[]> {
  const r = await db.query<OutboxRow>(
    `select ${OUTBOX_COLS} from outbox where household_id = $1 and completed_at is null and not dead_lettered and next_attempt_at <= $2 ${onlyPublished ? "and published_at is not null" : ""} order by created_at limit $3`,
    [householdId, now.toISOString(), limit],
  );
  return r.rows;
}

/** Publish due rows and move `send_to_bc` transactions to sent_to_bc (the relay's arrow). */
export async function relayOutbox(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "outbox-relay"): Promise<{ published: number; skipped: number }> {
  const rows = await db.query<OutboxRow>(`select ${OUTBOX_COLS} from outbox where household_id = $1 and completed_at is null and not dead_lettered and published_at is null and next_attempt_at <= $2 order by created_at limit 500`, [householdId, now.toISOString()]);
  let published = 0;
  let skipped = 0;
  for (const row of rows.rows) {
    if (row.operation === "send_to_bc") {
      const tx = await loadTx(db, row.aggregate_id);
      if (tx.state === "approved") {
        await transition(db, householdId, tx.id, "sent_to_bc", "relay", { actorId: actor, reason: "outbox row relayed to the queue" });
      } else if (tx.state !== "sent_to_bc") {
        // Corrected or superseded before relay: nothing to send.
        await db.query("update outbox set completed_at = now(), last_error = $2 where id = $1", [row.id, `not_relayed:${tx.state}`]);
        skipped += 1;
        continue;
      }
    }
    await deps.queue.publish(OUTBOX_TOPIC, { outboxId: row.id, householdId, operation: row.operation });
    await db.query("update outbox set published_at = now() where id = $1", [row.id]);
    published += 1;
  }
  return { published, skipped };
}

export interface WorkerCounts {
  processed: number;
  retried: number;
  deadLettered: number;
  skipped: number;
}

/** Process the published, due rows of one household. */
export async function workOutbox(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "bc-worker"): Promise<WorkerCounts> {
  const counts: WorkerCounts = { processed: 0, retried: 0, deadLettered: 0, skipped: 0 };
  for (const row of await dueOutboxRows(db, householdId, now, true)) {
    try {
      const outcome = await processOutboxRow(db, householdId, row, deps, now, actor);
      if (outcome === "done") {
        await db.query("update outbox set completed_at = now(), last_error = null where id = $1", [row.id]);
        counts.processed += 1;
      } else counts.skipped += 1;
    } catch (e) {
      const err = e as Error & { status?: number; retryable?: boolean };
      const retryable = err instanceof LedgerError ? err.retryable : isRetryableStatus(undefined) && !(err.name === "HttpError");
      const attempts = row.attempts + 1;
      const delay = retryable ? retryDelayMinutes(attempts) : undefined;
      if (delay !== undefined) {
        await db.query("update outbox set attempts = $2, next_attempt_at = $3, last_error = $4, published_at = null where id = $1", [row.id, attempts, new Date(now.getTime() + delay * 60_000).toISOString(), `${err.name}${err instanceof LedgerError && err.status ? ` ${err.status}` : ""}`]);
        counts.retried += 1;
        continue;
      }
      await db.query("update outbox set attempts = $2, dead_lettered = true, last_error = $3 where id = $1", [row.id, attempts, `${err.name}${err instanceof LedgerError && err.status ? ` ${err.status}` : ""}${err instanceof LedgerError && err.code ? ` ${err.code}` : ""}`]);
      await deps.queue.deadLetter({ id: row.id, topic: OUTBOX_TOPIC, body: { outboxId: row.id }, enqueuedAt: row.created_at }, err.name);
      counts.deadLettered += 1;
      if (row.operation === "send_to_bc") {
        const reason = `Business Central refused the write${err instanceof LedgerError && err.code ? ` (${err.code})` : ""}; it will not clear by retrying.`;
        await raiseException(db, householdId, row.aggregate_id, reason, "bc_worker", actor, { sync_status: "error" });
      } else {
        await audit(db, householdId, { actor, action: "outbox.dead_lettered", entity: "outbox", entityId: row.id, after: { operation: row.operation, error: err.name } });
      }
    }
  }
  return counts;
}

export async function processOutboxRow(db: Queryable, householdId: string, row: OutboxRow, deps: Deps, now: Date, actor: string): Promise<"done" | "skipped"> {
  switch (row.operation) {
    case "send_to_bc":
      return sendToBc(db, householdId, row, deps, actor);
    case "write_budget_revision": {
      const p = row.payload as { revisionId: string; entries: Parameters<Deps["ledger"]["writeBudgetEntries"]>[0] };
      await deps.ledger.writeBudgetEntries(p.entries);
      await db.query("update budget_revisions set written_to_bc_at = now() where id = $1", [p.revisionId]);
      await audit(db, householdId, { actor, action: "budget.revision_written", entity: "budget_revision", entityId: p.revisionId, after: { entries: p.entries.length } });
      return "done";
    }
    case "post_batch":
      return postBatch(db, householdId, row, deps, now, actor);
    case "plaid_sync": {
      const feed = (await listFeeds(db, householdId)).find((f) => f.id === row.aggregate_id);
      if (feed) await syncFeed(db, householdId, feed, deps.plaid, deps.secrets, actor);
      return "done";
    }
    case "bc_readback":
      await readBackHousehold(db, householdId, deps, now, actor);
      return "done";
    default:
      return "skipped";
  }
}

/** The write path with the pre-write check: never two documents for one key. */
async function sendToBc(db: Queryable, householdId: string, row: OutboxRow, deps: Deps, actor: string): Promise<"done" | "skipped"> {
  const payload = row.payload as { transactionId: string; externalDocumentNo: string; batch: BcBatch; lines: LedgerJournalLine[] };
  const tx = await loadTx(db, payload.transactionId);
  if (tx.state === "approved") await transition(db, householdId, tx.id, "sent_to_bc", "relay", { actorId: actor, reason: "in-process relay" });
  else if (tx.state !== "sent_to_bc") return "done"; // already a draft, posted, or corrected away
  const docNo = tx.bc_external_doc_no ?? payload.externalDocumentNo;
  const found = await deps.ledger.findByExternalDocumentNo(docNo);
  if (found.glEntryNos.length > 0) {
    // Already posted (a retry after a timeout, or Cade posted before the read-back ran).
    const entries = await deps.ledger.readGlEntriesByExternalDocNo({ externalDocumentNo: docNo });
    await recordDraftCreated(db, householdId, tx.id, { journalId: `journal-${payload.batch}`, lineIds: [] }, actor);
    await recordPosted(db, householdId, tx.id, { entryNos: found.glEntryNos, postingDate: entries[0]?.postingDate ?? tx.posted_date, ...(entries[0]?.documentNo ? { documentNo: entries[0].documentNo } : {}) }, "bc_worker", actor);
    return "done";
  }
  if (found.journalLineIds.length > 0) {
    await recordDraftCreated(db, householdId, tx.id, { journalId: `journal-${found.batch ?? payload.batch}`, lineIds: found.journalLineIds }, actor);
    await audit(db, householdId, { actor, action: "bc.pre_write_found", entity: "transaction", entityId: tx.id, after: { lineCount: found.journalLineIds.length } });
    return "done";
  }
  const created = await deps.ledger.createJournalLines({ batch: payload.batch, externalDocumentNo: docNo, lines: payload.lines });
  await recordDraftCreated(db, householdId, tx.id, created, actor);
  // Line ids follow the payload order: the bank side first, then one id per split.
  const splitLineIds = created.lineIds.slice(1);
  for (let i = 0; i < splitLineIds.length; i += 1) {
    await db.query("update transaction_splits set bc_line_id = $3 where transaction_id = $1 and line_no = $2", [tx.id, i + 1, splitLineIds[i]]);
  }
  return "done";
}

async function postBatch(db: Queryable, householdId: string, row: OutboxRow, deps: Deps, now: Date, actor: string): Promise<"done" | "skipped"> {
  const p = row.payload as { batch: BcBatch };
  const conn = await db.query<{ auto_post_enabled: boolean }>("select auto_post_enabled from ledger_connections where household_id = $1", [householdId]);
  const on = conn.rows[0]?.auto_post_enabled ?? false;
  if (p.batch !== "AUTOPOST" || !on) {
    await audit(db, householdId, { actor, action: "post.recorded_for_cade", entity: "batch", entityId: p.batch, after: { autoPostEnabled: on } });
    return "done";
  }
  const drafts = await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and bc_batch = 'AUTOPOST' and state = 'bc_draft_created'", [householdId]);
  if ((drafts.rows[0]?.n ?? 0) === 0) {
    await audit(db, householdId, { actor, action: "post.nothing_to_post", entity: "batch", entityId: p.batch });
    return "done";
  }
  await deps.ledger.postBatch("AUTOPOST");
  await audit(db, householdId, { actor, action: "post.autopost_posted", entity: "batch", entityId: "AUTOPOST", after: { drafts: drafts.rows[0]?.n } });
  await readBackHousehold(db, householdId, deps, now, actor);
  return "done";
}
