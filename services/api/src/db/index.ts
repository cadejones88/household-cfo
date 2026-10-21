/**
 * Database access with row-level security. Every unit of work runs inside `withHousehold`, which opens a
 * transaction and sets `app.household_id` for its duration, so a query can only ever see one household.
 */
import pg from "pg";
import { managedIdentityTokenProvider, POSTGRES_AAD_RESOURCE } from "../lib/managedIdentity.js";

export type Queryable = Pick<pg.PoolClient, "query">;

let pool: pg.Pool | undefined;

/**
 * The pool, from the environment:
 *  - DATABASE_URL (local development, CI, the migrator): a connection string.
 *  - otherwise PGHOST, PGUSER, PGDATABASE (and PGPORT) on Azure: Entra sign-in with the app's managed identity. The
 *    password is an access token for https://ossrdbms-aad.database.windows.net, fetched per new connection from a
 *    cache that refreshes five minutes before expiry (pg accepts an async password function). TLS is required.
 *    https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/how-to-connect-with-managed-identity
 */
export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env, tokenFor: (resource: string) => () => Promise<string> = managedIdentityTokenProvider): pg.PoolConfig {
  const ssl = env["PGSSLMODE"] === "disable" ? false : { rejectUnauthorized: true };
  const connectionString = env["DATABASE_URL"];
  if (connectionString) return { connectionString, max: 10, ssl };
  const host = env["PGHOST"];
  const user = env["PGUSER"];
  const database = env["PGDATABASE"];
  if (host && user && database) {
    return { host, user, database, port: Number(env["PGPORT"] ?? 5432), max: 10, ssl, password: tokenFor(POSTGRES_AAD_RESOURCE) };
  }
  throw new Error("Set DATABASE_URL, or PGHOST, PGUSER and PGDATABASE for managed-identity sign-in");
}

export function getPool(): pg.Pool {
  pool ??= new pg.Pool(poolConfigFromEnv());
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

/**
 * For jobs that iterate households. No household is set yet, so RLS would hide every row from the app role;
 * migration 0006's security-definer function returns the ids (ids only, never household data).
 */
export async function listHouseholdIds(db: Queryable): Promise<string[]> {
  const r = await db.query<{ id: string }>("select id from household_ids_fn()");
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
