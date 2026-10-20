/**
 * Pairing (spec rules R2, R3, R7 and A2): a transfer, a card payment and a loan payment never show as spending.
 *
 * - Transfer: equal and opposite lines on two household deposit accounts within 2 days -> kind `transfer`,
 *   category transfer-own (115101), both sides linked by pair_id. Each side posts its own document through
 *   115101, so the clearing account nets to zero.
 * - Card payment: the bank side and the card side -> card-payment (115201), same linking.
 * - BC-native (R7): PennyMac and Frontier payments whose amount equals the scheduled bill are matched to BC's
 *   own bank ledger entries (the recurring journal) and go straight to Reconciled; the app never creates lines.
 */
import { withinTolerance, type Actor } from "@homestead/shared";
import { audit, type Queryable } from "../db/index.js";
import { addDays } from "../lib/dates.js";
import type { LedgerPort } from "./ledgerPort.js";
import { approveTransaction, loadAccount, loadTx, patchTx, transition, type TxRow } from "./transactions.js";
import { decideBatch, type RuleRow } from "./rules.js";

const PRE_APPROVAL = ["imported", "needs_classification", "ready_for_review"];
const LINKABLE = [...PRE_APPROVAL, "approved", "sent_to_bc", "bc_draft_created", "posted", "reconciled"];
const DEPOSIT_KINDS = new Set(["checking", "savings", "share", "wallet", "cash"]);
const CARD_KINDS = new Set(["card", "line"]);

export interface PairingContext {
  rules: readonly RuleRow[];
  householdAutoPostOn: boolean;
  actor?: string;
}

export interface PairResult {
  kind: "transfer" | "card_payment";
  outId: string;
  inId: string;
  state: "approved" | "ready_for_review";
  batch?: string;
}

/** Pair transfers and card payments among unpaired lines. */
export async function pairTransfers(db: Queryable, householdId: string, ctx: PairingContext): Promise<PairResult[]> {
  const actor = ctx.actor ?? "jobs";
  const outs = await db.query<{ id: string }>(
    "select id from transactions where household_id = $1 and amount_cents < 0 and pair_id is null and not pending and state = any($2) and kind in ('spend','transfer') and business_flag = 'none' order by posted_date",
    [householdId, PRE_APPROVAL],
  );
  const results: PairResult[] = [];
  for (const { id } of outs.rows) {
    const out = await loadTx(db, id);
    if (out.pair_id) continue;
    const outAcct = await loadAccount(db, out.account_id);
    const candidates = await db.query<{ id: string }>(
      `select id from transactions where household_id = $1 and account_id <> $2 and amount_cents = $3 and pair_id is null and not pending
         and state = any($4) and kind in ('spend','transfer','income') and business_flag = 'none'
         and posted_date between $5::date and $6::date
       order by abs(posted_date - $7::date) limit 5`,
      [householdId, out.account_id, -out.amount_cents, LINKABLE, addDays(out.posted_date, -2), addDays(out.posted_date, 2), out.posted_date],
    );
    for (const c of candidates.rows) {
      const inn = await loadTx(db, c.id);
      const inAcct = await loadAccount(db, inn.account_id);
      let kind: PairResult["kind"] | undefined;
      if (DEPOSIT_KINDS.has(outAcct.kind) && DEPOSIT_KINDS.has(inAcct.kind)) kind = "transfer";
      else if (DEPOSIT_KINDS.has(outAcct.kind) && CARD_KINDS.has(inAcct.kind)) kind = "card_payment";
      else if (CARD_KINDS.has(outAcct.kind) && DEPOSIT_KINDS.has(inAcct.kind)) kind = "transfer"; // cash advance to a deposit account
      if (!kind) continue;
      const r = await applyPair(db, householdId, out, inn, kind, ctx, actor);
      results.push(r);
      break;
    }
  }
  return results;
}

async function applyPair(db: Queryable, householdId: string, out: TxRow, inn: TxRow, kind: PairResult["kind"], ctx: PairingContext, actor: string): Promise<PairResult> {
  const categoryId = kind === "transfer" ? "transfer-own" : "card-payment";
  const ruleKind = kind === "transfer" ? "transfer" : "card_payment";
  const rule = ctx.rules.find((r) => r.kind === ruleKind && r.state !== "retired");
  const approvedRule = rule?.state === "approved" ? rule : undefined;
  await patchTx(db, householdId, out.id, { pair_id: inn.id, kind: "transfer", category_id: categoryId }, actor, "transaction.paired");
  await patchTx(db, householdId, inn.id, { pair_id: out.id, kind: "transfer", category_id: categoryId }, actor, "transaction.paired");
  let state: PairResult["state"] = "ready_for_review";
  let batch: string | undefined;
  for (const side of [out, inn]) {
    if (!PRE_APPROVAL.includes(side.state)) continue; // the other side was already handled by a person
    let current = side.state === "imported" ? await transition(db, householdId, side.id, "needs_classification", "jobs", { actorId: actor, reason: `${kind} pair` }) : await loadTx(db, side.id);
    if (current.state === "needs_classification") {
      if (approvedRule) {
        const mayAutoPost = Boolean(approvedRule.may_auto_post) && ctx.householdAutoPostOn;
        batch = decideBatch({ mayAutoPost, ruleApproved: true }, approvedRule, ctx.householdAutoPostOn, "FEEDS");
        current = await approveTransaction(db, householdId, side.id, "rule_engine", { categoryId, ruleId: approvedRule.id, confidence: 0.99, batch: batch as "FEEDS" | "AUTOPOST", actorId: actor, reason: `${approvedRule.name} (both sides present)` });
        state = "approved";
      } else {
        await transition(db, householdId, side.id, "ready_for_review", "rule_engine", { actorId: actor, patch: { confidence: 0.9, category_id: categoryId, ...(rule ? { rule_id: rule.id } : {}) }, reason: `${kind} pair; rule not approved yet` });
      }
    }
  }
  await audit(db, householdId, { actor, action: "transaction.pair", entity: "transaction", entityId: out.id, after: { kind, pairId: inn.id, state } });
  const result: PairResult = { kind, outId: out.id, inId: inn.id, state };
  if (batch) result.batch = batch;
  return result;
}

