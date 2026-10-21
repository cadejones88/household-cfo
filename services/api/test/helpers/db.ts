/**
 * Integration-test plumbing: `describeDb` skips without DATABASE_URL (as rls.test.ts does); `seeded` creates a
 * fresh household per test file (unique name and Entra ids), so files never share rows and need no truncation.
 */
import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { closePool, getPool, withHousehold, type Queryable } from "../../src/db/index.js";
import { seedHousehold, type SeedOptions, type SeedResult } from "../../src/db/seed.js";
import type { HouseholdSettings } from "../../src/services/households.js";

export const DATABASE_URL = process.env["DATABASE_URL"];
export const describeDb = DATABASE_URL ? describe : describe.skip;

export async function seeded(label: string, opts: Omit<SeedOptions, "name" | "entraPrefix"> = {}): Promise<SeedResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const tag = randomUUID().slice(0, 8);
    const r = await seedHousehold(client, { ...opts, name: `Test ${label} ${tag}`, entraPrefix: `test-${label}-${tag}` });
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export function inHh<T>(hh: SeedResult | string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withHousehold(typeof hh === "string" ? hh : hh.householdId, fn);
}

/** Run `fn` and roll everything back (the household stays clean for the next case). */
export async function rolledBack<T>(hh: SeedResult, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.household_id', $1, true)", [hh.householdId]);
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

export async function setSettings(db: Queryable, householdId: string, patch: Partial<HouseholdSettings>): Promise<void> {
  await db.query("update households set settings = settings || $2::jsonb where id = $1", [householdId, JSON.stringify(patch)]);
}

export async function setAutoPost(db: Queryable, householdId: string, on: boolean): Promise<void> {
  await db.query("update ledger_connections set auto_post_enabled = $2 where household_id = $1", [householdId, on]);
}

/** Approve one of the seeded R1–R7 rules as Cade (proposed by "system"), with the written note auto-post needs. */
export async function approveSeedRule(db: Queryable, hh: SeedResult, ruleNo: string): Promise<void> {
  const { approveRule } = await import("../../src/services/rules.js");
  await approveRule(db, hh.householdId, hh.rules[ruleNo]!, hh.members.cade, { approvalNote: `Approved in writing for the test (${ruleNo})` });
}

export async function count(db: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) x`, params);
  return r.rows[0]!.n;
}

export { closePool };
