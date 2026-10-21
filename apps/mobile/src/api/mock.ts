/**
 * MockApi: serves the Phase 2 prototype's sample data (prototype/homestead.html) so the app runs with no
 * backend (`EXPO_PUBLIC_API_MODE=mock`). Examples, not real balances. State lives in memory for the session:
 * answers, corrections, business flags, budget moves, approvals and snapped receipts all behave like the
 * prototype. Option ids follow the OpenAPI convention (`confirm`, `edit`, `category:<id>`, `approve`, `decline`).
 */
import {
  addDays,
  type Alert,
  type Approval,
  type ApprovalDecision,
  type AskAnswer,
  type Bill,
  type BudgetLine,
  type BudgetStatus,
  type BusinessFlag,
  type DataThrough,
  type MemberSummary,
  type PaycheckSummary,
  type PlainStatus,
  type Question,
  type ReceiptSummary,
  type Transaction,
  type TransactionSplit,
  type TransactionState,
} from "@homestead/shared";
import { fmtDate, fmtShort, monthProgress, money, money0, todayIso } from "../model/format";
import { categoryName } from "../model/categories";
import type {
  AccountsResponse,
  AnswerInput,
  AnswerResponse,
  AskHistoryItem,
  BillsResponse,
  BudgetMoveInput,
  CorrectionInput,
  CorrectionResponse,
  GoalsResponse,
  HomesteadApi,
  Me,
  PushTokenRegistration,
  QuestionsResponse,
  ReceiptDetail,
  RuleProposalInput,
  SafeToSpendView,
  TransactionsPage,
  TransactionsQuery,
  UploadReceiptInput,
  UploadReceiptResult,
} from "./types";
import { ApiError, StepUpRequiredError } from "./types";

export const MOCK_MEMBERS: Record<string, MemberSummary> = {
  "dev-vanessa": { id: "dev-vanessa", displayName: "Vanessa", role: "member" },
  "dev-cade": { id: "dev-cade", displayName: "Cade", role: "member" },
};

const LATENCY_MS = 180;
const delay = (ms = LATENCY_MS) => new Promise<void>((r) => setTimeout(r, ms));

interface SeedTx {
  id: string;
  off: number;
  name: string;
  amt: number;
  cat?: string;
  st: "recorded" | "question" | "books" | "matched";
  acct: string;
  /** The prototype's "who": the FAMILY_AREA the line is tagged with. */
  who: "CADE" | "VANESSA" | "JOINT";
  kind?: Transaction["kind"];
  receipt?: boolean;
  est?: boolean;
  split?: [string, number][];
}

const SEED_TX: SeedTx[] = [
  { id: "t1", off: 0, name: "Maverik", amt: -58.4, cat: "fuel", st: "recorded", acct: "a-capone", who: "CADE" },
  { id: "t2", off: 0, name: "Broulim's", amt: -64.12, cat: "groceries", st: "recorded", acct: "a-beehive", who: "VANESSA" },
  { id: "t3", off: -1, name: "Walmart", amt: -142.37, cat: "groceries", st: "question", acct: "a-beehive", receipt: true, split: [["groceries", -88.2], ["household-supplies", -31.17], ["general-merchandise", -23.0]], who: "VANESSA" },
  { id: "t4", off: -1, name: "Venmo · Kayla M.", amt: 85, cat: "income-lash", st: "question", acct: "a-venmo", who: "VANESSA" },
  { id: "t5", off: -2, name: "Amazon", amt: -46.18, st: "question", acct: "a-capone", who: "VANESSA" },
  { id: "t6", off: -2, name: "DoorDash", amt: -31.55, cat: "food-delivery", st: "books", acct: "a-capone", who: "CADE" },
  { id: "t7", off: -3, name: "Madison School District", amt: -45, cat: "school", st: "books", acct: "a-beehive", who: "VANESSA" },
  { id: "t8", off: -4, name: "Capital One payment", amt: -400, cat: "card-payment", st: "matched", kind: "transfer", acct: "a-afcu", who: "CADE" },
  { id: "t9", off: -5, name: "Cade's paycheck · Henry's Fork Homes", amt: 3135.59, cat: "income-hfh-wages", st: "books", kind: "paycheck", acct: "a-afcu", who: "CADE" },
  { id: "t10", off: -5, name: "To savings", amt: -200, cat: "transfer-own", st: "matched", kind: "transfer", acct: "a-beehive", who: "CADE" },
  { id: "t11", off: -6, name: "Crumbl", amt: -23, cat: "treats", st: "books", acct: "a-beehive", who: "VANESSA" },
  { id: "t12", off: -7, name: "Frontier CU · F-350 payment", amt: -1496.09, cat: "car-loan", st: "books", kind: "bc_native", acct: "a-afcu", who: "CADE" },
  { id: "t13", off: -8, name: "Valley Wide Co-op", amt: -71.2, cat: "fuel", st: "matched", acct: "a-capone", who: "CADE" },
  { id: "t14", off: -9, name: "Tithing", amt: -388.08, cat: "tithing", st: "matched", acct: "a-beehive", who: "JOINT" },
  { id: "t15", off: -10, name: "Walmart", amt: -89.9, cat: "groceries", st: "books", est: true, acct: "a-beehive", who: "VANESSA" },
  { id: "t16", off: -12, name: "PennyMac · mortgage", amt: -5670.39, cat: "mortgage", st: "books", kind: "bc_native", acct: "a-afcu", who: "JOINT" },
];

