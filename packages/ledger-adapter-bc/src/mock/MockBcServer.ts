/**
 * MockBcServer: an in-process fake of the Business Central endpoints the adapter calls, with the documented shapes.
 * It exists because BC is unreachable from the build environment (brief: test against fakes that mirror the API).
 *
 * What it mirrors, and where that comes from
 *   companies, accounts, dimensions(+dimensionValues), bankAccounts, journals, journalLines, generalLedgerEntries,
 *   subscriptions, $batch                        API v2.0 reference pages and the BC 27 base-app pages 30018/30048/30049
 *   journals default to the first GENERAL template unless $filter=templateDisplayName is given   page 30048 OnFindRecord
 *   Document No. from the batch No. Series, shared by consecutive lines with the same External Document No.
 *                                                codeunit 5469 "Library API - General Journal"
 *   generalLedgerEntries has no externalDocumentNumber; filtering on it is a 400   page 30018 (Extensible = false)
 *   change sets are atomic; the batch runs in one transaction with Isolation: snapshot   OData 4 §11.7, use-odata-batch doc
 *   Microsoft.NAV.post posts the whole batch, 204, "There is nothing to post." when empty   page 30048
 *   subscriptions: validationToken handshake on POST and PATCH, 3-day expiry, clientState echoed, deleted on a non-retry reply
 *                                                dynamics-subscriptions doc
 *   HH App Connector pages hhJournalLineChecks, hhBankLedgerEntries, hhBudgetEntries   bc/hh-app-connector/src
 *   Analytics generalLedgerBudgets / generalLedgerBudgetEntries (read-only)             api-analytics-overview doc
 *
 * What it does not mirror (and the acceptance suite must prove on the sandbox)
 *   posting-date/period checks, posting groups, No. Series gaps, the full OData grammar, ETags, throttling.
 *
 * Use `server.fetch` as the adapter's fetch, or `await server.listen()` for a real http://127.0.0.1 port.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { BANK_CARD_LIST, CHART, DIMENSION_CODES, FAMILY_AREA, FUND_GOAL, PROJECT, SPEND_CLASS, TAX_TREATMENT, type DimensionCode } from "@homestead/shared";
import { FilterError, assertFilterFields, matchesFilter, parseFilter } from "./filter.js";
import { buildJsonBatchResponse, buildMultipartBatchResponse, parseJsonBatch, parseMultipartBatch, type InnerRequest, type InnerResponse } from "./multipart.js";

export interface MockBcServerOptions {
  tenantId?: string;
  environment?: string;
  companyId?: string;
  companyName?: string;
  journalTemplate?: string;
  batches?: string[];
  /** When false, the HH App Connector routes answer 404 as an environment without the extension would. */
  connectorInstalled?: boolean;
  now?: () => number;
  /** How the mock reaches a notificationUrl (handshake and notifications). Defaults to global fetch. */
  deliver?: (url: string, init: RequestInit) => Promise<Response>;
  /** Extra budgets to seed besides 2026-ORIG. */
  budgets?: string[];
}

export interface MockRequestLog {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  status: number;
}

interface MockLine {
  id: string;
  journalId: string;
  journalDisplayName: string;
  templateName: string;
  lineNumber: number;
  accountType: string;
  accountId: string;
  accountNumber: string;
  postingDate: string;
  documentNumber: string;
  externalDocumentNumber: string;
  amount: number;
  description: string;
  comment: string;
  lastModifiedDateTime: string;
  /** Not exposed on journalLines; stamped like the HH AutoPost Defaults subscriber and read through the connector. */
  sourceCode: string;
  reasonCode: string;
  dimensionSetLines: MockDimLine[];
}

interface MockDimLine {
  id: string;
  code: string;
  valueCode: string;
  displayName: string;
  valueId: string;
  valueDisplayName: string;
  parentId: string;
  parentType: string;
}

interface MockGlEntry {
  id: string;
  entryNumber: number;
  postingDate: string;
  documentNumber: string;
  documentType: string;
  accountId: string;
  accountNumber: string;
  description: string;
  debitAmount: number;
  creditAmount: number;
  additionalCurrencyDebitAmount: number;
  additionalCurrencyCreditAmount: number;
  lastModifiedDateTime: string;
  /** Internal: not exposed on generalLedgerEntries, only through the connector. */
  externalDocumentNumber: string;
  journalBatchName: string;
  sourceCode: string;
  reasonCode: string;
  dimensionSetLines: MockDimLine[];
}

interface MockBankLedgerEntry {
  entryNo: number;
  bankAccountNo: string;
  postingDate: string;
  amount: number;
  documentNo: string;
  externalDocumentNo: string;
  open: boolean;
  statementNo: string;
  statementLineNo: number;
  closedAtDate: string;
  reversed: boolean;
}

interface MockBudgetEntry {
  entryNo: number;
  budgetName: string;
  glAccountNo: string;
  date: string;
  amount: number;
  description: string;
  globalDimension1Code: string;
  globalDimension2Code: string;
  budgetDimension1Code: string;
  budgetDimension2Code: string;
  budgetDimension3Code: string;
  budgetDimension4Code: string;
}

interface MockSubscription {
  id: string;
  notificationUrl: string;
  resource: string;
  clientState: string;
  expirationDateTime: string;
  lastModifiedDateTime: string;
}

interface MockJournal {
  id: string;
  code: string;
  displayName: string;
  templateDisplayName: string;
  lastModifiedDateTime: string;
}

interface State {
  lines: MockLine[];
  glEntries: MockGlEntry[];
  bankLedger: MockBankLedgerEntry[];
  budgetEntries: MockBudgetEntry[];
  noSeries: Record<string, number>;
  nextLineNo: Record<string, number>;
  nextEntryNo: number;
  nextBankEntryNo: number;
  nextBudgetEntryNo: number;
}

type Handler = (ctx: Ctx) => Promise<Reply> | Reply;

interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw text body (batch responses). */
  text?: string;
}

interface OneShotFailure {
  match: { method?: string; pathIncludes?: string };
  reply: Reply;
  /** "before": refuse without doing the work; "after": do the work, then cut the connection (timeout after write). */
  when: "before" | "after";
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_TEMPLATE_NAME = "GENERAL";

export class MockBcServer {
  readonly tenantId: string;
  readonly environment: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly journalTemplate: string;
  readonly baseUrl: string;
  readonly log: MockRequestLog[] = [];
  readonly notifications: { url: string; body: unknown; status: number }[] = [];
  connectorInstalled: boolean;
  private nowFn: () => number;
  private offsetMs = 0;
  private readonly deliver: (url: string, init: RequestInit) => Promise<Response>;
  private readonly accounts: { id: string; number: string; displayName: string; category: string; subCategory: string; accountType: string; blocked: boolean; directPosting: boolean; lastModifiedDateTime: string }[];
  private readonly dimensions: { id: string; code: string; displayName: string; dimensionValues: { id: string; code: string; displayName: string }[] }[];
  private readonly bankAccounts: { id: string; number: string; displayName: string; blocked: boolean; lastModifiedDateTime: string; glAccount: string }[];
  private readonly journals: MockJournal[];
  private readonly budgets: Map<string, { name: string; description: string; blocked: boolean }>;
  private readonly subscriptions = new Map<string, MockSubscription>();
  private state: State;
  private readonly oneShots: OneShotFailure[] = [];
  private httpServer: Server | undefined;

