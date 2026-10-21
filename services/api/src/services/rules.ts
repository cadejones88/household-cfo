/**
 * The rule register (spec: "Auto-post rules and the draft authority matrix"; brief: confidence tiers).
 *
 * - Rules apply only in state `approved`; a proposed rule may *suggest* (medium confidence, one tap) but never
 *   files anything by itself. Every change is a new row with `supersedes_rule_id`; approving a version retires
 *   the one it supersedes.
 * - Rules learn only from approved classifications: after N (default 3) consistent approvals of one merchant to
 *   one category the proposer suggests a merchant rule with an amount band from the approved amounts; a merchant
 *   with 10 or more approvals under $25 in 6 months becomes an R6 small-merchant candidate.
 * - The drift guard: a merchant rule never classifies outside its band; the item is asked, not filed.
 * - Auto-post: only when the rule may auto-post, is approved, the household switch is on and none of the five
 *   guard conditions (`ruleBlockReasons`) hold. Then the batch is AUTOPOST; otherwise FEEDS or RECEIPTS.
 */
import {
  amountBand,
  inBand,
  ruleBlockReasons,
  tierOf,
  CATEGORIES,
  MATERIALITY_CENTS,
  withinTolerance,
  type AmountBand,
  type BusinessFlag,
  type ConfidenceTier,
  type DimensionSet,
  type RuleBlockReason,
  type TransactionKind,
} from "@homestead/shared";
import { audit, type Queryable } from "../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import type { CategoryMap } from "./categories.js";
import type { BcBatch } from "./ledgerPort.js";
import type { HouseholdSettings } from "./households.js";

export type RuleKind = "merchant" | "transfer" | "card_payment" | "recurring_bill" | "paycheck" | "loan_payment" | "bc_native" | "small_merchant";
export type RuleState = "proposed" | "approved" | "retired";

export interface RuleMatch {
  merchantPattern?: string;
  merchantNorm?: string;
  merchants?: { pattern: string; categoryId?: string; billName?: string }[];
  accountId?: string;
  bcBankAccountCode?: string;
  band?: AmountBand;
  cadence?: "weekly" | "biweekly" | "monthly" | "annual" | "any";
  tolerance?: { cents?: number; fraction?: number };
  maxCents?: number;
  minApprovedCount?: number;
  windowMonths?: number;
  direction?: "in" | "out" | "any";
  standingAmountCents?: number | null;
  billId?: string;
  requires?: string[];
}

export interface RuleAction {
  categoryId?: string;
  kind?: TransactionKind;
  dims?: DimensionSet;
  businessFlag?: BusinessFlag;
  confidence?: number;
}

export interface RuleRow {
  id: string;
  rule_no: string | null;
  kind: RuleKind;
  name: string;
  match: RuleMatch;
  action: RuleAction;
  may_auto_post: boolean;
  state: RuleState;
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  approval_note: string | null;
  effective_from: string | null;
  version: number;
  supersedes_rule_id: string | null;
  test_passed_at: string | null;
  created_at: string;
  updated_at: string;
}

const RULE_COLUMNS = "id, rule_no, kind, name, match, action, may_auto_post, state, proposed_by, approved_by, approved_at, approval_note, to_char(effective_from,'YYYY-MM-DD') as effective_from, version, supersedes_rule_id, test_passed_at, created_at, updated_at";

export async function listRules(db: Queryable, householdId: string, state?: RuleState): Promise<RuleRow[]> {
  const r = await db.query<RuleRow>(`select ${RULE_COLUMNS} from rules where household_id = $1${state ? " and state = $2" : ""} order by rule_no nulls last, name, version desc`, state ? [householdId, state] : [householdId]);
  return r.rows;
}

