/**
 * The Business Central implementation of LedgerAdapter.
 *
 * Endpoints (spec section "Business Central API mapping"; verified against the BC 27 base-app source where noted):
 *   api/v2.0/companies({id})/accounts | dimensions?$expand=dimensionValues | bankAccounts
 *   api/v2.0/companies({id})/journals?$filter=templateDisplayName eq '<template>'   (page 30016 "APIV2 - Journals":
 *       without the template filter BC lists the batches of the first GENERAL template, not HHAPP)
 *   api/v2.0/companies({id})/journals({id})/journalLines   (page 30049; `externalDocumentNumber` is filterable; the
 *       `dimensionSetLines` part accepts a deep insert on POST; Document No. comes from the batch No. Series and is
 *       shared by consecutive lines with the same External Document No. — codeunit 5469 "Library API - General Journal")
 *   api/v2.0/companies({id})/journals({id})/Microsoft.NAV.post   -> 204 (page 30016 `post` action, result code Deleted)
 *   api/v2.0/companies({id})/generalLedgerEntries?$filter=documentNumber eq '…' and postingDate eq …&$expand=dimensionSetLines
 *       (page 30018 "APIV2 - G/L Entries" has NO externalDocumentNumber field and is not extensible, so the External
 *        Document No. lookup goes through the HH App Connector and the standard entity supplies the dimensions)
 *   api/v2.0/subscriptions   (https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-subscriptions)
 *   api/microsoft/runtime/beta/companies({id})/webhookSupportedResources
 *   api/cadejonescpa/homestead/v1.0/companies({id})/hhJournalLineChecks | hhBankLedgerEntries | hhBudgetEntries
 *       (the HH App Connector in bc/hh-app-connector; budgets are written and read back through hhBudgetEntries)
 *   api/v2.0/$batch and api/cadejonescpa/homestead/v1.0/$batch: JSON, no atomicity group, header Isolation: snapshot
 *
 * Page numbers are the API v2 app's (_Exclude_APIV2_, 10cb69d9-bc8a-4d27-970a-9e110e9db2a5): 30014 Accounts,
 * 30016 Journals, 30018 G/L Entries, 30021 Dimensions, 30022 Dimension Set Lines, 30040 Dimension Values,
 * 30049 JournalLines, 30051 Bank Accounts. The application needs Execute on each (HH-APP lists them); without it BC
 * answers 403 "Sorry, the current permissions prevented the action. (Page 30016 APIV2 - Journals Execute: …)".
 */