  constructor(opts: MockBcServerOptions = {}) {
    this.tenantId = opts.tenantId ?? "00000000-0000-0000-0000-00000000c0de";
    this.environment = opts.environment ?? "CADE_Sandbox_vs25";
    this.companyId = opts.companyId ?? "11111111-2222-3333-4444-555555555555";
    this.companyName = opts.companyName ?? "Jones Household";
    this.journalTemplate = opts.journalTemplate ?? "HHAPP";
    this.connectorInstalled = opts.connectorInstalled ?? true;
    this.nowFn = opts.now ?? (() => Date.now());
    this.deliver = opts.deliver ?? ((url, init) => fetch(url, init));
    this.baseUrl = `https://api.businesscentral.dynamics.com/v2.0/${this.tenantId}/${this.environment}`;
    const stamp = new Date(this.now()).toISOString();

    this.accounts = CHART.map((a) => ({
      id: stableId("acct", a.no),
      number: a.no,
      displayName: a.name,
      category: categoryOf(a.no),
      subCategory: "",
      accountType: "Posting",
      blocked: false,
      directPosting: true,
      lastModifiedDateTime: stamp,
    }));
    const dimValues: Record<DimensionCode, readonly string[]> = { SPEND_CLASS, FUND_GOAL, FAMILY_AREA, TAX_TREATMENT, PROJECT };
    this.dimensions = (Object.keys(DIMENSION_CODES) as DimensionCode[]).map((code) => ({
      id: stableId("dim", code),
      code,
      displayName: code.replace("_", " "),
      dimensionValues: dimValues[code].map((v) => ({ id: stableId("dimval", `${code}:${v}`), code: v, displayName: v })),
    }));
    this.bankAccounts = BANK_CARD_LIST.map((b) => ({ id: stableId("bank", b.code), number: b.code, displayName: b.name, blocked: false, lastModifiedDateTime: stamp, glAccount: b.glAccount }));
    const batches = opts.batches ?? ["FEEDS", "RECEIPTS", "AUTOPOST"];
    this.journals = [
      { id: stableId("jnl", `${DEFAULT_TEMPLATE_NAME}:DEFAULT`), code: "DEFAULT", displayName: "Default Journal Batch", templateDisplayName: DEFAULT_TEMPLATE_NAME, lastModifiedDateTime: stamp },
      ...batches.map((b) => ({ id: stableId("jnl", `${this.journalTemplate}:${b}`), code: b, displayName: `Homestead ${b}`, templateDisplayName: this.journalTemplate, lastModifiedDateTime: stamp })),
    ];
    this.budgets = new Map(["2026-ORIG", ...(opts.budgets ?? [])].map((n) => [n, { name: n, description: `Budget ${n}`, blocked: false }]));
    this.state = { lines: [], glEntries: [], bankLedger: [], budgetEntries: [], noSeries: {}, nextLineNo: {}, nextEntryNo: 1, nextBankEntryNo: 1, nextBudgetEntryNo: 1 };
  }

  // ---- test controls -------------------------------------------------------------------------------------------

  now(): number {
    return this.nowFn() + this.offsetMs;
  }

  advanceTime(ms: number): void {
    this.offsetMs += ms;
  }

  /** Refuse the next matching request with this reply (e.g. 503) without doing its work. */
  failNext(match: OneShotFailure["match"], reply: Reply): void {
    this.oneShots.push({ match, reply, when: "before" });
  }

  /** Do the work of the next matching request, then make fetch throw as if the connection dropped (timeout after write). */
  cutConnectionAfterNext(match: OneShotFailure["match"]): void {
    this.oneShots.push({ match, reply: { status: 0 }, when: "after" });
  }

  seedBudget(name: string, description = ""): void {
    this.budgets.set(name, { name, description: description || `Budget ${name}`, blocked: false });
  }

  journalId(code: string, template = this.journalTemplate): string {
    const j = this.journals.find((x) => x.code === code && x.templateDisplayName === template);
    if (!j) throw new Error(`No journal ${template}/${code}`);
    return j.id;
  }

  /** Draft lines currently in a batch (test helper). */
  draftLines(code: string): readonly MockLine[] {
    const id = this.journalId(code);
    return this.state.lines.filter((l) => l.journalId === id);
  }

  postedEntries(): readonly MockGlEntry[] {
    return this.state.glEntries;
  }

  bankLedgerEntries(): readonly MockBankLedgerEntry[] {
    return this.state.bankLedger;
  }

  /** Simulates BC's bank reconciliation closing an entry against a statement line. */
  closeBankLedgerEntry(entryNo: number, statementNo: string, statementLineNo: number, closedAtDate: string): void {
    const e = this.state.bankLedger.find((x) => x.entryNo === entryNo);
    if (!e) throw new Error(`No bank ledger entry ${entryNo}`);
    e.open = false;
    e.statementNo = statementNo;
    e.statementLineNo = statementLineNo;
    e.closedAtDate = closedAtDate;
  }

  listSubscriptions(): readonly MockSubscription[] {
    return [...this.subscriptions.values()];
  }

  /** A fetch-compatible function for the adapter. */
  readonly fetch: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    return this.handle(req);
  };