export async function loadRule(db: Queryable, id: string): Promise<RuleRow> {
  const r = await db.query<RuleRow>(`select ${RULE_COLUMNS} from rules where id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound("rule");
  return row;
}

export interface ProposeRuleInput {
  kind: RuleKind;
  name: string;
  match: RuleMatch;
  action: RuleAction;
  mayAutoPost?: boolean;
  supersedesRuleId?: string;
  ruleNo?: string;
}

/** A proposal; a change to an existing rule is a new version that supersedes it. */
export async function proposeRule(db: Queryable, householdId: string, input: ProposeRuleInput, proposedBy: string): Promise<RuleRow> {
  let version = 1;
  let ruleNo = input.ruleNo ?? null;
  if (input.supersedesRuleId) {
    const prev = await loadRule(db, input.supersedesRuleId);
    if (prev.state === "retired") throw conflict("retired", "That rule is retired; propose a fresh one");
    version = prev.version + 1;
    ruleNo = ruleNo ?? prev.rule_no;
  }
  if (input.match.merchantPattern) assertRegex(input.match.merchantPattern);
  for (const m of input.match.merchants ?? []) assertRegex(m.pattern);
  const r = await db.query<RuleRow>(
    `insert into rules (household_id, rule_no, kind, name, match, action, may_auto_post, state, proposed_by, version, supersedes_rule_id)
     values ($1,$2,$3,$4,$5,$6,$7,'proposed',$8,$9,$10) returning ${RULE_COLUMNS}`,
    [householdId, ruleNo, input.kind, input.name.slice(0, 120), JSON.stringify(input.match), JSON.stringify(input.action), input.mayAutoPost ?? false, proposedBy, version, input.supersedesRuleId ?? null],
  );
  const row = r.rows[0]!;
  await audit(db, householdId, { actor: proposedBy, action: "rule.proposed", entity: "rule", entityId: row.id, after: { kind: row.kind, name: row.name, version, supersedes: input.supersedesRuleId } });
  return row;
}

function assertRegex(src: string): void {
  try {
    new RegExp(src, "i");
  } catch {
    throw badRequest("pattern", "The merchant pattern is not a valid expression");
  }
  if (src.length > 200) throw badRequest("pattern", "The merchant pattern is too long");
}

/**
 * Approve: the spouse who did not propose it. An auto-post flag needs Cade's written approval in `approvalNote`.
 * Step-up is checked by the route. Approving a version retires the version it supersedes.
 */
export async function approveRule(db: Queryable, householdId: string, ruleId: string, approverMemberId: string, opts: { approvalNote?: string; effectiveFrom?: string } = {}): Promise<RuleRow> {
  const rule = await loadRule(db, ruleId);
  if (rule.state !== "proposed") throw conflict("not_proposed", "Only a proposed rule can be approved");
  if (rule.proposed_by === approverMemberId) throw forbidden("other_spouse_decides", "The spouse who proposed a rule cannot approve it");
  if (rule.may_auto_post && !opts.approvalNote?.trim()) throw badRequest("approval_note_required", "An auto-post rule needs Cade's written approval note");
  await db.query("update rules set state = 'approved', approved_by = $2, approved_at = now(), approval_note = $3, effective_from = coalesce($4, current_date) where id = $1", [ruleId, approverMemberId, opts.approvalNote ?? null, opts.effectiveFrom ?? null]);
  if (rule.supersedes_rule_id) {
    await db.query("update rules set state = 'retired' where id = $1 and state <> 'retired'", [rule.supersedes_rule_id]);
    await audit(db, householdId, { actor: approverMemberId, action: "rule.retired", entity: "rule", entityId: rule.supersedes_rule_id, after: { supersededBy: ruleId } });
  }
  await audit(db, householdId, { actor: approverMemberId, action: "rule.approved", entity: "rule", entityId: ruleId, after: { mayAutoPost: rule.may_auto_post, approvalNote: opts.approvalNote } });
  return loadRule(db, ruleId);
}

export async function retireRule(db: Queryable, householdId: string, ruleId: string, memberId: string, reason?: string): Promise<RuleRow> {
  const rule = await loadRule(db, ruleId);
  if (rule.state === "retired") return rule;
  await db.query("update rules set state = 'retired' where id = $1", [ruleId]);
  await audit(db, householdId, { actor: memberId, action: "rule.retired", entity: "rule", entityId: ruleId, after: { reason } });
  return loadRule(db, ruleId);
}

export async function markRuleTested(db: Queryable, householdId: string, ruleId: string, actor: string): Promise<void> {
  await db.query("update rules set test_passed_at = now() where id = $1", [ruleId]);
  await audit(db, householdId, { actor, action: "rule.test_passed", entity: "rule", entityId: ruleId });
}

// Evaluation ------------------------------------------------------------------------------------------

export interface TxForRules {
  merchantRaw: string;
  merchantNorm: string;
  amountCents: number;
  accountId: string;
  bcBankAccountCode?: string | null;
  businessFlag: BusinessFlag;
  receiptSplitPending: boolean;
  feedStaleHours: number;
}

export interface MerchantHistory {
  /** Approved classifications of this merchant in the window. */
  count: number;
  /** The single category if every approval agreed; undefined if they disagreed. */
  categoryId?: string;
  amountsCents: number[];
  /** The last three amounts, newest first (recurring-bill tolerance). */
  lastThreeCents: number[];
}

export interface Evaluation {
  categoryId?: string;
  confidence: number;
  tier: ConfidenceTier;
  ruleId?: string;
  ruleApproved: boolean;
  mayAutoPost: boolean;
  inBand: boolean;
  blockReasons: RuleBlockReason[];
  /** Plain words for the question's "why". */
  reason: string;
  /** What the rule engine decides for the state machine. */
  nextState: "approved" | "ready_for_review";
}

interface Candidate {
  categoryId: string;
  confidence: number;
  rule?: RuleRow;
  inBand: boolean;
  reason: string;
}

function patternOf(src: string): RegExp {
  return new RegExp(src, "i");
}

function matchesMerchant(src: string, tx: TxForRules): boolean {
  const re = patternOf(src);
  return re.test(tx.merchantNorm) || re.test(tx.merchantRaw);
}

function directionOk(m: RuleMatch, tx: TxForRules): boolean {
  const d = m.direction ?? "any";
  if (d === "in") return tx.amountCents > 0;
  if (d === "out") return tx.amountCents < 0;
  return true;
}

function accountOk(m: RuleMatch, tx: TxForRules): boolean {
  if (m.accountId && m.accountId !== tx.accountId) return false;
  if (m.bcBankAccountCode && m.bcBankAccountCode !== tx.bcBankAccountCode) return false;
  return true;
}

/** The confidence a rule may claim: approved rules keep theirs; proposed rules are capped to a one-tap suggestion. */
function cappedConfidence(rule: RuleRow, base: number): number {
  return rule.state === "approved" ? base : Math.min(base, 0.85);
}

function evaluateOne(rule: RuleRow, tx: TxForRules, history: MerchantHistory | undefined): Candidate | undefined {
  const m = rule.match;
  if (!directionOk(m, tx) || !accountOk(m, tx)) return undefined;
  const base = rule.action.confidence ?? 0.99;
  switch (rule.kind) {
    case "merchant": {
      const hit = (m.merchantNorm && tx.merchantNorm === m.merchantNorm) || (m.merchantPattern && matchesMerchant(m.merchantPattern, tx));
      if (!hit || !rule.action.categoryId) return undefined;
      if (m.band && !inBand(tx.amountCents, m.band)) {
        return { categoryId: rule.action.categoryId, confidence: 0.4, rule, inBand: false, reason: `This is an unusual amount for ${tx.merchantRaw || "this merchant"}, so we are asking instead of filing it.` };
      }
      return { categoryId: rule.action.categoryId, confidence: cappedConfidence(rule, base), rule, inBand: true, reason: `${rule.name}: this merchant usually goes here.` };
    }
    case "recurring_bill": {
      let categoryId = rule.action.categoryId;
      let hit = false;
      if (m.merchants?.length) {
        const entry = m.merchants.find((e) => matchesMerchant(e.pattern, tx));
        if (entry) {
          hit = true;
          categoryId = entry.categoryId ?? categoryId;
        }
      } else if (m.merchantPattern) {
        hit = matchesMerchant(m.merchantPattern, tx);
      }
      if (!hit || !categoryId) return undefined;
      if (m.standingAmountCents !== undefined) {
        if (m.standingAmountCents === null) return { categoryId, confidence: 0.8, rule, inBand: true, reason: `${rule.name}: the standing amount is not set yet, so one tap confirms it.` };
        if (Math.abs(tx.amountCents) !== m.standingAmountCents) return { categoryId, confidence: 0.4, rule, inBand: false, reason: `${rule.name}: the amount differs from the standing amount.` };
        return { categoryId, confidence: cappedConfidence(rule, base), rule, inBand: true, reason: `${rule.name}: the standing amount.` };
      }
      const tol = m.tolerance ?? { cents: 500, fraction: 0.05 };
      const last3 = history?.lastThreeCents ?? [];
      if (last3.length < 3) return { categoryId, confidence: 0.8, rule, inBand: true, reason: `${rule.name}: fewer than three past payments, so one tap confirms it.` };
      const stable = last3.every((a) => withinTolerance(Math.abs(tx.amountCents), Math.abs(a), tol));
      if (!stable) return { categoryId, confidence: 0.4, rule, inBand: false, reason: `${rule.name}: the amount moved more than $5 or 5% from the last three.` };
      return { categoryId, confidence: cappedConfidence(rule, base), rule, inBand: true, reason: `${rule.name}: known payee, stable amount.` };
    }
    case "small_merchant": {
      // R6 as a policy rule applies to any merchant with the history; a per-merchant version names its merchant.
      if (m.merchantNorm && tx.merchantNorm !== m.merchantNorm) return undefined;
      if (m.merchantPattern && !matchesMerchant(m.merchantPattern, tx)) return undefined;
      const max = m.maxCents ?? MATERIALITY_CENTS;
      const minCount = m.minApprovedCount ?? 10;
      if (!history?.categoryId || history.count < minCount) return undefined;
      if (Math.abs(tx.amountCents) >= max) return undefined;
      if (history.amountsCents.some((a) => Math.abs(a) >= max)) return undefined;
      const band = amountBand(history.amountsCents.map((a) => Math.abs(a)));
      if (!inBand(tx.amountCents, band)) return { categoryId: history.categoryId, confidence: 0.4, rule, inBand: false, reason: `${rule.name}: outside this merchant's usual range.` };
      return { categoryId: history.categoryId, confidence: cappedConfidence(rule, base), rule, inBand: true, reason: `${rule.name}: ${history.count} approved to the same category under $25.` };
    }
    default:
      // transfer, card_payment, paycheck, loan_payment, bc_native: evaluated by pairing.ts / paychecks.
      return undefined;
  }
}

