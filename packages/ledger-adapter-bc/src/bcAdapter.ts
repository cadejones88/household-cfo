/**
 * The Business Central implementation of LedgerAdapter.
 *
 * Endpoints (spec section "Business Central API mapping"; verified against the BC 27 base-app source where noted):
 *   api/v2.0/companies({id})/accounts | dimensions?$expand=dimensionValues | bankAccounts
 *   api/v2.0/companies({id})/journals?$filter=templateDisplayName eq '<template>'   (page 30048 "APIV2 - Journals":
 *       without the template filter BC lists the batches of the first GENERAL template, not HHAPP)
 *   api/v2.0/companies({id})/journals({id})/journalLines   (page 30049; `externalDocumentNumber` is filterable; the
 *       `dimensionSetLines` part accepts a deep insert on POST; Document No. comes from the batch No. Series and is
 *       shared by consecutive lines with the same External Document No. — codeunit 5469 "Library API - General Journal")
 *   api/v2.0/companies({id})/journals({id})/Microsoft.NAV.post   -> 204 (page 30048 `post` action, result code Deleted)
 *   api/v2.0/companies({id})/generalLedgerEntries?$filter=documentNumber eq '…' and postingDate eq …&$expand=dimensionSetLines
 *       (page 30018 "APIV2 - G/L Entries" has NO externalDocumentNumber field and is not extensible, so the External
 *        Document No. lookup goes through the HH App Connector and the standard entity supplies the dimensions)
 *   api/v2.0/subscriptions   (https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-subscriptions)
 *   api/microsoft/runtime/beta/companies({id})/webhookSupportedResources
 *   api/microsoft/analytics/v1.0/companies({id})/generalLedgerBudgets | generalLedgerBudgetEntries  (read-only;
 *       https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-analytics/api-analytics-overview)
 *   api/cadejonescpa/homestead/v1.0/companies({id})/hhJournalLineChecks | hhBankLedgerEntries | hhBudgetEntries
 *       (the HH App Connector in bc/hh-app-connector)
 */
import { DIMENSION_CODES, EXTERNAL_DOC_MAX_LENGTH, EXTERNAL_DOC_RE, centsToNumber, parseCents, type BcDimensionSetLine, type DimensionCode, type DimensionSet } from "@homestead/shared";
import { LedgerAdapterError } from "./errors.js";
import { BcHttp, type BcHttpConfig } from "./http.js";
import { odataDate, odataString, type BatchRequest } from "./odata.js";
import type {
  BankLedgerEntry,
  BankLedgerEntryFilter,
  BudgetEntryInput,
  BudgetRead,
  BudgetReadOptions,
  CreateJournalLinesRequest,
  CreateJournalLinesResult,
  CreateSubscriptionRequest,
  ExternalDocLookup,
  JournalLineInput,
  LedgerAccount,
  LedgerAdapter,
  LedgerBankAccount,
  LedgerDimension,
  LedgerEntry,
  LedgerEntryRef,
  SubscriptionsApi,
  WebhookSubscription,
  WriteBudgetEntriesResult,
  WrittenJournalLine,
} from "./types.js";

export const API_V2 = "api/v2.0";
export const API_ANALYTICS = "api/microsoft/analytics/v1.0";
export const API_RUNTIME = "api/microsoft/runtime/beta";
export const CONNECTOR_PUBLISHER = "cadejonescpa";
export const CONNECTOR_GROUP = "homestead";
export const CONNECTOR_VERSION = "v1.0";
export const API_CONNECTOR = `api/${CONNECTOR_PUBLISHER}/${CONNECTOR_GROUP}/${CONNECTOR_VERSION}`;

export const DESCRIPTION_MAX = 100;
export const COMMENT_MAX = 250;
/** BC: G/L Budget Name.Name is Code[10]. */
export const BUDGET_NAME_MAX = 10;

/** Which BC budget field carries which household dimension (G/L Budget Entry has two globals plus four budget dimensions). */
export interface BudgetDimensionLayout {
  globalDimension1: DimensionCode;
  globalDimension2: DimensionCode;
  budgetDimension1?: DimensionCode;
  budgetDimension2?: DimensionCode;
  budgetDimension3?: DimensionCode;
  budgetDimension4?: DimensionCode;
}

