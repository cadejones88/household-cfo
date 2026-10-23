/**
 * Synthetic data for VITE_API_MODE=mock. Nothing here comes from a real account: merchants, amounts and dates
 * are invented; account masks are the family's own card codes from @homestead/shared (never a full number).
 * Timestamps are relative to "now" so the freshness cues look real.
 */
import {
  BANK_CARD_LIST,
  CATEGORIES,
  CATEGORY_CATALOG_VERSION,
  CHART,
  DIMENSION_CODES,
  FAMILY_AREA,
  FUND_GOAL,
  PROJECT,
  SPEND_CLASS,
  TAX_TREATMENT,
  externalDocumentNo,
  idempotencyKey,
  plainStatus,
  type AuditEntry,
  type AuthorityMatrix,
  type BankCardReconStatus,
  type BcSubscriptionSummary,
  type ConsoleMe,
  type ConsoleReceiptRow,
  type ConsoleTransactionRow,
  type DataThrough,
  type DimensionDictionaryEntry,
  type FeedConnectionSummary,
  type LoanRollforward,
  type MappingSet,
  type OutboxItem,
  type RuleSummary,
  type SyncRunSummary,
  type TransactionState,
  type BankCardCode,
} from "@homestead/shared";

export const NOW = Date.now();
const H = 3_600_000;
const D = 24 * H;

export const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
export const ymd = (msAgo: number) => {
  const d = new Date(NOW - msAgo);
  // America/Boise is UTC-6 in October; good enough for synthetic dates.
  const local = new Date(d.getTime() - 6 * H);
  return local.toISOString().slice(0, 10);
};

export const HOUSEHOLD_ID = "0f6b1d4a-7a0e-4a9b-9e0e-5c2d9b1a0001";
export const CADE_ID = "00000000-0000-0000-0000-000000000001";
export const VANESSA_ID = "00000000-0000-0000-0000-000000000002";

export const me: ConsoleMe = {
  member: { id: CADE_ID, displayName: "Cade", role: "member" },
  household: { id: HOUSEHOLD_ID, name: "Jones household", timezone: "America/Boise", settingsVersion: 1 },
  ledger: { tenantId: "mock-tenant", environment: "CADE_Sandbox_vs25", companyId: "mock-company", journalTemplate: "HHAPP", autoPostEnabled: false },
};

export function dataThrough(quality: DataThrough["quality"], pendingCount: number, msAgo = 20 * 60_000): DataThrough {
  return { at: iso(msAgo), quality, pendingCount };
}

interface TxSeed {
  n: number;
  card: string;
  daysAgo: number;
  amount: number; // cents, bank sign
  merchant: string;
  state: TransactionState;
  category?: string;
  kind?: ConsoleTransactionRow["kind"];
  confidence?: number;
  source?: "plaid" | "csv" | "receipt" | "paycheck" | "manual" | "ofx" | "pdf";
  receipt?: ConsoleTransactionRow["receiptStatus"];
  business?: ConsoleTransactionRow["businessFlag"];
  batch?: "FEEDS" | "RECEIPTS" | "AUTOPOST";
  exception?: { reason: string; bcNote?: string; bcCount?: number; bcSum?: number; entryNos?: number[] };
  dupOf?: number;
}