const STATE_OF: Record<SeedTx["st"], TransactionState> = { recorded: "approved", question: "ready_for_review", books: "posted", matched: "reconciled" };
const STATUS_OF: Record<TransactionState, PlainStatus> = {
  imported: "recorded",
  possible_duplicate: "needs_answer",
  needs_receipt: "needs_answer",
  needs_classification: "needs_answer",
  ready_for_review: "needs_answer",
  approved: "recorded",
  sent_to_bc: "recorded",
  bc_draft_created: "recorded",
  posted: "in_books",
  reconciled: "matched",
  exception: "being_checked",
  reversed: "in_books",
  dropped: "dropped",
};

const PAY = { gross: 388077, regular: 365000, bonus: 23077, fit: 29830, idaho: 15000, ss: 24061, medicare: 5627, net: 313559 };

interface SeedBill {
  id: string;
  name: string;
  amt: number;
  off: number;
  cat: string;
  isMinimum?: boolean;
  bcNative?: boolean;
}

/** Placed around payday (offset from it) so the "before payday" set stays the same whatever today is. */
const SEED_BILLS: SeedBill[] = [
  { id: "b1", name: "Verizon · phones", amt: 153.2, off: -3, cat: "phones" },
  { id: "b2", name: "Rocky Mountain Power", amt: 118.4, off: -1, cat: "electricity" },
  { id: "b3", name: "Capital One · minimum", amt: 363, off: 1, cat: "card-payment", isMinimum: true },
  { id: "b4", name: "Frontier CU · Suburban", amt: 1047.11, off: 4, cat: "car-loan", bcNative: true },
  { id: "b5", name: "America First Visa · minimum", amt: 222, off: 6, cat: "card-payment", isMinimum: true },
  { id: "b6", name: "PennyMac · mortgage", amt: 5670.39, off: 8, cat: "mortgage", bcNative: true },
  { id: "b7", name: "Internet", amt: 79.99, off: 10, cat: "internet" },
  { id: "b8", name: "Clear Management · trash", amt: 150, off: 12, cat: "water-sewer-trash" },
  { id: "b9", name: "Frontier CU · F-350", amt: 1496.09, off: 14, cat: "car-loan", bcNative: true },
];

interface SeedBudget {
  id: string;
  name: string;
  b: number;
  s: number;
  kind?: "committed" | "allowance";
}

const SEED_BUDGET: SeedBudget[] = [
  { id: "giving", name: "Giving", b: 1700, s: 850, kind: "committed" },
  { id: "housing", name: "Housing", b: 5670, s: 5670, kind: "committed" },
  { id: "utilities", name: "Utilities", b: 650, s: 420 },
  { id: "groceries-household", name: "Groceries & household", b: 1900, s: 1410 },
  { id: "eating-out-treats", name: "Eating out & treats", b: 450, s: 388 },
  { id: "gas-car", name: "Gas & car", b: 600, s: 310 },
  { id: "kids-school", name: "Kids & school", b: 350, s: 95 },
  { id: "fun-shopping", name: "Fun & shopping", b: 400, s: 260 },
  { id: "subscriptions", name: "Subscriptions", b: 180, s: 180, kind: "committed" },
  { id: "allowance-cade", name: "Cade's allowance", b: 150, s: 90, kind: "allowance" },
  { id: "allowance-vanessa", name: "Vanessa's allowance", b: 150, s: 40, kind: "allowance" },
];

const cents = (n: number): number => Math.round(n * 100);

interface BudgetRow {
  id: string;
  name: string;
  budgetCents: number;
  spentCents: number;
  kind?: "committed" | "allowance";
}

export interface MockOptions {
  now?: Date;
  /** Shorten the simulated latencies (tests). */
  fast?: boolean;
  /**
   * Whether a fresh step-up (Face ID inside 2 minutes) backs the current call. The API refuses to decide a budget
   * move, rule or settings approval without one, approve or decline alike; the mock does the same.
   */
  stepUpFresh?: () => boolean;
}

/** Approval kinds the API decides only with a fresh step-up (services/api/src/services/approvals.ts). */
const STEP_UP_KINDS = new Set<Approval["kind"]>(["budget_move", "rule", "auto_post_rule", "settings", "correction"]);

export class MockApi implements HomesteadApi {
  private readonly today: string;
  private readonly payday: string;
  private readonly txs: Transaction[];
  private readonly budgetRows: BudgetRow[];
  private readonly questionsById = new Map<string, Question>();
  private readonly approvalsList: Approval[] = [];
  private readonly receipts = new Map<string, ReceiptDetail>();
  private readonly receiptByHash = new Map<string, string>();
  private readonly fixPending = new Set<string>();
  private readonly alertsList: Alert[];
  private readonly history: AskHistoryItem[] = [];
  private readonly pushTokens = new Set<string>();
  private revision = 2;
  private receiptSeq = 0;
  private readonly fast: boolean;
  private readonly stepUpFresh: () => boolean;

