/**
 * The shim between this package's `LedgerPort` and the real Business Central adapter in
 * `packages/ledger-adapter-bc` (its README, "Wiring to services/api's LedgerPort"). One-to-one where the shapes
 * agree; the differences are handled here so neither side changes:
 *
 *   LedgerPort                                   LedgerAdapter (BusinessCentralAdapter)
 *   findByExternalDocumentNo(doc)                findByExternalDocumentNo(doc) -> journalLines[].id, ledgerEntries[].entryNumber
 *   createJournalLines({ batch, ... })           createJournalLines({ journalCode: batch, lines }) (accountNo -> accountNumber,
 *                                                externalDocumentNo -> externalDocumentNumber, dimensions -> dimensionSetLines);
 *                                                outcome already_in_journal / already_posted kept on the result
 *   readGlEntriesByExternalDocNo({ externalDocumentNo })            readGlEntriesByExternalDocNo(doc, { documentNumber })
 *   readGlEntriesByExternalDocNo({ externalDocumentNoStartsWith })  listAppDocuments({ source: "ledger", ... })
 *   readGlEntriesByExternalDocNo({ accountNoPrefix, dimension })    not in the adapter yet: a read-only OData GET on
 *                                                generalLedgerEntries through the adapter's own BcHttp (see below)
 *   readBankLedgerEntries({ bankAccountCode })   readBankLedgerEntries({ bankAccountNumber })
 *   writeBudgetEntries(entries with budgetName)  grouped by budget name, one writeBudgetEntries(name, entries) per group
 *   readBudget(name)                             readBudget(name).lines
 *   create/renew/deleteWebhookSubscription       subscriptions.create / renew(id, clientState) / delete
 *   listAppDocuments(query)                      listAppDocuments(filter)
 *   LedgerError(status, retryable, code)         BcRetryableError / BcNonRetryableError / LedgerAdapterError
 *
 * Every adapter error becomes a `LedgerError` so the BC worker's retry policy (408/429/5xx and network retry; the
 * rest dead-letters) reads one class. Messages are already scrubbed by the adapter.
 *
 * VERIFY on the sandbox (doc: https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/resources/dynamics_generalledgerentry):
 * the FUND_GOAL balance read filters `generalLedgerEntries` by `accountNumber ge '<prefix>' and accountNumber lt
 * '<prefix+1>'` with `$expand=dimensionSetLines` and sums client-side. That reads every cash-account entry; once the
 * ledger is large it belongs in the HH App Connector (a dimension-filtered balance page).
 */
import {
  BANK_CARD_LIST,
  DIMENSION_CODES,
  toBcDimensionSetLines,
  type BcDimensionSetLine,
  type DimensionCode,
  type DimensionSet,
} from "@homestead/shared";
import {
  BcHttp,
  BcNonRetryableError,
  BcRetryableError,
  BusinessCentralAdapter,
  CertificateCredential,
  LedgerAdapterError,
  StaticTokenProvider,
  type BatchFormat,
  type JournalLineInput,
  type MockBcServer,
  type TokenProvider,
} from "@homestead/ledger-adapter-bc";
import {
  LedgerError,
  type AppDocumentQuery,
  type AppDocumentRow,
  type BankLedgerEntry,
  type BankLedgerQuery,
  type BcBatch,
  type BudgetEntry,
  type BudgetEntryInput,
  type CreateJournalLinesInput,
  type CreateJournalLinesResult,
  type ExternalDocLookup,
  type GlEntry,
  type GlEntryQuery,
  type LedgerAccount,
  type LedgerBankAccount,
  type LedgerDimension,
  type LedgerPort,
  type WebhookSubscription,
} from "./ledgerPort.js";

const BATCHES: ReadonlySet<string> = new Set(["FEEDS", "RECEIPTS", "AUTOPOST"]);

function asBatch(code: string | undefined): BcBatch | undefined {
  return code && BATCHES.has(code) ? (code as BcBatch) : undefined;
}