const SEEDS: TxSeed[] = [
  // Possible duplicates: a CSV import overlapping Plaid
  { n: 1, card: "BEEHIVE-CHK", daysAgo: 3, amount: -8742, merchant: "BROULIMS SUPERMARKET REXBURG", state: "possible_duplicate", source: "csv", dupOf: 21 },
  { n: 2, card: "CAPONE-CC", daysAgo: 5, amount: -4599, merchant: "MAVERIK #412", state: "possible_duplicate", source: "csv", dupOf: 22 },
  // Needs receipt
  { n: 3, card: "CAPONE-CC", daysAgo: 2, amount: -14237, merchant: "WAL-MART #1878 REXBURG", state: "needs_receipt", receipt: "needed", category: "walmart-unsplit" },
  { n: 4, card: "BEEHIVE-CHK", daysAgo: 6, amount: -22310, merchant: "COSTCO WHSE #0123", state: "needs_receipt", receipt: "needed", category: "club-unsplit" },
  { n: 5, card: "CAPONE-CC", daysAgo: 9, amount: -3899, merchant: "AMZN MKTP US*2K3L", state: "needs_receipt", receipt: "needed", category: "amazon-unsplit" },
  // Needs classification (low confidence)
  { n: 6, card: "BEEHIVE-CHK", daysAgo: 1, amount: -6200, merchant: "SQ *THE CORNER STAND", state: "needs_classification", confidence: 0.41 },
  { n: 7, card: "AFCU-VISA", daysAgo: 4, amount: -11900, merchant: "IDAHO POWER", state: "needs_classification", confidence: 0.55, category: "electricity" },
  { n: 8, card: "VENMO", daysAgo: 2, amount: 8500, merchant: "Venmo from Kayla R", state: "needs_classification", confidence: 0.66, kind: "income", category: "income-lash" },
  // Ready for review (medium confidence)
  { n: 9, card: "BEEHIVE-CHK", daysAgo: 1, amount: -5412, merchant: "CHICK-FIL-A #3211", state: "ready_for_review", confidence: 0.88, category: "eating-out" },
  { n: 10, card: "CAPONE-CC", daysAgo: 2, amount: -2799, merchant: "SODALICIOUS REXBURG", state: "ready_for_review", confidence: 0.91, category: "treats" },
  { n: 11, card: "BEEHIVE-CHK", daysAgo: 3, amount: -9800, merchant: "VERIZON WIRELESS", state: "ready_for_review", confidence: 0.95, category: "phones" },
  { n: 12, card: "AFCU-CHK", daysAgo: 4, amount: -15000, merchant: "TRANSFER TO BEEHIVE", state: "ready_for_review", confidence: 0.93, kind: "transfer", category: "transfer-own" },
  { n: 13, card: "CAPONE-CC", daysAgo: 7, amount: -60012, merchant: "BROULIMS SUPERMARKET REXBURG", state: "ready_for_review", confidence: 0.52, category: "groceries" },
  // Exceptions
  {
    n: 14,
    card: "BEEHIVE-CHK",
    daysAgo: 12,
    amount: -4210,
    merchant: "ALBERTSONS #0287",
    state: "exception",
    category: "groceries",
    batch: "FEEDS",
    exception: { reason: "Nightly poll: draft line not found in HHAPP/FEEDS (deleted or edited in BC).", bcCount: 0, bcSum: 0, bcNote: "No journal line or G/L entry carries this External Document No." },
  },
  {
    n: 15,
    card: "CAPONE-CC",
    daysAgo: 15,
    amount: -12890,
    merchant: "WAL-MART #1878 REXBURG",
    state: "exception",
    category: "groceries",
    batch: "RECEIPTS",
    receipt: "matched",
    exception: { reason: "Nightly poll: BC shows 2 lines summing to $118.90; the app has 3 lines summing to $128.90.", bcCount: 2, bcSum: -11890, bcNote: "One split line is missing in BC." },
  },
  {
    n: 16,
    card: "AFCU-CHK",
    daysAgo: 20,
    amount: -25000,
    merchant: "FRONTIER CU LOAN PMT",
    state: "exception",
    kind: "loan_payment",
    batch: "FEEDS",
    exception: { reason: "G/L entry with an HHAPP- document number matches no app transaction.", entryNos: [4471, 4472], bcNote: "Posted in BC on a date the app has no line for." },
  },
  // Approved / sent / drafts / posted / reconciled (for the sync screen counts)
  { n: 17, card: "BEEHIVE-CHK", daysAgo: 8, amount: -3312, merchant: "SMITHS FOOD #4", state: "bc_draft_created", category: "groceries", batch: "FEEDS" },
  { n: 18, card: "CAPONE-CC", daysAgo: 9, amount: -7640, merchant: "WAL-MART #1878 REXBURG", state: "bc_draft_created", category: "groceries", batch: "RECEIPTS", receipt: "matched" },
  { n: 19, card: "BEEHIVE-CHK", daysAgo: 10, amount: -2200, merchant: "NETFLIX.COM", state: "sent_to_bc", category: "streaming", batch: "FEEDS" },
  { n: 20, card: "BEEHIVE-CHK", daysAgo: 14, amount: 312450, merchant: "HENRYS FORK HOMES PAYROLL", state: "posted", kind: "paycheck", category: "income-hfh-wages", batch: "FEEDS", source: "paycheck" },
  { n: 21, card: "BEEHIVE-CHK", daysAgo: 3, amount: -8742, merchant: "BROULIMS SUPERMARKET REXBURG", state: "approved", category: "groceries" },
  { n: 22, card: "CAPONE-CC", daysAgo: 5, amount: -4599, merchant: "MAVERIK #412", state: "approved", category: "fuel" },
  { n: 23, card: "BEEHIVE-CHK", daysAgo: 30, amount: -9800, merchant: "VERIZON WIRELESS", state: "reconciled", category: "phones", batch: "FEEDS" },
  { n: 24, card: "AFCU-CHK", daysAgo: 28, amount: -98542, merchant: "PENNYMAC MORTGAGE", state: "reconciled", kind: "bc_native" },
  { n: 25, card: "BEEHIVE-CHK", daysAgo: 25, amount: -4500, merchant: "CLEAR MANAGEMENT HOA", state: "posted", category: "hoa", batch: "FEEDS" },
  { n: 26, card: "CAPONE-CC", daysAgo: 6, amount: -8900, merchant: "AMZN MKTP US*7H1Q", state: "ready_for_review", confidence: 0.75, category: "household-supplies", business: "ctj" },
];

const cardById = new Map(BANK_CARD_LIST.map((c) => [c.code, c]));
const catById = new Map(CATEGORIES.map((c) => [c.id, c]));
const accountIdOf = (code: string) => `acct-${code.toLowerCase()}`;
const txId = (n: number) => `tx-${String(n).padStart(4, "0")}`;