  constructor(private readonly memberId: () => string, opts: MockOptions = {}) {
    const now = opts.now ?? new Date();
    this.fast = opts.fast ?? false;
    this.stepUpFresh = opts.stepUpFresh ?? (() => true);
    this.today = todayIso(now);
    // The next Friday at least 3 days out, like the prototype, so "before payday" always holds a few bills.
    this.payday = nextFriday(this.today, 3);
    this.txs = SEED_TX.map((s) => this.toTx(s));
    this.budgetRows = SEED_BUDGET.map((b) => ({ id: b.id, name: b.name, budgetCents: cents(b.b), spentCents: cents(b.s), ...(b.kind ? { kind: b.kind } : {}) }));
    this.approvalsList.push({
      id: "ap1",
      kind: "budget_move",
      payload: { fromCategoryId: "fun-shopping", toCategoryId: "gas-car", amountCents: 7500, note: "Two trips to Idaho Falls this week." },
      requestedBy: "dev-cade",
      requestedByName: "Cade",
      stepUpVerified: false,
      requestedAt: new Date(now.getTime() - 3 * 3600_000).toISOString(),
      effect: "Gas & car would have $365 left; Fun & shopping would have $65 left.",
    });
    this.seedQuestions();
    this.alertsList = [
      {
        id: "al1",
        kind: "receipt_missing",
        level: "watch",
        fingerprint: "receipt_missing:t15",
        title: "No receipt for Walmart $89.90",
        body: "It was split the usual way (60% groceries, 25% household, 15% other). Snap the receipt next time and it splits itself.",
        createdAt: new Date(now.getTime() - 26 * 3600_000).toISOString(),
      },
      {
        id: "al2",
        kind: "weekly_pulse",
        level: "pulse",
        fingerprint: "pulse:week",
        title: "This week's pulse",
        body: "Every bill before payday is covered. Three things need a quick answer on Home. The emergency fund grew $190.",
        createdAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      },
    ];
  }

  private wait(ms = LATENCY_MS): Promise<void> {
    return delay(this.fast ? 0 : ms);
  }

  private me_(): MemberSummary {
    return MOCK_MEMBERS[this.memberId()] ?? { id: this.memberId(), displayName: "Vanessa", role: "member" };
  }

  private other(): MemberSummary {
    return this.me_().id === "dev-cade" ? (MOCK_MEMBERS["dev-vanessa"] as MemberSummary) : (MOCK_MEMBERS["dev-cade"] as MemberSummary);
  }

  private dataThrough(): DataThrough {
    const pending = this.txs.filter((t) => t.status === "recorded" || t.status === "needs_answer").length;
    return { at: `${addDays(this.today, -1)}T23:59:00-06:00`, quality: "imported_pending", pendingCount: pending };
  }

  private toTx(s: SeedTx): Transaction {
    const state = STATE_OF[s.st];
    const date = addDays(this.today, s.off);
    const amountCents = cents(s.amt);
    const kind: Transaction["kind"] = s.kind ?? (amountCents > 0 ? "income" : "spend");
    const splits: TransactionSplit[] = (s.split ?? []).map(([cat, amt], i) => ({ lineNo: i + 1, amountCents: cents(amt), categoryId: cat, glAccount: "", dims: {} }));
    return {
      id: s.id,
      accountId: s.acct,
      source: "plaid",
      sourceRef: `plaid:${s.id}`,
      idempotencyKey: `plaid:${s.acct}:${s.id}`,
      postedDate: date,
      amountCents,
      merchantRaw: s.name.toUpperCase(),
      merchantNorm: s.name,
      pending: false,
      state,
      status: STATUS_OF[state],
      kind,
      ...(s.cat ? { categoryId: s.cat } : {}),
      dims: { FAMILY_AREA: s.who },
      businessFlag: "none",
      splits,
      receiptStatus: s.receipt ? "matched" : s.est ? "estimated" : "none",
      ...(s.receipt ? { receiptId: `rcpt-seed-${s.id}` } : {}),
      createdAt: `${date}T08:00:00-06:00`,
      updatedAt: `${date}T08:00:00-06:00`,
    };
  }

  private seedQuestions(): void {
    const t3 = this.find("t3");
    const t4 = this.find("t4");
    const t5 = this.find("t5");
    const base = (id: string, off: number) => ({ id, createdAt: `${addDays(this.today, off)}T09:00:00-06:00` });
    this.questionsById.set("tx:t3", {
      ...base("tx:t3", -1),
      kind: "confirm_split",
      transactionId: "t3",
      prompt: `Walmart ${money(t3.amountCents)} — split from your receipt. Look right?`,
      why: "Why we're asking: receipts tell us what was groceries and what wasn't. One tap keeps the budget honest.",
      options: [
        { id: "confirm", label: "Yes" },
        { id: "edit", label: "Change" },
      ],
      defaultOptionId: "confirm",
      amountCents: t3.amountCents,
      merchant: "Walmart",
      date: t3.postedDate,
      splits: t3.splits,
    });
    this.questionsById.set("tx:t4", {
      ...base("tx:t4", -1),
      kind: "confirm_category",
      transactionId: "t4",
      prompt: "Venmo +$85.00 from Kayla M. — lash appointment?",
      why: "Why we're asking: Venmo money in could be lash income or a friend paying you back. Lash income counts toward your business.",
      options: [
        { id: "confirm", label: "Yes, lash", categoryId: "income-lash" },
        { id: "category:payments-to-people", label: "Something else", categoryId: "payments-to-people" },
      ],
      defaultOptionId: "confirm",
      amountCents: t4.amountCents,
      merchant: "Venmo · Kayla M.",
      date: t4.postedDate,
    });
    this.questionsById.set("tx:t5", {
      ...base("tx:t5", -2),
      kind: "pick_category",
      transactionId: "t5",
      prompt: `Amazon ${money(t5.amountCents)} — what was it?`,
      why: "Why we're asking: Amazon charges don't say what was in the box. Pick the closest category and we'll remember it for next time.",
      options: [
        { id: "category:groceries", label: "Groceries & household", categoryId: "groceries" },
        { id: "category:school", label: "Kids & school", categoryId: "school" },
        { id: "category:gifts", label: "Gifts", categoryId: "gifts" },
        { id: "category:general-merchandise", label: "Fun & shopping", categoryId: "general-merchandise" },
        { id: "edit", label: "Something else" },
      ],
      amountCents: t5.amountCents,
      merchant: "Amazon",
      date: t5.postedDate,
    });
  }