/** Translate the adapter's error classes into the port's one class. */
export function toLedgerError(e: unknown): unknown {
  if (e instanceof LedgerError) return e;
  if (e instanceof BcRetryableError) return new LedgerError(e.message, e.status === 0 ? undefined : e.status, true, e.bc?.code, e.retryAfterMs);
  if (e instanceof BcNonRetryableError) return new LedgerError(e.message, e.status, false, e.code);
  if (e instanceof LedgerAdapterError) return new LedgerError(e.message, 400, false, "refused_by_adapter");
  return e;
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toLedgerError(e);
  }
}

function dimsToLines(d: DimensionSet): BcDimensionSetLine[] {
  const out: BcDimensionSetLine[] = [];
  for (const code of Object.keys(DIMENSION_CODES) as DimensionCode[]) {
    const v = d[code];
    if (v) out.push({ code, valueCode: v });
  }
  return out;
}

function linesToDims(lines: readonly BcDimensionSetLine[]): DimensionSet {
  const out: Record<string, string> = {};
  for (const l of lines) if (l.code in DIMENSION_CODES && l.valueCode) out[l.code] = l.valueCode;
  // Validates the values against the dictionary; an unknown value fails before anything reaches BC.
  toBcDimensionSetLines(out as DimensionSet);
  return out as DimensionSet;
}

/** "10" -> "11", "6031" -> "6032": the exclusive upper bound of an account-number prefix range. */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

function odataString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

interface RawGlEntry {
  entryNumber: number;
  postingDate: string;
  documentNumber: string;
  accountNumber: string;
  description?: string;
  debitAmount?: number;
  creditAmount?: number;
  dimensionSetLines?: { code: string; valueCode: string }[];
}

export class BcLedgerPort implements LedgerPort {
  constructor(readonly adapter: BusinessCentralAdapter) {}

  listAccounts(): Promise<LedgerAccount[]> {
    return wrap(async () => (await this.adapter.listAccounts()).map((a) => ({ number: a.number, displayName: a.displayName, category: a.category, blocked: a.blocked })));
  }

  listDimensions(): Promise<LedgerDimension[]> {
    return wrap(async () => (await this.adapter.listDimensions()).map((d) => ({ code: d.code, displayName: d.displayName, values: d.values.map((v) => ({ code: v.code, displayName: v.displayName })) })));
  }

  listBankAccounts(): Promise<LedgerBankAccount[]> {
    return wrap(async () =>
      (await this.adapter.listBankAccounts()).map((b) => {
        const out: LedgerBankAccount = { code: b.number, displayName: b.displayName };
        // The API's bankAccounts entity carries no G/L account; the household's cards are in the shared catalog.
        const gl = b.glAccount ?? BANK_CARD_LIST.find((c) => c.code === b.number)?.glAccount;
        if (gl) out.glAccount = gl;
        return out;
      }),
    );
  }

  findByExternalDocumentNo(externalDocumentNo: string): Promise<ExternalDocLookup> {
    return wrap(async () => {
      const r = await this.adapter.findByExternalDocumentNo(externalDocumentNo);
      const out: ExternalDocLookup = {
        externalDocumentNo,
        journalLineIds: r.journalLines.map((l) => l.id),
        glEntryNos: r.ledgerEntries.map((e) => e.entryNumber),
        lineCount: r.journalLines.length + r.ledgerEntries.length,
        sumCents: r.journalLines.reduce((s, l) => s + l.amountCents, 0) + r.ledgerEntries.reduce((s, e) => s + e.amountCents, 0),
      };
      const batch = asBatch(r.journalLines[0]?.journalCode);
      if (batch) out.batch = batch;
      return out;
    });
  }

