/**
 * One household, the API app and the ports the acceptance suite drives: BC (mock or sandbox, see target.ts), Plaid
 * (the fake, with Link run once per login), Document Intelligence (fixture reads by image hash), the line mapper,
 * and BC's webhook calls routed into the app's own receiver.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "@homestead/api/app";
import { FakeDocumentIntelligence, FakePlaid, attachPlaidAccount, buildFakeDeps, getPool, linkItem, seedHousehold, withHousehold, type ClaudeMapperPort, type Deps, type MapLinesInput, type MappedLine, type Queryable, type ReceiptRead, type SeedResult } from "@homestead/api";
import { runJob, type JobName } from "@homestead/jobs";
import { sha256Hex } from "@homestead/shared";
import type { BcSide } from "./target.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const readFixture = <T>(rel: string): T => JSON.parse(readFileSync(path.resolve(here, rel), "utf8")) as T;

export interface ReceiptFixture {
  name?: string;
  imageText: string;
  read: ReceiptRead;
  lineCategories?: string[];
}

/** Maps each fixture line to the category the fixture names (groceries for A1's Broulim's lines). */
export class FixtureMapper implements ClaudeMapperPort {
  readonly byDescription = new Map<string, string>();
  add(f: ReceiptFixture, fallback = "groceries"): void {
    f.read.items.forEach((it, i) => this.byDescription.set(it.description, f.lineCategories?.[i] ?? fallback));
  }
  async mapLines(input: MapLinesInput): Promise<MappedLine[]> {
    return input.lines.map((l) => ({ lineNo: l.lineNo, categoryId: this.byDescription.get(l.description) ?? "general-merchandise", confidence: 0.95 }));
  }
}

/** Plaid account ids for the household cards the fake Item exposes. */
export const PLAID_ACCOUNTS: Record<string, string> = {
  "BEEHIVE-CHK": "plaid-beehive-chk",
  "BEEHIVE-SAV": "plaid-beehive-sav",
  "AFCU-CHK": "plaid-afcu-chk",
  "CAPONE-CC": "plaid-capone-cc",
  "MACU-SAV": "plaid-macu-sav",
};

export interface World {
  hh: SeedResult;
  app: Awaited<ReturnType<typeof buildApp>>;
  deps: Deps;
  plaid: FakePlaid;
  di: FakeDocumentIntelligence;
  mapper: FixtureMapper;
  accessToken: string;
  side: BcSide;
  job(name: JobName): Promise<unknown>;
  db<T>(fn: (db: Queryable) => Promise<T>): Promise<T>;
  addReceiptFixture(f: ReceiptFixture, fallback?: string): void;
  /** Queue a settled Plaid transaction (Plaid sign: positive = money out) for the next sync. */
  plaidTx(code: string, id: string, date: string, amount: number, name: string, merchant?: string): void;
  close(): Promise<void>;
}

export async function makeWorld(side: BcSide, label: string): Promise<World> {
  const client = await getPool().connect();
  let hh: SeedResult;
  try {
    await client.query("begin");
    const tag = randomUUID().slice(0, 8);
    hh = await seedHousehold(client, { name: `Acceptance ${label} ${tag}`, entraPrefix: `acc-${label}-${tag}` });
    await client.query("commit");
  } finally {
    client.release();
  }
  const plaid = new FakePlaid();
  const di = new FakeDocumentIntelligence((b) => sha256Hex(b));
  const mapper = new FixtureMapper();
  const deps = buildFakeDeps({ ledger: side.ledger, plaid, docIntel: di, mapper });
  const app = await buildApp({ logger: false, deps });
  await app.ready();
  // BC's handshakes and notifications land in the app's own receiver (mock); the sandbox needs a public URL, which a
  // guided A6 run provides: CI's temporary tunnel forwards to HH_RECEIVER_PORT, where startReceiver passes BC's
  // webhook route (and nothing else) into the app.
  const port = Number(process.env["HH_RECEIVER_PORT"] ?? "0");
  const receiver = side.kind === "sandbox" && port > 0 ? await startReceiver(app, port) : undefined;
  side.setReceiver(async (url, init) => {
    const u = new URL(url);
    const r = await app.inject({ method: (init.method ?? "POST") as "POST", url: `${u.pathname}${u.search}`, headers: { "content-type": String((init.headers as Record<string, string> | undefined)?.["content-type"] ?? "application/json") }, ...(init.body ? { payload: String(init.body) } : {}) });
    return new Response(r.body, { status: r.statusCode, headers: { "content-type": String(r.headers["content-type"] ?? "text/plain") } });
  });
  const accessToken = "access-sandbox-public-household";
  await withHousehold(hh.householdId, async (db) => {
    const l = await linkItem(db, hh.householdId, hh.members.cade, plaid, deps.secrets, { publicToken: "public-household", institutionId: "ins_afcu", institutionName: "America First CU" });
    for (const [code, plaidId] of Object.entries(PLAID_ACCOUNTS)) await attachPlaidAccount(db, hh.householdId, l.feedConnectionId, hh.accounts[code]!, plaidId, hh.members.cade);
  });
  return {
    hh,
    app,
    deps,
    plaid,
    di,
    mapper,
    accessToken,
    side,
    job: (name) => runJob(name, deps, [hh.householdId]),
    db: (fn) => withHousehold(hh.householdId, fn),
    addReceiptFixture(f, fallback) {
      di.receiptsBySha.set(sha256Hex(new TextEncoder().encode(f.imageText)), f.read);
      mapper.add(f, fallback);
    },
    plaidTx(code, id, date, amount, name, merchant) {
      plaid.queue(accessToken, { added: [{ transaction_id: id, account_id: PLAID_ACCOUNTS[code]!, amount, date, name, merchant_name: merchant ?? null, pending: false }], next_cursor: `c-${id}`, has_more: false });
    },
    close: async () => {
      if (receiver) await new Promise<void>((resolve) => receiver.close(() => resolve()));
      await app.close();
    },
  };
}

/** The only path the run's public receiver serves: the app's BC webhook route (handshake and notifications). */
export const WEBHOOK_PATH = "/v1/webhooks/bc";

/**
 * The run's public webhook receiver (A6 in the sandbox, behind CI's temporary tunnel). It answers BC's webhook route
 * only, by passing the request into the app, which checks the clientState of every notification as the deployed
 * receiver does. Every other path or method gets 404, so the test API (dev sign-in) is never reachable from outside.
 * Bodies over 1 MB are refused. It listens on 127.0.0.1 only; the tunnel is the one way in.
 */
export async function startReceiver(app: World["app"], port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://receiver.invalid");
    if (url.pathname !== WEBHOOK_PATH || (req.method !== "GET" && req.method !== "POST")) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      app
        .inject({ method: req.method as "GET" | "POST", url: `${url.pathname}${url.search}`, headers: { "content-type": String(req.headers["content-type"] ?? "application/json") }, ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}) })
        .then((r) => res.writeHead(r.statusCode, { "content-type": String(r.headers["content-type"] ?? "text/plain") }).end(r.body))
        .catch(() => res.writeHead(500).end());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

/** Dev sign-in headers for app.inject. */
export const as = (memberId: string, stepUp = false): Record<string, string> => ({ "x-dev-member": memberId, ...(stepUp ? { "x-step-up": "true" } : {}) });

export function multipart(fields: Record<string, string>, file: { name: string; contentType: string; bytes: Uint8Array }): { body: Buffer; headers: Record<string, string> } {
  const boundary = `----acceptance${randomUUID().replace(/-/g, "")}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.contentType}\r\n\r\n`), Buffer.from(file.bytes), Buffer.from("\r\n"), Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
