/**
 * React Query hooks over the HomesteadApi. Query keys are grouped so a mutation can invalidate exactly what it
 * changed: an answer touches questions, transactions and safe-to-spend; a budget move touches budget, approvals
 * and questions; a receipt touches transactions and questions.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ApprovalDecision, BusinessFlag } from "@homestead/shared";
import { useAuth } from "../auth/AuthProvider";
import { useApi } from "./ApiProvider";
import type { AnswerInput, BudgetMoveInput, CorrectionInput, RuleProposalInput, TransactionsQuery } from "./types";

export const keys = {
  me: ["me"] as const,
  safe: ["safe-to-spend"] as const,
  questions: ["questions"] as const,
  transactions: (q: TransactionsQuery) => ["transactions", q] as const,
  transaction: (id: string) => ["transaction", id] as const,
  receipt: (id: string) => ["receipt", id] as const,
  paycheck: (id: string) => ["paycheck", id] as const,
  budget: ["budget"] as const,
  approvals: (state: "open" | "decided" | "all") => ["approvals", state] as const,
  goals: ["goals"] as const,
  bills: ["bills"] as const,
  alerts: ["alerts"] as const,
  askHistory: ["ask-history"] as const,
};

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: () => api.me(), staleTime: 5 * 60_000 });
}

/**
 * Who is who, from GET /v1/me (the household member ids the API uses), falling back to the sign-in until it loads.
 * `otherName` is the other spouse: approvals go to them, never to a fixed person.
 */
export function usePeople(): { myId: string | undefined; myName: string | undefined; otherName: string } {
  const auth = useAuth();
  const me = useMe();
  const myId = me.data?.member.id ?? auth.member?.id;
  const other = me.data?.members.find((m) => m.id !== myId && m.role === "member");
  return { myId, myName: me.data?.member.displayName ?? auth.member?.displayName, otherName: other?.displayName ?? "the other spouse" };
}

export function useAccounts() {
  const api = useApi();
  return useQuery({ queryKey: ["accounts"] as const, queryFn: () => api.accounts(), staleTime: 60_000 });
}

export function useSafeToSpend() {
  const api = useApi();
  return useQuery({ queryKey: keys.safe, queryFn: () => api.safeToSpend() });
}

export function useQuestions() {
  const api = useApi();
  return useQuery({ queryKey: keys.questions, queryFn: () => api.questions() });
}

export function useTransactions(query: TransactionsQuery = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.transactions(query), queryFn: () => api.transactions(query) });
}

export function useTransaction(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.transaction(id ?? ""), queryFn: () => api.transaction(id ?? ""), enabled: Boolean(id) });
}

export function useReceipt(id: string | undefined, opts: { pollWhileReading?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: keys.receipt(id ?? ""),
    queryFn: () => api.receipt(id ?? ""),
    enabled: Boolean(id),
    refetchInterval: (q) => (opts.pollWhileReading && q.state.data?.ocrStatus === "queued" ? 1200 : false),
  });
}

export function usePaycheck(id: string | undefined) {
  const api = useApi();
  return useQuery({ queryKey: keys.paycheck(id ?? ""), queryFn: () => api.paycheck(id ?? ""), enabled: Boolean(id) });
}

/**
 * The paycheck behind a net-pay deposit. `/v1/paychecks/{id}` takes the paycheck's own id and the Transaction DTO
 * does not carry it, so the list is searched by `transactionId` (null when the deposit has no paycheck record yet).
 */
export function usePaycheckForTransaction(transactionId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: ["paycheck-for", transactionId ?? ""] as const,
    queryFn: async () => (await api.paychecks()).find((p) => p.transactionId === transactionId) ?? null,
    enabled: Boolean(transactionId),
  });
}

export function useBudget() {
  const api = useApi();
  return useQuery({ queryKey: keys.budget, queryFn: () => api.budget() });
}

export function useApprovals(state: "open" | "decided" | "all" = "open") {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals(state), queryFn: () => api.approvals(state) });
}

export function useGoals() {
  const api = useApi();
  return useQuery({ queryKey: keys.goals, queryFn: () => api.goals() });
}

export function useBills() {
  const api = useApi();
  return useQuery({ queryKey: keys.bills, queryFn: () => api.bills() });
}

export function useAlerts() {
  const api = useApi();
  return useQuery({ queryKey: keys.alerts, queryFn: () => api.alerts(), staleTime: 60_000 });
}

export function useAskHistory() {
  const api = useApi();
  return useQuery({ queryKey: keys.askHistory, queryFn: () => api.askHistory(), staleTime: 60_000 });
}

function invalidate(qc: QueryClient, ...roots: string[]): Promise<void> {
  return Promise.all(roots.map((r) => qc.invalidateQueries({ queryKey: [r] }))).then(() => undefined);
}

export function useAnswerQuestion() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input, stepUp }: { id: string; input: AnswerInput; stepUp?: boolean }) => api.answerQuestion(id, input, stepUp ? { stepUp: true } : {}),
    onSuccess: () => invalidate(qc, "questions", "transactions", "transaction", "safe-to-spend", "budget", "approvals"),
  });
}

export function useCorrectTransaction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CorrectionInput }) => api.correctTransaction(id, input),
    onSuccess: () => invalidate(qc, "questions", "transactions", "transaction", "budget", "approvals"),
  });
}

export function useProposeRule() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: RuleProposalInput) => api.proposeRule(input), onSuccess: () => invalidate(qc, "approvals") });
}

export function useSetBusinessFlag() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, flag }: { id: string; flag: BusinessFlag }) => api.setBusinessFlag(id, flag),
    onSuccess: () => invalidate(qc, "transactions", "transaction", "budget"),
  });
}

export function useProposeBudgetMove() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: BudgetMoveInput) => api.proposeBudgetMove(input), onSuccess: () => invalidate(qc, "approvals", "questions", "budget") });
}

export function useDecideApproval() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: ApprovalDecision; note?: string }) => api.decideApproval(id, decision, note),
    onSuccess: () => invalidate(qc, "approvals", "questions", "budget", "safe-to-spend"),
  });
}

export function useAsk() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (question: string) => api.ask(question), onSuccess: () => invalidate(qc, "ask-history") });
}

export function useRequestExport() {
  const api = useApi();
  return useMutation({ mutationFn: () => api.requestExport() });
}

/** After a receipt uploads: the activity list and questions may have a new item. */
export function useInvalidateAfterReceipt() {
  const qc = useQueryClient();
  return () => invalidate(qc, "transactions", "questions", "receipt", "safe-to-spend");
}