  createJournalLines(input: CreateJournalLinesInput): Promise<CreateJournalLinesResult> {
    return wrap(async () => {
      const lines: JournalLineInput[] = input.lines.map((l) => {
        const line: JournalLineInput = {
          accountType: l.accountType,
          accountNumber: l.accountNo,
          postingDate: l.postingDate,
          amountCents: l.amountCents,
          description: l.description,
          externalDocumentNumber: input.externalDocumentNo,
          dimensionSetLines: l.dimensions.map((d) => ({ code: d.code, valueCode: d.valueCode })),
        };
        if (l.comment !== undefined) line.comment = l.comment;
        return line;
      });
      const r = await this.adapter.createJournalLines({ journalCode: input.batch, lines });
      if (r.outcome === "already_posted") return { journalId: "", lineIds: [], outcome: "already_posted", glEntryNos: r.entries.map((e) => e.entryNumber) };
      return { journalId: r.journalId, lineIds: r.lines.map((l) => l.id), outcome: r.outcome };
    });
  }

  postBatch(batch: BcBatch): Promise<void> {
    return wrap(() => this.adapter.postBatch(batch));
  }

  readGlEntriesByExternalDocNo(q: GlEntryQuery): Promise<GlEntry[]> {
    return wrap(async () => {
      if (q.externalDocumentNo) {
        const entries = await this.adapter.readGlEntriesByExternalDocNo(q.externalDocumentNo, q.documentNo ? { documentNumber: q.documentNo } : undefined);
        return entries
          .filter((e) => (!q.postingDateFrom || e.postingDate >= q.postingDateFrom) && (!q.postingDateTo || e.postingDate <= q.postingDateTo))
          .map((e) => {
            const g: GlEntry = {
              entryNo: e.entryNumber,
              postingDate: e.postingDate,
              accountNo: e.accountNumber,
              amountCents: e.amountCents,
              description: e.description,
              documentNo: e.documentNumber,
              externalDocumentNo: q.externalDocumentNo!,
              dimensions: e.dimensionSetLines.map((d) => ({ code: d.code, valueCode: d.valueCode })),
            };
            return g;
          });
      }
      if (q.externalDocumentNoStartsWith) {
        const filter: Parameters<BusinessCentralAdapter["listAppDocuments"]>[0] = { externalDocumentNoStartsWith: q.externalDocumentNoStartsWith, source: "ledger" };
        if (q.postingDateFrom) filter.postingDateFrom = q.postingDateFrom;
        if (q.postingDateTo) filter.postingDateTo = q.postingDateTo;
        const rows = await this.adapter.listAppDocuments(filter);
        return rows.map((r) => {
          const g: GlEntry = { entryNo: r.entryNumber ?? 0, postingDate: r.postingDate, accountNo: r.accountNumber, amountCents: r.amountCents, documentNo: r.documentNumber, externalDocumentNo: r.externalDocumentNumber, dimensions: [] };
          const b = asBatch(r.journalCode);
          if (b) g.batch = b;
          if (r.sourceCode) g.sourceCode = r.sourceCode;
          if (r.reasonCode) g.reasonCode = r.reasonCode;
          return g;
        });
      }
      return this.readGlEntriesByAccount(q);
    });
  }

  /** Balance reads for goals (FUND_GOAL set-asides on the cash accounts): read-only OData on generalLedgerEntries. */
  private async readGlEntriesByAccount(q: GlEntryQuery): Promise<GlEntry[]> {
    const terms: string[] = [];
    if (q.accountNoPrefix) terms.push(`accountNumber ge ${odataString(q.accountNoPrefix)}`, `accountNumber lt ${odataString(prefixUpperBound(q.accountNoPrefix))}`);
    if (q.postingDateFrom) terms.push(`postingDate ge ${q.postingDateFrom}`);
    if (q.postingDateTo) terms.push(`postingDate le ${q.postingDateTo}`);
    const http: BcHttp = this.adapter.http;
    const url = http.url("api/v2.0", `companies(${this.adapter.companyId})/generalLedgerEntries`, { ...(terms.length ? { $filter: terms.join(" and ") } : {}), $expand: "dimensionSetLines" });
    const rows = await http.getAll<RawGlEntry>(url);
    const out: GlEntry[] = [];
    for (const r of rows) {
      const dims = (r.dimensionSetLines ?? []).map((d) => ({ code: d.code, valueCode: d.valueCode }));
      if (q.dimension && !dims.some((d) => d.code === q.dimension!.code && d.valueCode === q.dimension!.valueCode)) continue;
      const debit = Math.round((r.debitAmount ?? 0) * 100);
      const credit = Math.round((r.creditAmount ?? 0) * 100);
      out.push({ entryNo: r.entryNumber, postingDate: r.postingDate, accountNo: r.accountNumber, amountCents: debit - credit, ...(r.description ? { description: r.description } : {}), documentNo: r.documentNumber, externalDocumentNo: "", dimensions: dims });
    }
    return out;
  }