  /** The other spouse's open approvals, phrased as questions for the signed-in member (openapi: approve_budget_move). */
  private approvalQuestions(): Question[] {
    const me = this.me_().id;
    return this.approvalsList
      .filter((a) => !a.decision && a.requestedBy !== me && a.kind === "budget_move")
      .map((a) => {
        const from = this.budgetRows.find((c) => c.id === a.payload.fromCategoryId);
        const to = this.budgetRows.find((c) => c.id === a.payload.toCategoryId);
        const amt = a.payload.amountCents ?? 0;
        return {
          id: `apr:${a.id}`,
          kind: "approve_budget_move",
          approvalId: a.id,
          prompt: `${a.requestedByName ?? "The other spouse"} wants to move ${money0(amt)} from ${from?.name ?? "?"} to ${to?.name ?? "?"}`,
          why: a.payload.note ? `“${a.payload.note}” · ${to?.name ?? ""} would have ${money0((to?.budgetCents ?? 0) - (to?.spentCents ?? 0) + amt)} left.` : (a.effect ?? ""),
          options: [
            { id: "approve", label: "Approve with Face ID" },
            { id: "decline", label: "Not now" },
          ],
          amountCents: amt,
          createdAt: a.requestedAt,
        };
      });
  }

  private find(id: string): Transaction {
    const t = this.txs.find((x) => x.id === id);
    if (!t) throw new ApiError(404, "not_found", "That item isn't here any more.");
    return t;
  }

  async me(): Promise<Me> {
    await this.wait(80);
    return {
      member: this.me_(),
      household: { id: "hh-jones", name: "Jones family", timezone: "America/Boise", quietHours: { start: "21:00", end: "07:00" }, nextPaydayIso: this.payday },
      members: [MOCK_MEMBERS["dev-vanessa"] as MemberSummary, MOCK_MEMBERS["dev-cade"] as MemberSummary],
    };
  }

  async accounts(): Promise<AccountsResponse> {
    await this.wait();
    const asOf = `${addDays(this.today, -1)}T23:59:00-06:00`;
    return {
      accounts: [
        { id: "a-beehive", displayName: "Beehive checking", institution: "Beehive FCU", kind: "checking", mask: "4821", balanceCents: 61202, balanceAsOf: asOf, feedStatus: "ok" },
        { id: "a-afcu", displayName: "America First checking", institution: "America First CU", kind: "checking", mask: "1190", balanceCents: 40000, balanceAsOf: asOf, feedStatus: "ok" },
        { id: "a-beehive-share", displayName: "Beehive savings (emergency fund)", institution: "Beehive FCU", kind: "share", mask: "4822", balanceCents: 124000, balanceAsOf: asOf, feedStatus: "ok", isRestricted: true },
        { id: "a-capone", displayName: "Capital One", institution: "Capital One", kind: "card", mask: "7730", balanceCents: -1050800, balanceAsOf: asOf, feedStatus: "ok" },
        { id: "a-venmo", displayName: "Venmo", institution: "Venmo", kind: "wallet", mask: "", balanceCents: 8500, balanceAsOf: asOf, feedStatus: "ok" },
        { id: "a-carecredit", displayName: "CareCredit", institution: "Synchrony", kind: "card", mask: "0042", feedStatus: "file_only" },
        { id: "a-frontier-f350", displayName: "F-350 loan", institution: "Frontier CU", kind: "loan", mask: "2201", feedStatus: "file_only" },
        { id: "a-pennymac", displayName: "Mortgage", institution: "PennyMac", kind: "mortgage", mask: "9087", feedStatus: "file_only" },
      ],
      dataThrough: this.dataThrough(),
    };
  }

  async safeToSpend(): Promise<SafeToSpendView> {
    await this.wait();
    return this.safeNow();
  }

  /** The prototype's numbers: cash in checking $1,012.02, $300 set aside, bills before payday. */
  private safeNow(): SafeToSpendView {
    const bills = this.billRows().filter((b) => b.dueDate < this.payday && b.dueDate >= this.today);
    const billsCents = bills.reduce((s, b) => s + b.amountCents, 0);
    const cash = 101202;
    const setAside = 30000; // Christmas + car + school sinking funds held in checking; the emergency fund sits in savings
    const safe = cash - setAside - billsCents;
    const days = Math.max(1, daysFromToday(this.today, this.payday));
    return {
      safeCents: safe,
      cashCents: cash,
      setAsideCents: setAside,
      billsBeforePaydayCents: billsCents,
      billsBeforePayday: bills.map((b) => ({ name: b.name, dueDateIso: b.dueDate, amountCents: b.amountCents })),
      givingDueCents: 0,
      liquidityFloorCents: 0,
      nextPaydayIso: this.payday,
      daysUntilPayday: days,
      perDayCents: Math.floor(safe / days),
      balanceAsOf: `${addDays(this.today, -1)}T23:59:00-06:00`,
      status: safe < 0 ? "short" : safe < 20000 ? "watch" : "on_track",
      forecast: "At this pace you'll finish the month about $120 under budget.",
      dataThrough: this.dataThrough(),
    };
  }

