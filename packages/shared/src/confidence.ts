/**
 * Confidence tiers (brief: high auto only under an approved rule; medium one-tap confirm; low review).
 * Rules learn only from approved corrections; a merchant rule must not blindly classify an unusual purchase.
 */
import type { Cents } from "./money.js";

export type ConfidenceTier = "high" | "medium" | "low";

export const CONFIDENCE_THRESHOLDS = {
  /** Pilot auto-classification confidence from the configuration (AUTO_CLASSIFICATION_CONFIDENCE suggested 98%). */
  high: 0.98,
  medium: 0.7,
} as const;

export function tierOf(confidence: number): ConfidenceTier {
  if (confidence < 0 || confidence > 1) throw new Error(`Confidence must be 0..1, got ${confidence}`);
  if (confidence >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (confidence >= CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "low";
}

export interface AmountBand {
  /** Inclusive, in cents. */
  minCents: Cents;
  maxCents: Cents;
}

/**
 * The drift guard. A merchant rule's band is built from its approved history: the observed range widened by
 * the larger of $5 or 5% on each side (R4's threshold), never below zero on the low side. A transaction outside
 * the band is asked, not filed, however many times the merchant has been seen.
 */
export function amountBand(approvedAmountsCents: readonly Cents[]): AmountBand {
  if (approvedAmountsCents.length === 0) throw new Error("A band needs at least one approved amount");
  const min = Math.min(...approvedAmountsCents);
  const max = Math.max(...approvedAmountsCents);
  const pad = (v: Cents) => Math.max(500, Math.round(Math.abs(v) * 0.05));
  return { minCents: Math.max(0, min - pad(min)), maxCents: max + pad(max) };
}

export function inBand(amountCents: Cents, band: AmountBand): boolean {
  const abs = Math.abs(amountCents);
  return abs >= band.minCents && abs <= band.maxCents;
}

/** Conditions under which no rule may fire (spec: "Auto-post rules", the five holds). */
export interface RuleGuardInput {
  amountCents: Cents;
  band?: AmountBand;
  merchantOnWatchList: boolean;
  businessFlagged: boolean;
  receiptSplitPending: boolean;
  feedStaleHours: number;
  householdAutoPostOn: boolean;
}

export type RuleBlockReason = "outside_band" | "watch_list" | "business" | "receipt_pending" | "feed_stale" | "autopost_off";

export function ruleBlockReasons(input: RuleGuardInput): RuleBlockReason[] {
  const reasons: RuleBlockReason[] = [];
  if (input.band && !inBand(input.amountCents, input.band)) reasons.push("outside_band");
  if (input.merchantOnWatchList) reasons.push("watch_list");
  if (input.businessFlagged) reasons.push("business");
  if (input.receiptSplitPending) reasons.push("receipt_pending");
  if (input.feedStaleHours > 48) reasons.push("feed_stale");
  if (!input.householdAutoPostOn) reasons.push("autopost_off");
  return reasons;
}
