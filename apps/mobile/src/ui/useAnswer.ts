/**
 * Answering a question from Home or Budget: step-up first when the answer is an approval, then the API call,
 * then one calm toast. Shared so the two screens say the same things.
 */
import { useCallback } from "react";
import { useRouter } from "expo-router";
import type { Question } from "@homestead/shared";
import { useAnswerQuestion } from "../api/hooks";
import { ApiError, StepUpRequiredError } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { categoryName } from "../model/categories";
import { useToast } from "./Toast";

export function toastForAnswer(q: Question, optionId: string, categoryId: string | undefined, otherName: string, revisionNo?: number): string {
  if (q.kind === "approve_budget_move" || q.kind === "approve_rule") {
    if (optionId === "approve") return revisionNo ? `Approved · Budget revision ${revisionNo} saved` : "Approved";
    return `${otherName} will see “Not now”`;
  }
  if (q.kind === "possible_duplicate") return optionId === "same_thing" ? "Removed as a repeat" : "Kept — not a repeat";
  if (q.kind === "needs_receipt") return optionId === "later" ? "We'll ask again later" : "Recorded with the usual split";
  const opt = q.options.find((o) => o.id === optionId);
  const cat = categoryId ?? opt?.categoryId;
  if (cat) return `${q.merchant ?? "Recorded"} recorded as ${categoryName(cat)}`.replace(/^Recorded recorded/, "Recorded");
  return "Recorded. Thanks!";
}

export function useAnswer(otherName: string) {
  const auth = useAuth();
  const { show: toast } = useToast();
  const router = useRouter();
  const mutation = useAnswerQuestion();

  const answer = useCallback(
    async (q: Question, optionId: string, categoryId?: string): Promise<boolean> => {
      const needsStepUp = optionId === "approve";
      if (needsStepUp) {
        const ok = await auth.stepUp("Approve this change");
        if (!ok) {
          toast("Not approved — couldn't confirm it was you.");
          return false;
        }
      }
      try {
        const r = await mutation.mutateAsync({ id: q.id, input: { optionId, ...(categoryId ? { categoryId } : {}) }, ...(needsStepUp ? { stepUp: true } : {}) });
        const rev = typeof r.approval?.payload["revisionNo"] === "number" ? (r.approval.payload["revisionNo"] as number) : undefined;
        toast(toastForAnswer(q, optionId, categoryId, otherName, rev));
        return true;
      } catch (err) {
        if (err instanceof StepUpRequiredError) toast("Confirm it's you with Face ID, then try again.");
        else if (err instanceof ApiError && err.code === "other_spouse_decides") toast("The other spouse decides this one.");
        else toast(err instanceof Error && err.message ? err.message : "That didn't go through. Try again.");
        return false;
      }
    },
    [auth, mutation, toast, otherName],
  );

  const edit = useCallback(
    (q: Question) => {
      if (q.transactionId) router.push({ pathname: "/wrong/[id]", params: { id: q.transactionId, question: q.id } });
    },
    [router],
  );

  return { answer, edit, busy: mutation.isPending };
}