/** Keyword fallback from the category examples when no rule matches. */
export function heuristicCategory(tx: TxForRules, cats: CategoryMap): Candidate | undefined {
  // Apostrophes vanish rather than split a word, so "Broulim's" matches "BROULIMS" and "BROULIM'S".
  const text = `${tx.merchantNorm} ${tx.merchantRaw.toLowerCase().replace(/['’]/g, "")}`;
  let best: Candidate | undefined;
  for (const c of CATEGORIES) {
    if (!cats.has(c.id)) continue;
    if (c.group === "Unsplit" || c.group === "Suspense") continue;
    for (const ex of c.examples) {
      const word = ex.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9 ]+/g, " ").trim();
      if (word.length < 3) continue;
      if (text.includes(word)) {
        const isIncome = c.group === "Income";
        if (isIncome !== tx.amountCents > 0 && !c.isTransfer) continue;
        const score = 0.7 + Math.min(0.1, word.length / 100);
        if (!best || score > best.confidence) best = { categoryId: c.id, confidence: score, inBand: true, reason: `Looks like ${c.name} (one tap confirms).` };
      }
    }
  }
  return best;
}

export interface EvaluateOptions {
  settings: Pick<HouseholdSettings, "merchantWatchList">;
  householdAutoPostOn: boolean;
  history?: MerchantHistory;
}

