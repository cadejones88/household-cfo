/**
 * Database access with row-level security. Every unit of work runs inside `withHousehold`, which opens a
 * transaction and sets `app.household_id` for its duration, so a query can only ever see one household.
 */
import pg from "pg";

export type Queryable = Pick<pg.PoolClient, "query">;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env["DATABASE_URL"];
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new pg.Pool({
      connectionString,
      max: 10,
      ssl: process.env["PGSSLMODE"] === "disable" ? false : { rejectUnauthorized: true },
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/** Run `fn` in one transaction scoped to `householdId`. Commits on return, rolls back on throw. */
export async function withHousehold<T>(householdId: string, fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.household_id', $1, true)", [householdId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** For jobs that iterate households: lists ids without RLS (requires the migrator/admin connection). */
export async function listHouseholdIds(db: Queryable): Promise<string[]> {
  const r = await db.query<{ id: string }>("select id from households order by created_at");
  return r.rows.map((x) => x.id);
}

export interface AuditInput {
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}

/** Append-only. The role cannot update or delete rows here. */
export async function audit(db: Queryable, householdId: string, a: AuditInput): Promise<void> {
  await db.query(
    "insert into audit_log (household_id, actor, action, entity, entity_id, before, after) values ($1,$2,$3,$4,$5,$6,$7)",
    [householdId, a.actor, a.action, a.entity, a.entityId, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after)],
  );
}

export interface OutboxInput {
  aggregate: "transaction" | "budget_revision" | "receipt" | "paycheck" | "household";
  aggregateId: string;
  operation: string;
  payload: unknown;
}

/** Written in the same transaction as the state change; a relay publishes it to Service Bus. */
export async function enqueueOutbox(db: Queryable, householdId: string, o: OutboxInput): Promise<string> {
  const r = await db.query<{ id: string }>(
    "insert into outbox (household_id, aggregate, aggregate_id, operation, payload) values ($1,$2,$3,$4,$5) returning id",
    [householdId, o.aggregate, o.aggregateId, o.operation, JSON.stringify(o.payload)],
  );
  return r.rows[0]!.id;
}