import { DIMENSION_CODES, EXTERNAL_DOC_MAX_LENGTH, EXTERNAL_DOC_RE, centsToNumber, parseCents, type BcDimensionSetLine, type DimensionCode, type DimensionSet } from "@homestead/shared";
import { LedgerAdapterError } from "./errors.js";
import { BcHttp, type BcHttpConfig } from "./http.js";
import { odataDate, odataString, type BatchRequest } from "./odata.js";
import type {
  AppDocumentFilter,
  AppDocumentRow,
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

/**
 * As the household's G/L Budget Name cards have it (BUD26-ORIG/-REV, BUD27-*, FCST2026/2027 in the sandbox, read
 * 10/21/2026): Budget Dimension 1 FAMILY_AREA, 2 PROJECT, 3-4 blank. TAX_TREATMENT is not a budget dimension, so it
 * is not written to budget entries. The first sandbox write with the old layout put NONDEDUCT in the PROJECT slot
 * ("Dimension Value PROJECT - NONDEDUCT is missing").
 */
export const DEFAULT_BUDGET_DIMENSION_LAYOUT: BudgetDimensionLayout = {
  globalDimension1: "SPEND_CLASS",
  globalDimension2: "FUND_GOAL",
  budgetDimension1: "FAMILY_AREA",
  budgetDimension2: "PROJECT",
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

/** One row of hhJournalLineChecks (bc/hh-app-connector/src/HHJournalLineCheck.Page.al). */
interface ConnectorCheckRow {
  rowNo?: number;
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
  dimensionSetId?: number;
  sourceCode?: string;
  reasonCode?: string;
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

  /** Every batch of the household template (for a pre-write check that names no batch). */
  async listJournals(): Promise<BcJournal[]> {
    const rows = await this.http.getAll<BcJournal>(this.v2("journals", { $filter: `templateDisplayName eq ${odataString(this.journalTemplate)}` }));
    for (const j of rows) this.journalIds.set(j.code, j);
    return rows.filter((r) => r.templateDisplayName === this.journalTemplate);
  }

  async findByExternalDocumentNo(externalDocumentNo: string, journalCode?: string, hints?: { documentNumber?: string }): Promise<ExternalDocLookup> {
    assertExternalDocNo(externalDocumentNo);
    if (this.connectorInstalled) {
      // One call answers both sides, across every batch; the template is the household's, so any hit counts.
      const rows = await this.http.getAll<ConnectorCheckRow>(this.connector("hhJournalLineChecks", { $filter: `externalDocumentNo eq ${odataString(externalDocumentNo)}` }));
      const journalLines: WrittenJournalLine[] = rows.filter((r) => r.source === "Journal").map(connectorRowToWrittenLine);
      const ledgerEntries: LedgerEntryRef[] = rows.filter((r) => r.source === "Ledger").map(connectorRowToEntryRef);
      return { externalDocumentNo, journalLines, ledgerEntries, answeredBy: "connector", ledgerCheckIncomplete: false };
    }
    // Two standard filters. journalLines exposes externalDocumentNumber; generalLedgerEntries does not, so the ledger
    // side can only be checked by a document number the caller already knows (stored after the draft was created).
    const journals = journalCode ? [await this.resolveJournal(journalCode)] : await this.listJournals();
    const journalLines: WrittenJournalLine[] = [];
    for (const journal of journals) {
      const lines = await this.http.getAll<BcJournalLine>(this.v2(`journals(${journal.id})/journalLines`, { $filter: `externalDocumentNumber eq ${odataString(externalDocumentNo)}` }));
      journalLines.push(...lines.map((l) => mapWrittenLine(l, journal.code)));
    }
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
    // Every batch of the household template is checked, not only the target, so a resend routed to another batch
    // (a rule changed between two attempts) still finds the first document instead of writing a second one.
    const found = await this.findByExternalDocumentNo(extDoc);
    if (found.ledgerEntries.length > 0) return { outcome: "already_posted", entries: found.ledgerEntries };
    if (found.journalLines.length > 0) return { outcome: "already_in_journal", journalId: journal.id, lines: found.journalLines };

    // With the HH App Connector: hhJournalLines takes the dimensions with the line and lays them over the account's
    // defaults. The standard page cannot (a deep insert of a code the account defaults is refused, page 30022), so
    // without the connector only lines whose accounts carry no default for the codes sent can be written.
    const requests: BatchRequest[] = this.connectorInstalled
      ? lines.map((l) => ({ method: "POST", url: this.connector("hhJournalLines"), body: toConnectorLineBody(l, journal.id) }))
      : lines.map((l) => ({ method: "POST", url: this.v2(`journals(${journal.id})/journalLines`), body: toBcLineBody(l) }));
    const parts = await this.http.batchChangeset(requests, this.connectorInstalled ? API_CONNECTOR : API_V2);
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
      refs = rows.map(connectorRowToEntryRef);
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

  /**
   * The nightly poll's view (spec: Webhooks and polling): every draft line and posted entry whose External Document
   * No. the app owns, in a posting-date window, so the worker can compare count and sum per batch and date with its
   * own rows and open an Exception for any difference. Connector only: journalLines cannot be listed across batches
   * by prefix and generalLedgerEntries has no External Document No.
   */
  async listAppDocuments(filter: AppDocumentFilter): Promise<AppDocumentRow[]> {
    this.requireConnector("hhJournalLineChecks");
    const terms: string[] = [];
    if (filter.externalDocumentNo) {
      assertExternalDocNo(filter.externalDocumentNo);
      terms.push(`externalDocumentNo eq ${odataString(filter.externalDocumentNo)}`);
    } else {
      const prefix = filter.externalDocumentNoStartsWith ?? "HHAPP-";
      if (!prefix.startsWith("HHAPP-")) throw new LedgerAdapterError("listAppDocuments only reads documents the app owns (prefix HHAPP-)");
      // VERIFY on the sandbox: BC translates startswith(field,'v') into the AL filter v* that the page passes through.
      terms.push(`startswith(externalDocumentNo,${odataString(prefix)})`);
    }
    if (filter.postingDateFrom) terms.push(`postingDate ge ${odataDate(filter.postingDateFrom)}`);
    if (filter.postingDateTo) terms.push(`postingDate le ${odataDate(filter.postingDateTo)}`);
    if (filter.source) terms.push(`source eq ${odataString(filter.source === "journal" ? "Journal" : "Ledger")}`);
    if (filter.journalCode) terms.push(`journalBatchName eq ${odataString(filter.journalCode)}`);
    const rows = await this.http.getAll<ConnectorCheckRow>(this.connector("hhJournalLineChecks", { $filter: terms.join(" and ") }));
    return rows.map((r) => {
      const row: AppDocumentRow = {
        externalDocumentNumber: r.externalDocumentNo,
        source: r.source === "Journal" ? "journal" : "ledger",
        documentNumber: r.documentNo,
        postingDate: r.postingDate,
        accountType: r.accountType,
        accountNumber: r.accountNo,
        amountCents: toCents(r.amount),
      };
      if (r.journalBatchName) row.journalCode = r.journalBatchName;
      if (r.source === "Journal") {
        row.lineId = r.lineSystemId;
        row.lineNumber = r.lineNo;
      } else {
        row.entryNumber = r.entryNo;
      }
      if (r.sourceCode) row.sourceCode = r.sourceCode;
      if (r.reasonCode) row.reasonCode = r.reasonCode;
      return row;
    });
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

  /**
   * Read through the HH App Connector's hhBudgetEntries page, the route the writes use. Microsoft's Analytics API
   * (the Power BI app's queries 36960/36961) publishes budget entries without Description or the dimension codes, and
   * the app needs both: Description carries the revision number, the codes carry the category. An empty budget and a
   * budget that does not exist read the same (no lines); writes to a missing budget are refused by the page.
   */
  async readBudget(budgetName: string, opts: BudgetReadOptions = {}): Promise<BudgetRead> {
    const name = budgetName.trim();
    this.requireConnector("hhBudgetEntries");
    const terms = [`budgetName eq ${odataString(name)}`];
    if (opts.dateFrom) terms.push(`date ge ${odataDate(opts.dateFrom)}`);
    if (opts.dateTo) terms.push(`date le ${odataDate(opts.dateTo)}`);
    if (opts.glAccount) terms.push(`glAccountNo eq ${odataString(opts.glAccount)}`);
    const rows = await this.http.getAll<ConnectorBudgetEntry>(this.connector("hhBudgetEntries", { $filter: terms.join(" and ") }));
    const L = this.budgetLayout;
    return {
      budgetName: name,
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

/** The body hhJournalLines takes: the standard fields plus the dimensions as CODE=VALUE pairs joined with |. */
export function toConnectorLineBody(l: JournalLineInput, journalId: string): Record<string, unknown> {
  for (const d of l.dimensionSetLines) {
    if (/[|=]/.test(d.code) || /[|=]/.test(d.valueCode)) throw new LedgerAdapterError(`Dimension ${d.code}=${d.valueCode} contains | or =, which hhJournalLines uses as separators`);
  }
  const body: Record<string, unknown> = {
    journalId,
    accountType: l.accountType,
    accountNumber: l.accountNumber,
    postingDate: l.postingDate,
    externalDocumentNumber: l.externalDocumentNumber,
    amount: centsToNumber(l.amountCents),
    description: truncateDescription(l.description),
    dimensions: l.dimensionSetLines.map((d) => `${d.code}=${d.valueCode}`).join("|"),
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

function connectorRowToWrittenLine(r: ConnectorCheckRow): WrittenJournalLine {
  return {
    id: r.lineSystemId,
    lineNumber: r.lineNo,
    documentNumber: r.documentNo,
    externalDocumentNumber: r.externalDocumentNo,
    accountNumber: r.accountNo,
    amountCents: toCents(r.amount),
    postingDate: r.postingDate,
    journalCode: r.journalBatchName,
  };
}

function connectorRowToEntryRef(r: ConnectorCheckRow): LedgerEntryRef {
  return { entryNumber: r.entryNo, documentNumber: r.documentNo, postingDate: r.postingDate, accountNumber: r.accountNo, amountCents: toCents(r.amount) };
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