/** The engine's decision for one spend/income line. Pairing and paychecks decide their own kinds. */
export function evaluateRules(rules: readonly RuleRow[], tx: TxForRules, cats: CategoryMap, opts: EvaluateOptions): Evaluation {
  const candidates: Candidate[] = [];
  for (const rule of rules) {
    if (rule.state === "retired") continue;
    const c = evaluateOne(rule, tx, opts.history);
    if (c) candidates.push(c);
  }
  // Approved rules first, then by confidence; an outside-band answer from an approved rule still wins (it asks).
  candidates.sort((a, b) => Number(b.rule?.state === "approved") - Number(a.rule?.state === "approved") || b.confidence - a.confidence);
  let pick = candidates[0];
  if (!pick) pick = heuristicCategory(tx, cats);
  if (!pick) {
    return { confidence: 0.3, tier: "low", ruleApproved: false, mayAutoPost: false, inBand: true, blockReasons: [], reason: "We have not seen this merchant before. Pick the closest category and we will remember it.", nextState: "ready_for_review" };
  }
  const tier = tierOf(pick.confidence);
  const ruleApproved = pick.rule?.state === "approved";
  const watch = opts.settings.merchantWatchList.some((w) => w && tx.merchantNorm.includes(w.toLowerCase()));
  const blockReasons = ruleBlockReasons({
    amountCents: tx.amountCents,
    ...(pick.rule?.match.band ? { band: pick.rule.match.band } : {}),
    merchantOnWatchList: watch,
    businessFlagged: tx.businessFlag !== "none",
    receiptSplitPending: tx.receiptSplitPending,
    feedStaleHours: tx.feedStaleHours,
    householdAutoPostOn: opts.householdAutoPostOn,
  });
  const nextState: Evaluation["nextState"] = tier === "high" && ruleApproved && pick.inBand && !watch && tx.businessFlag === "none" ? "approved" : "ready_for_review";
  const mayAutoPost = nextState === "approved" && Boolean(pick.rule?.may_auto_post) && blockReasons.length === 0;
  const out: Evaluation = { categoryId: pick.categoryId, confidence: pick.confidence, tier, ruleApproved, mayAutoPost, inBand: pick.inBand, blockReasons, reason: pick.reason, nextState };
  if (pick.rule) out.ruleId = pick.rule.id;
  return out;
}

