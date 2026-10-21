/**
 * The ledger port the API and jobs code against. `packages/ledger-adapter-bc` implements the same method names
 * for Business Central (API v2.0, the Analytics API and the HH App Connector); the coordinator wires it in.
 * Shapes here are plain data: integer cents, YYYY-MM-DD dates, dimension lines as { code, valueCode }.
 *
 * `InMemoryLedger` is the fake used by unit and integration tests. It keeps journal batches, posts them into
 * G/L entries, holds bank ledger entries, budgets and webhook subscriptions, and can be told to fail.
 */
import type { BcDimensionSetLine } from "@homestead/shared";

export type BcBatch = "FEEDS" | "RECEIPTS" | "AUTOPOST";

export interface LedgerAccount {
  number: string;
  displayName: string;
  category?: string;
  blocked?: boolean;
}

export interface LedgerDimension {
  code: string;
  displayName?: string;
  values: readonly { code: string; displayName?: string }[];
}

export interface LedgerBankAccount {
  code: string; // BEEHIVE-CHK ...
  displayName: string;
  glAccount?: string;
  balanceCents?: number;
}

/** One journal line as the app sends it. Bank sides post through the Bank Account card, never the G/L number. */
export interface LedgerJournalLine {
  lineNo: number;
  accountType: "G/L Account" | "Bank Account";
  accountNo: string;
  /** Debit positive, credit negative. */
  amountCents: number;
  postingDate: string;
  documentDate?: string;
  description: string;
  externalDocumentNo: string;
  comment?: string;
  dimensions: readonly BcDimensionSetLine[];
}

export interface CreateJournalLinesInput {
  batch: BcBatch;
  externalDocumentNo: string;
  /** All lines of one transaction: sent as one $batch changeset so a failure leaves nothing. */
  lines: readonly LedgerJournalLine[];
}

export interface CreateJournalLinesResult {
  journalId: string;
  lineIds: readonly string[];
  /**
   * What the ledger's own pre-write check found (the real adapter reruns it on every call): `written` by this call,
   * `already_in_journal` (lines found, nothing written) or `already_posted` (G/L entries found; `glEntryNos` set,
   * `lineIds` empty). Absent from older fakes, which means `written`.
   */
  outcome?: "written" | "already_in_journal" | "already_posted";
  glEntryNos?: readonly number[];
}

export interface ExternalDocLookup {
  externalDocumentNo: string;
  journalLineIds: readonly string[];
  batch?: BcBatch;
  glEntryNos: readonly number[];
  /** Count and sum on the ledger side, drafts plus posted, for the nightly comparison. */
  lineCount: number;
  sumCents: number;
}

export interface GlEntry {
  entryNo: number;
  /** The journal batch the entry was posted from, when the ledger reports it (HH App Connector). */
  batch?: BcBatch;
  postingDate: string;
  accountNo: string;
  amountCents: number;
  description?: string;
  documentNo: string;
  externalDocumentNo: string;
  sourceCode?: string;
  reasonCode?: string;
  dimensions: readonly BcDimensionSetLine[];
}

export interface GlEntryQuery {
  externalDocumentNo?: string;
  /** e.g. "HHAPP-" to list everything the app might own. */
  externalDocumentNoStartsWith?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  /** Balance reads for goals: cash accounts carrying a FUND_GOAL value. */
  accountNoPrefix?: string;
  dimension?: { code: string; valueCode: string };
  /** A BC Document No. already known for the External Document No. (lets the read work without the connector). */
  documentNo?: string;
}

/** A line the app owns as the ledger holds it: a draft or a posted entry (nightly count-and-sum comparison). */
export interface AppDocumentRow {
  externalDocumentNo: string;
  source: "journal" | "ledger";
  batch?: BcBatch;
  lineId?: string;
  entryNo?: number;
  documentNo?: string;
  postingDate: string;
  accountNo: string;
  amountCents: number;
  sourceCode?: string;
  reasonCode?: string;
}

export interface AppDocumentQuery {
  externalDocumentNoStartsWith?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  source?: "journal" | "ledger";
}

