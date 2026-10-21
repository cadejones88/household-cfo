/**
 * Answering a question from Home or Budget: step-up first when the answer is an approval (and on demand when the
 * API asks for it, as it does for "Not now" on a budget move), then the API call, then one calm toast. Shared so
 * the two screens say the same things.
 */
import { useCallback } from "react";
import { useRouter } from "expo-router";
import type { Question } from "@homestead/shared";
import { useAnswerQuestion } from "../api/hooks";
import { ApiError, StepUpRequiredError } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { withStepUp } from "../auth/stepUp";
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

/** The plain sentence for a failed answer or decision. */
export function toastForError(err: unknown): string {
  if (err instanceof StepUpRequiredError) return "Confirm it's you with Face ID, then try again.";
  if (err instanceof ApiError && err.code === "other_spouse_decides") return "The other spouse decides this one.";
  if (err instanceof ApiError && (err.code === "already_decided" || err.status === 409)) return "That was already taken care of.";
  return err instanceof Error && err.message ? err.message : "That didn't go through. Try again.";
}

export function useAnswer(otherName: string) {
  const auth = useAuth();
  const { show: toast } = useToast();
  const router = useRouter();
  const mutation = useAnswerQuestion();

  const answer = useCallback(
    async (q: Question, optionId: string, categoryId?: string): Promise<boolean> => {
      try {
        const r = await withStepUp({
          confirm: () => auth.stepUp(optionId === "approve" ? "Approve this change" : "Confirm it's you"),
          upfront: optionId === "approve",
          isStepUpError: (e) => e instanceof StepUpRequiredError,
          run: (stepUp) => mutation.mutateAsync({ id: q.id, input: { optionId, ...(categoryId ? { categoryId } : {}) }, ...(stepUp ? { stepUp: true } : {}) }),
        });
        if (!r.ok) {
          toast(optionId === "approve" ? "Not approved — couldn't confirm it was you." : "Nothing changed — couldn't confirm it was you.");
          return false;
        }
        const rev = typeof r.value.approval?.payload["revisionNo"] === "number" ? (r.value.approval.payload["revisionNo"] as number) : undefined;
        toast(toastForAnswer(q, optionId, categoryId, otherName, rev));
        return true;
      } catch (err) {
        toast(toastForError(err));
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
