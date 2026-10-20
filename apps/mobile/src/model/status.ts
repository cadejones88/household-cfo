/**
 * Status words for the household screens. Vanessa's five words come from @homestead/shared
 * (PLAIN_STATUS_WORDS); the calm chips are On track / Watch / Action needed, never a wall of red.
 */
import { PLAIN_STATUS_WORDS, type BudgetLine, type PlainStatus, type Transaction } from "@homestead/shared";
import type { StatusKey } from "../ui/theme";

export type SyncWord = "Not synced yet" | "Fix pending";

/** The subtitle line under an activity row, e.g. "Groceries · Recorded" (the category is added by the caller). */
export function statusLine(tx: Pick<Transaction, "kind" | "status" | "receiptStatus" | "businessFlag" | "categoryId">, extra?: { fixPending?: boolean; categoryName?: string }): string {
  if (tx.kind === "transfer") return "Transfer · not spending";
  if (tx.kind === "loan_payment" || tx.kind === "bc_native") {
    const isMortgage = tx.categoryId === "mortgage" || extra?.categoryName?.toLowerCase().includes("housing") || extra?.categoryName?.toLowerCase().includes("mortgage");
    return isMortgage ? "Mortgage · in the books" : "Loan payment · in the books";
  }
  if (tx.kind === "paycheck") return "Paycheck · in the books";
  let s: string = extra?.fixPending ? "Fix pending" : PLAIN_STATUS_WORDS[tx.status];
  if (tx.receiptStatus === "estimated") s = `Estimated split · ${s}`;
  if (tx.businessFlag === "ctj") s = `Business · CTJ · ${s}`;
  if (tx.businessFlag === "lash") s = `Business · Lash · ${s}`;
  return s;
}

/** The chip colour for a plain status. Questions are wheat/watch; everything recorded is calm green. */
export function statusKeyOf(status: PlainStatus): StatusKey {
  switch (status) {
    case "needs_answer":
      return "watch";
    case "being_checked":
      return "neutral";
    case "dropped":
      return "neutral";
    case "recorded":
    case "in_books":
    case "matched":
      return "good";
  }
}

export function statusWord(status: PlainStatus): string {
  return PLAIN_STATUS_WORDS[status];
}

/** Budget pace to chip. Allowances never alert (I-10): the caller shows "No alerts" instead. */
export function paceKey(pace: BudgetLine["pace"]): Exclude<StatusKey, "neutral"> {
  switch (pace) {
    case "on_track":
      return "good";
    case "watch":
      return "watch";
    case "over":
      return "action";
  }
}

export function safeStatusKey(status: "on_track" | "watch" | "short"): Exclude<StatusKey, "neutral"> {
  return status === "on_track" ? "good" : status === "watch" ? "watch" : "action";
}

/** Glyph and tone for an activity row's icon, as the prototype draws them. */
export function rowIcon(tx: Pick<Transaction, "kind" | "status" | "receiptStatus" | "amountCents" | "merchantNorm" | "merchantRaw">): { glyph: string; tone: "plain" | "in" | "q" | "rc" } {
  const inflow = tx.amountCents > 0;
  const hasReceipt = tx.receiptStatus === "matched";
  const tone = tx.status === "needs_answer" ? "q" : hasReceipt ? "rc" : inflow ? "in" : "plain";
  const glyph = tx.kind === "paycheck" ? "$" : hasReceipt ? "▣" : tx.kind === "transfer" ? "⇄" : tx.kind === "loan_payment" || tx.kind === "bc_native" ? "▤" : (tx.merchantNorm || tx.merchantRaw || "?").charAt(0).toUpperCase();
  return { glyph, tone };
}