export interface BankLedgerEntry {
  entryNo: number;
  bankAccountCode: string;
  postingDate: string;
  amountCents: number;
  description?: string;
  documentNo?: string;
  externalDocumentNo?: string;
  open: boolean;
  statementNo?: string;
  statementLineNo?: number;
  closedAtDate?: string;
  reversed: boolean;
}

export interface BankLedgerQuery {
  bankAccountCode?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  open?: boolean;
  externalDocumentNo?: string;
}

export interface BudgetEntryInput {
  budgetName: string;
  glAccount: string;
  date: string;
  amountCents: number;
  dimensions: readonly BcDimensionSetLine[];
  /** The revision number, as the HH App Connector stores it in Description. */
  description: string;
}

export interface BudgetEntry extends BudgetEntryInput {
  entryNo?: number;
}

export interface WebhookSubscription {
  subscriptionId: string;
  resource: string;
  notificationUrl: string;
  clientState: string;
  expiresAt: string;
}

export interface ListedWebhookSubscription {
  subscriptionId: string;
  resource: string;
  notificationUrl?: string;
  expiresAt: string;
}

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly status: number | undefined,
    public readonly retryable: boolean,
    public readonly code?: string,
    /** From BC's Retry-After header on a 429, when it sent one. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

/** 408, 429 and 5xx retry (spec: "Idempotency and retries", item 4); anything else is dead-lettered. */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true; // network failure, timeout
  return status === 408 || status === 429 || status >= 500;
}

export interface LedgerPort {
  listAccounts(): Promise<LedgerAccount[]>;
  listDimensions(): Promise<LedgerDimension[]>;
  listBankAccounts(): Promise<LedgerBankAccount[]>;
  /** Pre-write check: journal lines in any HHAPP batch plus G/L entries with this External Document No. */
  findByExternalDocumentNo(externalDocumentNo: string): Promise<ExternalDocLookup>;
  createJournalLines(input: CreateJournalLinesInput): Promise<CreateJournalLinesResult>;
  postBatch(batch: BcBatch): Promise<void>;
  readGlEntriesByExternalDocNo(query: GlEntryQuery): Promise<GlEntry[]>;
  readBankLedgerEntries(query: BankLedgerQuery): Promise<BankLedgerEntry[]>;
  writeBudgetEntries(entries: readonly BudgetEntryInput[]): Promise<{ written: number }>;
  readBudget(budgetName: string): Promise<BudgetEntry[]>;
  createWebhookSubscription(resource: string, notificationUrl: string, clientState: string): Promise<WebhookSubscription>;
  /** BC repeats the handshake on renewal; `clientState` is resent so a rotated secret takes effect. */
  renewWebhookSubscription(subscriptionId: string, clientState?: string): Promise<WebhookSubscription>;
  deleteWebhookSubscription(subscriptionId: string): Promise<void>;
  /**
   * The subscriptions BC holds right now (no clientState: BC does not return it). Optional: the renewal job uses it to
   * recreate a subscription BC dropped (after a non-2xx reply or an environment update) before it would expire.
   */
  listWebhookSubscriptions?(): Promise<ListedWebhookSubscription[]>;
  /**
   * Every draft line and posted entry the app owns in a window (the nightly poll's per-batch, per-date count and
   * sum). Optional: a ledger without it is compared document by document only.
   */
  listAppDocuments?(query: AppDocumentQuery): Promise<AppDocumentRow[]>;
}

// --------------------------------------------------------------------------------------------------
// In-memory fake
// --------------------------------------------------------------------------------------------------

interface StoredLine extends LedgerJournalLine {
  id: string;
  batch: BcBatch;
}

export interface InMemoryLedgerOptions {
  accounts?: LedgerAccount[];
  bankAccounts?: LedgerBankAccount[];
  dimensions?: LedgerDimension[];
}