function toTransaction(s: TxSeed): ConsoleTransactionRow {
  const card = cardById.get(s.card as BankCardCode) ?? { code: s.card, name: s.card, mask: "", institution: "", glAccount: "" };
  const source = s.source ?? "plaid";
  const key =
    source === "plaid"
      ? idempotencyKey.plaid(accountIdOf(s.card), `plaid-tx-${s.n}`)
      : source === "csv"
        ? idempotencyKey.csv(accountIdOf(s.card), ymd(s.daysAgo * D), s.amount, s.merchant, 1)
        : source === "paycheck"
          ? idempotencyKey.paycheck("emp-hfh", ymd(s.daysAgo * D), s.amount)
          : idempotencyKey.manual(`00000000-0000-4000-8000-${String(s.n).padStart(12, "0")}`);
  const postedDate = ymd(s.daysAgo * D);
  const needsDoc = ["sent_to_bc", "bc_draft_created", "posted", "reconciled", "reversed", "exception", "approved"].includes(s.state);
  const docNo = needsDoc ? externalDocumentNo(key, postedDate) : undefined;
  const cat = s.category ? catById.get(s.category) : undefined;
  const dims = cat?.dims ?? {};
  const splits =
    s.state === "exception" && s.n === 15
      ? [
          { lineNo: 1, amountCents: -6890, categoryId: "groceries", glAccount: "603101", dims },
          { lineNo: 2, amountCents: -5000, categoryId: "household-supplies", glAccount: "603301", dims },
          { lineNo: 3, amountCents: -1000, categoryId: "treats", glAccount: "603701", dims },
        ]
      : cat
        ? [{ lineNo: 1, amountCents: s.amount, categoryId: cat.id, glAccount: cat.glAccount, dims }]
        : [];
  const bcState = s.state;
  const row: ConsoleTransactionRow = {
    id: txId(s.n),
    accountId: accountIdOf(s.card),
    accountName: card.name,
    accountMask: card.mask,
    source,
    sourceRef: source === "plaid" ? `plaid-tx-${s.n}` : `row-${s.n}`,
    idempotencyKey: key,
    postedDate,
    amountCents: s.amount,
    merchantRaw: s.merchant,
    merchantNorm: s.merchant.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(),
    pending: false,
    state: s.state,
    status: plainStatus(s.state),
    kind: s.kind ?? (s.amount > 0 ? "income" : "spend"),
    dims,
    businessFlag: s.business ?? "none",
    splits,
    receiptStatus: s.receipt ?? "none",
    createdAt: iso(s.daysAgo * D),
    updatedAt: iso(Math.max(0, s.daysAgo - 1) * D + 3 * H),
  };
  if (cat) {
    row.categoryId = cat.id;
    row.categoryName = cat.name;
  }
  if (s.confidence !== undefined) {
    row.confidence = s.confidence;
    row.tier = s.confidence >= 0.98 ? "high" : s.confidence >= 0.7 ? "medium" : "low";
  }
  if (s.receipt === "matched") row.receiptId = `rcpt-${s.n}`;
  if (s.dupOf) row.duplicateOfId = txId(s.dupOf);
  if (docNo) {
    row.bc = { externalDocumentNo: docNo };
    if (s.batch) row.bc.batch = s.batch;
    if (["bc_draft_created", "posted", "reconciled", "exception"].includes(bcState) && s.batch) {
      row.bc.journalId = `journal-${s.batch.toLowerCase()}`;
      row.bc.lineIds = splits.map((_, i) => `line-${s.n}-${i + 1}`);
    }
    if (["posted", "reconciled"].includes(bcState)) {
      row.bc.documentNo = `G${String(1000 + s.n).padStart(5, "0")}`;
      row.bc.entryNos = splits.map((_, i) => 4000 + s.n * 10 + i);
      row.bc.postingDate = postedDate;
      row.bc.syncStatus = "in_sync";
      row.bc.lastSyncAt = iso(5 * H);
    } else if (bcState === "exception") {
      row.bc.syncStatus = "difference";
      row.bc.lastSyncAt = iso(5 * H);
      row.bc.difference = s.exception?.reason;
    } else {
      row.bc.syncStatus = "pending";
    }
  }
  if (s.exception) {
    row.exception = {
      reason: s.exception.reason,
      appSide: { idempotencyKey: key, externalDocumentNo: docNo, lineIds: row.bc?.lineIds, state: s.state, amountCents: s.amount },
      bcSide: { entryNos: s.exception.entryNos, lineCount: s.exception.bcCount, sumCents: s.exception.bcSum, note: s.exception.bcNote, postingDate: s.exception.entryNos ? postedDate : undefined },
      raisedAt: iso(12 * H),
      raisedBy: "jobs:bc_poll",
    };
  }
  return row;
}

export const transactions: ConsoleTransactionRow[] = SEEDS.map(toTransaction);

export const receipts: ConsoleReceiptRow[] = [
  {
    id: "rcpt-101",
    capturedAt: iso(1.2 * D),
    uploadedAt: iso(1.2 * D - 60_000),
    sha256: "3f1c9a0e".padEnd(64, "0"),
    ocrStatus: "read",
    merchant: "Broulim's",
    totalCents: 8742,
    taxCents: 512,
    receiptDate: ymd(3 * D),
    syncState: "synced",
    memberName: "Vanessa",
    candidates: [
      { transactionId: "tx-0021", postedDate: ymd(3 * D), amountCents: -8742, merchant: "BROULIMS SUPERMARKET REXBURG", confidence: 0.86 },
      { transactionId: "tx-0001", postedDate: ymd(3 * D), amountCents: -8742, merchant: "BROULIMS SUPERMARKET REXBURG", confidence: 0.84 },
    ],
  },
  {
    id: "rcpt-102",
    capturedAt: iso(2 * D),
    uploadedAt: iso(2 * D),
    sha256: "9ab2c3d4".padEnd(64, "1"),
    ocrStatus: "read",
    merchant: "Maverik",
    totalCents: 1899,
    taxCents: 0,
    receiptDate: ymd(2 * D),
    syncState: "synced",
    memberName: "Vanessa",
    candidates: [],
  },
  {
    id: "rcpt-103",
    capturedAt: iso(5 * D),
    uploadedAt: iso(5 * D),
    sha256: "77e1f0aa".padEnd(64, "2"),
    ocrStatus: "needs_review",
    merchant: "Walmart",
    totalCents: 14240,
    taxCents: 804,
    receiptDate: ymd(2 * D),
    syncState: "synced",
    memberName: "Vanessa",
    candidates: [{ transactionId: "tx-0003", postedDate: ymd(2 * D), amountCents: -14237, merchant: "WAL-MART #1878 REXBURG", confidence: 0.71 }],
  },
  {
    id: "rcpt-104",
    capturedAt: iso(6 * D),
    sha256: "c0ffee00".padEnd(64, "3"),
    ocrStatus: "failed",
    syncState: "synced",
    memberName: "Cade",
    candidates: [],
  },
];