// BC-native -------------------------------------------------------------------------------------------

export interface BcNativeBill {
  id: string;
  name: string;
  amountCents: number;
  accountId: string | null;
}

export interface BcNativeResult {
  transactionId: string;
  billId: string;
  outcome: "reconciled" | "awaiting_bc_entry" | "needs_confirmation";
  bankLedgerEntryNo?: number;
}

export async function listBcNativeBills(db: Queryable, householdId: string): Promise<BcNativeBill[]> {
  const r = await db.query<{ id: string; name: string; amount_cents: number; account_id: string | null }>("select id, name, amount_cents::bigint::int as amount_cents, account_id from bills where household_id = $1 and is_bc_native", [householdId]);
  return r.rows.map((b) => ({ id: b.id, name: b.name, amountCents: b.amount_cents, accountId: b.account_id }));
}

function billMatches(bill: BcNativeBill, tx: TxRow): boolean {
  const words = bill.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !["minimum", "mortgage", "payment"].includes(w));
  const hit = words.some((w) => tx.merchant_norm.includes(w));
  return hit && Math.abs(tx.amount_cents) === bill.amountCents;
}

/**
 * Match PennyMac/Frontier payment lines to BC's recurring-journal bank entries. With R7 approved the line goes to
 * Reconciled by itself; otherwise it waits in `imported` (kind bc_native) for a person's one tap. A line whose
 * BC entry has not appeared stays `awaiting_bc_entry`.
 */
export async function matchBcNative(db: Queryable, householdId: string, ledger: LedgerPort, ctx: PairingContext): Promise<BcNativeResult[]> {
  const actor = ctx.actor ?? "jobs";
  const bills = await listBcNativeBills(db, householdId);
  if (bills.length === 0) return [];
  const rule = ctx.rules.find((r) => r.kind === "bc_native" && r.state !== "retired");
  const rows = await db.query<{ id: string }>("select id from transactions where household_id = $1 and amount_cents < 0 and not pending and state = 'imported' and pair_id is null order by posted_date", [householdId]);
  const results: BcNativeResult[] = [];
  for (const { id } of rows.rows) {
    const tx = await loadTx(db, id);
    const bill = bills.find((b) => billMatches(b, tx));
    if (!bill) continue;
    if (tx.kind !== "bc_native") await patchTx(db, householdId, tx.id, { kind: "bc_native", ...(rule ? { rule_id: rule.id } : {}) }, actor, "transaction.bc_native_candidate");
    const acct = await loadAccount(db, tx.account_id);
    const entries = acct.bc_bank_account_code
      ? await ledger.readBankLedgerEntries({ bankAccountCode: acct.bc_bank_account_code, postingDateFrom: addDays(tx.posted_date, -5), postingDateTo: addDays(tx.posted_date, 5) })
      : [];
    const entry = entries.find((e) => !e.reversed && e.amountCents === tx.amount_cents && !e.externalDocumentNo?.startsWith("HHAPP-"));
    if (!entry) {
      results.push({ transactionId: tx.id, billId: bill.id, outcome: "awaiting_bc_entry" });
      continue;
    }
    if (rule?.state === "approved") {
      await reconcileBcNative(db, householdId, tx.id, entry.entryNo, entry.externalDocumentNo, entry.documentNo, entry.postingDate, "rule_engine", actor, `${rule.name}: amount equals the scheduled ${bill.name}`);
      results.push({ transactionId: tx.id, billId: bill.id, outcome: "reconciled", bankLedgerEntryNo: entry.entryNo });
    } else {
      await patchTx(db, householdId, tx.id, { bc_bank_ledger_entry_no: entry.entryNo, confidence: 0.9 }, actor, "transaction.bc_native_found");
      results.push({ transactionId: tx.id, billId: bill.id, outcome: "needs_confirmation", bankLedgerEntryNo: entry.entryNo });
    }
  }
  return results;
}

/** imported -> reconciled with the keys on both sides; no HHAPP document exists, so BC's own is recorded. */
export async function reconcileBcNative(db: Queryable, householdId: string, txId: string, bankEntryNo: number, externalDocumentNo: string | undefined, documentNo: string | undefined, postingDate: string, who: Actor, actorId: string, reason: string): Promise<TxRow> {
  return transition(db, householdId, txId, "reconciled", who, {
    actorId,
    reason,
    patch: {
      kind: "bc_native",
      bc_bank_ledger_entry_no: bankEntryNo,
      bc_external_doc_no: externalDocumentNo || `BCNATIVE-${bankEntryNo}`,
      bc_document_no: documentNo ?? null,
      bc_posting_date: postingDate,
      sync_status: "in_sync",
      last_sync_at: new Date().toISOString(),
    },
  });
}

/** Loan-payment tolerance for a person's eye: the scheduled amount within $1. */
export function looksLikeScheduledPayment(amountCents: number, scheduledCents: number): boolean {
  return withinTolerance(Math.abs(amountCents), scheduledCents, { cents: 100 });
}
