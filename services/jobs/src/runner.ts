/**
 * Shared job plumbing: every job iterates households inside `withHousehold` (RLS) and records one `sync_runs`
 * row per household with its counts, or the failure (scrubbed: the error's name only).
 */
import { getPool, listHouseholdIds, withHousehold, type Deps, type Queryable } from "@homestead/api";
import pino from "pino";

export type SyncKind = "plaid" | "bc_poll" | "bc_webhook" | "webhook_renewal" | "autopost" | "ocr" | "file_import" | "alerts" | "matching" | "outbox_relay" | "bc_worker" | "bc_readback" | "paycheck_fallback" | "receipt_fallback" | "rule_proposals";

export interface JobContext {
  deps: Deps;
  log: pino.Logger;
  now: Date;
  /** Job name used as the audit actor. */
  actor: string;
}

export type HouseholdJob = (db: Queryable, householdId: string, ctx: JobContext) => Promise<Record<string, number>>;

export interface JobRunResult {
  households: number;
  ok: number;
  failed: number;
  counts: Record<string, Record<string, number>>;
}

export const log = pino({ level: process.env["LOG_LEVEL"] ?? "info" });

/** Run `fn` for every household (or the ones given), each in its own transaction and sync_runs row. */
export async function runForHouseholds(kind: SyncKind, actor: string, deps: Deps, fn: HouseholdJob, householdIds?: readonly string[]): Promise<JobRunResult> {
  const ids = householdIds ?? (await listHouseholdIds(getPool()));
  const result: JobRunResult = { households: ids.length, ok: 0, failed: 0, counts: {} };
  for (const householdId of ids) {
    const ctx: JobContext = { deps, log: log.child({ job: kind }), now: deps.now(), actor };
    const runId = await withHousehold(householdId, async (db) => (await db.query<{ id: string }>("insert into sync_runs (household_id, kind, status) values ($1,$2,'running') returning id", [householdId, kind])).rows[0]!.id);
    try {
      const counts = await withHousehold(householdId, (db) => fn(db, householdId, ctx));
      await withHousehold(householdId, (db) => db.query("update sync_runs set status = 'ok', finished_at = now(), counts = $2 where id = $1", [runId, JSON.stringify(counts)]));
      result.counts[householdId] = counts;
      result.ok += 1;
    } catch (e) {
      const err = e as Error;
      ctx.log.error({ err: { type: err.name } }, `${kind} failed for a household`);
      await withHousehold(householdId, (db) => db.query("update sync_runs set status = 'failed', finished_at = now(), error = $2 where id = $1", [runId, `${err.name}: ${scrubMessage(err.message)}`])).catch(() => undefined);
      result.failed += 1;
    }
  }
  return result;
}

/** Keep error text free of amounts, masks and merchants: only the first word-ish token survives. */
export function scrubMessage(m: string): string {
  return m.replace(/\$?\d[\d,]*(\.\d+)?/g, "#").slice(0, 120);
}
