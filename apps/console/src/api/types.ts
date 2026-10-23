/**
 * The Console's view of the API. Shapes come from @homestead/shared (types.ts, "Console DTOs"); route paths are
 * listed in api/http.ts and reconciled against services/api/openapi.yaml (see README "API routes").
 */
import type {
  AccountSummary,
  AuditEntry,
  AuthorityMatrix,
  BcBatch,
  ConnectionHealth,
  ConsoleMe,
  ConsolePage,
  ConsoleReceiptRow,
  ConsoleTransactionQueue,
  ConsoleTransactionRow,
  ExceptionResolution,
  HealthReport,
  MappingProposal,
  MappingSet,
  OutboxItem,
  PostBatchResult,
  ReconciliationStatus,
  RuleSummary,
  SyncRunSummary,
  SyncStatus,
  BusinessFlag,
} from "@homestead/shared";

/** A Plaid Link token (Link opens in Plaid's own frame; the token is single-use and short-lived). */
export interface LinkToken {
  linkToken: string;
  expiration: string;
}

/** One bank account on a login, as Plaid names it (mask: last 2-4 characters). */
export interface BankLoginAccount {
  plaidAccountId: string;
  name: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  /** Plaid's cached current balance in dollars, where known (not in Link's own results). */
  balance?: number | null;
}

export interface AccountLink {
  /** Household account id. */
  accountId: string;
  plaidAccountId: string;
}

export interface LinkBankInput {
  publicToken: string;
  institutionId?: string;
  institutionName?: string;
  accounts: AccountLink[];
}

export interface FeedAccounts {
  feedConnectionId: string;
  institutionName: string | null;
  ownerMemberId: string;
  /** balance: Plaid's cached current balance in dollars (amount owed for cards and loans), when it has one. */
  accounts: (BankLoginAccount & { accountId: string | null; balance?: number | null })[];
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface ConsoleApi {
  me(): Promise<ConsoleMe>;

  // Function 1: work queues
  transactions(queue: ConsoleTransactionQueue, q?: PageQuery): Promise<ConsolePage<ConsoleTransactionRow>>;
  approveTransactions(ids: readonly string[]): Promise<{ approved: number; skipped: readonly { id: string; reason: string }[] }>;
  /** Before BC the line changes in place; after BC the API opens a correction request for Cade and says so. */
  correctTransaction(id: string, input: { categoryId: string; note?: string; makeRule?: boolean }): Promise<ConsoleTransactionRow & { correctionRequestId?: string }>;
  setBusinessFlag(id: string, flag: BusinessFlag): Promise<ConsoleTransactionRow>;
  resolveDuplicate(id: string, decision: "not_a_repeat" | "same_thing"): Promise<ConsoleTransactionRow>;
  resolveException(id: string, resolution: ExceptionResolution): Promise<ConsoleTransactionRow>;
  receipts(status: "unmatched" | "needs_review", q?: PageQuery): Promise<ConsolePage<ConsoleReceiptRow>>;
  matchReceipt(receiptId: string, transactionId: string): Promise<ConsoleReceiptRow>;
  rules(state: "proposed" | "approved" | "retired", q?: PageQuery): Promise<ConsolePage<RuleSummary>>;
  decideRule(id: string, decision: "approve" | "decline" | "retire", note?: string): Promise<RuleSummary>;

  // Function 2: BC sync and posting
  syncStatus(): Promise<SyncStatus>;
  postBatch(batch: BcBatch): Promise<PostBatchResult>;

  // Function 3: reconciliation
  reconciliation(): Promise<ReconciliationStatus>;

  // Function 4: mappings
  mappings(): Promise<MappingSet>;
  proposeMapping(input: MappingProposal): Promise<{ approvalId: string }>;

  // Function 11: authority matrix
  authority(): Promise<AuthorityMatrix>;

  // Function 12: connection health, logs and audit
  connections(): Promise<ConnectionHealth>;
  syncRuns(q?: PageQuery & { kind?: SyncRunSummary["kind"]; status?: SyncRunSummary["status"] }): Promise<ConsolePage<SyncRunSummary>>;
  outbox(q?: PageQuery & { deadLettered?: boolean }): Promise<ConsolePage<OutboxItem>>;
  retryOutbox(id: string): Promise<OutboxItem>;
  audit(q?: PageQuery & { entity?: string; entityId?: string; actor?: string }): Promise<ConsolePage<AuditEntry>>;
  healthReport(): Promise<HealthReport | null>;

  // Bank logins (Plaid Link). Each spouse connects and looks after their own; the other can see, not change.
  householdAccounts(): Promise<AccountSummary[]>;
  /** Fresh sign-in check before Link opens, so the save at the end never has to leave the page. */
  confirmStepUp(): Promise<void>;
  bankLinkToken(): Promise<LinkToken>;
  /** Step-up. Exchanges the public token on the server; the access token never reaches the browser. */
  linkBank(input: LinkBankInput): Promise<{ feedConnectionId: string; itemId: string }>;
  /** Update mode: a fresh bank sign-in for an existing login (its owner only). */
  feedLinkToken(feedId: string): Promise<LinkToken>;
  feedReconnected(feedId: string): Promise<{ syncQueued: boolean }>;
  feedAccounts(feedId: string): Promise<FeedAccounts>;
  /** Step-up; replaces the whole mapping. */
  setFeedAccounts(feedId: string, accounts: readonly AccountLink[]): Promise<{ attached: number; detached: number; syncQueued: boolean }>;
  /** Step-up; Plaid's access ends and the vaulted token is deleted. Imported lines stay. */
  unlinkFeed(feedId: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? `${status} ${code}`);
    this.name = "ApiError";
  }
}
