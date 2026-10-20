/**
 * The Console's view of the API. Shapes come from @homestead/shared (types.ts, "Console DTOs"); route paths are
 * listed in api/http.ts and reconciled against services/api/openapi.yaml (see README "API routes").
 */
import type {
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

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export interface ConsoleApi {
  me(): Promise<ConsoleMe>;

  // Function 1: work queues
  transactions(queue: ConsoleTransactionQueue, q?: PageQuery): Promise<ConsolePage<ConsoleTransactionRow>>;
  approveTransactions(ids: readonly string[]): Promise<{ approved: number; skipped: readonly { id: string; reason: string }[] }>;
  correctTransaction(id: string, input: { categoryId: string; note?: string; makeRule?: boolean }): Promise<ConsoleTransactionRow>;
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