export const DEFAULT_BUDGET_DIMENSION_LAYOUT: BudgetDimensionLayout = {
  globalDimension1: "SPEND_CLASS",
  globalDimension2: "FUND_GOAL",
  budgetDimension1: "FAMILY_AREA",
  budgetDimension2: "TAX_TREATMENT",
  budgetDimension3: "PROJECT",
};

export interface BcAdapterConfig {
  http: BcHttp | BcHttpConfig;
  companyId: string;
  /** The household journal template, HHAPP. */
  journalTemplate: string;
  /** False until the HH App Connector is published to the environment; then the connector answers the checks. */
  connectorInstalled: boolean;
  budgetDimensionLayout?: BudgetDimensionLayout;
}

interface BcJournal {
  id: string;
  code: string;
  displayName: string;
  templateDisplayName: string;
}

interface BcJournalLine {
  id: string;
  journalId: string;
  lineNumber: number;
  accountType: string;
  accountNumber: string;
  postingDate: string;
  documentNumber: string;
  externalDocumentNumber: string;
  amount: number;
  description: string;
  comment?: string;
}

interface BcGlEntry {
  id: string;
  entryNumber: number;
  postingDate: string;
  documentNumber: string;
  accountNumber: string;
  description: string;
  debitAmount: number;
  creditAmount: number;
  dimensionSetLines?: { code: string; valueCode: string }[];
}

/** One row of hhJournalLineChecks (bc/hh-app-connector/src/HHDocCheck.Page.al). */
interface ConnectorCheckRow {
  externalDocumentNo: string;
  source: "Journal" | "Ledger";
  journalTemplateName: string;
  journalBatchName: string;
  lineNo: number;
  lineSystemId: string;
  entryNo: number;
  documentNo: string;
  postingDate: string;
  accountType: string;
  accountNo: string;
  amount: number;
}

interface ConnectorBankLedgerEntry {
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

interface ConnectorBudgetEntry {
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

export function isOrigBudgetName(name: string): boolean {
  return /-ORIG$/i.test(name.trim());
}

/** The connector's whitelist, mirrored client-side: `*-REV*` or `FCST*`, never `*-ORIG`, at most 10 characters. */
export function assertWritableBudgetName(name: string): void {
  const n = name.trim();
  if (!n) throw new LedgerAdapterError("Budget name is required");
  if (n.length > BUDGET_NAME_MAX) throw new LedgerAdapterError(`Budget name "${n}" is longer than ${BUDGET_NAME_MAX} characters (BC Code[10])`);
  if (isOrigBudgetName(n)) throw new LedgerAdapterError(`Budget "${n}" is an original budget; -ORIG budgets are never written by the app`);
  if (!/-REV/i.test(n) && !/^FCST/i.test(n)) throw new LedgerAdapterError(`Budget "${n}" is not a revision (*-REV*) or a forecast (FCST*)`);
}

export function truncateDescription(s: string): string {
  return s.length > DESCRIPTION_MAX ? s.slice(0, DESCRIPTION_MAX) : s;
}

function dimsFromSetLines(lines: readonly { code: string; valueCode: string }[] | undefined): DimensionSet {
  const out: DimensionSet = {};
  for (const l of lines ?? []) {
    if (l.code in DIMENSION_CODES) (out as Record<string, string>)[l.code] = l.valueCode;
  }
  return out;
}

function toCents(n: number | undefined): number {
  return parseCents(n ?? 0);
}

export class BusinessCentralAdapter implements LedgerAdapter {
  readonly http: BcHttp;
  readonly companyId: string;
  readonly journalTemplate: string;
  readonly connectorInstalled: boolean;
  private readonly budgetLayout: BudgetDimensionLayout;
  private readonly journalIds = new Map<string, BcJournal>();
  readonly subscriptions: SubscriptionsApi;