export const rules: RuleSummary[] = [
  {
    id: "rule-r2",
    ruleNo: "R2",
    kind: "transfer",
    name: "Own-account transfer",
    match: { pairWithinDays: 2, accounts: "household" },
    action: { category: "transfer-own", glAccount: "115101" },
    mayAutoPost: true,
    state: "proposed",
    proposedBy: "system",
    proposedByName: "System (spec candidate)",
    version: 1,
    testPassedAt: iso(2 * D),
    stats: { fired: 0, corrected: 0 },
  },
  {
    id: "rule-r3",
    ruleNo: "R3",
    kind: "card_payment",
    name: "Card payment",
    match: { from: "household account", to: "household card" },
    action: { category: "card-payment", glAccount: "115201" },
    mayAutoPost: true,
    state: "proposed",
    proposedBy: "system",
    proposedByName: "System (spec candidate)",
    version: 1,
    stats: { fired: 0, corrected: 0 },
  },
  {
    id: "rule-m1",
    kind: "merchant",
    name: "Maverik → Fuel",
    match: { merchant: /maverik/i.source, amountBandCents: { min: 1500, max: 9000 }, account: "any" },
    action: { category: "fuel" },
    mayAutoPost: false,
    state: "proposed",
    proposedBy: VANESSA_ID,
    proposedByName: "Vanessa",
    version: 1,
    stats: { fired: 0, corrected: 0 },
  },
  {
    id: "rule-m2",
    kind: "merchant",
    name: "Verizon → Phones",
    match: { merchant: /verizon/i.source, amountBandCents: { min: 9300, max: 10300 } },
    action: { category: "phones" },
    mayAutoPost: false,
    state: "approved",
    proposedBy: CADE_ID,
    proposedByName: "Cade",
    approvedBy: VANESSA_ID,
    approvedAt: iso(20 * D),
    effectiveFrom: ymd(20 * D),
    version: 1,
    stats: { fired: 3, corrected: 0 },
  },
  {
    id: "rule-r7",
    ruleNo: "R7",
    kind: "bc_native",
    name: "BC-native payments (PennyMac, Frontier)",
    match: { payees: ["PENNYMAC", "FRONTIER CU LOAN"], amountEqualsScheduled: true },
    action: { matchBankLedgerEntry: true },
    mayAutoPost: true,
    state: "proposed",
    proposedBy: "system",
    proposedByName: "System (spec candidate)",
    version: 1,
    stats: { fired: 0, corrected: 0 },
  },
];

export const subscriptions: BcSubscriptionSummary[] = [
  { resource: "generalLedgerEntries", subscriptionId: "sub-gle-1", expiresAt: iso(-2.1 * D), lastRenewedAt: iso(0.9 * D), needsRenewal: false },
  { resource: "journals", subscriptionId: "sub-jnl-1", expiresAt: iso(-0.4 * D), lastRenewedAt: iso(2.6 * D), needsRenewal: true },
];

export const feeds: FeedConnectionSummary[] = [
  { id: "feed-beehive", provider: "plaid", institutionName: "Beehive FCU", ownerMemberId: VANESSA_ID, ownerName: "Vanessa", status: "ok", needsRelink: false, lastSyncedAt: iso(3 * H), accountCount: 3, cursorPresent: true },
  { id: "feed-venmo", provider: "plaid", institutionName: "Venmo", ownerMemberId: VANESSA_ID, ownerName: "Vanessa", status: "ok", needsRelink: false, lastSyncedAt: iso(3.2 * H), accountCount: 1, cursorPresent: true },
  { id: "feed-afcu", provider: "plaid", institutionName: "America First CU", ownerMemberId: CADE_ID, ownerName: "Cade", status: "ok", needsRelink: false, lastSyncedAt: iso(2.8 * H), accountCount: 4, cursorPresent: true },
  { id: "feed-macu", provider: "plaid", institutionName: "Mountain America CU", ownerMemberId: CADE_ID, ownerName: "Cade", status: "stale", needsRelink: false, lastSyncedAt: iso(3.1 * D), accountCount: 2, cursorPresent: true },
  { id: "feed-capone", provider: "plaid", institutionName: "Capital One", ownerMemberId: CADE_ID, ownerName: "Cade", status: "needs_relink", needsRelink: true, lastSyncedAt: iso(4 * D), accountCount: 1, cursorPresent: true },
  { id: "feed-carecredit", provider: "file", institutionName: "CareCredit (Synchrony)", ownerMemberId: CADE_ID, ownerName: "Cade", status: "ok", needsRelink: false, lastSyncedAt: iso(18 * D), accountCount: 1, cursorPresent: false },
  { id: "feed-frontier", provider: "file", institutionName: "Frontier CU", ownerMemberId: CADE_ID, ownerName: "Cade", status: "ok", needsRelink: false, lastSyncedAt: iso(20 * D), accountCount: 3, cursorPresent: false },
  { id: "feed-pennymac", provider: "file", institutionName: "PennyMac", ownerMemberId: CADE_ID, ownerName: "Cade", status: "ok", needsRelink: false, lastSyncedAt: iso(22 * D), accountCount: 1, cursorPresent: false },
];