  readBankLedgerEntries(q: BankLedgerQuery): Promise<BankLedgerEntry[]> {
    return wrap(async () => {
      const filter: Parameters<BusinessCentralAdapter["readBankLedgerEntries"]>[0] = {};
      if (q.bankAccountCode) filter.bankAccountNumber = q.bankAccountCode;
      if (q.externalDocumentNo) filter.externalDocumentNumber = q.externalDocumentNo;
      if (q.postingDateFrom) filter.postingDateFrom = q.postingDateFrom;
      if (q.postingDateTo) filter.postingDateTo = q.postingDateTo;
      if (q.open !== undefined) filter.open = q.open;
      return (await this.adapter.readBankLedgerEntries(filter)).map((e) => {
        const b: BankLedgerEntry = { entryNo: e.entryNumber, bankAccountCode: e.bankAccountNumber, postingDate: e.postingDate, amountCents: e.amountCents, open: e.open, reversed: e.reversed };
        if (e.documentNumber) b.documentNo = e.documentNumber;
        if (e.externalDocumentNumber) b.externalDocumentNo = e.externalDocumentNumber;
        if (e.statementNumber) b.statementNo = e.statementNumber;
        if (e.statementLineNumber) b.statementLineNo = e.statementLineNumber;
        if (e.closedAtDate) b.closedAtDate = e.closedAtDate;
        return b;
      });
    });
  }

  writeBudgetEntries(entries: readonly BudgetEntryInput[]): Promise<{ written: number }> {
    return wrap(async () => {
      const byName = new Map<string, BudgetEntryInput[]>();
      for (const e of entries) byName.set(e.budgetName, [...(byName.get(e.budgetName) ?? []), e]);
      let written = 0;
      // One change set per budget name (a revision is written whole or not at all).
      for (const [name, list] of byName) {
        const r = await this.adapter.writeBudgetEntries(
          name,
          list.map((e) => ({ glAccount: e.glAccount, date: e.date, amountCents: e.amountCents, description: e.description, dimensions: linesToDims(e.dimensions) })),
        );
        written += r.entryNumbers.length;
      }
      return { written };
    });
  }

  readBudget(budgetName: string): Promise<BudgetEntry[]> {
    return wrap(async () =>
      (await this.adapter.readBudget(budgetName)).lines.map((l) => ({ entryNo: l.entryNumber, budgetName: l.budgetName, glAccount: l.glAccount, date: l.date, amountCents: l.amountCents, description: l.description, dimensions: dimsToLines(l.dimensions) })),
    );
  }

  createWebhookSubscription(resource: string, notificationUrl: string, clientState: string): Promise<WebhookSubscription> {
    return wrap(async () => {
      if (resource !== "generalLedgerEntries" && resource !== "journals") throw new LedgerError(`Unsupported webhook resource ${resource}`, 400, false, "unsupported_resource");
      const s = await this.adapter.subscriptions.create({ resource, notificationUrl, clientState });
      return { subscriptionId: s.id, resource, notificationUrl: s.notificationUrl, clientState, expiresAt: s.expirationDateTime };
    });
  }

  renewWebhookSubscription(subscriptionId: string, clientState?: string): Promise<WebhookSubscription> {
    return wrap(async () => {
      // The PATCH resends clientState; without it the renewal would blank the secret, so refuse and let the job recreate.
      if (!clientState) throw new LedgerError("Renewal needs the subscription's clientState", 400, false, "client_state_required");
      const s = await this.adapter.subscriptions.renew(subscriptionId, clientState);
      return { subscriptionId: s.id, resource: s.resource, notificationUrl: s.notificationUrl, clientState, expiresAt: s.expirationDateTime };
    });
  }