export class InMemoryLedger implements LedgerPort {
  readonly drafts = new Map<string, StoredLine>(); // line id -> line
  readonly glEntries: GlEntry[] = [];
  readonly bankLedgerEntries: BankLedgerEntry[] = [];
  readonly budgets = new Map<string, BudgetEntry[]>();
  readonly subscriptions = new Map<string, WebhookSubscription>();
  readonly calls: string[] = [];
  /** Queue of failures for the next createJournalLines calls: a status (retryable per isRetryableStatus) or an Error. */
  readonly failNextCreate: (number | Error)[] = [];
  /** When set, `postBatch` throws with this status once. */
  failNextPost: number | undefined = undefined;
  private nextLine = 1;
  private nextEntry = 1000;
  private nextBankEntry = 500;
  private readonly accounts: LedgerAccount[];
  private readonly bankAccounts: LedgerBankAccount[];
  private readonly dimensions: LedgerDimension[];
  readonly whitelistedBudgetNames = [/-REV\d*$/i, /^FCST/i];

  constructor(opts: InMemoryLedgerOptions = {}) {
    this.accounts = opts.accounts ?? [];
    this.bankAccounts = opts.bankAccounts ?? [];
    this.dimensions = opts.dimensions ?? [];
  }

  async listAccounts(): Promise<LedgerAccount[]> {
    this.calls.push("listAccounts");
    return [...this.accounts];
  }
  async listDimensions(): Promise<LedgerDimension[]> {
    this.calls.push("listDimensions");
    return [...this.dimensions];
  }
  async listBankAccounts(): Promise<LedgerBankAccount[]> {
    this.calls.push("listBankAccounts");
    return [...this.bankAccounts];
  }

  async findByExternalDocumentNo(externalDocumentNo: string): Promise<ExternalDocLookup> {
    this.calls.push(`find:${externalDocumentNo}`);
    const lines = [...this.drafts.values()].filter((l) => l.externalDocumentNo === externalDocumentNo);
    const entries = this.glEntries.filter((e) => e.externalDocumentNo === externalDocumentNo);
    const sum = lines.reduce((s, l) => s + l.amountCents, 0) + entries.reduce((s, e) => s + e.amountCents, 0);
    const out: ExternalDocLookup = {
      externalDocumentNo,
      journalLineIds: lines.map((l) => l.id),
      glEntryNos: entries.map((e) => e.entryNo),
      lineCount: lines.length + entries.length,
      sumCents: sum,
    };
    const batch = lines[0]?.batch;
    if (batch) out.batch = batch;
    return out;
  }

  async createJournalLines(input: CreateJournalLinesInput): Promise<CreateJournalLinesResult> {
    this.calls.push(`create:${input.externalDocumentNo}`);
    const fail = this.failNextCreate.shift();
    if (fail !== undefined) {
      if (fail instanceof Error) throw fail;
      throw new LedgerError(`BC returned ${fail}`, fail, isRetryableStatus(fail));
    }
    // One changeset: validate every line before storing any.
    const sum = input.lines.reduce((s, l) => s + l.amountCents, 0);
    for (const l of input.lines) {
      if (!l.accountNo) throw new LedgerError("Line has no account", 400, false, "invalid_line");
      if (l.externalDocumentNo !== input.externalDocumentNo) throw new LedgerError("Mixed documents in one changeset", 400, false);
      if (l.accountType === "G/L Account" && this.accounts.length && !this.accounts.some((a) => a.number === l.accountNo)) {
        throw new LedgerError(`Unknown G/L account ${l.accountNo}`, 400, false, "unknown_account");
      }
    }
    if (sum !== 0) throw new LedgerError("Document does not balance", 400, false, "unbalanced");
    const ids: string[] = [];
    for (const l of input.lines) {
      const id = `jl-${this.nextLine++}`;
      this.drafts.set(id, { ...l, id, batch: input.batch });
      ids.push(id);
    }
    return { journalId: `journal-${input.batch}`, lineIds: ids, outcome: "written" };
  }