  constructor(cfg: BcAdapterConfig) {
    this.http = cfg.http instanceof BcHttp ? cfg.http : new BcHttp(cfg.http);
    this.companyId = cfg.companyId;
    this.journalTemplate = cfg.journalTemplate;
    this.connectorInstalled = cfg.connectorInstalled;
    this.budgetLayout = cfg.budgetDimensionLayout ?? DEFAULT_BUDGET_DIMENSION_LAYOUT;
    this.subscriptions = {
      create: (req) => this.createSubscription(req),
      renew: (id, clientState) => this.renewSubscription(id, clientState),
      delete: (id) => this.deleteSubscription(id),
      list: () => this.listSubscriptions(),
    };
  }

  // ---- URLs ---------------------------------------------------------------------------------------------------

  private v2(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    return this.http.url(API_V2, `companies(${this.companyId})/${path}`, query);
  }

  private connector(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    return this.http.url(API_CONNECTOR, `companies(${this.companyId})/${path}`, query);
  }

  private analytics(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    return this.http.url(API_ANALYTICS, `companies(${this.companyId})/${path}`, query);
  }

  // ---- Master data --------------------------------------------------------------------------------------------

  async listCompanies(): Promise<{ id: string; name: string; displayName: string }[]> {
    return this.http.getAll(this.http.url(API_V2, "companies"));
  }