/** The batch for an approved item: AUTOPOST only under an approved auto-post rule with the switch on and no guard tripped. */
export function decideBatch(e: Pick<Evaluation, "mayAutoPost" | "ruleApproved">, rule: RuleRow | undefined, householdAutoPostOn: boolean, fallback: BcBatch): BcBatch {
  if (rule && rule.state === "approved" && rule.may_auto_post && householdAutoPostOn && e.mayAutoPost) return "AUTOPOST";
  return fallback;
}

// History and proposals -----------------------------------------------------------------------------

const APPROVED_STATES = ["approved", "sent_to_bc", "bc_draft_created", "posted", "reconciled"];

/** Approved classifications of one merchant in the last `months` months (what the rules may learn from). */
export async function merchantHistory(db: Queryable, householdId: string, merchantNorm: string, months = 6, excludeTxId?: string): Promise<MerchantHistory> {
  if (!merchantNorm) return { count: 0, amountsCents: [], lastThreeCents: [] };
  const r = await db.query<{ category_id: string | null; amount_cents: number; posted_date: string }>(
    `select category_id, amount_cents::bigint::int as amount_cents, posted_date from transactions
      where household_id = $1 and merchant_norm = $2 and state = any($3) and kind in ('spend','income') and business_flag = 'none'
        and posted_date >= (current_date - ($4 || ' months')::interval) and ($5::uuid is null or id <> $5::uuid)
      order by posted_date desc`,
    [householdId, merchantNorm, APPROVED_STATES, String(months), excludeTxId ?? null],
  );
  const cats = new Set(r.rows.map((x) => x.category_id).filter((x): x is string => Boolean(x)));
  const out: MerchantHistory = { count: r.rows.length, amountsCents: r.rows.map((x) => x.amount_cents), lastThreeCents: r.rows.slice(0, 3).map((x) => x.amount_cents) };
  if (cats.size === 1) out.categoryId = [...cats][0]!;
  return out;
}

/**
 * Propose merchant rules from approved history (only). Runs after approvals and nightly.
 * N consistent approvals (default 3) -> a merchant rule with the band of the approved amounts;
 * 10+ approvals all under $25 -> a small-merchant rule (R6 shape) for that merchant.
 */
export async function proposeRulesFromHistory(db: Queryable, householdId: string, settings: Pick<HouseholdSettings, "ruleProposalMinApprovals">, months = 6): Promise<RuleRow[]> {
  const r = await db.query<{ merchant_norm: string; category_ids: string[]; amounts: number[]; n: number }>(
    `select merchant_norm, array_agg(distinct category_id) as category_ids, array_agg(amount_cents::bigint::int) as amounts, count(*)::int as n
       from transactions
      where household_id = $1 and merchant_norm <> '' and state = any($2) and kind = 'spend' and business_flag = 'none' and category_id is not null
        and posted_date >= (current_date - ($3 || ' months')::interval)
        and receipt_status <> 'matched'
      group by merchant_norm having count(*) >= $4`,
    [householdId, APPROVED_STATES, String(months), settings.ruleProposalMinApprovals],
  );
  const existing = await listRules(db, householdId);
  const covered = new Set(existing.filter((x) => x.state !== "retired" && x.kind === "merchant").map((x) => x.match.merchantNorm));
  const proposed: RuleRow[] = [];
  for (const row of r.rows) {
    if (row.category_ids.length !== 1 || covered.has(row.merchant_norm)) continue;
    const categoryId = row.category_ids[0]!;
    const cat = CATEGORIES.find((c) => c.id === categoryId);
    if (!cat || cat.isAllowance || cat.isTransfer || cat.group === "Unsplit") continue;
    const abs = row.amounts.map((a) => Math.abs(a));
    const small = row.n >= 10 && abs.every((a) => a < MATERIALITY_CENTS);
    const band = amountBand(abs);
    const rule = await proposeRule(
      db,
      householdId,
      {
        kind: small ? "small_merchant" : "merchant",
        name: `${row.merchant_norm} → ${cat.name}`,
        match: small ? { merchantNorm: row.merchant_norm, maxCents: MATERIALITY_CENTS, minApprovedCount: 10, windowMonths: months, band, direction: "out" } : { merchantNorm: row.merchant_norm, band, direction: "out" },
        action: { categoryId, confidence: 0.99 },
        mayAutoPost: false,
      },
      "system",
    );
    proposed.push(rule);
  }
  return proposed;
}
