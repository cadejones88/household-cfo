/**
 * "Needs your answer" (Phase 1 Household Home function 3): the short queue of items that need a person's
 * judgment, phrased in plain words with a `why`. Answers apply through the state machine; only approved answers
 * are learned from (the rule proposer reads approved classifications, never declined or pending ones).
 *
 * Question ids: `tx:<transaction id>` for transaction questions, `apr:<approval id>` for approvals and
 * `pay:<paycheck id>:<n>` for an unmapped pay-stub line.
 */
import { formatUsd, tierOf, type Question, type TransactionSplit } from "@homestead/shared";
import type { Queryable } from "../db/index.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { decideApproval, listApprovals, toApprovalDto, type ApprovalRow } from "./approvals.js";
import { loadCategories, type CategoryMap } from "./categories.js";
import { resolveDuplicate } from "./duplicates.js";
import { answerComponent, applyTemplateToPaycheck, assertComponentKind, listEmployers, listPaychecks, type UnmappedLine } from "./paychecks/index.js";
import { approveTransaction, loadSplits, loadTx, setSplits, splitDto, toTransactionDto, transition, type SplitInput, type TxRow } from "./transactions.js";
import type { PayStubRead } from "./receipts/documentIntelligence.js";

const QUEUE_STATES = ["possible_duplicate", "needs_receipt", "ready_for_review"];

function catOptions(cats: CategoryMap, limit = 8, preferGroup?: string): Question["options"] {
  const visible = [...cats.values()].filter((c) => c.household_visible && !c.is_transfer && c.group !== "Income" && c.group !== "Unsplit" && c.group !== "Suspense");
  visible.sort((a, b) => Number(b.group === preferGroup) - Number(a.group === preferGroup) || a.name.localeCompare(b.name));
  return visible.slice(0, limit).map((c) => ({ id: `category:${c.id}`, label: c.name, categoryId: c.id }));
}

/** The question for one transaction in a queue state, or undefined if it is waiting on a job rather than a person. */
export function questionForTransaction(tx: TxRow, splits: readonly TransactionSplit[], cats: CategoryMap, employerDeposit: boolean): Question | undefined {
  const base = { id: `tx:${tx.id}`, transactionId: tx.id, amountCents: tx.amount_cents, merchant: tx.merchant_raw, date: tx.posted_date, createdAt: new Date(tx.updated_at).toISOString() };
  const amount = formatUsd(Math.abs(tx.amount_cents));
  const merchant = tx.merchant_raw || "this item";
  const cat = tx.category_id ? cats.get(tx.category_id) : undefined;
  switch (tx.state) {
    case "possible_duplicate":
      return {
        ...base,
        kind: "possible_duplicate",
        prompt: `Is this ${amount} at ${merchant} a repeat?`,
        why: "The same amount on the same account showed up twice within three days from two sources. If it is the same purchase, we drop one so it never counts twice.",
        options: [
          { id: "not_repeat", label: "No, it is a separate purchase" },
          { id: "same_thing", label: "Yes, same thing" },
        ],
        defaultOptionId: "same_thing",
      };
    case "needs_receipt":
      if (employerDeposit) {
        return {
          ...base,
          kind: "needs_receipt",
          prompt: `Paycheck of ${amount} needs its stub`,
          why: "Each paycheck posts by component (wages, taxes, deductions) so the year ties to the W-2. Forward the stub PDF, or let the last stub's breakdown stand in as an estimate.",
          options: [
            { id: "later", label: "I will send the stub" },
            { id: "no_receipt", label: "Use the last stub as an estimate" },
          ],
          defaultOptionId: "later",
        };
      }
      return {
        ...base,
        kind: "needs_receipt",
        prompt: `Got a receipt for ${amount} at ${merchant}?`,
        why: "Walmart, club and Amazon trips mix groceries with everything else. The receipt splits it by line; without one it goes to a single catch-all that BC spreads out monthly.",
        options: [
          { id: "later", label: "I will snap it" },
          { id: "no_receipt", label: "No receipt; use the estimate" },
        ],
        defaultOptionId: "later",
      };
    case "ready_for_review": {
      const tier = tx.confidence !== null && tx.confidence !== undefined ? tierOf(Number(tx.confidence)) : "low";
      if (splits.length > 1 || (tx.receipt_status === "matched" && splits.length >= 1)) {
        return {
          ...base,
          kind: "confirm_split",
          prompt: `Does this split of ${amount} at ${merchant} look right?`,
          why: "The receipt was read line by line and tax was spread across the lines. One tap files it; edit if a line landed in the wrong place.",
          options: [
            { id: "confirm", label: "Looks right" },
            { id: "edit", label: "Change a line" },
          ],
          defaultOptionId: "confirm",
          splits,
        };
      }
      if (cat && tier === "medium") {
        return {
          ...base,
          kind: "confirm_category",
          prompt: `${amount} at ${merchant}: ${cat.name}?`,
          why: "We are fairly sure but not certain. One tap confirms it, and after a few confirmations we will propose a rule so you are not asked again.",
          options: [{ id: "confirm", label: `Yes, ${cat.name}`, categoryId: cat.id }, ...catOptions(cats, 5, cat.group).filter((o) => o.categoryId !== cat.id)],
          defaultOptionId: "confirm",
        };
      }
      return {
        ...base,
        kind: "pick_category",
        prompt: `Where does ${amount} at ${merchant} go?`,
        why: cat ? `Our best guess is ${cat.name}, but we are not sure enough to file it without you.` : "We have not seen this merchant before. Pick the closest category and we will remember it.",
        options: cat ? [{ id: "confirm", label: cat.name, categoryId: cat.id }, ...catOptions(cats, 7, cat.group).filter((o) => o.categoryId !== cat.id)] : catOptions(cats, 8),
        ...(cat ? { defaultOptionId: "confirm" } : {}),
      };
    }
    default:
      return undefined;
  }
}