  async listAccounts(): Promise<LedgerAccount[]> {
    const rows = await this.http.getAll<Record<string, unknown>>(this.v2("accounts"));
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      number: String(r.number ?? ""),
      displayName: String(r.displayName ?? ""),
      category: String(r.category ?? ""),
      subCategory: String(r.subCategory ?? ""),
      accountType: String(r.accountType ?? ""),
      blocked: Boolean(r.blocked),
      directPosting: Boolean(r.directPosting),
      ...(typeof r.lastModifiedDateTime === "string" ? { lastModifiedDateTime: r.lastModifiedDateTime } : {}),
    }));
  }

  async listDimensions(): Promise<LedgerDimension[]> {
    const rows = await this.http.getAll<{ id: string; code: string; displayName: string; dimensionValues?: { id: string; code: string; displayName: string }[] }>(
      this.v2("dimensions", { $expand: "dimensionValues" }),
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      displayName: r.displayName,
      values: (r.dimensionValues ?? []).map((v) => ({ id: v.id, code: v.code, displayName: v.displayName })),
    }));
  }

  async listBankAccounts(): Promise<LedgerBankAccount[]> {
    const rows = await this.http.getAll<Record<string, unknown>>(this.v2("bankAccounts"));
    return rows.map((r) => ({
      id: String(r.id ?? ""),
      number: String(r.number ?? ""),
      displayName: String(r.displayName ?? ""),
      blocked: Boolean(r.blocked),
      ...(typeof r.lastModifiedDateTime === "string" ? { lastModifiedDateTime: r.lastModifiedDateTime } : {}),
    }));
  }

  // ---- Journals -----------------------------------------------------------------------------------------------

  async resolveJournal(journalCode: string): Promise<BcJournal> {
    const cached = this.journalIds.get(journalCode);
    if (cached) return cached;
    const rows = await this.http.getAll<BcJournal>(
      this.v2("journals", { $filter: `templateDisplayName eq ${odataString(this.journalTemplate)} and code eq ${odataString(journalCode)}` }),
    );
    const j = rows.find((r) => r.code === journalCode && r.templateDisplayName === this.journalTemplate);
    if (!j) throw new LedgerAdapterError(`Journal batch ${this.journalTemplate}/${journalCode} does not exist in company ${this.companyId}`);
    this.journalIds.set(journalCode, j);
    return j;
  }

  async findByExternalDocumentNo(externalDocumentNo: string, journalCode: string, hints?: { documentNumber?: string }): Promise<ExternalDocLookup> {
    assertExternalDocNo(externalDocumentNo);
    const journal = await this.resolveJournal(journalCode);
    if (this.connectorInstalled) {
      const rows = await this.http.getAll<ConnectorCheckRow>(this.connector("hhJournalLineChecks", { $filter: `externalDocumentNo eq ${odataString(externalDocumentNo)}` }));
      const journalLines: WrittenJournalLine[] = rows
        .filter((r) => r.source === "Journal")
        .map((r) => ({
          id: r.lineSystemId,
          lineNumber: r.lineNo,
          documentNumber: r.documentNo,
          externalDocumentNumber: r.externalDocumentNo,
          accountNumber: r.accountNo,
          amountCents: toCents(r.amount),
          postingDate: r.postingDate,
          journalCode: r.journalBatchName,
        }));
      const ledgerEntries: LedgerEntryRef[] = rows
        .filter((r) => r.source === "Ledger")
        .map((r) => ({ entryNumber: r.entryNo, documentNumber: r.documentNo, postingDate: r.postingDate, accountNumber: r.accountNo, amountCents: toCents(r.amount) }));
      return { externalDocumentNo, journalLines, ledgerEntries, answeredBy: "connector", ledgerCheckIncomplete: false };
    }
    // Two standard filters. journalLines exposes externalDocumentNumber; generalLedgerEntries does not, so the ledger
    // side can only be checked by a document number the caller already knows (stored after the draft was created).
    const lines = await this.http.getAll<BcJournalLine>(this.v2(`journals(${journal.id})/journalLines`, { $filter: `externalDocumentNumber eq ${odataString(externalDocumentNo)}` }));
    const journalLines = lines.map((l) => mapWrittenLine(l, journalCode));
    let ledgerEntries: LedgerEntryRef[] = [];
    let ledgerCheckIncomplete = true;
    const docNo = hints?.documentNumber ?? journalLines[0]?.documentNumber;
    if (docNo) {
      const entries = await this.http.getAll<BcGlEntry>(this.v2("generalLedgerEntries", { $filter: `documentNumber eq ${odataString(docNo)}` }));
      ledgerEntries = entries.map(mapEntryRef);
      ledgerCheckIncomplete = false;
    }
    return { externalDocumentNo, journalLines, ledgerEntries, answeredBy: "odata", ledgerCheckIncomplete };
  }

  async createJournalLines(req: CreateJournalLinesRequest): Promise<CreateJournalLinesResult> {
    const lines = validateLines(req.lines);
    const extDoc = lines[0]?.externalDocumentNumber ?? "";
    const journal = await this.resolveJournal(req.journalCode);

    // Pre-write check, every time (spec item 2 and 4): a retry after a timeout must find what the first try wrote.
    const found = await this.findByExternalDocumentNo(extDoc, req.journalCode);
    if (found.ledgerEntries.length > 0) return { outcome: "already_posted", entries: found.ledgerEntries };
    if (found.journalLines.length > 0) return { outcome: "already_in_journal", journalId: journal.id, lines: found.journalLines };

    const url = this.v2(`journals(${journal.id})/journalLines`);
    const requests: BatchRequest[] = lines.map((l) => ({ method: "POST", url, body: toBcLineBody(l) }));
    const parts = await this.http.batchChangeset(requests);
    const written = parts.map((p) => mapWrittenLine(p.body as BcJournalLine, req.journalCode));
    return { outcome: "written", journalId: journal.id, lines: written };
  }

  async postBatch(journalCode: string): Promise<void> {
    const journal = await this.resolveJournal(journalCode);
    const res = await this.http.post<unknown>(this.v2(`journals(${journal.id})/Microsoft.NAV.post`), {});
    if (res.status !== 204 && res.status !== 200) throw new LedgerAdapterError(`Post action returned ${res.status}, expected 204`);
  }

  // ---- Posted entries -----------------------------------------------------------------------------------------

  async readGlEntriesByExternalDocNo(externalDocumentNo: string, hints?: { documentNumber?: string; postingDate?: string }): Promise<LedgerEntry[]> {
    assertExternalDocNo(externalDocumentNo);
    let refs: LedgerEntryRef[] = [];
    let docNo = hints?.documentNumber;
    let postingDate = hints?.postingDate;
    if (this.connectorInstalled) {
      const rows = await this.http.getAll<ConnectorCheckRow>(this.connector("hhJournalLineChecks", { $filter: `externalDocumentNo eq ${odataString(externalDocumentNo)} and source eq 'Ledger'` }));
      refs = rows.map((r) => ({ entryNumber: r.entryNo, documentNumber: r.documentNo, postingDate: r.postingDate, accountNumber: r.accountNo, amountCents: toCents(r.amount) }));
      if (refs.length === 0) return [];
      docNo = docNo ?? refs[0]?.documentNumber;
      postingDate = postingDate ?? refs[0]?.postingDate;
    }
    if (!docNo) {
      throw new LedgerAdapterError("Reading posted entries by External Document No. needs the HH App Connector or a known document number (generalLedgerEntries has no externalDocumentNumber)");
    }
    const filter = postingDate ? `documentNumber eq ${odataString(docNo)} and postingDate eq ${odataDate(postingDate)}` : `documentNumber eq ${odataString(docNo)}`;
    const entries = await this.http.getAll<BcGlEntry>(this.v2("generalLedgerEntries", { $filter: filter, $expand: "dimensionSetLines" }));
    const wanted = refs.length > 0 ? new Set(refs.map((r) => r.entryNumber)) : undefined;
    return entries
      .filter((e) => !wanted || wanted.has(e.entryNumber))
      .map((e) => ({
        ...mapEntryRef(e),
        id: e.id,
        description: e.description,
        debitCents: toCents(e.debitAmount),
        creditCents: toCents(e.creditAmount),
        dimensions: dimsFromSetLines(e.dimensionSetLines),
        dimensionSetLines: (e.dimensionSetLines ?? []).map((d) => ({ code: d.code, valueCode: d.valueCode })),
        externalDocumentNumber: externalDocumentNo,
      }));
  }

  async readBankLedgerEntries(filter: BankLedgerEntryFilter): Promise<BankLedgerEntry[]> {
    this.requireConnector("hhBankLedgerEntries");
    const terms: string[] = [];
    if (filter.bankAccountNumber) terms.push(`bankAccountNo eq ${odataString(filter.bankAccountNumber)}`);
    if (filter.externalDocumentNumber) terms.push(`externalDocumentNo eq ${odataString(filter.externalDocumentNumber)}`);
    if (filter.postingDateFrom) terms.push(`postingDate ge ${odataDate(filter.postingDateFrom)}`);
    if (filter.postingDateTo) terms.push(`postingDate le ${odataDate(filter.postingDateTo)}`);
    if (filter.open !== undefined) terms.push(`open eq ${filter.open ? "true" : "false"}`);
    const query: Record<string, string | number | undefined> = { $filter: terms.length ? terms.join(" and ") : undefined, $top: filter.top };
    const rows = await this.http.getAll<ConnectorBankLedgerEntry>(this.connector("hhBankLedgerEntries", query));
    return rows.map((r) => ({
      entryNumber: r.entryNo,
      bankAccountNumber: r.bankAccountNo,
      postingDate: r.postingDate,
      amountCents: toCents(r.amount),
      documentNumber: r.documentNo,
      externalDocumentNumber: r.externalDocumentNo,
      open: r.open,
      statementNumber: r.statementNo ?? "",
      statementLineNumber: r.statementLineNo ?? 0,
      ...(r.closedAtDate && r.closedAtDate !== "0001-01-01" ? { closedAtDate: r.closedAtDate } : {}),
      reversed: Boolean(r.reversed),
    }));
  }

  // ---- Budgets ------------------------------------------------------------------------------------------------

  async writeBudgetEntries(budgetName: string, entries: readonly BudgetEntryInput[]): Promise<WriteBudgetEntriesResult> {
    assertWritableBudgetName(budgetName);
    this.requireConnector("hhBudgetEntries");
    if (entries.length === 0) throw new LedgerAdapterError("A budget revision needs at least one entry");
    const url = this.connector("hhBudgetEntries");
    const requests: BatchRequest[] = entries.map((e) => ({ method: "POST", url, body: this.toBudgetBody(budgetName.trim(), e) }));
    const parts = await this.http.batchChangeset(requests, API_CONNECTOR);
    return { budgetName: budgetName.trim(), entryNumbers: parts.map((p) => Number((p.body as ConnectorBudgetEntry).entryNo)) };
  }

  private toBudgetBody(budgetName: string, e: BudgetEntryInput): Record<string, unknown> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new LedgerAdapterError(`Budget entry date must be YYYY-MM-DD, got ${e.date}`);
    const L = this.budgetLayout;
    const dim = (code: DimensionCode | undefined): string => (code ? (e.dimensions[code] ?? "") : "");
    return {
      budgetName,
      glAccountNo: e.glAccount,
      date: e.date,
      amount: centsToNumber(e.amountCents),
      description: truncateDescription(e.description),
      globalDimension1Code: dim(L.globalDimension1),
      globalDimension2Code: dim(L.globalDimension2),
      budgetDimension1Code: dim(L.budgetDimension1),
      budgetDimension2Code: dim(L.budgetDimension2),
      budgetDimension3Code: dim(L.budgetDimension3),
      budgetDimension4Code: dim(L.budgetDimension4),
    };
  }

  /** Read-only through the Analytics API. Field names follow the base tables in camelCase; VERIFY against $metadata. */
  async readBudget(budgetName: string, opts: BudgetReadOptions = {}): Promise<BudgetRead> {
    const name = budgetName.trim();
    const budgets = await this.http.getAll<{ name: string; description?: string; blocked?: boolean }>(this.analytics("generalLedgerBudgets", { $filter: `name eq ${odataString(name)}` }));
    const b = budgets[0];
    if (!b) throw new LedgerAdapterError(`Budget ${name} does not exist`);
    const terms = [`budgetName eq ${odataString(name)}`];
    if (opts.dateFrom) terms.push(`date ge ${odataDate(opts.dateFrom)}`);
    if (opts.dateTo) terms.push(`date le ${odataDate(opts.dateTo)}`);
    if (opts.glAccount) terms.push(`glAccountNo eq ${odataString(opts.glAccount)}`);
    const rows = await this.http.getAll<ConnectorBudgetEntry>(this.analytics("generalLedgerBudgetEntries", { $filter: terms.join(" and ") }));
    const L = this.budgetLayout;
    return {
      budgetName: name,
      description: b.description ?? "",
      blocked: Boolean(b.blocked),
      lines: rows.map((r) => {
        const dims: DimensionSet = {};
        const put = (code: DimensionCode | undefined, value: string | undefined): void => {
          if (code && value) (dims as Record<string, string>)[code] = value;
        };
        put(L.globalDimension1, r.globalDimension1Code);
        put(L.globalDimension2, r.globalDimension2Code);
        put(L.budgetDimension1, r.budgetDimension1Code);
        put(L.budgetDimension2, r.budgetDimension2Code);
        put(L.budgetDimension3, r.budgetDimension3Code);
        put(L.budgetDimension4, r.budgetDimension4Code);
        return { entryNumber: r.entryNo, budgetName: r.budgetName, glAccount: r.glAccountNo, date: r.date, amountCents: toCents(r.amount), description: r.description ?? "", dimensions: dims };
      }),
    };
  }

  // ---- Webhooks -----------------------------------------------------------------------------------------------

  resourcePath(resource: CreateSubscriptionRequest["resource"]): string {
    return `/${API_V2}/companies(${this.companyId})/${resource}`;
  }

  private async createSubscription(req: CreateSubscriptionRequest): Promise<WebhookSubscription> {
    const res = await this.http.post<WebhookSubscription>(this.http.url(API_V2, "subscriptions"), {
      notificationUrl: req.notificationUrl,
      resource: this.resourcePath(req.resource),
      clientState: req.clientState,
    });
    return res.body;
  }

  /** PATCH renews (BC repeats the handshake); clientState is resent so a rotated secret takes effect. */
  private async renewSubscription(id: string, clientState: string): Promise<WebhookSubscription> {
    const res = await this.http.patch<WebhookSubscription>(this.http.url(API_V2, `subscriptions(${odataString(id)})`), { clientState });
    return res.body;
  }

  private async deleteSubscription(id: string): Promise<void> {
    await this.http.delete(this.http.url(API_V2, `subscriptions(${odataString(id)})`));
  }

  private async listSubscriptions(): Promise<WebhookSubscription[]> {
    return this.http.getAll<WebhookSubscription>(this.http.url(API_V2, "subscriptions"));
  }

  async webhookSupportedResources(): Promise<string[]> {
    const rows = await this.http.getAll<{ resource: string }>(this.http.url(API_RUNTIME, `companies(${this.companyId})/webhookSupportedResources`, { $filter: "resource eq 'v2.0*'" }));
    return rows.map((r) => r.resource);
  }

  private requireConnector(page: string): void {
    if (!this.connectorInstalled) throw new LedgerAdapterError(`${page} needs the HH App Connector, which is not installed in this environment`);
  }
}

