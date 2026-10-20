/**
 * Possible duplicates (spec: state machine rows 2–3; "File import"): a row that matches an existing transaction
 * on the same account by amount and date within 3 days, from another source, is marked Possible Duplicate for a
 * person to resolve, never merged silently. "Same thing" drops it but keeps its key so it cannot return.
 */
import { RECEIPT_REQUIRED_MERCHANTS, RECEIPT_THRESHOLD_CENTS, type Actor } from "@homestead/shared";
import type { Queryable } from "../db/index.js";
import { loadTx, transition, type TxRow } from "./transactions.js";

const LIVE_STATES = ["imported", "possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review", "approved", "sent_to_bc", "bc_draft_created", "posted", "reconciled"];

/** The earlier transaction this one may repeat, if any. */
export async function findDuplicateCandidate(db: Queryable, householdId: string, tx: TxRow): Promise<TxRow | undefined> {
  const r = await db.query<{ id: string }>(
    `select id from transactions
      where household_id = $1 and account_id = $2 and amount_cents = $3 and id <> $4 and not pending
        and source <> $5 and state = any($6)
        and abs(posted_date - $7::date) <= 3
      order by abs(posted_date - $7::date), created_at limit 1`,
    [householdId, tx.account_id, tx.amount_cents, tx.id, tx.source, LIVE_STATES, tx.posted_date],
  );
  const id = r.rows[0]?.id;
  return id ? loadTx(db, id) : undefined;
}

/** Mark a freshly imported row as a possible duplicate when a candidate exists. Returns the updated row. */
export async function detectPossibleDuplicate(db: Queryable, householdId: string, tx: TxRow, actor = "jobs"): Promise<{ transaction: TxRow; duplicateOf?: TxRow }> {
  if (tx.state !== "imported" || tx.pending) return { transaction: tx };
  const candidate = await findDuplicateCandidate(db, householdId, tx);
  if (!candidate) return { transaction: tx };
  const updated = await transition(db, householdId, tx.id, "possible_duplicate", "jobs", { actorId: actor, patch: { duplicate_of_id: candidate.id }, reason: `may repeat ${candidate.idempotency_key}` });
  return { transaction: updated, duplicateOf: candidate };
}

export function needsReceipt(merchantRaw: string, amountCents: number): { required: boolean; unsplitCategory?: string } {
  if (amountCents > -RECEIPT_THRESHOLD_CENTS) return { required: false };
  for (const m of RECEIPT_REQUIRED_MERCHANTS) {
    if (m.pattern.test(merchantRaw)) return { required: true, unsplitCategory: m.unsplitCategory };
  }
  return { required: false };
}

/** A person resolves it: "not a repeat" continues through the normal path; "same thing" drops it (key kept). */
export async function resolveDuplicate(db: Queryable, householdId: string, txId: string, answer: "not_repeat" | "same_thing", who: Actor, actorId: string): Promise<TxRow> {
  const tx = await loadTx(db, txId, true);
  if (answer === "same_thing") {
    return transition(db, householdId, txId, "dropped", who, { actorId, reason: "same thing" });
  }
  const r = needsReceipt(tx.merchant_raw, tx.amount_cents);
  return transition(db, householdId, txId, r.required ? "needs_receipt" : "needs_classification", who, {
    actorId,
    reason: "not a repeat",
    patch: r.required ? { receipt_status: "needed", category_id: r.unsplitCategory ?? null, duplicate_of_id: null } : { duplicate_of_id: null },
  });
}
