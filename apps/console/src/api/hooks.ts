/**
 * react-query hooks over ConsoleApi. Query keys are grouped so a mutation can invalidate the slice it touched.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BcBatch, BusinessFlag, ConsoleTransactionQueue, ExceptionResolution, MappingProposal, SyncRunSummary } from "@homestead/shared";
import { useApi } from "./ApiProvider";
import type { AccountLink, LinkBankInput, PageQuery } from "./types";

export const keys = {
  me: ["me"] as const,
  transactions: (queue: ConsoleTransactionQueue, q?: PageQuery) => ["transactions", queue, q ?? {}] as const,
  receipts: (status: "unmatched" | "needs_review", q?: PageQuery) => ["receipts", status, q ?? {}] as const,
  rules: (state: "proposed" | "approved" | "retired", q?: PageQuery) => ["rules", state, q ?? {}] as const,
  sync: ["sync"] as const,
  reconciliation: ["reconciliation"] as const,
  mappings: ["mappings"] as const,
  authority: ["authority"] as const,
  connections: ["connections"] as const,
  syncRuns: (q?: object) => ["sync-runs", q ?? {}] as const,
  outbox: (q?: object) => ["outbox", q ?? {}] as const,
  audit: (q?: object) => ["audit", q ?? {}] as const,
  health: ["health"] as const,
  householdAccounts: ["household-accounts"] as const,
  feedAccounts: (feedId: string) => ["feed-accounts", feedId] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.me(), staleTime: 5 * 60_000 });
}

export function useTransactions(queue: ConsoleTransactionQueue, q?: PageQuery) {
  const api = useApi();
  return useQuery({ queryKey: keys.transactions(queue, q), queryFn: () => api.transactions(queue, q) });
}

function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: readonly (readonly unknown[])[]) => Promise.all(prefixes.map((p) => qc.invalidateQueries({ queryKey: p })));
}

export function useApproveTransactions() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (ids: readonly string[]) => api.approveTransactions(ids),
    onSuccess: () => invalidate(["transactions"], keys.sync, ["outbox"], ["audit"]),
  });
}

export function useCorrectTransaction() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; categoryId: string; note?: string; makeRule?: boolean }) => api.correctTransaction(v.id, v),
    onSuccess: () => invalidate(["transactions"], ["rules"], ["audit"]),
  });
}

export function useSetBusinessFlag() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; flag: BusinessFlag }) => api.setBusinessFlag(v.id, v.flag),
    onSuccess: () => invalidate(["transactions"], ["audit"]),
  });
}

export function useResolveDuplicate() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; decision: "not_a_repeat" | "same_thing" }) => api.resolveDuplicate(v.id, v.decision),
    onSuccess: () => invalidate(["transactions"], ["audit"]),
  });
}

export function useResolveException() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; resolution: ExceptionResolution }) => api.resolveException(v.id, v.resolution),
    onSuccess: () => invalidate(["transactions"], keys.sync, keys.reconciliation, ["audit"]),
  });
}

export function useReceipts(status: "unmatched" | "needs_review", q?: PageQuery) {
  const api = useApi();
  return useQuery({ queryKey: keys.receipts(status, q), queryFn: () => api.receipts(status, q) });
}

export function useMatchReceipt() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { receiptId: string; transactionId: string }) => api.matchReceipt(v.receiptId, v.transactionId),
    onSuccess: () => invalidate(["receipts"], ["transactions"], ["audit"]),
  });
}

export function useRules(state: "proposed" | "approved" | "retired", q?: PageQuery) {
  const api = useApi();
  return useQuery({ queryKey: keys.rules(state, q), queryFn: () => api.rules(state, q) });
}

export function useDecideRule() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "decline" | "retire"; note?: string }) => api.decideRule(v.id, v.decision, v.note),
    onSuccess: () => invalidate(["rules"], keys.authority, ["audit"]),
  });
}

export function useSyncStatus() {
  const api = useApi();
  return useQuery({ queryKey: keys.sync, queryFn: () => api.syncStatus(), refetchInterval: 60_000 });
}

export function usePostBatch() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (batch: BcBatch) => api.postBatch(batch),
    onSuccess: () => invalidate(keys.sync, ["outbox"], ["audit"]),
  });
}

export function useReconciliation() {
  const api = useApi();
  return useQuery({ queryKey: keys.reconciliation, queryFn: () => api.reconciliation() });
}

export function useMappings() {
  const api = useApi();
  return useQuery({ queryKey: keys.mappings, queryFn: () => api.mappings() });
}

export function useProposeMapping() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: MappingProposal) => api.proposeMapping(input),
    onSuccess: () => invalidate(keys.mappings, ["audit"]),
  });
}

export function useAuthority() {
  const api = useApi();
  return useQuery({ queryKey: keys.authority, queryFn: () => api.authority() });
}

export function useConnections() {
  const api = useApi();
  return useQuery({ queryKey: keys.connections, queryFn: () => api.connections(), refetchInterval: 60_000 });
}

export function useSyncRuns(q?: PageQuery & { kind?: SyncRunSummary["kind"]; status?: SyncRunSummary["status"] }) {
  const api = useApi();
  return useQuery({ queryKey: keys.syncRuns(q), queryFn: () => api.syncRuns(q) });
}

export function useOutbox(q?: PageQuery & { deadLettered?: boolean }) {
  const api = useApi();
  return useQuery({ queryKey: keys.outbox(q), queryFn: () => api.outbox(q) });
}

export function useRetryOutbox() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.retryOutbox(id),
    onSuccess: () => invalidate(["outbox"], keys.sync, ["audit"]),
  });
}

export function useAudit(q?: PageQuery & { entity?: string; entityId?: string; actor?: string }) {
  const api = useApi();
  return useQuery({ queryKey: keys.audit(q), queryFn: () => api.audit(q) });
}

export function useHealthReport() {
  const api = useApi();
  return useQuery({ queryKey: keys.health, queryFn: () => api.healthReport(), staleTime: 5 * 60_000 });
}

// ---- Bank logins ---------------------------------------------------------------------------------------------------

export function useHouseholdAccounts() {
  const api = useApi();
  return useQuery({ queryKey: keys.householdAccounts, queryFn: () => api.householdAccounts() });
}

export function useFeedAccounts(feedId: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.feedAccounts(feedId ?? ""), queryFn: () => api.feedAccounts(feedId ?? ""), enabled: Boolean(feedId), staleTime: 0 });
}

const BANK_KEYS = [keys.connections, keys.householdAccounts, ["feed-accounts"], keys.mappings, keys.reconciliation, ["audit"]] as const;

export function useLinkBank() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: LinkBankInput) => api.linkBank(input), onSuccess: () => invalidate(...BANK_KEYS) });
}

export function useSetFeedAccounts() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (v: { feedId: string; accounts: readonly AccountLink[] }) => api.setFeedAccounts(v.feedId, v.accounts), onSuccess: () => invalidate(...BANK_KEYS) });
}

export function useUnlinkFeed() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (feedId: string) => api.unlinkFeed(feedId), onSuccess: () => invalidate(...BANK_KEYS) });
}

export function useFeedReconnected() {
  const api = useApi();
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (feedId: string) => api.feedReconnected(feedId), onSuccess: () => invalidate(...BANK_KEYS) });
}
