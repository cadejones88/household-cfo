/**
 * Status mapping for the Console. Cade's vocabulary is the state machine's (Imported … Posted, Reconciled);
 * each state gets a label, a calm tone and the plain words Vanessa sees for the same thing.
 */
import { PLAIN_STATUS_WORDS, plainStatus, type DataQuality, type TransactionState } from "@homestead/shared";

export type Tone = "good" | "watch" | "action" | "neutral" | "muted";

export interface StatusView {
  label: string;
  tone: Tone;
  /** What the same state reads as in the phone app. */
  plain: string;
}

const STATE_LABELS: Record<TransactionState, { label: string; tone: Tone }> = {
  imported: { label: "Imported", tone: "neutral" },
  possible_duplicate: { label: "Possible duplicate", tone: "watch" },
  needs_receipt: { label: "Needs receipt", tone: "watch" },
  needs_classification: { label: "Needs classification", tone: "watch" },
  ready_for_review: { label: "Ready for review", tone: "watch" },
  approved: { label: "Approved", tone: "neutral" },
  sent_to_bc: { label: "Sent to BC", tone: "neutral" },
  bc_draft_created: { label: "BC draft created", tone: "neutral" },
  posted: { label: "Posted", tone: "good" },
  reconciled: { label: "Reconciled", tone: "good" },
  exception: { label: "Exception", tone: "action" },
  reversed: { label: "Reversed / superseded", tone: "muted" },
  dropped: { label: "Dropped (repeat)", tone: "muted" },
};

export function stateView(state: TransactionState): StatusView {
  const s = STATE_LABELS[state];
  return { label: s.label, tone: s.tone, plain: PLAIN_STATUS_WORDS[plainStatus(state)] };
}

const QUALITY_LABELS: Record<DataQuality, { label: string; tone: Tone; hint: string }> = {
  posted_reconciled: { label: "Posted and reconciled", tone: "good", hint: "Every number ties to a posted BC entry closed by bank reconciliation." },
  posted_unreconciled: { label: "Posted, not yet reconciled", tone: "good", hint: "Posted in BC; bank reconciliation has not closed the lines yet." },
  imported_pending: { label: "Imported, pending", tone: "watch", hint: "Includes lines still waiting for a person or for BC." },
  estimated: { label: "Estimated", tone: "watch", hint: "Includes an estimated split or template; a stub or receipt will true it up." },
  stale: { label: "Stale", tone: "action", hint: "A feed or poll is older than its threshold. Treat the numbers as a snapshot." },
  missing: { label: "Missing", tone: "action", hint: "A source is unavailable; these numbers are incomplete." },
};

export function qualityView(q: DataQuality): { label: string; tone: Tone; hint: string } {
  return QUALITY_LABELS[q];
}

export function feedStatusView(status: "ok" | "stale" | "needs_relink" | "disabled" | "file_only" | "none"): StatusView {
  switch (status) {
    case "ok":
      return { label: "Connected", tone: "good", plain: "Connected" };
    case "stale":
      return { label: "Stale", tone: "watch", plain: "Not updated lately" };
    case "needs_relink":
      return { label: "Needs re-link", tone: "action", plain: "Needs a quick re-link" };
    case "disabled":
      return { label: "Disabled", tone: "muted", plain: "Turned off" };
    case "file_only":
      return { label: "File import", tone: "neutral", plain: "From statements" };
    case "none":
      return { label: "No feed", tone: "muted", plain: "No feed" };
  }
}

export function syncRunStatusView(status: "running" | "ok" | "failed"): StatusView {
  switch (status) {
    case "running":
      return { label: "Running", tone: "neutral", plain: "Running" };
    case "ok":
      return { label: "OK", tone: "good", plain: "OK" };
    case "failed":
      return { label: "Failed", tone: "action", plain: "Failed" };
  }
}

export function ruleStateView(state: "proposed" | "approved" | "retired"): StatusView {
  switch (state) {
    case "proposed":
      return { label: "Proposed", tone: "watch", plain: "Waiting for approval" };
    case "approved":
      return { label: "Approved", tone: "good", plain: "Approved" };
    case "retired":
      return { label: "Retired", tone: "muted", plain: "Retired" };
  }
}

/** Hours since an ISO timestamp, or undefined when absent. */
export function hoursSince(iso: string | undefined, now = Date.now()): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return (now - t) / 3_600_000;
}

/** Feed freshness: the spec's 48-hour rule marks a feed stale. */
export function freshnessTone(iso: string | undefined, staleAfterHours = 48, now = Date.now()): Tone {
  const h = hoursSince(iso, now);
  if (h === undefined) return "muted";
  if (h > staleAfterHours) return "action";
  if (h > staleAfterHours / 2) return "watch";
  return "good";
}