export const syncRuns: SyncRunSummary[] = [
  { id: "run-1", kind: "plaid", startedAt: iso(3 * H), finishedAt: iso(3 * H - 42_000), status: "ok", counts: { added: 7, modified: 1, removed: 0, items: 5 } },
  { id: "run-2", kind: "bc_poll", startedAt: iso(12 * H), finishedAt: iso(12 * H - 95_000), status: "ok", counts: { batches: 3, compared: 41, differences: 3, exceptionsOpened: 2 } },
  { id: "run-3", kind: "webhook_renewal", startedAt: iso(0.9 * D), finishedAt: iso(0.9 * D - 4_000), status: "ok", counts: { renewed: 1, failed: 1 }, error: "journals: 409 subscription busy; will retry" },
  { id: "run-4", kind: "plaid", startedAt: iso(7 * H), finishedAt: iso(7 * H - 30_000), status: "failed", counts: { items: 5, failedItems: 1 }, error: "ITEM_LOGIN_REQUIRED on one item (Capital One); marked needs_relink" },
  { id: "run-5", kind: "ocr", startedAt: iso(1.2 * D), finishedAt: iso(1.2 * D - 8_000), status: "ok", counts: { receipts: 2, read: 2, needsReview: 1 } },
  { id: "run-6", kind: "alerts", startedAt: iso(7 * H + 10 * 60_000), finishedAt: iso(7 * H + 9 * 60_000), status: "ok", counts: { evaluated: 14, opened: 1, closed: 0 } },
  { id: "run-7", kind: "bc_webhook", startedAt: iso(5 * H), finishedAt: iso(5 * H - 2_000), status: "ok", counts: { notifications: 2, matched: 2 } },
  { id: "run-8", kind: "autopost", startedAt: iso(1 * H), finishedAt: iso(1 * H - 1_000), status: "ok", counts: { posted: 0, skipped: 0 }, error: undefined },
  { id: "run-9", kind: "file_import", startedAt: iso(3.5 * D), finishedAt: iso(3.5 * D - 6_000), status: "ok", counts: { rows: 38, imported: 36, possibleDuplicates: 2 } },
  { id: "run-10", kind: "bc_poll", startedAt: iso(1.5 * D), finishedAt: iso(1.5 * D - 80_000), status: "ok", counts: { batches: 3, compared: 39, differences: 0 } },
];

export const outbox: OutboxItem[] = [
  { id: "ob-1", aggregate: "transaction", aggregateId: "tx-0019", operation: "send_to_bc", attempts: 2, nextAttemptAt: iso(-8 * 60_000), lastError: "BC 429: retry after backoff", deadLettered: false, publishedAt: iso(40 * 60_000), createdAt: iso(45 * 60_000) },
  { id: "ob-2", aggregate: "transaction", aggregateId: "tx-0021", operation: "send_to_bc", attempts: 0, nextAttemptAt: iso(0), deadLettered: false, createdAt: iso(2 * 60_000) },
  { id: "ob-3", aggregate: "transaction", aggregateId: "tx-0022", operation: "send_to_bc", attempts: 0, nextAttemptAt: iso(0), deadLettered: false, createdAt: iso(90_000) },
  { id: "ob-5", aggregate: "budget_revision", aggregateId: "bud-rev-3", operation: "write_budget_revision", attempts: 6, nextAttemptAt: iso(5 * D), lastError: "HH App Connector 403: budget name BUD26-ORIG refused (ORIG budgets are never written)", deadLettered: true, publishedAt: iso(5 * D), createdAt: iso(5.1 * D) },
  { id: "ob-4", aggregate: "transaction", aggregateId: "tx-0014", operation: "send_to_bc", attempts: 6, nextAttemptAt: iso(2 * D), lastError: "BC 400: dimension value SINK-GIFTS blocked for account 603101", deadLettered: true, publishedAt: iso(2 * D), createdAt: iso(2.1 * D) },
];

export const auditLog: AuditEntry[] = [
  { id: "aud-1", actor: VANESSA_ID, action: "transaction.approve", entity: "transaction", entityId: "tx-0021", at: iso(2 * H), before: { state: "ready_for_review" }, after: { state: "approved", categoryId: "groceries" } },
  { id: "aud-2", actor: "jobs:bc_poll", action: "transaction.exception", entity: "transaction", entityId: "tx-0014", at: iso(12 * H), before: { state: "bc_draft_created" }, after: { state: "exception", reason: "draft missing in BC" } },
  { id: "aud-3", actor: "jobs:bc_poll", action: "transaction.exception", entity: "transaction", entityId: "tx-0015", at: iso(12 * H), before: { state: "bc_draft_created" }, after: { state: "exception", reason: "count/sum differs" } },
  { id: "aud-4", actor: CADE_ID, action: "rule.propose", entity: "rule", entityId: "rule-m2", at: iso(21 * D), after: { name: "Verizon → Phones", version: 1 } },
  { id: "aud-5", actor: VANESSA_ID, action: "rule.approve", entity: "rule", entityId: "rule-m2", at: iso(20 * D), before: { state: "proposed" }, after: { state: "approved", stepUp: true } },
  { id: "aud-6", actor: "jobs:plaid", action: "feed.needs_relink", entity: "feed_connection", entityId: "feed-capone", at: iso(7 * H), before: { status: "ok" }, after: { status: "needs_relink" } },
  { id: "aud-7", actor: CADE_ID, action: "transaction.business_flag", entity: "transaction", entityId: "tx-0026", at: iso(1.5 * D), before: { businessFlag: "none" }, after: { businessFlag: "ctj" } },
  { id: "aud-8", actor: "jobs:webhook_renewal", action: "webhooks.renewed", entity: "household", entityId: HOUSEHOLD_ID, at: iso(0.9 * D), after: { expiresAt: iso(-2.1 * D) } },
  { id: "aud-9", actor: VANESSA_ID, action: "receipt.upload", entity: "receipt", entityId: "rcpt-101", at: iso(1.2 * D), after: { sha256: "3f1c9a0e…" } },
  { id: "aud-10", actor: "jobs:relay", action: "outbox.dead_letter", entity: "outbox", entityId: "ob-4", at: iso(2 * D), after: { attempts: 6 } },
  { id: "aud-11", actor: CADE_ID, action: "settings.version", entity: "household", entityId: HOUSEHOLD_ID, at: iso(30 * D), after: { version: 1, note: "Draft authority matrix from the Phase 3 spec" } },
  { id: "aud-12", actor: "jobs:bc_webhook", action: "transaction.posted", entity: "transaction", entityId: "tx-0025", at: iso(24 * D), before: { state: "bc_draft_created" }, after: { state: "posted", entryNos: [4250] } },
];

