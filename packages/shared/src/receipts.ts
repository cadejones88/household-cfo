/**
 * Receipt splitting and matching rules (spec: "Receipts", steps 5 and 6).
 */
import type { Cents } from "./money.js";
import { prorateCents, sumCents, withinTolerance } from "./money.js";
import { RECEIPT_THRESHOLD_CENTS } from "./categories.js";

export interface ReceiptLineIn {
  description: string;
  amountCents: Cents;
  categoryId: string;
  confidence: number;
}

export interface SplitLine {
  lineNo: number;
  description: string;
  amountCents: Cents;
  categoryId: string;
}

export interface SplitResult {
  lines: SplitLine[];
  /** True when the split needs a one-tap confirmation: a receipt-required merchant at $25 or more, or more than one category. */
  needsConfirmation: boolean;
}

export class SplitDoesNotTieError extends Error {
  constructor(public readonly totalCents: Cents, public readonly linesCents: Cents, public readonly taxCents: Cents) {
    super(`Receipt split does not equal the total: lines ${linesCents} + tax ${taxCents} != ${totalCents}`);
    this.name = "SplitDoesNotTieError";
  }
}

/**
 * Tax is spread across lines in proportion to their amounts; rounding goes to the largest line; lines with the
 * same category are merged; the split must equal the receipt total to the cent or the receipt goes to review.
 */
export function splitReceipt(opts: { totalCents: Cents; taxCents: Cents; lines: readonly ReceiptLineIn[]; receiptRequiredMerchant: boolean }): SplitResult {
  if (opts.lines.length === 0) throw new Error("A receipt split needs at least one line");
  const linesCents = sumCents(opts.lines.map((l) => l.amountCents));
  if (linesCents + opts.taxCents !== opts.totalCents) throw new SplitDoesNotTieError(opts.totalCents, linesCents, opts.taxCents);
  const taxShares = prorateCents(opts.taxCents, opts.lines.map((l) => Math.max(0, l.amountCents)));
  const byCategory = new Map<string, SplitLine>();
  opts.lines.forEach((l, i) => {
    const amt = l.amountCents + (taxShares[i] ?? 0);
    const existing = byCategory.get(l.categoryId);
    if (existing) {
      existing.amountCents += amt;
      existing.description = `${existing.description}; ${l.description}`.slice(0, 100);
    } else {
      byCategory.set(l.categoryId, { lineNo: byCategory.size + 1, description: l.description.slice(0, 100), amountCents: amt, categoryId: l.categoryId });
    }
  });
  const lines = [...byCategory.values()];
  if (sumCents(lines.map((l) => l.amountCents)) !== opts.totalCents) throw new SplitDoesNotTieError(opts.totalCents, linesCents, opts.taxCents);
  const needsConfirmation = (opts.receiptRequiredMerchant && opts.totalCents >= RECEIPT_THRESHOLD_CENTS) || lines.length > 1 || opts.lines.some((l) => l.confidence < 0.98);
  return { lines, needsConfirmation };
}

export interface MatchCandidate {
  transactionId: string;
  postedDate: string;
  amountCents: Cents;
  merchantNorm: string;
  accountId: string;
}

export interface MatchResult {
  matched?: MatchCandidate;
  confidence: number;
  candidates: readonly { candidate: MatchCandidate; score: number }[];
  /** Two plausible candidates: a person decides. */
  ambiguous: boolean;
}

/**
 * Candidates are bank lines on the same account within -3..+5 days whose amount equals the total (or within 2%
 * for tips). One candidate above 0.9 matches; two plausible candidates go to a person.
 */
export function matchReceipt(opts: {
  receiptDateIso: string;
  totalCents: Cents;
  merchantNorm: string;
  tipPossible: boolean;
  candidates: readonly MatchCandidate[];
  daysBetween: (fromIso: string, toIso: string) => number;
}): MatchResult {
  const scored = opts.candidates
    .map((c) => {
      const dayDiff = opts.daysBetween(opts.receiptDateIso, c.postedDate);
      if (dayDiff < -3 || dayDiff > 5) return undefined;
      const exact = Math.abs(c.amountCents) === Math.abs(opts.totalCents);
      const tipped = opts.tipPossible && withinTolerance(Math.abs(c.amountCents), Math.abs(opts.totalCents), { fraction: 0.02 }) && !exact;
      if (!exact && !tipped) return undefined;
      let score = exact ? 0.8 : 0.6;
      score += dayDiff >= 0 && dayDiff <= 2 ? 0.1 : 0.05;
      if (opts.merchantNorm && c.merchantNorm && (c.merchantNorm.includes(opts.merchantNorm) || opts.merchantNorm.includes(c.merchantNorm))) score += 0.1;
      return { candidate: c, score: Math.min(1, score) };
    })
    .filter((x): x is { candidate: MatchCandidate; score: number } => x !== undefined)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const second = scored[1];
  const ambiguous = Boolean(top && second && second.score >= 0.7 && top.score - second.score < 0.15);
  if (top && top.score > 0.9 && !ambiguous) return { matched: top.candidate, confidence: top.score, candidates: scored, ambiguous: false };
  return { confidence: top?.score ?? 0, candidates: scored, ambiguous };
}