  async postBatch(batch: BcBatch): Promise<void> {
    this.calls.push(`post:${batch}`);
    if (this.failNextPost !== undefined) {
      const s = this.failNextPost;
      this.failNextPost = undefined;
      throw new LedgerError(`BC returned ${s}`, s, isRetryableStatus(s));
    }
    const lines = [...this.drafts.values()].filter((l) => l.batch === batch);
    const byDoc = new Map<string, StoredLine[]>();
    for (const l of lines) {
      const list = byDoc.get(l.externalDocumentNo) ?? [];
      list.push(l);
      byDoc.set(l.externalDocumentNo, list);
    }
    let docSeq = 1;
    for (const [extDoc, docLines] of byDoc) {
      const documentNo = `G${String(docSeq++).padStart(5, "0")}-${extDoc.slice(-8)}`;
      for (const l of docLines) {
        const entry: GlEntry = {
          entryNo: this.nextEntry++,
          postingDate: l.postingDate,
          accountNo: l.accountType === "Bank Account" ? this.glForBank(l.accountNo) : l.accountNo,
          amountCents: l.amountCents,
          description: l.description,
          documentNo,
          externalDocumentNo: l.externalDocumentNo,
          sourceCode: batch === "AUTOPOST" ? "HHAUTO" : "GENJNL",
          dimensions: l.dimensions,
          batch,
        };
        if (batch === "AUTOPOST") entry.reasonCode = "AUTOPOST";
        this.glEntries.push(entry);
        if (l.accountType === "Bank Account") {
          this.bankLedgerEntries.push({
            entryNo: this.nextBankEntry++,
            bankAccountCode: l.accountNo,
            postingDate: l.postingDate,
            amountCents: l.amountCents,
            description: l.description,
            documentNo,
            externalDocumentNo: l.externalDocumentNo,
            open: true,
            reversed: false,
          });
        }
        this.drafts.delete(l.id);
      }
    }
  }

  private glForBank(code: string): string {
    return this.bankAccounts.find((b) => b.code === code)?.glAccount ?? code;
  }

  async readGlEntriesByExternalDocNo(q: GlEntryQuery): Promise<GlEntry[]> {
    this.calls.push("readGl");
    return this.glEntries.filter((e) => {
      if (q.externalDocumentNo && e.externalDocumentNo !== q.externalDocumentNo) return false;
      if (q.externalDocumentNoStartsWith && !e.externalDocumentNo.startsWith(q.externalDocumentNoStartsWith)) return false;
      if (q.postingDateFrom && e.postingDate < q.postingDateFrom) return false;
      if (q.postingDateTo && e.postingDate > q.postingDateTo) return false;
      if (q.accountNoPrefix && !e.accountNo.startsWith(q.accountNoPrefix)) return false;
      if (q.dimension && !e.dimensions.some((d) => d.code === q.dimension!.code && d.valueCode === q.dimension!.valueCode)) return false;
      return true;
    });
  }

  async readBankLedgerEntries(q: BankLedgerQuery): Promise<BankLedgerEntry[]> {
    this.calls.push("readBank");
    return this.bankLedgerEntries.filter((e) => {
      if (q.bankAccountCode && e.bankAccountCode !== q.bankAccountCode) return false;
      if (q.postingDateFrom && e.postingDate < q.postingDateFrom) return false;
      if (q.postingDateTo && e.postingDate > q.postingDateTo) return false;
      if (q.open !== undefined && e.open !== q.open) return false;
      if (q.externalDocumentNo && e.externalDocumentNo !== q.externalDocumentNo) return false;
      return true;
    });
  }

  async writeBudgetEntries(entries: readonly BudgetEntryInput[]): Promise<{ written: number }> {
    this.calls.push("writeBudget");
    for (const e of entries) {
      if (/-ORIG$/i.test(e.budgetName) || !this.whitelistedBudgetNames.some((re) => re.test(e.budgetName))) {
        throw new LedgerError(`Budget name ${e.budgetName} is not writable`, 400, false, "budget_name_refused");
      }
    }
    for (const e of entries) {
      const list = this.budgets.get(e.budgetName) ?? [];
      list.push({ ...e, entryNo: list.length + 1 });
      this.budgets.set(e.budgetName, list);
    }
    return { written: entries.length };
  }

  async readBudget(budgetName: string): Promise<BudgetEntry[]> {
    this.calls.push(`readBudget:${budgetName}`);
    return [...(this.budgets.get(budgetName) ?? [])];
  }

