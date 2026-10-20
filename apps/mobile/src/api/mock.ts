/**
 * MockApi: serves the Phase 2 prototype's sample data (prototype/homestead.html) so the app runs with no
 * backend (`EXPO_PUBLIC_API_MODE=mock`). Examples, not real balances. State lives in memory for the session:
 * answers, corrections, business flags, budget moves and snapped receipts all behave like the prototype.
 */
import {
  addDays,
  nextBiweeklyPayday,
  type AccountSummary,
  type Alert,
  type Approval,
  type ApprovalDecision,
  type AskAnswer,
  type BillsView,
  type BudgetLine,
  type BudgetStatus,
  type BusinessFlag,
  type CorrectionResult,
  type DataThrough,
  type Goal,
  type MemberSummary,
  type MeResponse,
  type PaycheckSummary,
  type PlainStatus,
  type PushTokenRegistration,
  type Question,
  type ReceiptSummary,
  type SafeToSpendView,
  type Transaction,
  type TransactionState,
} from "@homestead/shared";
import { fmtDate, fmtShort, monthProgress, money, money0, todayIso } from "../model/format";
import { categoryName } from "../model/categories";
import { DuplicateReceiptError, type AnswerInput, type BudgetMoveInput, type CorrectionInput, type HomesteadApi, type ReceiptDetail, type TransactionsPage, type TransactionsQuery, type UploadReceiptInput } from "./types";

const MEMBERS: Record<string, MemberSummary> = {
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
  who: string;
  acct: string;
  kind?: Transaction["kind"];
  receipt?: boolean;
  est?: boolean;
  split?: [string, number][];
}

const SEED_TX: SeedTx[] = [
  { id: "t1", off: 0, name: "Maverik", amt: -58.4, cat: "fuel", st: "recorded", who: "dev-cade", acct: "a-capone" },
  { id: "t2", off: 0, name: "Broulim's", amt: -64.12, cat: "groceries", st: "recorded", who: "dev-vanessa", acct: "a-beehive" },
  { id: "t3", off: -1, name: "Walmart", amt: -142.37, cat: "groceries", st: "question", who: "dev-vanessa", acct: "a-beehive", receipt: true, split: [["groceries", 88.2], ["household-supplies", 31.17], ["general-merchandise", 23.0]] },
  { id: "t4", off: -1, name: "Venmo · Kayla M.", amt: 85, cat: "income-lash", st: "question", who: "dev-vanessa", acct: "a-venmo" },
  { id: "t5", off: -2, name: "Amazon", amt: -46.18, st: "question", who: "dev-vanessa", acct: "a-capone" },
  { id: "t6", off: -2, name: "DoorDash", amt: -31.55, cat: "food-delivery", st: "books", who: "dev-cade", acct: "a-capone" },
  { id: "t7", off: -3, name: "Madison School District", amt: -45, cat: "school", st: "books", who: "dev-vanessa", acct: "a-beehive" },
  { id: "t8", off: -4, name: "Capital One payment", amt: -400, cat: "card-payment", st: "matched", kind: "transfer", who: "dev-cade", acct: "a-afcu" },
  { id: "t9", off: -5, name: "Cade's paycheck · Henry's Fork Homes", amt: 3135.59, cat: "income-hfh-wages", st: "books", kind: "paycheck", who: "dev-cade", acct: "a-afcu" },
  { id: "t10", off: -5, name: "To savings", amt: -200, cat: "transfer-own", st: "matched", kind: "transfer", who: "dev-cade", acct: "a-beehive" },
  { id: "t11", off: -6, name: "Crumbl", amt: -23, cat: "treats", st: "books", who: "dev-vanessa", acct: "a-beehive" },
  { id: "t12", off: -7, name: "Frontier CU · F-350 payment", amt: -1496.09, cat: "car-loan", st: "books", kind: "bc_native", who: "dev-cade", acct: "a-afcu" },
  { id: "t13", off: -8, name: "Valley Wide Co-op", amt: -71.2, cat: "fuel", st: "matched", who: "dev-cade", acct: "a-capone" },
  { id: "t14", off: -9, name: "Tithing", amt: -388.08, cat: "tithing", st: "matched", who: "joint", acct: "a-beehive" },
  { id: "t15", off: -10, name: "Walmart", amt: -89.9, cat: "groceries", st: "books", est: true, who: "dev-vanessa", acct: "a-beehive" },
  { id: "t16", off: -12, name: "PennyMac · mortgage", amt: -5670.39, cat: "mortgage", st: "books", kind: "bc_native", who: "joint", acct: "a-afcu" },
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
  isMinimum?: boolean;
}