const chartName = (no: string) => CHART.find((a) => a.no === no)?.name;

const dimensionValueNames: Record<string, Record<string, string>> = {
  SPEND_CLASS: { ESSENTIAL: "Essential", COMMITTED: "Committed", FLEXIBLE: "Flexible", DISCRETIONARY: "Discretionary", GIVING: "Giving", TRANSFER: "Transfer (excluded)", NONCASH: "Non-cash" },
  FUND_GOAL: { OPERATING: "Operating cash", "EMERG-1M": "Emergency, 1 month", "EMERG-3-6M": "Emergency, 3–6 months", "DEBT-TARGET": "Debt target", RETIRE: "Retirement", EDUCATION: "Education", MAJOR: "Major goal" },
  FAMILY_AREA: { JOINT: "Joint household", CADE: "Cade", VANESSA: "Vanessa", KIDS: "Kids" },
  TAX_TREATMENT: { TAXABLE: "Taxable", TAXFREE: "Tax-free", TAXDEFER: "Tax-deferred", "DED-CHAR": "Deductible: charitable", "DED-BUS": "Deductible: business", REVIEW: "Review required", NONDEDUCT: "Nondeductible" },
  PROJECT: { "HOME-SHOP": "Home shop build-out", "F350-BUILD": "F-350 build", "XMAS-2026": "Christmas 2026", "TRIP-2027": "Trip 2027" },
};

const dims = (code: keyof typeof DIMENSION_CODES, values: readonly string[], slot: DimensionDictionaryEntry["slot"], name: string): DimensionDictionaryEntry => ({
  code,
  name,
  slot,
  values: values.map((v) => ({ code: v, name: dimensionValueNames[code]?.[v] ?? v.replace(/-/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) })),
});

export const mappings: MappingSet = {
  catalogVersion: CATEGORY_CATALOG_VERSION,
  categories: CATEGORIES.map((c) => ({
    id: c.id,
    name: c.name,
    group: c.group,
    glAccount: c.glAccount,
    glAccountName: chartName(c.glAccount),
    dims: c.dims,
    spendClass: c.dims.SPEND_CLASS,
    isAllowance: c.isAllowance,
    isTransfer: c.isTransfer,
    householdVisible: c.householdVisible,
    version: 1,
  })),
  dimensions: [
    dims("SPEND_CLASS", SPEND_CLASS, "global1", "Spend class"),
    dims("FUND_GOAL", FUND_GOAL, "global2", "Fund / goal"),
    dims("FAMILY_AREA", FAMILY_AREA, "shortcut3", "Family area"),
    dims("TAX_TREATMENT", TAX_TREATMENT, "shortcut4", "Tax treatment"),
    dims("PROJECT", PROJECT, "shortcut5", "Project"),
  ],
  bankCards: BANK_CARD_LIST.map((b) => ({
    code: b.code,
    glAccount: b.glAccount,
    name: b.name,
    kind: b.kind,
    institution: b.institution,
    mask: b.mask,
    accountId: accountIdOf(b.code),
    feedProvider: ["CARECREDIT", "FRONTIER-SH", "CASH"].includes(b.code) ? "file" : "plaid",
  })),
  employers: [
    {
      id: "emp-hfh",
      code: "HFH",
      name: "Henry's Fork Homes",
      memberName: "Cade",
      descriptorPattern: "HENRYS FORK HOMES PAYROLL",
      grossAccount: "401101",
      bonusAccount: "401102",
      components: [
        { kind: "regular", label: "Regular pay", glAccount: "401101", dims: { FAMILY_AREA: "CADE", TAX_TREATMENT: "TAXABLE" } },
        { kind: "bonus", label: "Bonus", glAccount: "401102", dims: { FAMILY_AREA: "CADE", TAX_TREATMENT: "TAXABLE" } },
        { kind: "fit", label: "Federal withholding", glAccount: "701101", dims: { SPEND_CLASS: "COMMITTED" } },
        { kind: "state_tax", label: "Idaho withholding", glAccount: "701201", dims: { SPEND_CLASS: "COMMITTED", TAX_TREATMENT: "DED-SALT" } },
        { kind: "social_security", label: "Social Security", glAccount: "701301", dims: { SPEND_CLASS: "COMMITTED" } },
        { kind: "medicare", label: "Medicare", glAccount: "701401", dims: { SPEND_CLASS: "COMMITTED" } },
        { kind: "other_deduction", label: "Other deductions", glAccount: "701801", dims: { TAX_TREATMENT: "REVIEW" } },
      ],
      lastStubAt: iso(14 * D),
    },
    {
      id: "emp-ctj",
      code: "CTJ",
      name: "Cade T. Jones CPA, P.C.",
      memberName: "Cade",
      descriptorPattern: "CADE T JONES CPA PAYROLL|GUSTO",
      grossAccount: "401201",
      bonusAccount: "401202",
      components: [
        { kind: "regular", label: "Regular pay", glAccount: "401201", dims: { FAMILY_AREA: "CADE", TAX_TREATMENT: "TAXABLE" } },
        { kind: "bonus", label: "Bonus", glAccount: "401202", dims: { FAMILY_AREA: "CADE", TAX_TREATMENT: "TAXABLE" } },
        { kind: "fit", label: "Federal withholding", glAccount: "701102", dims: { SPEND_CLASS: "COMMITTED" } },
        { kind: "state_tax", label: "Idaho withholding", glAccount: "701202", dims: { SPEND_CLASS: "COMMITTED", TAX_TREATMENT: "DED-SALT" } },
        { kind: "social_security", label: "Social Security", glAccount: "701302", dims: { SPEND_CLASS: "COMMITTED" } },
        { kind: "medicare", label: "Medicare", glAccount: "701402", dims: { SPEND_CLASS: "COMMITTED" } },
      ],
      lastStubAt: iso(28 * D),
    },
  ],
  pendingProposals: [],
  dataThrough: dataThrough("posted_unreconciled", 0, 9 * H),
};

