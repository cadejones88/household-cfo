/**
 * The transaction state machine from the Phase 3 spec, section "Transaction state machine".
 * A transaction moves only along these arrows; every move writes an audit row.
 */

export const TRANSACTION_STATES = [
  "imported",
  "possible_duplicate",
  "needs_receipt",
  "needs_classification",
  "ready_for_review",
  "approved",
  "sent_to_bc",
  "bc_draft_created",
  "posted",
  "reconciled",
  "exception",
  "reversed",
  "dropped",
] as const;

export type TransactionState = (typeof TRANSACTION_STATES)[number];

/** Who or what may cause a transition. */
export type Actor = "jobs" | "api" | "rule_engine" | "relay" | "bc_worker" | "poll" | "member" | "cade";

export interface Transition {
  from: TransactionState;
  to: TransactionState;
  trigger: string;
  actors: readonly Actor[];
}

export const TRANSITIONS: readonly Transition[] = [
  { from: "imported", to: "possible_duplicate", trigger: "same account, amount and date within 3 days from another source", actors: ["jobs"] },
  { from: "possible_duplicate", to: "needs_receipt", trigger: "a person says not a repeat (receipt-required merchant)", actors: ["member", "cade"] },
  { from: "possible_duplicate", to: "needs_classification", trigger: "a person says not a repeat", actors: ["member", "cade"] },
  { from: "possible_duplicate", to: "dropped", trigger: "a person says same thing; key kept so it cannot return", actors: ["member", "cade"] },
  { from: "imported", to: "needs_receipt", trigger: "Walmart, club or Amazon line of $25 or more without a matched receipt", actors: ["jobs"] },
  { from: "needs_receipt", to: "needs_classification", trigger: "receipt matched, or 10 days passed (estimated split applied)", actors: ["jobs"] },
  { from: "imported", to: "needs_classification", trigger: "any other line", actors: ["jobs"] },
  { from: "needs_classification", to: "approved", trigger: "approved rule matched with high confidence inside its band", actors: ["rule_engine"] },
  { from: "needs_classification", to: "ready_for_review", trigger: "medium confidence (one-tap confirm) or low confidence (pick a category)", actors: ["rule_engine"] },
  { from: "ready_for_review", to: "approved", trigger: "one tap in the app or a Console approval", actors: ["member", "cade"] },
  { from: "approved", to: "sent_to_bc", trigger: "outbox row relayed to the queue", actors: ["relay"] },
  { from: "sent_to_bc", to: "bc_draft_created", trigger: "journal lines written or found by the pre-write check; line IDs stored", actors: ["bc_worker"] },
  { from: "sent_to_bc", to: "exception", trigger: "non-retryable error, or BC reports a line the app does not know", actors: ["bc_worker"] },
  { from: "bc_draft_created", to: "posted", trigger: "batch posted; G/L entries read back by webhook or poll", actors: ["cade", "jobs", "poll", "bc_worker"] },
  { from: "bc_draft_created", to: "exception", trigger: "draft edited or deleted in BC; nightly poll count or sum differs", actors: ["poll"] },
  { from: "posted", to: "reconciled", trigger: "bank ledger entry closed by BC bank reconciliation", actors: ["poll", "jobs"] },
  { from: "posted", to: "reversed", trigger: "correction: reversal in BC (REVERSE) and a new linked entry (CORRECT)", actors: ["cade"] },
  { from: "exception", to: "ready_for_review", trigger: "a person resolves it", actors: ["cade"] },
  { from: "exception", to: "posted", trigger: "a person resolves it against an existing BC entry", actors: ["cade"] },
  // BC-native entries (mortgage, loans) are matched to BC's own entries and go straight to reconciled.
  { from: "imported", to: "reconciled", trigger: "matched to a BC-native recurring-journal bank ledger entry (R7)", actors: ["jobs", "rule_engine"] },
];

const byFrom = new Map<TransactionState, Transition[]>();
for (const t of TRANSITIONS) {
  const list = byFrom.get(t.from) ?? [];
  list.push(t);
  byFrom.set(t.from, list);
}

export function allowedTransitions(from: TransactionState): readonly Transition[] {
  return byFrom.get(from) ?? [];
}

export function canTransition(from: TransactionState, to: TransactionState, actor?: Actor): boolean {
  return allowedTransitions(from).some((t) => t.to === to && (actor === undefined || t.actors.includes(actor)));
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TransactionState,
    public readonly to: TransactionState,
    public readonly actor?: Actor,
  ) {
    super(`Illegal transition ${from} -> ${to}${actor ? ` by ${actor}` : ""}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: TransactionState, to: TransactionState, actor?: Actor): void {
  if (!canTransition(from, to, actor)) throw new IllegalTransitionError(from, to, actor);
}

/** States from Sent to BC onward require a BC External Document No. (database invariant, mirrored here). */
export const STATES_REQUIRING_BC_DOC: ReadonlySet<TransactionState> = new Set([
  "sent_to_bc",
  "bc_draft_created",
  "posted",
  "reversed",
]);

/** Vanessa's five words. */
export type PlainStatus = "needs_answer" | "recorded" | "in_books" | "matched" | "being_checked" | "dropped";

export const PLAIN_STATUS_WORDS: Record<PlainStatus, string> = {
  needs_answer: "Needs a quick answer",
  recorded: "Recorded",
  in_books: "In the books",
  matched: "Matched to the bank",
  being_checked: "Being checked",
  dropped: "Removed as a repeat",
};

export function plainStatus(state: TransactionState): PlainStatus {
  switch (state) {
    case "possible_duplicate":
    case "needs_receipt":
    case "needs_classification":
    case "ready_for_review":
      return "needs_answer";
    case "imported":
    case "approved":
    case "sent_to_bc":
    case "bc_draft_created":
      return "recorded";
    case "posted":
      return "in_books";
    case "reconciled":
      return "matched";
    case "exception":
      return "being_checked";
    case "reversed":
      // The app shows the new entry instead; the old one reads as in the books.
      return "in_books";
    case "dropped":
      return "dropped";
  }
}

/** The states that mean "a person needs to act". */
export const QUEUE_STATES: readonly TransactionState[] = [
  "possible_duplicate",
  "needs_receipt",
  "needs_classification",
  "ready_for_review",
];
