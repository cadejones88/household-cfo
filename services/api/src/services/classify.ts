/**
 * The matching job's orchestration for one household: duplicates, BC-native matches, transfer and card-payment
 * pairs, paycheck detection, receipt-required merchants, then the rule engine for everything else.
 * Every step moves items along the state machine through transactions.ts, so each move is audited.
 */
import { hoursBetween } from "../lib/dates.js";
import type { Queryable } from "../db/index.js";
import { detectPossibleDuplicate, needsReceipt } from "./duplicates.js";
import { loadCategories, type CategoryMap } from "./categories.js";
import { getSettings, ledgerConnection, type HouseholdSettings } from "./households.js";
import type { LedgerPort } from "./ledgerPort.js";
import { matchBcNative, pairTransfers } from "./pairing.js";
import { evaluateRules, listRules, merchantHistory, decideBatch, type RuleRow } from "./rules.js";
import { approveTransaction, loadAccount, loadTx, transition, type TxRow } from "./transactions.js";
import { detectPaycheck } from "./paychecks/detect.js";

export interface MatchingContext {
  ledger: LedgerPort;
  actor?: string;
  now?: Date;
}

export interface MatchingCounts {
  duplicates: number;
  bcNative: number;
  pairs: number;
  paychecks: number;
  needsReceipt: number;
  approved: number;
  review: number;
}

export async function runMatching(db: Queryable, householdId: string, ctx: MatchingContext): Promise<MatchingCounts> {
  const actor = ctx.actor ?? "matching";
  const counts: MatchingCounts = { duplicates: 0, bcNative: 0, pairs: 0, paychecks: 0, needsReceipt: 0, approved: 0, review: 0 };
  const rules = await listRules(db, householdId);
  const settings = await getSettings(db, householdId);
  const conn = await ledgerConnection(db, householdId);
  const autoPostOn = conn?.auto_post_enabled ?? false;
  const cats = await loadCategories(db, householdId);

  // 1. duplicates on fresh imports
  const fresh = await db.query<{ id: string }>("select id from transactions where household_id = $1 and state = 'imported' and not pending order by created_at", [householdId]);
  for (const { id } of fresh.rows) {
    const r = await detectPossibleDuplicate(db, householdId, await loadTx(db, id), actor);
    if (r.duplicateOf) counts.duplicates += 1;
  }
  // 2. BC-native payments
  const native = await matchBcNative(db, householdId, ctx.ledger, { rules, householdAutoPostOn: autoPostOn, actor });
  counts.bcNative = native.filter((n) => n.outcome === "reconciled").length;
  // 3. transfers and card payments
  const pairs = await pairTransfers(db, householdId, { rules, householdAutoPostOn: autoPostOn, actor });
  counts.pairs = pairs.length;
  // 4. paychecks
  const deposits = await db.query<{ id: string }>("select id from transactions where household_id = $1 and state = 'imported' and not pending and amount_cents > 0 and pair_id is null and kind = 'spend'", [householdId]);
  for (const { id } of deposits.rows) {
    const r = await detectPaycheck(db, householdId, await loadTx(db, id), actor);
    if (r) counts.paychecks += 1;
  }
  // 5. everything else still imported, plus items already waiting for classification
  const rest = await db.query<{ id: string }>(
    "select id from transactions where household_id = $1 and not pending and pair_id is null and kind in ('spend','income') and state in ('imported','needs_classification') order by posted_date, created_at",
    [householdId],
  );
  for (const { id } of rest.rows) {
    const tx = await loadTx(db, id);
    if (tx.state === "imported") {
      const nr = needsReceipt(tx.merchant_raw, tx.amount_cents);
      if (nr.required && tx.receipt_status !== "matched") {
        await transition(db, householdId, tx.id, "needs_receipt", "jobs", { actorId: actor, patch: { receipt_status: "needed", category_id: nr.unsplitCategory ?? null }, reason: "receipt-required merchant at $25 or more" });
        counts.needsReceipt += 1;
        continue;
      }
      await transition(db, householdId, tx.id, "needs_classification", "jobs", { actorId: actor, reason: "ready for the rule engine" });
    }
    const outcome = await classifyOne(db, householdId, await loadTx(db, tx.id), { rules, settings, autoPostOn, cats, actor, now: ctx.now });
    if (outcome === "approved") counts.approved += 1;
    else counts.review += 1;
  }
  return counts;
}