  deleteWebhookSubscription(subscriptionId: string): Promise<void> {
    return wrap(() => this.adapter.subscriptions.delete(subscriptionId));
  }

  listAppDocuments(q: AppDocumentQuery): Promise<AppDocumentRow[]> {
    return wrap(async () => {
      const filter: Parameters<BusinessCentralAdapter["listAppDocuments"]>[0] = { externalDocumentNoStartsWith: q.externalDocumentNoStartsWith ?? "HHAPP-" };
      if (q.postingDateFrom) filter.postingDateFrom = q.postingDateFrom;
      if (q.postingDateTo) filter.postingDateTo = q.postingDateTo;
      if (q.source) filter.source = q.source;
      return (await this.adapter.listAppDocuments(filter)).map((r) => {
        const row: AppDocumentRow = { externalDocumentNo: r.externalDocumentNumber, source: r.source, postingDate: r.postingDate, accountNo: r.accountNumber, amountCents: r.amountCents, documentNo: r.documentNumber };
        const b = asBatch(r.journalCode);
        if (b) row.batch = b;
        if (r.lineId) row.lineId = r.lineId;
        if (r.entryNumber !== undefined) row.entryNo = r.entryNumber;
        if (r.sourceCode) row.sourceCode = r.sourceCode;
        if (r.reasonCode) row.reasonCode = r.reasonCode;
        return row;
      });
    });
  }
}

// Construction ------------------------------------------------------------------------------------

export interface BcLedgerConfig {
  tenantId: string;
  environment: string;
  companyId: string;
  /** The Entra app registration (client credentials with a certificate). */
  clientId: string;
  /** The PEM (key + certificate) read from Key Vault by name; by value here, never logged. */
  pem: string;
  journalTemplate?: string;
  /** False until the HH App Connector is published to the environment. */
  connectorInstalled?: boolean;
  /** Defaults to https://api.businesscentral.dynamics.com/v2.0. */
  apiBaseUrl?: string;
  batchFormat?: BatchFormat;
  fetch?: typeof fetch;
}

/** The real port for one BC environment: certificate credential -> BcHttp -> BusinessCentralAdapter -> shim. */
export function createBcLedgerPort(cfg: BcLedgerConfig): BcLedgerPort {
  const tokenProvider: TokenProvider = new CertificateCredential({ tenantId: cfg.tenantId, clientId: cfg.clientId, pem: cfg.pem, ...(cfg.fetch ? { fetch: cfg.fetch } : {}) });
  const root = (cfg.apiBaseUrl ?? "https://api.businesscentral.dynamics.com/v2.0").replace(/\/+$/, "");
  const http = new BcHttp({ baseUrl: `${root}/${cfg.tenantId}/${cfg.environment}`, tokenProvider, ...(cfg.fetch ? { fetch: cfg.fetch } : {}), ...(cfg.batchFormat ? { batchFormat: cfg.batchFormat } : {}) });
  const adapter = new BusinessCentralAdapter({ http, companyId: cfg.companyId, journalTemplate: cfg.journalTemplate ?? "HHAPP", connectorInstalled: cfg.connectorInstalled ?? true });
  return new BcLedgerPort(adapter);
}

/** The real adapter pointed at the in-process `MockBcServer` (integration and acceptance tests, no network). */
export function bcLedgerPortForMock(server: MockBcServer, opts: { connectorInstalled?: boolean; batchFormat?: BatchFormat } = {}): BcLedgerPort {
  const http = new BcHttp({ baseUrl: server.baseUrl, tokenProvider: new StaticTokenProvider(), fetch: server.fetch, timeoutMs: 10_000, ...(opts.batchFormat ? { batchFormat: opts.batchFormat } : {}) });
  const adapter = new BusinessCentralAdapter({ http, companyId: server.companyId, journalTemplate: server.journalTemplate, connectorInstalled: opts.connectorInstalled ?? server.connectorInstalled });
  return new BcLedgerPort(adapter);
}