const SEED_BILLS: SeedBill[] = [
  { id: "b1", name: "Verizon · phones", amt: 153.2, off: -3 },
  { id: "b2", name: "Rocky Mountain Power", amt: 118.4, off: -1 },
  { id: "b3", name: "Capital One · minimum", amt: 363, off: 1, isMinimum: true },
  { id: "b4", name: "Frontier CU · Suburban", amt: 1047.11, off: 4 },
  { id: "b5", name: "America First Visa · minimum", amt: 222, off: 6, isMinimum: true },
  { id: "b6", name: "PennyMac · mortgage", amt: 5670.39, off: 8 },
  { id: "b7", name: "Internet", amt: 79.99, off: 10 },
  { id: "b8", name: "Clear Management · trash", amt: 150, off: 12 },
  { id: "b9", name: "Frontier CU · F-350", amt: 1496.09, off: 14 },
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

export class MockApi implements HomesteadApi {
  private readonly today: string;
  private readonly payday: string;
  private readonly txs: Transaction[];
  private readonly budget: { id: string; name: string; budgetCents: number; spentCents: number; kind?: "committed" | "allowance" }[];
  private questionsById = new Map<string, Question>();
  private readonly approvalsList: Approval[] = [];
  private readonly receipts = new Map<string, ReceiptDetail>();
  private readonly receiptByHash = new Map<string, string>();
  private readonly fixPending = new Set<string>();
  private readonly alertsList: Alert[];
  private revision = 2;
  private receiptSeq = 0;

  constructor(private readonly memberId: () => string, now: Date = new Date()) {
    this.today = todayIso(now);
    // The next Friday at least 3 days out, like the prototype, so "before payday" always holds a few bills.
    let payday = nextBiweeklyPayday(this.today, "2026-10-09", false);
    const dow = new Date(payday).getUTCDay();
    if (dow !== 5) payday = nextFriday(this.today, 3);
    if (daysFromToday(this.today, payday) < 3) payday = addDays(payday, 14);
    this.payday = payday;
    this.txs = SEED_TX.map((s) => this.toTx(s));
    this.budget = SEED_BUDGET.map((b) => ({ id: b.id, name: b.name, budgetCents: cents(b.b), spentCents: cents(b.s), ...(b.kind ? { kind: b.kind } : {}) }));
    this.seedQuestions();
    this.approvalsList.push({
      id: "ap1",
      kind: "budget_move",
      payload: { fromCategoryId: "fun-shopping", toCategoryId: "gas-car", amountCents: 7500, note: "Two trips to Idaho Falls this week." },
      requestedBy: MEMBERS["dev-cade"] as MemberSummary,
      requestedAt: new Date(now.getTime() - 3 * 3600_000).toISOString(),
    });
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

  private me_(): MemberSummary {
    return MEMBERS[this.memberId()] ?? { id: this.memberId(), displayName: "Vanessa", role: "member" };
  }

  private other(): MemberSummary {
    const me = this.me_();
    return me.id === "dev-cade" ? (MEMBERS["dev-vanessa"] as MemberSummary) : (MEMBERS["dev-cade"] as MemberSummary);
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
    const splits = (s.split ?? []).map(([cat, amt], i) => ({ lineNo: i + 1, amountCents: cents(amt), categoryId: cat, glAccount: "", dims: {} }));
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
      dims: {},
      businessFlag: "none",
      splits,
      receiptStatus: s.receipt ? "matched" : s.est ? "estimated" : "none",
      ...(s.who !== "joint" ? { memberId: s.who } : {}),
      createdAt: `${date}T08:00:00-06:00`,
      updatedAt: `${date}T08:00:00-06:00`,
    } as Transaction;
  }

  private seedQuestions(): void {
    const t3 = this.find("t3");
    const t4 = this.find("t4");
    const t5 = this.find("t5");
    const base = (id: string, off: number) => ({ id, createdAt: `${addDays(this.today, off)}T09:00:00-06:00` });
    this.questionsById.set("q-t3", {
      ...base("q-t3", -1),
      kind: "confirm_split",
      transactionId: "t3",
      prompt: `Walmart ${money(t3.amountCents)} — split from your receipt. Look right?`,
      why: "Why we're asking: receipts tell us what was groceries and what wasn't. One tap keeps the budget honest.",
      options: [
        { id: "yes", label: "Yes" },
        { id: "change", label: "Change" },
      ],
      defaultOptionId: "yes",
      amountCents: t3.amountCents,
      merchant: "Walmart",
      date: t3.postedDate,
    });
    this.questionsById.set("q-t4", {
      ...base("q-t4", -1),
      kind: "confirm_category",
      transactionId: "t4",
      prompt: "Venmo +$85.00 from Kayla M. — lash appointment?",
      why: "Why we're asking: Venmo money in could be lash income or a friend paying you back. Lash income counts toward your business.",
      options: [
        { id: "lash", label: "Yes, lash", categoryId: "income-lash" },
        { id: "other", label: "Something else", categoryId: "payments-to-people" },
      ],
      defaultOptionId: "lash",
      amountCents: t4.amountCents,
      merchant: "Venmo · Kayla M.",
      date: t4.postedDate,
    });
    this.questionsById.set("q-t5", {
      ...base("q-t5", -2),
      kind: "pick_category",
      transactionId: "t5",
      prompt: `Amazon ${money(t5.amountCents)} — what was it?`,
      why: "Why we're asking: Amazon charges don't say what was in the box. Pick the closest category and we'll remember it for next time.",
      options: [
        { id: "groceries", label: "Groceries & household", categoryId: "groceries" },
        { id: "school", label: "Kids & school", categoryId: "school" },
        { id: "gifts", label: "Gifts", categoryId: "gifts" },
        { id: "fun", label: "Fun & shopping", categoryId: "general-merchandise" },
        { id: "change", label: "Something else" },
      ],
      amountCents: t5.amountCents,
      merchant: "Amazon",
      date: t5.postedDate,
    });
  }

  private find(id: string): Transaction {
    const t = this.txs.find((x) => x.id === id);
    if (!t) throw new Error(`mock: no transaction ${id}`);
    return t;
  }

  async me(): Promise<MeResponse> {
    await delay(80);
    return {
      member: this.me_(),
      household: { id: "hh-jones", name: "Jones family", timezone: "America/Boise", quietHours: { start: "21:00", end: "07:00" }, nextPaydayIso: this.payday },
      members: [MEMBERS["dev-vanessa"] as MemberSummary, MEMBERS["dev-cade"] as MemberSummary],
    };
  }

  async accounts(): Promise<readonly AccountSummary[]> {
    await delay();
    const asOf = `${addDays(this.today, -1)}T23:59:00-06:00`;
    return [
      { id: "a-beehive", displayName: "Beehive checking", institution: "Beehive FCU", kind: "checking", mask: "4821", balanceCents: 61202, balanceAsOf: asOf, feedStatus: "ok" },
      { id: "a-afcu", displayName: "America First checking", institution: "America First CU", kind: "checking", mask: "1190", balanceCents: 40000, balanceAsOf: asOf, feedStatus: "ok" },
      { id: "a-capone", displayName: "Capital One", institution: "Capital One", kind: "card", mask: "7730", balanceCents: -1050800, balanceAsOf: asOf, feedStatus: "ok" },
      { id: "a-venmo", displayName: "Venmo", institution: "Venmo", kind: "wallet", mask: "", balanceCents: 8500, balanceAsOf: asOf, feedStatus: "ok" },
      { id: "a-carecredit", displayName: "CareCredit", institution: "Synchrony", kind: "card", mask: "0042", feedStatus: "file_only" },
      { id: "a-frontier-f350", displayName: "F-350 loan", institution: "Frontier CU", kind: "loan", mask: "2201", feedStatus: "file_only" },
      { id: "a-pennymac", displayName: "Mortgage", institution: "PennyMac", kind: "mortgage", mask: "9087", feedStatus: "file_only" },
    ];
  }

  async safeToSpend(): Promise<SafeToSpendView> {
    await delay();
    const bills = this.billRows().filter((b) => b.dueDate < this.payday);
    const billsCents = bills.reduce((s, b) => s + b.amountCents, 0);
    const cash = 101202;
    const setAside = 30000;
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

  async questions(): Promise<readonly Question[]> {
    await delay();
    return [...this.questionsById.values()];
  }

  async answerQuestion(id: string, input: AnswerInput): Promise<void> {
    await delay();
    const q = this.questionsById.get(id);
    if (!q) return;
    const opt = q.options.find((o) => o.id === input.optionId);
    if (q.transactionId) {
      const t = this.find(q.transactionId);
      const cat = input.categoryId ?? opt?.categoryId;
      if (cat) t.categoryId = cat;
      t.state = "approved";
      t.status = "recorded";
      t.updatedAt = new Date().toISOString();
    }
    this.questionsById.delete(id);
  }

  async transactions(query: TransactionsQuery = {}): Promise<TransactionsPage> {
    await delay();
    const q = (query.q ?? "").toLowerCase();
    let list = this.txs.filter((t) => !q || t.merchantNorm.toLowerCase().includes(q) || categoryName(t.categoryId).toLowerCase().includes(q));
    if (query.needsAnswer) list = list.filter((t) => t.status === "needs_answer");
    if (query.withReceipt) list = list.filter((t) => t.receiptStatus === "matched");
    if (query.memberId) list = list.filter((t) => (t as Transaction & { memberId?: string }).memberId === query.memberId);
    list = [...list].sort((a, b) => b.postedDate.localeCompare(a.postedDate) || b.createdAt.localeCompare(a.createdAt));
    if (query.limit) list = list.slice(0, query.limit);
    return { items: list.map((t) => this.decorate(t)), dataThrough: this.dataThrough() };
  }

  async transaction(id: string): Promise<Transaction> {
    await delay(100);
    return this.decorate(this.find(id));
  }

  private decorate(t: Transaction): Transaction {
    // "Fix pending" after a correction on a posted item: the status stays in the books; the app shows the fix line.
    return this.fixPending.has(t.id) ? ({ ...t, fixPending: true } as Transaction) : { ...t };
  }

  async correctTransaction(id: string, input: CorrectionInput): Promise<CorrectionResult> {
    await delay();
    const t = this.find(id);
    const posted = t.state === "posted" || t.state === "reconciled";
    t.categoryId = input.categoryId;
    if (posted) {
      this.fixPending.add(id);
      const approval: Approval = {
        id: `ap-fix-${id}`,
        kind: "correction",
        payload: { transactionId: id, categoryId: input.categoryId, merchant: t.merchantNorm },
        requestedBy: this.me_(),
        requestedAt: new Date().toISOString(),
      };
      this.approvalsList.push(approval);
      return { outcome: "fix_pending", approvalId: approval.id, ...(input.proposeRule ? { ruleProposalId: `rule-${id}` } : {}) };
    }
    if (t.status === "needs_answer") {
      t.state = "approved";
      t.status = "recorded";
      for (const [qid, q] of this.questionsById) if (q.transactionId === id) this.questionsById.delete(qid);
    }
    return { outcome: "fixed", ...(input.proposeRule ? { ruleProposalId: `rule-${id}` } : {}) };
  }

  async setBusinessFlag(id: string, flag: BusinessFlag): Promise<Transaction> {
    await delay();
    const t = this.find(id);
    t.businessFlag = flag;
    return this.decorate(t);
  }

  async uploadReceipt(input: UploadReceiptInput): Promise<ReceiptSummary> {
    await delay(600);
    const existing = this.receiptByHash.get(input.sha256);
    if (existing) throw new DuplicateReceiptError(existing);
    this.receiptSeq += 1;
    const id = `rcpt-${this.receiptSeq}`;
    const summary: ReceiptSummary = { id, capturedAt: input.capturedAt, uploadedAt: new Date().toISOString(), sha256: input.sha256, ocrStatus: "queued", syncState: "synced" };
    const detail: ReceiptDetail = { ...summary, lines: [], split: [] };
    this.receipts.set(id, detail);
    this.receiptByHash.set(input.sha256, id);
    // "Reading…" for a moment, then the Broulim's sample read, like the prototype.
    setTimeout(() => this.finishRead(id, input), 1800);
    return summary;
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
    const tx: Transaction = {
      id: txId,
      accountId: "a-beehive",
      source: "receipt",
      sourceRef: input.clientId,
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
      dims: {},
      businessFlag: "none",
      splits: [
        { lineNo: 1, amountCents: -1461, categoryId: "groceries", glAccount: "", dims: {} },
        { lineNo: 2, amountCents: -1725, categoryId: "household-supplies", glAccount: "", dims: {} },
      ],
      receiptId: id,
      receiptStatus: "matched",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (tx as Transaction & { memberId?: string }).memberId = this.me_().id;
    this.txs.unshift(tx);
    Object.assign(r, {
      ocrStatus: "read",
      merchant: "Broulim's",
      totalCents: 3186,
      taxCents: 0,
      receiptDate: this.today,
      matchedTransactionId: txId,
      matchConfidence: 0.95,
      lines: lines.map(([description, amountCents, categoryId], i) => ({ lineNo: i + 1, description, amountCents, categoryId, categoryName: categoryName(categoryId) })),
      split: [
        { categoryId: "groceries", categoryName: categoryName("groceries"), amountCents: 1461 },
        { categoryId: "household-supplies", categoryName: categoryName("household-supplies"), amountCents: 1725 },
      ],
      suggestedCategoryId: "groceries",
      suggestedCategoryName: categoryName("groceries"),
    } satisfies Partial<ReceiptDetail>);
  }

  async receipt(id: string): Promise<ReceiptDetail> {
    await delay(100);
    const r = this.receipts.get(id);
    if (!r) throw new Error(`mock: no receipt ${id}`);
    return { ...r };
  }

  async paycheck(id: string): Promise<PaycheckSummary> {
    await delay();
    const t = this.find(id);
    return {
      id: `pay-${id}`,
      employer: "HFH",
      payDate: t.postedDate,
      netCents: PAY.net,
      source: "stub_pdf",
      estimated: false,
      transactionId: id,
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

  async budget(): Promise<BudgetStatus> {
    await delay();
    const { fraction } = monthProgress(this.today);
    const lines: BudgetLine[] = this.budget.map((c) => {
      const left = c.budgetCents - c.spentCents;
      let pace: BudgetLine["pace"] = "on_track";
      if (c.kind !== "committed" && c.kind !== "allowance") {
        if (c.spentCents > c.budgetCents) pace = "over";
        else if (c.spentCents / c.budgetCents > fraction + 0.12) pace = "watch";
      }
      const forecast = c.kind === "committed" ? c.budgetCents : Math.round(c.spentCents / Math.max(fraction, 0.05));
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
    return { month: this.today.slice(0, 7), budgetName: "BUD26-ORIG (sample)", isSample: true, lines, dataThrough: this.dataThrough() };
  }

  async proposeBudgetMove(input: BudgetMoveInput): Promise<Approval> {
    await delay();
    const a: Approval = {
      id: `ap-${Date.now()}`,
      kind: "budget_move",
      payload: { fromCategoryId: input.fromCategoryId, toCategoryId: input.toCategoryId, amountCents: input.amountCents, ...(input.note ? { note: input.note } : {}) },
      requestedBy: this.me_(),
      requestedAt: new Date().toISOString(),
    };
    this.approvalsList.push(a);
    return a;
  }

  async approvals(): Promise<readonly Approval[]> {
    await delay();
    return [...this.approvalsList].reverse();
  }

  async decideApproval(id: string, decision: ApprovalDecision): Promise<Approval> {
    await delay();
    const a = this.approvalsList.find((x) => x.id === id);
    if (!a) throw new Error(`mock: no approval ${id}`);
    a.decision = decision;
    a.decidedBy = this.me_();
    a.decidedAt = new Date().toISOString();
    a.stepUpVerified = true;
    if (decision === "approved" && a.kind === "budget_move") {
      const from = this.budget.find((c) => c.id === a.payload.fromCategoryId);
      const to = this.budget.find((c) => c.id === a.payload.toCategoryId);
      const amt = a.payload.amountCents ?? 0;
      if (from && to) {
        from.budgetCents -= amt;
        to.budgetCents += amt;
      }
      this.revision += 1;
      a.revisionNo = this.revision;
    }
    return { ...a };
  }

  async goals(): Promise<readonly Goal[]> {
    await delay();
    const dt = this.dataThrough();
    return [
      { id: "g-emerg", name: "Emergency fund · 1 month", fundGoal: "EMERG-1M", currentCents: 124000, targetCents: 1560000, nextMilestone: "$2,000 by Dec 1 · about $190 a paycheck gets there", dataThrough: dt },
      { id: "g-debt", name: "Capital One card", fundGoal: "DEBT-TARGET", currentCents: 1050800, targetCents: 1092800, nextMilestone: "Minimums only until the emergency fund has one month in it — that's the plan, not a setback.", dataThrough: dt },
      { id: "g-xmas", name: "Christmas", fundGoal: "SINK-GIFTS", currentCents: 18000, targetCents: 60000, dataThrough: dt },
      { id: "g-car", name: "Car repairs & registration", fundGoal: "SINK-VEHICLE", currentCents: 9000, targetCents: 120000, dataThrough: dt },
      { id: "g-school", name: "Kids' school fees", fundGoal: "SINK-SCHOOL", currentCents: 3000, targetCents: 40000, dataThrough: dt },
    ];
  }

  private billRows() {
    return SEED_BILLS.map((b) => {
      const dueDate = addDays(this.payday, b.off);
      return { id: b.id, name: b.name, dueDate, amountCents: cents(b.amt), isMinimum: b.isMinimum ?? false, beforePayday: dueDate < this.payday, paid: false };
    });
  }

  async bills(): Promise<BillsView> {
    await delay();
    return { bills: this.billRows(), nextPaydayIso: this.payday, nextPaycheckNetCents: PAY.net, dataThrough: this.dataThrough() };
  }

  async ask(question: string): Promise<AskAnswer> {
    await delay(700);
    const l = question.toLowerCase();
    const dt = this.dataThrough();
    const eat = this.budget.find((c) => c.id === "eating-out-treats");
    const gro = this.budget.find((c) => c.id === "groceries-household");
    const s = await this.safeToSpend();
    const used = (fn: string, rows: unknown): AskAnswer["used"] => [{ fn, rows }];
    if (/move|transfer/.test(l)) {
      const m = l.match(/\$?(\d{1,5})/);
      const amt = m ? Number(m[1]) * 100 : 5000;
      const to = this.budget.find((c) => l.includes(c.name.toLowerCase().split(" ")[0] ?? "")) ?? gro;
      const from = this.budget.find((c) => c.id === "fun-shopping");
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

  async alerts(): Promise<readonly Alert[]> {
    await delay();
    return [...this.alertsList];
  }

  async registerPushToken(_input: PushTokenRegistration): Promise<void> {
    await delay(50);
  }

  async requestExport(): Promise<{ requested: true }> {
    await delay(400);
    return { requested: true };
  }
}

function daysFromToday(today: string, iso: string): number {
  const a = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  const b = Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

function nextFriday(today: string, atLeastDays: number): string {
  for (let i = atLeastDays; i < atLeastDays + 8; i += 1) {
    const d = addDays(today, i);
    if (new Date(d).getUTCDay() === 5) return d;
  }
  return addDays(today, atLeastDays);
}