export function questionForApproval(a: ApprovalRow, requestedByName: string | undefined, effect: string): Question | undefined {
  const who = requestedByName ?? "Your spouse";
  const base = { id: `apr:${a.id}`, approvalId: a.id, createdAt: new Date(a.requested_at).toISOString() };
  if (a.kind === "budget_move") {
    return {
      ...base,
      kind: "approve_budget_move",
      prompt: `${who} wants to move ${formatUsd(Number(a.payload["amountCents"] ?? 0))} in the budget`,
      why: effect,
      options: [
        { id: "approve", label: "Approve (Face ID)" },
        { id: "decline", label: "Not now" },
      ],
      amountCents: Number(a.payload["amountCents"] ?? 0),
    };
  }
  if (a.kind === "rule" || a.kind === "auto_post_rule") {
    return {
      ...base,
      kind: "approve_rule",
      prompt: `${who} proposed a rule: ${String(a.payload["name"] ?? "")}`,
      why: effect,
      options: [
        { id: "approve", label: "Approve (Face ID)" },
        { id: "decline", label: "Decline" },
      ],
    };
  }
  return undefined;
}

/** The queue for one member: transaction questions (both spouses), approvals (the other spouse), stub lines (the employee). */
export async function listQuestions(db: Queryable, householdId: string, memberId: string): Promise<Question[]> {
  const cats = await loadCategories(db, householdId);
  const employers = await listEmployers(db, householdId);
  const out: Question[] = [];
  // Items with a recorded exception reason (for example a line the bank removed) wait for Cade, not the household.
  const txs = await db.query<{ id: string }>("select id from transactions where household_id = $1 and not pending and state = any($2) and exception_reason is null order by updated_at asc limit 100", [householdId, QUEUE_STATES]);
  for (const { id } of txs.rows) {
    const tx = await loadTx(db, id);
    const employerDeposit = tx.kind === "paycheck";
    if (employerDeposit) {
      const emp = employers.find((e) => new RegExp(e.descriptor_pattern, "i").test(tx.merchant_raw));
      if (emp && emp.member_id !== memberId) continue; // the stub is the employee's to send
    }
    const splits = (await loadSplits(db, id)).map(splitDto);
    const q = questionForTransaction(tx, splits, cats, employerDeposit);
    if (q) out.push(q);
  }
  for (const a of await listApprovals(db, householdId, "open")) {
    if (a.requested_by === memberId) continue;
    const dto = await toApprovalDto(db, householdId, a);
    const q = questionForApproval(a, dto.requestedByName, dto.effect ?? "");
    if (q) out.push(q);
  }
  for (const p of await listPaychecks(db, householdId, 20)) {
    if (p.member_id !== memberId || !p.stub_receipt_id) continue;
    const r = await db.query<{ ocr_status: string; ocr_result: (PayStubRead & { unmapped?: UnmappedLine[] }) | null }>("select ocr_status, ocr_result from receipts where id = $1", [p.stub_receipt_id]);
    const rec = r.rows[0];
    if (rec?.ocr_status !== "needs_review" || !rec.ocr_result?.unmapped?.length) continue;
    rec.ocr_result.unmapped.forEach((u, i) => {
      out.push({
        id: `pay:${p.id}:${i}`,
        kind: "paycheck_component",
        prompt: `On the ${p.pay_date} stub, what is "${u.label}" (${formatUsd(u.amountCents)})?`,
        why: "Each stub line posts to its own account. Once you tell us, the employer template remembers it for every future stub.",
        options: componentOptions(u.section),
        amountCents: u.amountCents,
        date: p.pay_date,
        createdAt: new Date(p.created_at).toISOString(),
      });
    });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

function componentOptions(section: UnmappedLine["section"]): Question["options"] {
  if (section === "earnings") return [{ id: "kind:regular", label: "Regular pay" }, { id: "kind:bonus", label: "Bonus" }, { id: "kind:overtime", label: "Overtime" }];
  if (section === "taxes") return [{ id: "kind:fit", label: "Federal income tax" }, { id: "kind:state_tax", label: "Idaho income tax" }, { id: "kind:social_security", label: "Social Security" }, { id: "kind:medicare", label: "Medicare" }];
  return [{ id: "kind:benefit", label: "Insurance or benefit premium" }, { id: "kind:other_deduction", label: "Other deduction" }];
}

// Answers -------------------------------------------------------------------------------------------

export interface AnswerInput {
  optionId: string;
  categoryId?: string;
  splits?: readonly SplitInput[];
  note?: string;
  stepUp: boolean;
}

export interface AnswerResult {
  transaction?: ReturnType<typeof toTransactionDto>;
  approvalId?: string;
  paycheckOutcome?: string;
}

export async function answerQuestion(db: Queryable, householdId: string, memberId: string, questionId: string, input: AnswerInput): Promise<AnswerResult> {
  const [prefix, id, rest] = questionId.split(":");
  if (prefix === "tx" && id) return answerTransaction(db, householdId, memberId, id, input);
  if (prefix === "apr" && id) {
    const decision = input.optionId === "approve" ? "approved" : input.optionId === "decline" ? "declined" : undefined;
    if (!decision) throw badRequest("option", "Answer with approve or decline");
    const o: Parameters<typeof decideApproval>[5] = { stepUp: input.stepUp };
    if (input.note) o.note = input.note;
    const row = await decideApproval(db, householdId, id, memberId, decision, o);
    return { approvalId: row.id };
  }
  if (prefix === "pay" && id && rest !== undefined) {
    const kind = input.optionId.startsWith("kind:") ? assertComponentKind(input.optionId.slice(5)) : undefined;
    if (!kind) throw badRequest("option", "Answer with kind:<component kind>");
    const p = (await listPaychecks(db, householdId, 50)).find((x) => x.id === id);
    if (!p?.stub_receipt_id) throw notFound("paycheck");
    const r = await db.query<{ ocr_result: { unmapped?: UnmappedLine[] } | null }>("select ocr_result from receipts where id = $1", [p.stub_receipt_id]);
    const line = r.rows[0]?.ocr_result?.unmapped?.[Number(rest)];
    if (!line) throw notFound("stub line");
    const res = await answerComponent(db, householdId, id, line.label, kind, memberId);
    return { paycheckOutcome: res.outcome };
  }
  throw notFound("question");
}

async function answerTransaction(db: Queryable, householdId: string, memberId: string, txId: string, input: AnswerInput): Promise<AnswerResult> {
  const tx = await loadTx(db, txId, true);
  const done = async () => ({ transaction: toTransactionDto(await loadTx(db, txId), await loadSplits(db, txId)) });
  const chosenCategory = input.categoryId ?? (input.optionId.startsWith("category:") ? input.optionId.slice(9) : undefined);
  switch (tx.state) {
    case "possible_duplicate": {
      if (input.optionId !== "not_repeat" && input.optionId !== "same_thing") throw badRequest("option", "Answer with not_repeat or same_thing");
      await resolveDuplicate(db, householdId, txId, input.optionId, "member", memberId);
      return done();
    }
    case "needs_receipt": {
      if (input.optionId === "later") return done();
      if (input.optionId !== "no_receipt") throw badRequest("option", "Answer with no_receipt or later");
      await applyEstimatedSplit(db, householdId, tx, memberId);
      return done();
    }
    case "needs_classification": {
      // Not a household question (the rule engine has not run yet), but Cade may classify it by hand in the Console.
      if (!chosenCategory && !input.splits?.length) throw badRequest("option", "Answer with category:<id> or splits");
      await transition(db, householdId, txId, "ready_for_review", "rule_engine", { actorId: memberId, reason: "classified by hand" });
      if (input.splits?.length) await setSplits(db, householdId, txId, input.splits, memberId);
      await approveTransaction(db, householdId, txId, "member", { ...(chosenCategory && !input.splits?.length ? { categoryId: chosenCategory } : {}), actorId: memberId, reason: "classified by hand" });
      return done();
    }
    case "ready_for_review": {
      if (input.optionId === "edit" || input.splits) {
        if (!input.splits?.length) throw badRequest("splits", "Send the corrected lines with edit");
        await setSplits(db, householdId, txId, input.splits, memberId);
        await approveTransaction(db, householdId, txId, "member", { actorId: memberId, reason: "split edited and approved" });
        return done();
      }
      if (input.optionId === "confirm") {
        if (!tx.category_id && (await loadSplits(db, txId)).length === 0) throw badRequest("category_required", "Pick a category first");
        await approveTransaction(db, householdId, txId, "member", { actorId: memberId, reason: "confirmed" });
        return done();
      }
      if (chosenCategory) {
        await approveTransaction(db, householdId, txId, "member", { categoryId: chosenCategory, actorId: memberId, reason: "category picked" });
        return done();
      }
      throw badRequest("option", "Answer with confirm, edit or category:<id>");
    }
    default:
      throw conflict("not_a_question", "This item is not waiting for an answer");
  }
}

/**
 * No receipt: the estimated split (spec: "No receipt after 10 days") applied now at the member's request. The line
 * takes the unallocated category, goes to review with the category set, and the member's answer approves it.
 */
export async function applyEstimatedSplit(db: Queryable, householdId: string, tx: TxRow, actorId: string): Promise<TxRow> {
  if (tx.state !== "needs_receipt") throw conflict("not_needs_receipt", "This item is not waiting for a receipt");
  if (tx.kind === "paycheck") {
    // A paycheck's estimate is the employer template (the last stub's ratios), applied now instead of after 3 days.
    const p = await db.query<{ id: string }>("select id from paychecks where household_id = $1 and transaction_id = $2", [householdId, tx.id]);
    const paycheckId = p.rows[0]?.id;
    if (!paycheckId) throw conflict("no_paycheck", "No paycheck record for this deposit");
    await applyTemplateToPaycheck(db, householdId, paycheckId, actorId);
    return loadTx(db, tx.id);
  }
  const categoryId = tx.category_id ?? "uncategorized";
  await transition(db, householdId, tx.id, "needs_classification", "jobs", { actorId, reason: "no receipt: estimated split", patch: { receipt_status: "estimated" } });
  await transition(db, householdId, tx.id, "ready_for_review", "rule_engine", { actorId, reason: "estimated split needs one tap", patch: { confidence: 0.9, ...(categoryId ? { category_id: categoryId } : {}) } });
  return approveTransaction(db, householdId, tx.id, "member", { categoryId, actorId, reason: "estimated split accepted" });
}