// ---- helpers ----------------------------------------------------------------------------------------------------

export function assertExternalDocNo(doc: string): void {
  if (doc.length > EXTERNAL_DOC_MAX_LENGTH) throw new LedgerAdapterError(`External Document No. longer than ${EXTERNAL_DOC_MAX_LENGTH}`);
  if (!EXTERNAL_DOC_RE.test(doc)) throw new LedgerAdapterError(`External Document No. "${doc}" is not in the HHAPP-<SRC>-<yyyymmdd>-<hash8> form`);
}

/** Checks the invariants once, returns the lines with description/comment cut to BC's field lengths. */
export function validateLines(lines: readonly JournalLineInput[]): JournalLineInput[] {
  if (lines.length === 0) throw new LedgerAdapterError("A document needs at least one line");
  const extDoc = lines[0]?.externalDocumentNumber ?? "";
  assertExternalDocNo(extDoc);
  let sum = 0;
  const out: JournalLineInput[] = [];
  for (const l of lines) {
    if (l.externalDocumentNumber !== extDoc) throw new LedgerAdapterError("All lines of one document must share the External Document No.");
    if (!Number.isSafeInteger(l.amountCents) || l.amountCents === 0) throw new LedgerAdapterError("Line amount must be a non-zero integer number of cents");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.postingDate)) throw new LedgerAdapterError(`postingDate must be YYYY-MM-DD, got ${l.postingDate}`);
    if (!l.accountNumber) throw new LedgerAdapterError("Line needs an account number");
    sum += l.amountCents;
    const line: JournalLineInput = { ...l, description: truncateDescription(l.description) };
    if (l.comment !== undefined) line.comment = l.comment.slice(0, COMMENT_MAX);
    out.push(line);
  }
  if (sum !== 0) throw new LedgerAdapterError("Document lines must sum to zero");
  return out;
}

