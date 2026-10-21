/** Integration plumbing for the jobs: a fresh seeded household per file, MockBcServer behind the real adapter. */
import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { MockBcServer } from "@homestead/ledger-adapter-bc";
import { approveTransaction, bcLedgerPortForMock, buildFakeDeps, getPool, importTransaction, seedHousehold, transition, withHousehold, type BcBatch, type Deps, type Queryable, type SeedResult } from "@homestead/api";
import { idempotencyKey } from "@homestead/shared";

export const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

export async function seeded(label: string): Promise<SeedResult> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const tag = randomUUID().slice(0, 8);
    const r = await seedHousehold(client, { name: `Jobs ${label} ${tag}`, entraPrefix: `jobs-${label}-${tag}`, today: "2026-10-20" });
    await client.query("commit");
    return r;
  } finally {
    client.release();
  }
}

export function inHh<T>(hh: SeedResult, fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withHousehold(hh.householdId, fn);
}

/** A receiver like the API's: echoes the validationToken with 200 and answers notifications 202. */
export function echoReceiver(sink: unknown[] = []): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const token = new URL(url).searchParams.get("validationToken");
    if (token) return new Response(token, { status: 200, headers: { "content-type": "text/plain" } });
    sink.push(JSON.parse(String(init.body ?? "{}")));
    return new Response("", { status: 202 });
  };
}

export function mockBc(deliver?: (url: string, init: RequestInit) => Promise<Response>, now?: () => number): { server: MockBcServer; deps: Deps } {
  const server = new MockBcServer({ deliver: deliver ?? echoReceiver(), budgets: ["BUD26-REV"], ...(now ? { now } : {}) });
  const deps = buildFakeDeps({ ledger: bcLedgerPortForMock(server) });
  return { server, deps };
}

let seq = 0;
/** Import a line and approve it with a category, the way a member's one tap does; returns the transaction id. */
export async function approvedTx(hh: SeedResult, opts: { code?: string; amountCents?: number; merchant?: string; categoryId?: string; date?: string; batch?: BcBatch } = {}): Promise<string> {
  seq += 1;
  return inHh(hh, async (db) => {
    const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts[opts.code ?? "CAPONE-CC"]!, source: "plaid", sourceRef: `j${seq}-${randomUUID().slice(0, 6)}`, idempotencyKey: idempotencyKey.plaid("jobs", `${seq}-${randomUUID().slice(0, 8)}`), postedDate: opts.date ?? "2026-10-15", amountCents: opts.amountCents ?? -6233, merchantRaw: opts.merchant ?? "BROULIMS REXBURG" }, "test");
    await transition(db, hh.householdId, t.transaction.id, "needs_classification", "jobs");
    await transition(db, hh.householdId, t.transaction.id, "ready_for_review", "rule_engine");
    await approveTransaction(db, hh.householdId, t.transaction.id, "member", { categoryId: opts.categoryId ?? "groceries", actorId: hh.members.vanessa, ...(opts.batch ? { batch: opts.batch } : {}) });
    return t.transaction.id;
  });
}

/** Call a mock BC endpoint directly (what Cade does in BC's own client). */
export async function bcCall(server: MockBcServer, method: string, path: string, body?: unknown): Promise<Response> {
  return server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/${path}`, { method, headers: { authorization: "Bearer cade", "content-type": "application/json", "if-match": "*" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