  async listen(port = 0): Promise<string> {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const url = `http://127.0.0.1${req.url ?? "/"}`;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const method = req.method ?? "GET";
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const r = await this.handle(new Request(url, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: bodyText }) }));
      res.statusCode = r.status;
      r.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(await r.text());
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    this.httpServer = server;
    const addr = server.address();
    const actualPort = typeof addr === "object" && addr ? addr.port : port;
    return `http://127.0.0.1:${actualPort}/v2.0/${this.tenantId}/${this.environment}`;
  }

  async close(): Promise<void> {
    const s = this.httpServer;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    this.httpServer = undefined;
  }

  // ---- dispatch -------------------------------------------------------------------------------------------------

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const rawBody = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    const entry: MockRequestLog = { method: req.method, url: req.url, headers, body: rawBody, status: 0 };
    this.log.push(entry);
    const oneShot = this.takeOneShot(req.method, url.pathname);
    if (oneShot?.when === "before") {
      entry.status = oneShot.reply.status;
      return toResponse(oneShot.reply);
    }
    let reply: Reply;
    try {
      reply = await this.route(req.method, url, headers, rawBody);
    } catch (e) {
      reply = e instanceof FilterError ? odataError(400, "BadRequest", e.message) : odataError(500, "Internal_ServerError", e instanceof Error ? e.message : "mock failure");
    }
    entry.status = reply.status;
    if (oneShot?.when === "after") throw new TypeError("fetch failed: connection reset by peer (mock: timeout after write)");
    return toResponse(reply);
  }

  private takeOneShot(method: string, path: string): OneShotFailure | undefined {
    const i = this.oneShots.findIndex((f) => (!f.match.method || f.match.method === method) && (!f.match.pathIncludes || path.includes(f.match.pathIncludes)));
    if (i === -1) return undefined;
    return this.oneShots.splice(i, 1)[0];
  }

  private async route(method: string, url: URL, headers: Record<string, string>, rawBody: string): Promise<Reply> {
    const auth = headers.authorization ?? "";
    if (!/^Bearer\s+\S+/.test(auth)) return odataError(401, "Unauthorized", "The credentials provided are incorrect");
    const prefix = `/v2.0/${this.tenantId}/${this.environment}/`;
    if (!url.pathname.startsWith(prefix)) return odataError(404, "BadRequest_NotFound", "Environment not found");
    const path = url.pathname.slice(prefix.length);
    let body: unknown = undefined;
    if (rawBody && /json/i.test(headers["content-type"] ?? "")) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return odataError(400, "BadRequest", "Malformed JSON body");
      }
    }
    const ctx: Ctx = { method, path, query: url.searchParams, headers, body, rawBody };
    if (path === "api/v2.0/$batch" || path === "api/cadejonescpa/homestead/v1.0/$batch") return this.handleBatch(ctx);
    return this.routeSingle(ctx);
  }

  private routeSingle(ctx: Ctx): Promise<Reply> | Reply {
    const { method, path } = ctx;
    const seg = path.split("/");
    const api = seg.slice(0, seg[1] === "microsoft" ? 4 : seg[1] === "v2.0" ? 2 : 4).join("/");
    const rest = seg.slice(api.split("/").length);
    if (api === "api/v2.0") return this.routeV2(ctx, rest);
    if (api === "api/cadejonescpa/homestead/v1.0") {
      if (!this.connectorInstalled) return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI (the HH App Connector is not installed).");
      return this.routeConnector(ctx, rest);
    }
    if (api === "api/microsoft/analytics/v1.0") {
      if (method !== "GET") return odataError(405, "MethodNotAllowed", "The Analytics API is read-only.");
      return this.routeAnalytics(ctx, rest);
    }
    if (api === "api/microsoft/runtime/beta") return this.routeRuntime(ctx, rest);
    return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
  }

  // ---- API v2.0 -------------------------------------------------------------------------------------------------

  private async routeV2(ctx: Ctx, rest: string[]): Promise<Reply> {
    const { method } = ctx;
    const [head, ...tail] = rest;
    if (head === "companies" && tail.length === 0 && method === "GET") {
      return ok({ value: [{ id: this.companyId, systemVersion: "27.0.0.0", name: this.companyName, displayName: this.companyName, businessProfileId: "" }] });
    }
    const headKeyed = parseKeyed(head ?? "");
    if (headKeyed?.name === "subscriptions") return this.routeSubscriptions(ctx, headKeyed.key);
    const company = parseKeyed(head ?? "");
    if (company?.name !== "companies" || company.key !== this.companyId) return odataError(404, "BadRequest_NotFound", "Company not found");
    const [entity, ...more] = tail;
    const e = parseKeyed(entity ?? "");
    if (!e) return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
    switch (e.name) {
      case "accounts":
        if (method !== "GET") return odataError(405, "MethodNotAllowed", "accounts is read-only");
        return this.collection(ctx, this.accounts, ["id", "number", "displayName", "category", "subCategory", "accountType", "blocked", "directPosting", "lastModifiedDateTime"], e.key);
      case "dimensions": {
        if (method !== "GET") return odataError(405, "MethodNotAllowed", "dimensions is read-only");
        if (more[0] === "dimensionValues") {
          const d = this.dimensions.find((x) => x.id === e.key);
          return d ? ok({ value: d.dimensionValues }) : odataError(404, "BadRequest_NotFound", "Dimension not found");
        }
        const expand = (ctx.query.get("$expand") ?? "").includes("dimensionValues");
        const rows = this.dimensions.map((d) => (expand ? d : { id: d.id, code: d.code, displayName: d.displayName }));
        return this.collection(ctx, rows, ["id", "code", "displayName"], e.key);
      }
      case "bankAccounts":
        if (method !== "GET") return odataError(405, "MethodNotAllowed", "bankAccounts is read-only here");
        return this.collection(
          ctx,
          this.bankAccounts.map(({ glAccount: _gl, ...b }) => b),
          ["id", "number", "displayName", "blocked", "lastModifiedDateTime"],
          e.key,
        );
      case "journals":
        return this.routeJournals(ctx, e.key, more);
      case "journalLines":
        return this.routeJournalLine(ctx, e.key, more);
      case "generalLedgerEntries": {
        if (method !== "GET") return odataError(405, "MethodNotAllowed", "generalLedgerEntries is read-only");
        const expand = (ctx.query.get("$expand") ?? "").includes("dimensionSetLines");
        const exposed = ["id", "entryNumber", "postingDate", "documentNumber", "documentType", "accountId", "accountNumber", "description", "debitAmount", "creditAmount", "additionalCurrencyDebitAmount", "additionalCurrencyCreditAmount", "lastModifiedDateTime"];
        if (more[0] === "dimensionSetLines") {
          const g = this.state.glEntries.find((x) => x.id === e.key);
          return g ? ok({ value: g.dimensionSetLines }) : odataError(404, "BadRequest_NotFound", "Entry not found");
        }
        const rows = this.state.glEntries.map((g) => {
          const { externalDocumentNumber: _x, journalBatchName: _b, sourceCode: _s, reasonCode: _r, dimensionSetLines, ...pub } = g;
          return expand ? { ...pub, dimensionSetLines } : pub;
        });
        return this.collection(ctx, rows, exposed, e.key);
      }
      default:
        return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
    }
  }

  private collection(ctx: Ctx, rows: readonly Record<string, unknown>[], exposed: readonly string[], key: string | undefined): Reply {
    if (key !== undefined) {
      const row = rows.find((r) => r.id === key);
      return row ? ok(row) : odataError(404, "BadRequest_NotFound", `No entity with id ${key}`);
    }
    const terms = parseFilter(ctx.query.get("$filter"));
    assertFilterFields(terms, exposed);
    let out = rows.filter((r) => matchesFilter(r, terms, exposed));
    const top = Number(ctx.query.get("$top") ?? "0");
    if (top > 0) out = out.slice(0, top);
    return ok({ value: out });
  }

  private routeJournals(ctx: Ctx, key: string | undefined, more: string[]): Promise<Reply> | Reply {
    const { method } = ctx;
    if (key === undefined) {
      if (method !== "GET") return odataError(405, "MethodNotAllowed", "journals are managed in BC");
      const terms = parseFilter(ctx.query.get("$filter"));
      const templateTerm = terms.find((t) => t.field === "templateDisplayName");
      // Page 30048: without a template filter the default GENERAL template is listed.
      const template = templateTerm ? String(templateTerm.value) : DEFAULT_TEMPLATE_NAME;
      const rows = this.journals.filter((j) => j.templateDisplayName === template).filter((j) => matchesFilter(j as unknown as Record<string, unknown>, terms, ["id", "code", "displayName", "templateDisplayName", "lastModifiedDateTime"]));
      return ok({ value: rows });
    }
    const journal = this.journals.find((j) => j.id === key);
    if (!journal) return odataError(404, "BadRequest_NotFound", `The General Journal Batch with ID ${key} cannot be found.`);
    const [sub] = more;
    if (sub === undefined) return method === "GET" ? ok(journal) : odataError(405, "MethodNotAllowed", "journals are managed in BC");
    if (sub === "Microsoft.NAV.post") {
      if (method !== "POST") return odataError(405, "MethodNotAllowed", "post is an action");
      return this.postJournal(journal);
    }
    const subKeyed = parseKeyed(sub);
    if (subKeyed?.name === "journalLines") {
      if (subKeyed.key !== undefined) return this.routeJournalLine(ctx, subKeyed.key, more.slice(1));
      if (method === "GET") {
        const exposed = lineExposedFields();
        const rows = this.state.lines.filter((l) => l.journalId === journal.id).map(publicLine);
        return this.collection(ctx, rows, exposed, undefined);
      }
      if (method === "POST") return this.insertLine(journal, ctx.body);
      return odataError(405, "MethodNotAllowed", "");
    }
    return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
  }

  private routeJournalLine(ctx: Ctx, key: string | undefined, more: string[]): Reply {
    const { method } = ctx;
    if (key === undefined) {
      // Page 30049: a journal batch id or a system id filter is required.
      if (method === "GET") {
        const terms = parseFilter(ctx.query.get("$filter"));
        if (!terms.some((t) => t.field === "journalId" || t.field === "id")) return odataError(400, "BadRequest", "You must specify a journal batch ID or a journal ID to get a journal line.");
        return this.collection(ctx, this.state.lines.map(publicLine), lineExposedFields(), undefined);
      }
      return odataError(400, "BadRequest", "You must specify a journal batch ID or a journal ID to get a journal line.");
    }
    const line = this.state.lines.find((l) => l.id === key);
    if (!line) return odataError(404, "BadRequest_NotFound", `No journal line with id ${key}`);
    if (more[0] === "dimensionSetLines") {
      if (method === "GET") return ok({ value: line.dimensionSetLines });
      if (method === "POST") {
        const err = this.applyDimension(line, ctx.body as Record<string, unknown>, line.id, "Journal Line");
        return err ?? ok(line.dimensionSetLines[line.dimensionSetLines.length - 1], 201);
      }
      return odataError(405, "MethodNotAllowed", "");
    }
    if (method === "GET") return ok(publicLine(line));
    if (method === "DELETE") {
      this.state.lines = this.state.lines.filter((l) => l.id !== key);
      return { status: 204 };
    }
    if (method === "PATCH") {
      if (!ctx.headers["if-match"]) return odataError(428, "PreconditionRequired", "A PATCH request needs an If-Match header.");
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      if (typeof b.description === "string") line.description = b.description;
      if (typeof b.amount === "number") line.amount = b.amount;
      line.lastModifiedDateTime = new Date(this.now()).toISOString();
      return ok(publicLine(line));
    }
    return odataError(405, "MethodNotAllowed", "");
  }

  private insertLine(journal: MockJournal, body: unknown): Reply {
    const b = (body ?? {}) as Record<string, unknown>;
    const accountType = typeof b.accountType === "string" && b.accountType ? b.accountType : "G/L Account";
    if (accountType !== "G/L Account" && accountType !== "Bank Account") return odataError(400, "BadRequest", `Account Type ${accountType} is not allowed on this page.`);
    const accountNumber = String(b.accountNumber ?? "");
    let accountId = "";
    if (accountType === "G/L Account") {
      const a = this.accounts.find((x) => x.number === accountNumber);
      if (!a) return odataError(400, "BadRequest", 'The "accountNumber" does not match to an Account.');
      accountId = a.id;
    } else {
      const bank = this.bankAccounts.find((x) => x.number === accountNumber);
      if (!bank) return odataError(400, "BadRequest", 'The "accountNumber" does not match to an Account.');
      accountId = bank.id;
    }
    const postingDate = String(b.postingDate ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)) return odataError(400, "BadRequest", "Cannot convert the literal to Edm.Date.");
    const externalDocumentNumber = String(b.externalDocumentNumber ?? "");
    if (externalDocumentNumber.length > 35) return odataError(400, "BadRequest", `The length of the string is ${externalDocumentNumber.length}, but it must be less than or equal to 35 characters. Value: ${externalDocumentNumber}`);
    const description = String(b.description ?? "");
    if (description.length > 100) return odataError(400, "BadRequest", `The length of the string is ${description.length}, but it must be less than or equal to 100 characters.`);
    const comment = String(b.comment ?? "");
    if (comment.length > 250) return odataError(400, "BadRequest", `The length of the string is ${comment.length}, but it must be less than or equal to 250 characters.`);
    if (typeof b.amount !== "number" || !Number.isFinite(b.amount)) return odataError(400, "BadRequest", "Cannot convert the literal to Edm.Decimal.");
    const amount = Math.round(b.amount * 100) / 100;

    // Document No.: given, or from the batch No. Series; consecutive lines with the same External Document No. share it
    // (codeunit 5469 AlterDocNoBasedOnExternalDocNo).
    const batchLines = this.state.lines.filter((l) => l.journalId === journal.id);
    const last = batchLines[batchLines.length - 1];
    let documentNumber = typeof b.documentNumber === "string" && b.documentNumber ? b.documentNumber : "";
    if (!documentNumber) {
      if (last && last.externalDocumentNumber === externalDocumentNumber && externalDocumentNumber !== "") documentNumber = last.documentNumber;
      else documentNumber = this.nextDocumentNo(journal);
    }
    const lineNumber = typeof b.lineNumber === "number" && b.lineNumber > 0 ? b.lineNumber : (this.state.nextLineNo[journal.id] ?? 0) + 10000;
    this.state.nextLineNo[journal.id] = Math.max(this.state.nextLineNo[journal.id] ?? 0, lineNumber);
    const line: MockLine = {
      id: randomUUID(),
      journalId: journal.id,
      journalDisplayName: journal.code,
      templateName: journal.templateDisplayName,
      lineNumber,
      accountType,
      accountId,
      accountNumber,
      postingDate,
      documentNumber,
      externalDocumentNumber,
      amount,
      description,
      comment,
      lastModifiedDateTime: new Date(this.now()).toISOString(),
      // bc/hh-app-connector/src/HHAutoPostDefaults.Codeunit.al (BC change 6): HHAPP/AUTOPOST lines carry HHAUTO/AUTOPOST.
      sourceCode: journal.templateDisplayName === this.journalTemplate && journal.code === "AUTOPOST" ? "HHAUTO" : "GENJNL",
      reasonCode: journal.templateDisplayName === this.journalTemplate && journal.code === "AUTOPOST" ? "AUTOPOST" : "",
      dimensionSetLines: [],
    };
    // Deep insert of the dimensionSetLines part.
    const dims = Array.isArray(b.dimensionSetLines) ? (b.dimensionSetLines as Record<string, unknown>[]) : [];
    for (const d of dims) {
      const err = this.applyDimension(line, d, line.id, "Journal Line");
      if (err) return err;
    }
    this.state.lines.push(line);
    return ok(publicLine(line), 201);
  }

  private applyDimension(target: { dimensionSetLines: MockDimLine[] }, d: Record<string, unknown>, parentId: string, parentType: string): Reply | undefined {
    const code = String(d.code ?? "");
    const valueCode = String(d.valueCode ?? "");
    const dim = this.dimensions.find((x) => x.code === code || x.id === d.id);
    if (!dim) return odataError(400, "BadRequest", `The "code" does not match to a Dimension.`);
    const val = dim.dimensionValues.find((v) => v.code === valueCode || v.id === d.valueId);
    if (!val) return odataError(400, "Internal_RecordNotFound", `The Dimension Value does not exist. Identification fields and values: Dimension Code='${dim.code}',Code='${valueCode}'`);
    target.dimensionSetLines = target.dimensionSetLines.filter((x) => x.code !== dim.code);
    target.dimensionSetLines.push({ id: dim.id, code: dim.code, valueCode: val.code, displayName: dim.displayName, valueId: val.id, valueDisplayName: val.displayName, parentId, parentType });
    return undefined;
  }

  private nextDocumentNo(journal: MockJournal): string {
    const n = (this.state.noSeries[journal.id] ?? 0) + 1;
    this.state.noSeries[journal.id] = n;
    return `HH${journal.code.slice(0, 1)}${String(n).padStart(5, "0")}`;
  }

  private async postJournal(journal: MockJournal): Promise<Reply> {
    const lines = this.state.lines.filter((l) => l.journalId === journal.id);
    if (lines.length === 0) return odataError(400, "Application_DialogException", "There is nothing to post.");
    const groups = new Map<string, MockLine[]>();
    for (const l of lines) {
      const k = `${l.documentNumber}|${l.postingDate}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const [k, g] of groups) {
      const sum = Math.round(g.reduce((a, l) => a + l.amount, 0) * 100) / 100;
      if (sum !== 0) return odataError(400, "Application_DialogException", `Document No. ${k.split("|")[0]} is out of balance by ${sum.toFixed(2)}. Please check that Posting Date, Document No. and Amount are correct for each line.`);
      for (const l of g) {
        if (!l.accountNumber) return odataError(400, "Application_DialogException", "Account No. must have a value in Gen. Journal Line.");
      }
    }
    const stamp = new Date(this.now()).toISOString();
    for (const l of lines) {
      const glAccount = l.accountType === "Bank Account" ? (this.bankAccounts.find((b) => b.number === l.accountNumber)?.glAccount ?? "") : l.accountNumber;
      const acct = this.accounts.find((a) => a.number === glAccount);
      const entry: MockGlEntry = {
        id: randomUUID(),
        entryNumber: this.state.nextEntryNo,
        postingDate: l.postingDate,
        documentNumber: l.documentNumber,
        documentType: " ",
        accountId: acct?.id ?? "",
        accountNumber: glAccount,
        description: l.description,
        debitAmount: l.amount > 0 ? l.amount : 0,
        creditAmount: l.amount < 0 ? -l.amount : 0,
        additionalCurrencyDebitAmount: 0,
        additionalCurrencyCreditAmount: 0,
        lastModifiedDateTime: stamp,
        externalDocumentNumber: l.externalDocumentNumber,
        journalBatchName: journal.code,
        // Codeunit 12 copies the line's Source Code and Reason Code to the entry.
        sourceCode: l.sourceCode,
        reasonCode: l.reasonCode,
        dimensionSetLines: l.dimensionSetLines.map((d) => ({ ...d, parentType: "General Ledger Entry" })),
      };
      entry.dimensionSetLines.forEach((d) => {
        d.parentId = entry.id;
      });
      this.state.nextEntryNo += 1;
      this.state.glEntries.push(entry);
      if (l.accountType === "Bank Account") {
        this.state.bankLedger.push({
          entryNo: this.state.nextBankEntryNo,
          bankAccountNo: l.accountNumber,
          postingDate: l.postingDate,
          amount: l.amount,
          documentNo: l.documentNumber,
          externalDocumentNo: l.externalDocumentNumber,
          open: true,
          statementNo: "",
          statementLineNo: 0,
          closedAtDate: "0001-01-01",
          reversed: false,
        });
        this.state.nextBankEntryNo += 1;
      }
    }
    this.state.lines = this.state.lines.filter((l) => l.journalId !== journal.id);
    await this.notify("generalLedgerEntries", "collection", `api/v2.0/companies(${this.companyId})/generalLedgerEntries`);
    await this.notify("journals", "updated", `api/v2.0/companies(${this.companyId})/journals(${journal.id})`);
    return { status: 204 };
  }

  // ---- subscriptions -------------------------------------------------------------------------------------------

  private async routeSubscriptions(ctx: Ctx, id: string | undefined): Promise<Reply> {
    const { method } = ctx;
    if (id === undefined) {
      if (method === "GET") return ok({ value: [...this.subscriptions.values()].filter((s) => !this.expired(s)) });
      if (method === "POST") {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const notificationUrl = String(b.notificationUrl ?? "");
        const resource = String(b.resource ?? "");
        const clientState = typeof b.clientState === "string" ? b.clientState : "";
        if (!/^https:\/\//.test(notificationUrl)) return odataError(400, "BadRequest", "notificationUrl must be an https URL.");
        if (!this.supportedResources().includes(resource)) return odataError(400, "BadRequest", `The resource ${resource} is not supported for webhook subscriptions.`);
        if (clientState.length > 2048) return odataError(400, "BadRequest", "clientState is longer than 2048 characters.");
        const handshake = await this.handshake(notificationUrl);
        if (!handshake) return odataError(400, "BadRequest", "The subscription could not be validated: the notification URL did not echo the validationToken with status 200.");
        const now = this.now();
        const sub: MockSubscription = {
          id: randomUUID().replace(/-/g, "").slice(0, 20),
          notificationUrl,
          resource,
          clientState,
          expirationDateTime: new Date(now + THREE_DAYS_MS).toISOString(),
          lastModifiedDateTime: new Date(now).toISOString(),
        };
        this.subscriptions.set(sub.id, sub);
        return ok(sub, 201);
      }
      return odataError(405, "MethodNotAllowed", "");
    }
    const sub = this.subscriptions.get(id);
    if (!sub) return odataError(404, "BadRequest_NotFound", `Subscription ${id} not found`);
    if (method === "GET") return ok(sub);
    if (method === "DELETE") {
      this.subscriptions.delete(id);
      return { status: 204 };
    }
    if (method === "PATCH") {
      if (!ctx.headers["if-match"]) return odataError(428, "PreconditionRequired", "A PATCH request needs an If-Match header.");
      const b = (ctx.body ?? {}) as Record<string, unknown>;
      const handshake = await this.handshake(sub.notificationUrl);
      if (!handshake) return odataError(400, "BadRequest", "The subscription could not be validated: the notification URL did not echo the validationToken with status 200.");
      if (typeof b.clientState === "string") sub.clientState = b.clientState;
      if (typeof b.notificationUrl === "string" && b.notificationUrl) sub.notificationUrl = b.notificationUrl;
      const now = this.now();
      sub.expirationDateTime = new Date(now + THREE_DAYS_MS).toISOString();
      sub.lastModifiedDateTime = new Date(now).toISOString();
      return ok(sub);
    }
    return odataError(405, "MethodNotAllowed", "");
  }

  private supportedResources(): string[] {
    const c = `/api/v2.0/companies(${this.companyId})`;
    return ["generalLedgerEntries", "journals", "accounts", "bankAccounts", "dimensions", "customers", "items", "vendors"].map((r) => `${c}/${r}`);
  }

  private expired(s: MockSubscription): boolean {
    return Date.parse(s.expirationDateTime) <= this.now();
  }

  private async handshake(notificationUrl: string): Promise<boolean> {
    const token = randomUUID();
    const u = new URL(notificationUrl);
    u.searchParams.set("validationToken", token);
    try {
      const res = await this.deliver(u.toString(), { method: "POST", headers: { "content-type": "text/plain" } });
      const text = (await res.text()).trim();
      return res.status === 200 && text === token;
    } catch {
      return false;
    }
  }

  private async notify(resourceKind: string, changeType: string, resourcePath: string): Promise<void> {
    for (const s of [...this.subscriptions.values()]) {
      if (!s.resource.endsWith(`/${resourceKind}`)) continue;
      if (this.expired(s)) {
        this.subscriptions.delete(s.id);
        continue;
      }
      const body = {
        value: [{ subscriptionId: s.id, clientState: s.clientState, expirationDateTime: s.expirationDateTime, resource: resourcePath, changeType, lastModifiedDateTime: new Date(this.now()).toISOString() }],
      };
      let status = 0;
      try {
        const res = await this.deliver(s.notificationUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        status = res.status;
      } catch {
        status = 0;
      }
      this.notifications.push({ url: s.notificationUrl, body, status });
      // dynamics-subscriptions doc: 408, 429 and 5xx are retried; any other failure deletes the subscription.
      const retryable = status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
      if (!(status >= 200 && status < 300) && !retryable) this.subscriptions.delete(s.id);
    }
  }

  // ---- HH App Connector ---------------------------------------------------------------------------------------

  private routeConnector(ctx: Ctx, rest: string[]): Reply {
    const { method } = ctx;
    const company = parseKeyed(rest[0] ?? "");
    if (company?.name !== "companies" || company.key !== this.companyId) return odataError(404, "BadRequest_NotFound", "Company not found");
    const e = parseKeyed(rest[1] ?? "");
    switch (e?.name) {
      case "hhJournalLineChecks": {
        if (method !== "GET") return odataError(405, "MethodNotAllowed", "hhJournalLineChecks is read-only");
        const terms = parseFilter(ctx.query.get("$filter"));
        // HHJournalLineCheck.Page.al: a filter on externalDocumentNo (exact or startswith) is required; the other terms
        // are applied by the page to the buffer.
        const ext = terms.find((t) => t.field === "externalDocumentNo" && (t.op === "eq" || t.op === "startswith"));
        if (!ext) return odataError(400, "Application_DialogException", "hhJournalLineChecks needs a $filter on externalDocumentNo (an exact value or startswith).");
        const rows: Record<string, unknown>[] = [];
        let rowNo = 0;
        for (const l of this.state.lines) {
          rowNo += 1;
          rows.push({ rowNo, externalDocumentNo: l.externalDocumentNumber, source: "Journal", journalTemplateName: l.templateName, journalBatchName: l.journalDisplayName, lineNo: l.lineNumber, lineSystemId: l.id, entryNo: 0, documentNo: l.documentNumber, postingDate: l.postingDate, accountType: l.accountType, accountNo: l.accountNumber, amount: l.amount, dimensionSetId: 0, sourceCode: l.sourceCode, reasonCode: l.reasonCode });
        }
        for (const g of this.state.glEntries) {
          rowNo += 1;
          rows.push({ rowNo, externalDocumentNo: g.externalDocumentNumber, source: "Ledger", journalTemplateName: "", journalBatchName: g.journalBatchName, lineNo: 0, lineSystemId: "00000000-0000-0000-0000-000000000000", entryNo: g.entryNumber, documentNo: g.documentNumber, postingDate: g.postingDate, accountType: "G/L Account", accountNo: g.accountNumber, amount: g.debitAmount - g.creditAmount, dimensionSetId: 0, sourceCode: g.sourceCode, reasonCode: g.reasonCode });
        }
        return ok({ value: rows.filter((r) => matchesFilter(r, terms, ["rowNo", "externalDocumentNo", "source", "journalTemplateName", "journalBatchName", "lineNo", "lineSystemId", "entryNo", "documentNo", "postingDate", "accountType", "accountNo", "amount", "dimensionSetId", "sourceCode", "reasonCode"])) });
      }
      case "hhBankLedgerEntries": {
        if (method !== "GET") return odataError(405, "MethodNotAllowed", "hhBankLedgerEntries is read-only");
        const terms = parseFilter(ctx.query.get("$filter"));
        let rows = this.state.bankLedger.filter((r) => matchesFilter(r as unknown as Record<string, unknown>, terms, ["entryNo", "bankAccountNo", "postingDate", "amount", "documentNo", "externalDocumentNo", "open", "statementNo", "statementLineNo", "closedAtDate", "reversed"]));
        const top = Number(ctx.query.get("$top") ?? "0");
        if (top > 0) rows = rows.slice(0, top);
        return ok({ value: rows });
      }
      case "hhBudgetEntries": {
        if (method === "GET") {
          const terms = parseFilter(ctx.query.get("$filter"));
          return ok({ value: this.state.budgetEntries.filter((r) => matchesFilter(r as unknown as Record<string, unknown>, terms, budgetFields())) });
        }
        if (method === "POST") return this.insertBudgetEntry((ctx.body ?? {}) as Record<string, unknown>);
        return odataError(405, "MethodNotAllowed", "hhBudgetEntries allows insert and read only");
      }
      default:
        return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
    }
  }

  private insertBudgetEntry(b: Record<string, unknown>): Reply {
    const budgetName = String(b.budgetName ?? "").toUpperCase();
    if (!budgetName) return odataError(400, "BadRequest", "Budget Name must have a value in G/L Budget Entry.");
    if (budgetName.length > 10) return odataError(400, "BadRequest", `The length of the string is ${budgetName.length}, but it must be less than or equal to 10 characters. Value: ${budgetName}`);
    // HHBudgetEntries.Page.al OnInsertRecord: refuse *-ORIG; allow *-REV* and FCST* only.
    if (budgetName.endsWith("-ORIG")) return odataError(400, "Application_DialogException", `Budget ${budgetName} is an original budget and is never changed by the Homestead app.`);
    if (!budgetName.includes("-REV") && !budgetName.startsWith("FCST")) return odataError(400, "Application_DialogException", `Budget ${budgetName} is not a revision (*-REV*) or a forecast (FCST*).`);
    const budget = this.budgets.get(budgetName);
    if (!budget) return odataError(400, "Application_DialogException", `The field Budget Name of table G/L Budget Entry contains a value (${budgetName}) that cannot be found in the related table (G/L Budget Name).`);
    if (budget.blocked) return odataError(400, "Application_DialogException", `Budget ${budgetName} is blocked.`);
    const glAccountNo = String(b.glAccountNo ?? "");
    if (!this.accounts.some((a) => a.number === glAccountNo)) return odataError(400, "Application_DialogException", `The field G/L Account No. of table G/L Budget Entry contains a value (${glAccountNo}) that cannot be found in the related table (G/L Account).`);
    const date = String(b.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return odataError(400, "BadRequest", "Cannot convert the literal to Edm.Date.");
    if (typeof b.amount !== "number") return odataError(400, "BadRequest", "Cannot convert the literal to Edm.Decimal.");
    const description = String(b.description ?? "");
    if (description.length > 100) return odataError(400, "BadRequest", `The length of the string is ${description.length}, but it must be less than or equal to 100 characters.`);
    const dimFields: [keyof MockBudgetEntry, DimensionCode][] = [
      ["globalDimension1Code", "SPEND_CLASS"],
      ["globalDimension2Code", "FUND_GOAL"],
      ["budgetDimension1Code", "FAMILY_AREA"],
      ["budgetDimension2Code", "TAX_TREATMENT"],
      ["budgetDimension3Code", "PROJECT"],
    ];
    const entry: MockBudgetEntry = {
      entryNo: this.state.nextBudgetEntryNo,
      budgetName,
      glAccountNo,
      date,
      amount: Math.round(b.amount * 100) / 100,
      description,
      globalDimension1Code: "",
      globalDimension2Code: "",
      budgetDimension1Code: "",
      budgetDimension2Code: "",
      budgetDimension3Code: "",
      budgetDimension4Code: String(b.budgetDimension4Code ?? ""),
    };
    for (const [field, code] of dimFields) {
      const v = String(b[field] ?? "");
      if (v) {
        const dim = this.dimensions.find((d) => d.code === code);
        if (!dim?.dimensionValues.some((x) => x.code === v)) return odataError(400, "Internal_RecordNotFound", `The Dimension Value does not exist. Identification fields and values: Dimension Code='${code}',Code='${v}'`);
      }
      (entry as unknown as Record<string, unknown>)[field] = v;
    }
    this.state.nextBudgetEntryNo += 1;
    this.state.budgetEntries.push(entry);
    return ok(entry, 201);
  }

  // ---- Analytics -----------------------------------------------------------------------------------------------

  private routeAnalytics(ctx: Ctx, rest: string[]): Reply {
    const company = parseKeyed(rest[0] ?? "");
    if (company?.name !== "companies" || company.key !== this.companyId) return odataError(404, "BadRequest_NotFound", "Company not found");
    const e = parseKeyed(rest[1] ?? "");
    const terms = parseFilter(ctx.query.get("$filter"));
    // Field names as Microsoft's Power BI app queries publish them (queries 36961 "G/L Budgets" and 36960 "G/L Budget
    // Entries - PBI API", api/microsoft/analytics/v1.0): no description or dimension codes on the entries.
    if (e?.name === "generalLedgerBudgets") {
      const rows = [...this.budgets.values()].map((b) => ({ budgetName: b.name, budgetDescription: b.description }));
      return ok({ value: rows.filter((r) => matchesFilter(r, terms, ["budgetName", "budgetDescription"])) });
    }
    if (e?.name === "generalLedgerBudgetEntries") {
      const rows = this.state.budgetEntries.map((r) => ({ budgetName: r.budgetName, glAccountNo: r.glAccountNo, budgetDate: r.date, budgetAmount: r.amount, dimensionSetID: 0, entryNo: r.entryNo }));
      return ok({ value: rows.filter((r) => matchesFilter(r, terms, ["budgetName", "glAccountNo", "budgetDate", "budgetAmount", "entryNo"])) });
    }
    return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
  }

  // ---- runtime -------------------------------------------------------------------------------------------------

  private routeRuntime(ctx: Ctx, rest: string[]): Reply {
    const company = parseKeyed(rest[0] ?? "");
    if (company?.name !== "companies" || company.key !== this.companyId) return odataError(404, "BadRequest_NotFound", "Company not found");
    if (rest[1] === "webhookSupportedResources" && ctx.method === "GET") {
      const terms = parseFilter(ctx.query.get("$filter"));
      const rows = this.supportedResources().map((r) => ({ resource: r.replace(/^\/api\//, "") }));
      return ok({ value: rows.filter((r) => matchesFilter(r, terms, ["resource"])).map((r) => ({ resource: `/api/${r.resource}` })) });
    }
    return odataError(404, "BadRequest_NotFound", "No HTTP resource was found that matches the request URI.");
  }

  // ---- $batch --------------------------------------------------------------------------------------------------

  private async handleBatch(ctx: Ctx): Promise<Reply> {
    const ct = ctx.headers["content-type"] ?? "";
    let inner: InnerRequest[];
    let json = false;
    try {
      if (/multipart\/mixed/i.test(ct)) inner = parseMultipartBatch(ct, ctx.rawBody);
      else {
        json = true;
        inner = parseJsonBatch(JSON.parse(ctx.rawBody));
      }
    } catch (e) {
      return odataError(400, "BadRequest", `Malformed batch: ${e instanceof Error ? e.message : "unknown"}`);
    }
    const snapshotIsolation = (ctx.headers.isolation ?? "").toLowerCase() === "snapshot";
    const responses: InnerResponse[] = [];
    const groups = new Map<string | undefined, InnerRequest[]>();
    for (const r of inner) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    for (const [group, reqs] of groups) {
      // Business Central refuses a change set (multipart) or atomicity group (JSON) with more than one request; the
      // whole $batch answers 400 (seen on the sandbox 10/21/2026). Atomicity comes from `Isolation: snapshot` instead.
      if (group !== undefined && reqs.length > 1) return odataError(400, "BadRequest_NotSupported", "Multiple requests within the same change set are not supported by Dynamics 365 Business Central OData web services.");
      const atomic = group !== undefined || snapshotIsolation;
      const snapshot = atomic ? structuredClone(this.state) : undefined;
      const groupResponses: InnerResponse[] = [];
      let failed: InnerResponse | undefined;
      for (const r of reqs) {
        // Business Central resolves inner URLs relative to the batch's API root (its documented example uses
        // "items(…)"); an absolute URL with the tenant in it is not understood and the whole batch answers 404 for the
        // tenant segment (seen on the sandbox 10/21/2026, where GitHub masked the tenant id as '***').
        if (/^https?:\/\//i.test(r.url)) return odataError(404, "BadRequest_NotFound", `Resource not found for the segment '${this.tenantId}'.`);
        const apiRoot = ctx.path.replace(/\$batch$/, "");
        const u = new URL(r.url, `${this.baseUrl}/${apiRoot}`);
        const prefix = `/v2.0/${this.tenantId}/${this.environment}/`;
        if (!u.pathname.startsWith(prefix)) {
          failed = { contentId: r.contentId, status: 404, headers: {}, body: odataError(404, "BadRequest_NotFound", "Inner request URL is outside the environment").body };
          break;
        }
        const innerCtx: Ctx = { method: r.method, path: u.pathname.slice(prefix.length), query: u.searchParams, headers: { ...ctx.headers, ...r.headers }, body: r.body, rawBody: r.body === undefined ? "" : JSON.stringify(r.body) };
        const oneShot = this.takeOneShot(r.method, u.pathname);
        const reply = oneShot?.when === "before" ? oneShot.reply : await this.routeSingle(innerCtx);
        const resp: InnerResponse = { contentId: r.contentId, status: reply.status, headers: reply.headers ?? {}, body: reply.body };
        if (reply.status >= 400) {
          failed = resp;
          break;
        }
        groupResponses.push(resp);
      }
      if (failed) {
        if (snapshot) this.state = snapshot;
        // OData 4 §11.7.4: a failed change set yields one response for the set; BC returns the failing request's error.
        responses.push(failed);
      } else {
        responses.push(...groupResponses);
      }
    }
    const built = json ? buildJsonBatchResponse(responses) : buildMultipartBatchResponse(responses);
    return { status: 200, headers: { "content-type": built.contentType }, text: built.body };
  }
}

// ---- helpers ------------------------------------------------------------------------------------------------------

function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

function odataError(status: number, code: string, message: string): Reply {
  return { status, body: { error: { code, message: `${message}  CorrelationId:  ${randomUUID()}.` } } };
}

function toResponse(r: Reply): Response {
  const headers = new Headers(r.headers ?? {});
  if (r.text !== undefined) return new Response(r.text, { status: r.status, headers });
  if (r.body === undefined) return new Response(null, { status: r.status, headers });
  headers.set("content-type", "application/json; odata.metadata=minimal");
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}

/** `name(key)` → { name, key } with quotes stripped; `name` → { name, key: undefined }. */
function parseKeyed(segment: string): { name: string; key: string | undefined } | undefined {
  const m = /^([A-Za-z_][\w.]*)(?:\((.*)\))?$/.exec(segment);
  if (!m) return undefined;
  const raw = m[2];
  const key = raw === undefined ? undefined : raw.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
  return { name: m[1] ?? "", key };
}

function stableId(kind: string, key: string): string {
  // Deterministic GUID-shaped ids so tests can compare across runs.
  let h = 0;
  for (const ch of `${kind}:${key}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, "0");
  const k = key.replace(/[^0-9a-f]/gi, "").padEnd(12, "0").slice(0, 12).toLowerCase();
  return `${hex}-0000-4000-8000-${k}`;
}

function categoryOf(no: string): string {
  const first = no[0];
  if (first === "1") return "Assets";
  if (first === "2") return "Liabilities";
  if (first === "3") return "Equity";
  if (first === "4") return "Income";
  return "Expense";
}

function lineExposedFields(): string[] {
  return ["id", "journalId", "journalDisplayName", "lineNumber", "accountType", "accountId", "accountNumber", "postingDate", "documentNumber", "externalDocumentNumber", "amount", "description", "comment", "lastModifiedDateTime"];
}

function publicLine(l: MockLine): Record<string, unknown> {
  const { dimensionSetLines: _d, templateName: _t, sourceCode: _s, reasonCode: _r, ...pub } = l;
  return pub;
}

function budgetFields(): string[] {
  return ["entryNo", "budgetName", "glAccountNo", "date", "amount", "description", "globalDimension1Code", "globalDimension2Code", "budgetDimension1Code", "budgetDimension2Code", "budgetDimension3Code", "budgetDimension4Code"];
}