export const authority: AuthorityMatrix = {
  version: 1,
  rows: [
    { action: "Approve a classification or split", who: "Either spouse", stepUp: "No", notes: "One tap" },
    { action: "Mark an item as business", who: "Either spouse", stepUp: "No", notes: "Shown to Cade in the CTJ list" },
    { action: "Post approved drafts in BC", who: "Cade", stepUp: "BC sign-in", notes: "Until auto-post rules are approved" },
    { action: "Auto-post under R1–R7", who: "System", stepUp: "None", notes: "Only after written approval of each rule and the AUTOPOST permission" },
    { action: "Approve or retire a rule", who: "The spouse who did not propose it", stepUp: "Yes", notes: "Auto-post flag on a rule needs Cade's written approval" },
    { action: "Budget move", who: "The other spouse", stepUp: "Yes (Face ID)", notes: "I-09 threshold for unilateral moves between flexible categories: $[TBD]", settingKeys: ["I-09"], tbd: true },
    { action: "Correction after posting", who: "Cade", stepUp: "BC sign-in", notes: "Reverse and repost in BC with reason CORRECT" },
    { action: "Opening-balance or policy change", who: "Both, in writing", stepUp: "Yes", notes: "Per BC design §12" },
    { action: "Change thresholds, quiet hours, alert types", who: "Both", stepUp: "Yes", notes: "Settings are versioned" },
    { action: "Connect or remove a bank login", who: "The login's owner", stepUp: "Yes", notes: "Never the other spouse" },
    { action: "Export all data", who: "Either spouse", stepUp: "Yes", notes: "Full human-readable export" },
  ],
  settings: {
    version: 1,
    effectiveFrom: iso(30 * D),
    values: {
      "I-09 unilateral budget move threshold": "TBD (Constitution decision pending)",
      "Materiality line": "$25.00",
      "Receipt threshold (Walmart, club, Amazon)": "$25.00",
      "Quiet hours": "9:00 pm – 7:00 am Mountain",
      "Feed stale after": "48 hours",
      "Step-up window": "2 minutes",
      "Console session": "12 hours",
      "Auto-post switch": "off",
      "Auto-classification confidence": "0.98",
    },
    history: [{ version: 1, effectiveFrom: iso(30 * D), approvedBy: ["Cade (draft from the Phase 3 spec; awaiting joint approval)"] }],
  },
  autoPostRules: [
    { ruleNo: "R1", name: "HFH paycheck", state: "proposed", mayAutoPost: true },
    { ruleNo: "R2", name: "Own-account transfer", state: "proposed", mayAutoPost: true, testPassedAt: iso(2 * D) },
    { ruleNo: "R3", name: "Card payment", state: "proposed", mayAutoPost: true },
    { ruleNo: "R4", name: "Recurring bill, fixed", state: "proposed", mayAutoPost: true },
    { ruleNo: "R5", name: "Tithing", state: "proposed", mayAutoPost: true },
    { ruleNo: "R6", name: "Small known merchant", state: "proposed", mayAutoPost: true },
    { ruleNo: "R7", name: "BC-native payments", state: "proposed", mayAutoPost: true },
  ],
  dataThrough: dataThrough("posted_reconciled", 0, 60_000),
};