  async createWebhookSubscription(resource: string, notificationUrl: string, clientState: string): Promise<WebhookSubscription> {
    this.calls.push(`sub:${resource}`);
    const sub: WebhookSubscription = {
      subscriptionId: `sub-${resource}-${this.subscriptions.size + 1}`,
      resource,
      notificationUrl,
      clientState,
      expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    };
    this.subscriptions.set(sub.subscriptionId, sub);
    return sub;
  }
  async renewWebhookSubscription(subscriptionId: string, _clientState?: string): Promise<WebhookSubscription> {
    this.calls.push(`renew:${subscriptionId}`);
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) throw new LedgerError("Subscription not found", 404, false, "subscription_missing");
    const renewed = { ...sub, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };
    this.subscriptions.set(subscriptionId, renewed);
    return renewed;
  }
  async deleteWebhookSubscription(subscriptionId: string): Promise<void> {
    this.calls.push(`unsub:${subscriptionId}`);
    this.subscriptions.delete(subscriptionId);
  }
  async listWebhookSubscriptions(): Promise<ListedWebhookSubscription[]> {
    this.calls.push("listSubs");
    return [...this.subscriptions.values()].map((s) => ({ subscriptionId: s.subscriptionId, resource: s.resource, notificationUrl: s.notificationUrl, expiresAt: s.expiresAt }));
  }

  async listAppDocuments(q: AppDocumentQuery): Promise<AppDocumentRow[]> {
    this.calls.push("listAppDocuments");
    const prefix = q.externalDocumentNoStartsWith ?? "HHAPP-";
    const inWindow = (d: string) => (!q.postingDateFrom || d >= q.postingDateFrom) && (!q.postingDateTo || d <= q.postingDateTo);
    const out: AppDocumentRow[] = [];
    if (q.source !== "ledger") {
      for (const l of this.drafts.values()) {
        if (!l.externalDocumentNo.startsWith(prefix) || !inWindow(l.postingDate)) continue;
        out.push({ externalDocumentNo: l.externalDocumentNo, source: "journal", batch: l.batch, lineId: l.id, postingDate: l.postingDate, accountNo: l.accountNo, amountCents: l.amountCents });
      }
    }
    if (q.source !== "journal") {
      for (const e of this.glEntries) {
        if (!e.externalDocumentNo.startsWith(prefix) || !inWindow(e.postingDate)) continue;
        const row: AppDocumentRow = { externalDocumentNo: e.externalDocumentNo, source: "ledger", entryNo: e.entryNo, documentNo: e.documentNo, postingDate: e.postingDate, accountNo: e.accountNo, amountCents: e.amountCents };
        if (e.batch) row.batch = e.batch;
        if (e.sourceCode) row.sourceCode = e.sourceCode;
        if (e.reasonCode) row.reasonCode = e.reasonCode;
        out.push(row);
      }
    }
    return out;
  }

  // Test helpers ---------------------------------------------------------------------------------

  /** Simulate Cade editing or deleting a draft in BC. */
  deleteDraft(lineId: string): void {
    this.drafts.delete(lineId);
  }

  /** Simulate BC's bank reconciliation closing an entry. */
  closeBankEntry(entryNo: number, statementNo: string, closedAtDate: string): void {
    const e = this.bankLedgerEntries.find((x) => x.entryNo === entryNo);
    if (e) {
      e.open = false;
      e.statementNo = statementNo;
      e.closedAtDate = closedAtDate;
    }
  }

  /** A BC-native recurring-journal bank entry (PennyMac, Frontier) that BC posted itself. */
  addNativeBankEntry(e: Omit<BankLedgerEntry, "entryNo" | "open" | "reversed"> & Partial<Pick<BankLedgerEntry, "open" | "reversed">>): BankLedgerEntry {
    const entry: BankLedgerEntry = { open: true, reversed: false, ...e, entryNo: this.nextBankEntry++ };
    this.bankLedgerEntries.push(entry);
    return entry;
  }

  /** A G/L entry BC holds that the app does not know (nightly poll must raise an exception). */
  addForeignGlEntry(e: Omit<GlEntry, "entryNo">): GlEntry {
    const entry = { ...e, entryNo: this.nextEntry++ };
    this.glEntries.push(entry);
    return entry;
  }
}