export interface ClassifyOneContext {
  rules: readonly RuleRow[];
  settings: HouseholdSettings;
  autoPostOn: boolean;
  cats: CategoryMap;
  actor: string;
  now?: Date | undefined;
}

/** Hours since the account's feed last synced (file-only accounts: since the newest import). */
export async function feedStaleHours(db: Queryable, householdId: string, accountId: string, now = new Date()): Promise<number> {
  const acct = await loadAccount(db, accountId);
  if (acct.feed_connection_id) {
    const r = await db.query<{ last_synced_at: string | null }>("select last_synced_at from feed_connections where id = $1", [acct.feed_connection_id]);
    const at = r.rows[0]?.last_synced_at;
    return at ? hoursBetween(at, now) : 0;
  }
  const r = await db.query<{ at: string | null }>("select max(created_at) as at from transactions where household_id = $1 and account_id = $2", [householdId, accountId]);
  return r.rows[0]?.at ? hoursBetween(r.rows[0].at, now) : 0;
}

/** Run the rule engine on one item in needs_classification. */
export async function classifyOne(db: Queryable, householdId: string, tx: TxRow, ctx: ClassifyOneContext): Promise<"approved" | "ready_for_review"> {
  if (tx.state !== "needs_classification") throw new Error(`classifyOne expects needs_classification, got ${tx.state}`);
  const acct = await loadAccount(db, tx.account_id);
  const history = await merchantHistory(db, householdId, tx.merchant_norm, 6, tx.id);
  const stale = await feedStaleHours(db, householdId, tx.account_id, ctx.now);
  const receiptPending = tx.receipt_status === "needed";
  const e = evaluateRules(
    ctx.rules,
    { merchantRaw: tx.merchant_raw, merchantNorm: tx.merchant_norm, amountCents: tx.amount_cents, accountId: tx.account_id, bcBankAccountCode: acct.bc_bank_account_code, businessFlag: tx.business_flag, receiptSplitPending: receiptPending, feedStaleHours: stale },
    ctx.cats,
    { settings: ctx.settings, householdAutoPostOn: ctx.autoPostOn, history },
  );
  // A matched receipt already wrote the splits; the rule engine only decides the tier for the confirmation.
  const hasSplits = (await db.query<{ n: number }>("select count(*)::int as n from transaction_splits where transaction_id = $1", [tx.id])).rows[0]!.n > 0;
  if (e.nextState === "approved" && e.categoryId) {
    const rule = ctx.rules.find((r) => r.id === e.ruleId);
    const batch = decideBatch(e, rule, ctx.autoPostOn, tx.receipt_status === "matched" ? "RECEIPTS" : "FEEDS");
    const opts: Parameters<typeof approveTransaction>[4] = { ruleId: e.ruleId!, confidence: e.confidence, batch, actorId: ctx.actor, reason: e.reason };
    if (!hasSplits) opts.categoryId = e.categoryId;
    await approveTransaction(db, householdId, tx.id, "rule_engine", opts);
    return "approved";
  }
  await transition(db, householdId, tx.id, "ready_for_review", "rule_engine", {
    actorId: ctx.actor,
    reason: e.reason,
    patch: { confidence: e.confidence, ...(e.ruleId ? { rule_id: e.ruleId } : {}), ...(!hasSplits && e.categoryId ? { category_id: e.categoryId } : {}) },
  });
  return "ready_for_review";
}