export function toBcLineBody(l: JournalLineInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    accountType: l.accountType,
    accountNumber: l.accountNumber,
    postingDate: l.postingDate,
    externalDocumentNumber: l.externalDocumentNumber,
    amount: centsToNumber(l.amountCents),
    description: truncateDescription(l.description),
    // Deep insert of the part (page 30049 has part dimensionSetLines; DelayedInsert pages accept nested collections).
    // VERIFY on the sandbox that the five dimensions come back on GET …/journalLines({id})/dimensionSetLines.
    dimensionSetLines: l.dimensionSetLines.map((d: BcDimensionSetLine) => ({ code: d.code, valueCode: d.valueCode })),
  };
  if (l.comment !== undefined) body.comment = l.comment.slice(0, COMMENT_MAX);
  return body;
}

function mapWrittenLine(l: BcJournalLine, journalCode: string): WrittenJournalLine {
  return {
    id: l.id,
    lineNumber: l.lineNumber,
    documentNumber: l.documentNumber,
    externalDocumentNumber: l.externalDocumentNumber,
    accountNumber: l.accountNumber,
    amountCents: toCents(l.amount),
    postingDate: l.postingDate,
    journalCode,
  };
}

function mapEntryRef(e: BcGlEntry): LedgerEntryRef {
  return {
    entryNumber: e.entryNumber,
    documentNumber: e.documentNumber,
    postingDate: e.postingDate,
    accountNumber: e.accountNumber,
    amountCents: toCents(e.debitAmount) - toCents(e.creditAmount),
  };
}