  async questions(): Promise<QuestionsResponse> {
    await this.wait();
    const list = [...this.questionsById.values(), ...this.approvalQuestions()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { questions: list, dataThrough: this.dataThrough() };
  }

  async answerQuestion(id: string, input: AnswerInput): Promise<AnswerResponse> {
    await this.wait();
    if (id.startsWith("apr:")) {
      const approvalId = id.slice(4);
      const approval = await this.decideApproval(approvalId, input.optionId === "approve" ? "approved" : "declined", input.note);
      return { approval };
    }
    const q = this.questionsById.get(id);
    if (!q) throw new ApiError(404, "not_found", "That question was already answered.");
    const opt = q.options.find((o) => o.id === input.optionId);
    if (!opt) throw new ApiError(400, "bad_option", "That isn't one of the choices.");
    if (!q.transactionId) {
      this.questionsById.delete(id);
      return {};
    }
    const t = this.find(q.transactionId);
    const cat = input.categoryId ?? opt.categoryId ?? (input.optionId.startsWith("category:") ? input.optionId.slice(9) : undefined);
    if (cat) t.categoryId = cat;
    if (input.splits && input.splits.length > 0) t.splits = input.splits.map((s, i) => ({ lineNo: i + 1, amountCents: s.amountCents, categoryId: s.categoryId, glAccount: "", dims: {} }));
    if (input.optionId === "edit" && !cat) {
      // "Change": the app opens the category picker; the question stays until a category is picked.
      return { transaction: this.decorate(t) };
    }
    t.state = "approved";
    t.status = "recorded";
    t.updatedAt = new Date().toISOString();
    this.questionsById.delete(id);
    return { transaction: this.decorate(t) };
  }

  async transactions(query: TransactionsQuery = {}): Promise<TransactionsPage> {
    await this.wait();
    const q = (query.q ?? "").toLowerCase();
    let list = this.txs.filter((t) => !q || t.merchantNorm.toLowerCase().includes(q) || categoryName(t.categoryId).toLowerCase().includes(q));
    if (query.status) list = list.filter((t) => t.status === query.status);
    if (query.kind) list = list.filter((t) => t.kind === query.kind);
    if (query.categoryId) list = list.filter((t) => t.categoryId === query.categoryId);
    if (query.accountId) list = list.filter((t) => t.accountId === query.accountId);
    list = [...list].sort((a, b) => b.postedDate.localeCompare(a.postedDate) || b.createdAt.localeCompare(a.createdAt));
    const limit = query.limit ?? 50;
    const start = query.cursor ? Number(query.cursor) || 0 : 0;
    const page = list.slice(start, start + limit);
    const next = start + limit < list.length ? String(start + limit) : undefined;
    return { transactions: page.map((t) => this.decorate(t)), ...(next ? { next } : {}), dataThrough: this.dataThrough() };
  }

  async transaction(id: string): Promise<Transaction> {
    await this.wait(100);
    return this.decorate(this.find(id));
  }

  private decorate(t: Transaction): Transaction {
    // A correction on a posted item opens a request for Cade: the status stays "in the books"; the detail shows "Fix pending".
    const copy: Transaction = { ...t, splits: t.splits.map((s) => ({ ...s })) };
    if (this.fixPending.has(t.id)) copy.exceptionReason = "fix_pending";
    return copy;
  }

  async correctTransaction(id: string, input: CorrectionInput): Promise<CorrectionResponse> {
    await this.wait();
    const t = this.find(id);
    const posted = t.state === "posted" || t.state === "reconciled";
    if (posted) {
      this.fixPending.add(id);
      const approval: Approval = {
        id: `ap-fix-${id}`,
        kind: "correction",
        payload: { transactionId: id, categoryId: input.categoryId, merchant: t.merchantNorm, ...(input.reason ? { note: input.reason } : {}) },
        requestedBy: this.me_().id,
        requestedByName: this.me_().displayName,
        stepUpVerified: false,
        requestedAt: new Date().toISOString(),
      };
      this.approvalsList.push(approval);
      return { transaction: this.decorate(t), correctionRequestId: approval.id };
    }
    t.categoryId = input.categoryId;
    if (input.splits && input.splits.length > 0) t.splits = input.splits.map((s, i) => ({ lineNo: i + 1, amountCents: s.amountCents, categoryId: s.categoryId, glAccount: "", dims: {} }));
    else if (t.splits.length > 0) t.splits = [{ lineNo: 1, amountCents: t.amountCents, categoryId: input.categoryId, glAccount: "", dims: {} }];
    if (t.status === "needs_answer") {
      t.state = "approved";
      t.status = "recorded";
      for (const [qid, q] of this.questionsById) if (q.transactionId === id) this.questionsById.delete(qid);
    }
    t.updatedAt = new Date().toISOString();
    return { transaction: this.decorate(t) };
  }

  async proposeRule(input: RuleProposalInput): Promise<{ id: string }> {
    await this.wait();
    const id = `rule-${Date.now()}`;
    this.approvalsList.push({
      id: `ap-${id}`,
      kind: "rule",
      payload: { categoryId: input.categoryId, merchant: input.merchantNorm, name: input.name },
      requestedBy: this.me_().id,
      requestedByName: this.me_().displayName,
      stepUpVerified: false,
      requestedAt: new Date().toISOString(),
    });
    return { id };
  }

  async setBusinessFlag(id: string, flag: BusinessFlag): Promise<Transaction> {
    await this.wait();
    const t = this.find(id);
    t.businessFlag = flag;
    t.updatedAt = new Date().toISOString();
    return this.decorate(t);
  }

  async uploadReceipt(input: UploadReceiptInput): Promise<UploadReceiptResult> {
    await this.wait(600);
    const existing = this.receiptByHash.get(input.sha256);
    if (existing) {
      const r = this.receipts.get(existing);
      if (r) return { receipt: summaryOf(r), alreadyHeld: true };
    }
    this.receiptSeq += 1;
    const id = `rcpt-${this.receiptSeq}`;
    const detail: ReceiptDetail = {
      id,
      kind: "receipt",
      capturedAt: input.capturedAt,
      uploadedAt: new Date().toISOString(),
      sha256: input.sha256,
      offlineId: input.offlineId,
      ocrStatus: "queued",
      syncState: "synced",
      lines: [],
    };
    this.receipts.set(id, detail);
    this.receiptByHash.set(input.sha256, id);
    // "Reading…" for a moment, then the Broulim's sample read, like the prototype.
    setTimeout(() => this.finishRead(id, input), this.fast ? 5 : 1800);
    return { receipt: summaryOf(detail), alreadyHeld: false };
  }

  private finishRead(id: string, input: UploadReceiptInput): void {
    const r = this.receipts.get(id);
    if (!r) return;
    const lines = [
      ["MILK 2%", 349, "groceries"],
      ["EGGS 18CT", 529, "groceries"],
      ["BANANAS", 184, "groceries"],
      ["PAPER TOWELS", 1298, "household-supplies"],
      ["DISH SOAP", 427, "household-supplies"],
      ["CHIPS", 399, "groceries"],
    ] as const;
    const txId = `rx-${id}`;
    const splits: TransactionSplit[] = [
      { lineNo: 1, amountCents: -1461, categoryId: "groceries", glAccount: "", dims: {} },
      { lineNo: 2, amountCents: -1725, categoryId: "household-supplies", glAccount: "", dims: {} },
    ];
    const tx: Transaction = {
      id: txId,
      accountId: "a-beehive",
      source: "receipt",
      sourceRef: input.offlineId,
      idempotencyKey: `rcpt:${input.sha256}`,
      postedDate: this.today,
      amountCents: -3186,
      merchantRaw: "BROULIMS",
      merchantNorm: "Broulim's",
      pending: false,
      state: "approved",
      status: "recorded",
      kind: "spend",
      categoryId: "groceries",
      dims: { FAMILY_AREA: this.me_().id === "dev-cade" ? "CADE" : "VANESSA" },
      businessFlag: "none",
      splits,
      receiptId: id,
      receiptStatus: "matched",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.txs.unshift(tx);
    r.ocrStatus = "read";
    r.merchant = "Broulim's";
    r.totalCents = 3186;
    r.taxCents = 0;
    r.receiptDate = this.today;
    r.matchedTransactionId = txId;
    r.matchConfidence = 0.95;
    r.lines = lines.map(([description, amountCents, suggestedCategoryId], i) => ({ lineNo: i + 1, description, amountCents, suggestedCategoryId, suggestedConfidence: 0.97 }));
    r.split = { lines: splits, needsConfirmation: false };
    r.transaction = tx;
  }

  async receipt(id: string): Promise<ReceiptDetail> {
    await this.wait(100);
    const r = this.receipts.get(id);
    if (r) return { ...r };
    // Seeded receipts (the Walmart split) have no stored image in the mock; return a read receipt from the transaction.
    const seeded = this.txs.find((t) => t.receiptId === id);
    if (!seeded) throw new ApiError(404, "not_found");
    return {
      id,
      kind: "receipt",
      capturedAt: `${seeded.postedDate}T17:12:00-06:00`,
      uploadedAt: `${seeded.postedDate}T17:12:30-06:00`,
      sha256: "0".repeat(64),
      ocrStatus: "read",
      syncState: "synced",
      merchant: seeded.merchantNorm,
      totalCents: Math.abs(seeded.amountCents),
      receiptDate: seeded.postedDate,
      matchedTransactionId: seeded.id,
      matchConfidence: 0.98,
      lines: seeded.splits.map((s) => ({ lineNo: s.lineNo, description: categoryName(s.categoryId), amountCents: Math.abs(s.amountCents), suggestedCategoryId: s.categoryId })),
      split: { lines: seeded.splits, needsConfirmation: seeded.status === "needs_answer" },
      transaction: this.decorate(seeded),
    };
  }

  async paychecks(): Promise<readonly PaycheckSummary[]> {
    await this.wait();
    return this.txs.filter((t) => t.kind === "paycheck").map((t) => this.paycheckOf(t));
  }

  async paycheck(id: string): Promise<PaycheckSummary> {
    await this.wait();
    const t = this.txs.find((x) => x.kind === "paycheck" && (x.id === id || `pay-${x.id}` === id));
    if (!t) throw new ApiError(404, "not_found");
    return this.paycheckOf(t);
  }

  private paycheckOf(t: Transaction): PaycheckSummary {
    return {
      id: `pay-${t.id}`,
      employer: "HFH",
      payDate: t.postedDate,
      netCents: PAY.net,
      source: "stub_pdf",
      estimated: false,
      transactionId: t.id,
      components: [
        { kind: "regular", label: "Regular pay", amountCents: PAY.regular, glAccount: "401101" },
        { kind: "bonus", label: "Bonus", amountCents: PAY.bonus, glAccount: "401102" },
        { kind: "fit", label: "Federal withholding", amountCents: PAY.fit, glAccount: "701101" },
        { kind: "state_tax", label: "Idaho withholding", amountCents: PAY.idaho, glAccount: "701201" },
        { kind: "social_security", label: "Social Security", amountCents: PAY.ss, glAccount: "701301" },
        { kind: "medicare", label: "Medicare", amountCents: PAY.medicare, glAccount: "701401" },
      ],
    };
  }

  async budget(month?: string): Promise<BudgetStatus> {
    await this.wait();
    const { fraction } = monthProgress(this.today);
    const lines: BudgetLine[] = this.budgetRows.map((c) => {
      const left = c.budgetCents - c.spentCents;
      let pace: BudgetLine["pace"] = "on_track";
      if (c.kind !== "committed" && c.kind !== "allowance") {
        if (c.spentCents > c.budgetCents) pace = "over";
        else if (c.spentCents / c.budgetCents > fraction + 0.12) pace = "watch";
      }
      const forecast = c.kind === "committed" ? c.budgetCents : Math.min(Math.round(c.spentCents / Math.max(fraction, 0.05)), c.budgetCents + 12000);
      return {
        categoryId: c.id,
        name: c.name,
        budgetCents: c.budgetCents,
        spentCents: c.spentCents,
        leftCents: left,
        pace,
        forecastCents: forecast,
        isAllowance: c.kind === "allowance",
        isCommitted: c.kind === "committed",
      };
    });
    const totals = lines.reduce((a, l) => ({ budgetCents: a.budgetCents + l.budgetCents, spentCents: a.spentCents + l.spentCents, leftCents: a.leftCents + l.leftCents }), { budgetCents: 0, spentCents: 0, leftCents: 0 });
    return { month: month ?? this.today.slice(0, 7), budgetName: "BUD26-ORIG (sample)", isSample: true, revisionNo: this.revision, lines, totals, dataThrough: this.dataThrough() };
  }

  async proposeBudgetMove(input: BudgetMoveInput): Promise<Approval> {
    await this.wait();
    if (input.amountCents < 1) throw new ApiError(400, "bad_amount", "The amount has to be more than zero.");
    const from = this.budgetRows.find((c) => c.id === input.fromCategoryId);
    const to = this.budgetRows.find((c) => c.id === input.toCategoryId);
    if (!from || !to) throw new ApiError(400, "bad_category", "Pick a category on both sides.");
    const a: Approval = {
      id: `ap-${Date.now()}`,
      kind: "budget_move",
      payload: { fromCategoryId: input.fromCategoryId, toCategoryId: input.toCategoryId, amountCents: input.amountCents, ...(input.month ? { month: input.month } : {}), ...(input.note ? { note: input.note } : {}) },
      requestedBy: this.me_().id,
      requestedByName: this.me_().displayName,
      stepUpVerified: false,
      requestedAt: new Date().toISOString(),
      effect: `${to.name} would have ${money0(to.budgetCents - to.spentCents + input.amountCents)} left · ${from.name} would have ${money0(from.budgetCents - from.spentCents - input.amountCents)} left.`,
    };
    this.approvalsList.push(a);
    return a;
  }

  async approvals(state: "open" | "decided" | "all" = "open"): Promise<readonly Approval[]> {
    await this.wait();
    const list = [...this.approvalsList].reverse().map((a) => ({ ...a }));
    if (state === "open") return list.filter((a) => !a.decision);
    if (state === "decided") return list.filter((a) => a.decision);
    return list;
  }

  async decideApproval(id: string, decision: ApprovalDecision, note?: string): Promise<Approval> {
    await this.wait();
    const a = this.approvalsList.find((x) => x.id === id);
    if (!a) throw new ApiError(404, "not_found");
    if (a.requestedBy === this.me_().id) throw new ApiError(403, "other_spouse_decides", "The other spouse decides this one.");
    if (a.decision) throw new ApiError(409, "already_decided", "This was already decided.");
    if (STEP_UP_KINDS.has(a.kind) && !this.stepUpFresh()) throw new StepUpRequiredError();
    a.decision = decision;
    a.decidedBy = this.me_().id;
    a.decidedAt = new Date().toISOString();
    a.stepUpVerified = true;
    if (note) a.payload = { ...a.payload, decisionNote: note };
    if (decision === "approved" && a.kind === "budget_move") {
      const from = this.budgetRows.find((c) => c.id === a.payload.fromCategoryId);
      const to = this.budgetRows.find((c) => c.id === a.payload.toCategoryId);
      const amt = a.payload.amountCents ?? 0;
      if (from && to) {
        from.budgetCents -= amt;
        to.budgetCents += amt;
      }
      this.revision += 1;
      a.payload = { ...a.payload, revisionNo: this.revision };
    }
    return { ...a };
  }

  async goals(): Promise<GoalsResponse> {
    await this.wait();
    const dt = this.dataThrough();
    return {
      goals: [
        { id: "g-emerg", name: "Emergency fund · 1 month", fundGoal: "EMERG-1M", currentCents: 124000, targetCents: 1560000, nextMilestone: "$2,000 by Dec 1 · about $190 a paycheck gets there", isSample: true, dataThrough: dt },
        { id: "g-debt", name: "Capital One card", fundGoal: "DEBT-TARGET", currentCents: 1050800, targetCents: 1092800, nextMilestone: "Minimums only until the emergency fund has one month in it — that's the plan, not a setback.", dataThrough: dt },
        { id: "g-xmas", name: "Christmas", fundGoal: "SINK-GIFTS", currentCents: 18000, targetCents: 60000, isSample: true, dataThrough: dt },
        { id: "g-car", name: "Car repairs & registration", fundGoal: "SINK-VEHICLE", currentCents: 9000, targetCents: 120000, isSample: true, dataThrough: dt },
        { id: "g-school", name: "Kids' school fees", fundGoal: "SINK-SCHOOL", currentCents: 3000, targetCents: 40000, isSample: true, dataThrough: dt },
      ],
      dataThrough: dt,
    };
  }

  private billRows(): Bill[] {
    return SEED_BILLS.map((b) => {
      const dueDate = addDays(this.payday, b.off);
      return { id: b.id, name: b.name, dueDate, amountCents: cents(b.amt), categoryId: b.cat, isMinimum: b.isMinimum ?? false, ...(b.bcNative ? { isBcNative: true } : {}), beforePayday: dueDate < this.payday, paid: false };
    });
  }

  async bills(): Promise<BillsResponse> {
    await this.wait();
    return { bills: this.billRows(), nextPayday: this.payday, dataThrough: this.dataThrough() };
  }

  async ask(question: string): Promise<AskAnswer> {
    await this.wait(700);
    const answer = this.answer(question);
    this.history.unshift({ id: `c-${Date.now()}`, question, answer: answer.answer, dataThrough: answer.dataThrough.at, createdAt: new Date().toISOString() });
    return answer;
  }

  private answer(question: string): AskAnswer {
    const l = question.toLowerCase();
    const dt = this.dataThrough();
    const eat = this.budgetRows.find((c) => c.id === "eating-out-treats");
    const gro = this.budgetRows.find((c) => c.id === "groceries-household");
    const s = this.safeNow();
    const used = (fn: string, rows: unknown): AskAnswer["used"] => [{ fn, rows }];
    if (/move|transfer/.test(l)) {
      const m = l.match(/\$?(\d{1,5})/);
      const amt = m ? Number(m[1]) * 100 : 5000;
      const to = this.budgetRows.find((c) => c.kind !== "committed" && c.kind !== "allowance" && l.includes((c.name.toLowerCase().split(" ")[0] ?? "").replace(/[^a-z]/g, ""))) ?? gro;
      const from = this.budgetRows.find((c) => c.id === "fun-shopping" && c.id !== to?.id) ?? this.budgetRows.find((c) => c.id === "kids-school");
      if (to && from) {
        return {
          answer: `I can't move money myself, but I can draft the request: ${money0(amt)} from ${from.name} to ${to.name}. It goes to ${this.other().displayName} for one tap of approval.`,
          dataThrough: dt,
          used: used("get_budget_status", [from, to]),
          draftAction: { kind: "budget_move", fromCategoryId: from.id, toCategoryId: to.id, amountCents: amt },
        };
      }
    }
    if (eat && /eat|dining|restaurant|treat|doordash/.test(l)) {
      return { answer: `${money0(eat.spentCents)} so far this month on eating out and treats, with ${money0(eat.budgetCents - eat.spentCents)} left in that budget. The biggest pieces: DoorDash $31.55 and Crumbl $23.00.`, dataThrough: dt, used: used("get_budget_status", [eat]) };
    }
    if (gro && /grocer|walmart|food|broulim/.test(l)) {
      return { answer: `${money0(gro.spentCents)} on groceries and household so far, ${money0(gro.budgetCents - gro.spentCents)} left. One Walmart trip still needs your answer on the Home screen.`, dataThrough: dt, used: used("get_budget_status", [gro]) };
    }
    if (/safe|spend|afford|can we|cleats/.test(l)) {
      const m = l.match(/\$?(\d{2,5})/);
      const a = m ? Number(m[1]) * 100 : 0;
      if (a) {
        const answer =
          s.safeCents - a >= 0
            ? `Yes. ${money0(a)} leaves ${money0(s.safeCents - a)} safe to spend until ${fmtDate(s.nextPaydayIso)}, with every bill before payday covered.`
            : `Not before payday without a move: safe to spend is ${money(s.safeCents)} until ${fmtDate(s.nextPaydayIso)}. After Cade's paycheck lands it fits.`;
        return { answer, dataThrough: dt, used: used("get_safe_to_spend", s) };
      }
      return { answer: `${s.safeCents >= 0 ? `${money(s.safeCents)} is safe to spend` : `We're short ${money(-s.safeCents)}`} until ${fmtDate(s.nextPaydayIso)}. That's cash in checking, minus money set aside, minus the ${money0(s.billsBeforePaydayCents)} of bills due first.`, dataThrough: dt, used: used("get_safe_to_spend", s) };
    }
    if (/due|bill|payday/.test(l)) {
      const before = this.billRows().filter((b) => b.beforePayday);
      return { answer: `Before payday on ${fmtDate(this.payday)}: ${before.map((b) => `${b.name} ${money(b.amountCents)} (${fmtShort(b.dueDate)})`).join(", ")}. Then Cade's paycheck lands.`, dataThrough: dt, used: used("get_bills", before) };
    }
    if (/emergency|fund|goal|save/.test(l)) {
      return { answer: "The emergency fund has $1,240 toward a one-month target of $15,600 (sample). The next milestone is $2,000 by Dec 1, which is about $190 a paycheck.", dataThrough: dt, used: used("get_goals", []) };
    }
    if (/debt|capital one|card/.test(l)) {
      return { answer: "The Capital One balance is about $10,508, down $420 since September. The plan is minimums only until the emergency fund has one month in it.", dataThrough: dt, used: used("get_goals", []) };
    }
    return { answer: "I can answer questions about spending, bills, the budget and goals. Try “What's due before payday?” or “How much have we spent on groceries?”", dataThrough: dt, used: [] };
  }

  async askHistory(): Promise<readonly AskHistoryItem[]> {
    await this.wait(60);
    return [...this.history];
  }

  async alerts(): Promise<readonly Alert[]> {
    await this.wait();
    return [...this.alertsList];
  }

  async registerPushToken(input: PushTokenRegistration): Promise<void> {
    await this.wait(50);
    this.pushTokens.add(input.token);
  }

  async requestExport(): Promise<{ requested: boolean; available: boolean }> {
    await this.wait(400);
    return { requested: true, available: true };
  }
}

function summaryOf(r: ReceiptDetail): ReceiptSummary {
  const { lines: _lines, split: _split, transaction: _tx, ...summary } = r;
  return summary;
}

function daysFromToday(today: string, iso: string): number {
  const a = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  const b = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** The next Friday at least `atLeastDays` out (the prototype's payday rule). */
export function nextFriday(today: string, atLeastDays: number): string {
  for (let i = atLeastDays; i < atLeastDays + 8; i += 1) {
    const d = addDays(today, i);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === 5) return d;
  }
  return addDays(today, atLeastDays);
}