export function reconciliationCards(): BankCardReconStatus[] {
  const seed: Record<string, Partial<BankCardReconStatus>> = {
    "BEEHIVE-CHK": { openCount: 9, reconciledCount: 212, openSumCents: -41833, lastStatementNo: "2026-09", lastStatementDate: ymd(19 * D), reconciledThrough: ymd(19 * D), feedStatus: "ok", differences: [{ transactionId: "tx-0014", postedDate: ymd(12 * D), amountCents: -4210, note: "App shows a draft; BC bank ledger has no entry (see exception)." }] },
    "BEEHIVE-CHK2": { openCount: 0, reconciledCount: 14, openSumCents: 0, lastStatementNo: "2026-09", lastStatementDate: ymd(19 * D), reconciledThrough: ymd(19 * D), feedStatus: "ok" },
    "BEEHIVE-SAV": { openCount: 1, reconciledCount: 31, openSumCents: 15000, lastStatementNo: "2026-09", lastStatementDate: ymd(19 * D), reconciledThrough: ymd(19 * D), feedStatus: "ok" },
    "AFCU-CHK": { openCount: 4, reconciledCount: 88, openSumCents: -123542, lastStatementNo: "2026-09", lastStatementDate: ymd(20 * D), reconciledThrough: ymd(20 * D), feedStatus: "ok", differences: [{ bankLedgerEntryNo: 4471, postedDate: ymd(20 * D), amountCents: -25000, note: "BC entry with an HHAPP- number the app does not know (exception tx-0016)." }] },
    "AFCU-SAV": { openCount: 0, reconciledCount: 12, openSumCents: 0, lastStatementNo: "2026-09", lastStatementDate: ymd(20 * D), reconciledThrough: ymd(20 * D), feedStatus: "ok" },
    "MACU-CHK": { openCount: 0, reconciledCount: 3, openSumCents: 0, lastStatementNo: "2026-08", lastStatementDate: ymd(50 * D), reconciledThrough: ymd(50 * D), feedStatus: "stale" },
    "MACU-SAV": { openCount: 0, reconciledCount: 2, openSumCents: 0, lastStatementNo: "2026-08", lastStatementDate: ymd(50 * D), reconciledThrough: ymd(50 * D), feedStatus: "stale" },
    "FRONTIER-SH": { openCount: 0, reconciledCount: 4, openSumCents: 0, lastStatementNo: "2026-09", lastStatementDate: ymd(20 * D), reconciledThrough: ymd(20 * D), feedStatus: "file_only" },
    CASH: { openCount: 2, reconciledCount: 6, openSumCents: -4000, feedStatus: "none" },
    VENMO: { openCount: 3, reconciledCount: 27, openSumCents: 8500, lastStatementNo: "2026-09", lastStatementDate: ymd(19 * D), reconciledThrough: ymd(19 * D), feedStatus: "ok" },
    "CAPONE-CC": { openCount: 11, reconciledCount: 301, openSumCents: -46229, lastStatementNo: "2026-09", lastStatementDate: ymd(14 * D), reconciledThrough: ymd(14 * D), feedStatus: "needs_relink", differences: [{ transactionId: "tx-0015", postedDate: ymd(15 * D), amountCents: -12890, note: "Split count differs between the app and BC (exception tx-0015)." }] },
    "AFCU-VISA": { openCount: 2, reconciledCount: 44, openSumCents: -11900, lastStatementNo: "2026-09", lastStatementDate: ymd(16 * D), reconciledThrough: ymd(16 * D), feedStatus: "ok" },
    CARECREDIT: { openCount: 0, reconciledCount: 9, openSumCents: 0, lastStatementNo: "2026-09", lastStatementDate: ymd(18 * D), reconciledThrough: ymd(18 * D), feedStatus: "file_only" },
    "AFCU-ODL": { openCount: 0, reconciledCount: 5, openSumCents: 0, lastStatementNo: "2026-09", lastStatementDate: ymd(20 * D), reconciledThrough: ymd(20 * D), feedStatus: "ok" },
  };
  return BANK_CARD_LIST.map((b) => {
    const s = seed[b.code] ?? {};
    return {
      code: b.code,
      name: b.name,
      glAccount: b.glAccount,
      institution: b.institution,
      mask: b.mask,
      openCount: s.openCount ?? 0,
      reconciledCount: s.reconciledCount ?? 0,
      openSumCents: s.openSumCents ?? 0,
      lastStatementNo: s.lastStatementNo,
      lastStatementDate: s.lastStatementDate,
      reconciledThrough: s.reconciledThrough,
      differences: s.differences ?? [],
      feedStatus: s.feedStatus ?? "none",
    };
  });
}

export const loans: LoanRollforward[] = [
  { id: "loan-frontier-1", name: "Frontier auto loan — Suburban", lender: "Frontier CU", mask: "7003-0001", glAccount: "251101", openingCents: 1_842_311, principalCents: 41_022, interestCents: 8_978, feesCents: 0, closingCents: 1_801_289, matchedEntryNo: 4388, matchedAt: iso(20 * D), period: ymd(20 * D).slice(0, 7), nextDueDate: ymd(-10 * D) },
  { id: "loan-frontier-2", name: "Frontier auto loan — F-350", lender: "Frontier CU", mask: "7003-0002", glAccount: "251201", openingCents: 2_610_540, principalCents: 52_310, interestCents: 12_690, feesCents: 0, closingCents: 2_558_230, matchedEntryNo: 4389, matchedAt: iso(20 * D), period: ymd(20 * D).slice(0, 7), nextDueDate: ymd(-10 * D) },
  { id: "loan-pennymac", name: "PennyMac mortgage", lender: "PennyMac", mask: "9114", glAccount: "271101", openingCents: 31_204_118, principalCents: 38_912, interestCents: 112_430, feesCents: 0, escrowCents: 47_200, closingCents: 31_165_206, matchedEntryNo: 4402, matchedAt: iso(28 * D), period: ymd(28 * D).slice(0, 7), nextDueDate: ymd(-2 * D) },
];
