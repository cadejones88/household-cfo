/**
 * Approvals (spec: "Draft authority matrix"; A8): the other spouse decides, step-up is recorded on the row.
 *
 * - budget_move: Vanessa proposes, Cade approves with step-up (or the reverse); approval writes a budget_revisions
 *   row with the next revision number for the household's revision budget (never an `-ORIG` name) and an outbox
 *   row `write_budget_revision` that the BC worker sends through the HH App Connector.
 * - rule / auto_post_rule: the spouse who did not propose the rule approves it (step-up); an auto-post flag needs
 *   Cade's written approval in the note.
 * - business_flag: the other spouse confirms a business mark.
 * - settings: a settings change needs both spouses; the proposer's request plus the other's approval write the
 *   next household_setting_versions row.
 * - correction: a correction request after posting, decided by Cade (reverse and repost in BC).
 */
import { CATEGORIES, formatUsd, toBcDimensionSetLines, type Approval, type ApprovalKind, type DimensionSet } from "@homestead/shared";
import { audit, enqueueOutbox, type Queryable } from "../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { loadCategories } from "./categories.js";
import { getHousehold, listMembers, writeSettingsVersion, type HouseholdSettings } from "./households.js";
import { approveRule, retireRule } from "./rules.js";
import { correctTransaction } from "./transactions.js";

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  payload: Record<string, unknown>;
  requested_by: string;
  decided_by: string | null;
  decision: "approved" | "declined" | null;
  step_up_verified: boolean;
  requested_at: string;
  decided_at: string | null;
}

const COLS = "id, kind, payload, requested_by, decided_by, decision, step_up_verified, requested_at, decided_at";

export async function loadApproval(db: Queryable, id: string): Promise<ApprovalRow> {
  const r = await db.query<ApprovalRow>(`select ${COLS} from approvals where id = $1`, [id]);
  const row = r.rows[0];
  if (!row) throw notFound("approval");
  return row;
}

export async function listApprovals(db: Queryable, householdId: string, state: "open" | "decided" | "all" = "open"): Promise<ApprovalRow[]> {
  const where = state === "open" ? "and decided_by is null" : state === "decided" ? "and decided_by is not null" : "";
  const r = await db.query<ApprovalRow>(`select ${COLS} from approvals where household_id = $1 ${where} order by (decided_by is null) desc, requested_at desc limit 200`, [householdId]);
  return r.rows;
}

export async function toApprovalDto(db: Queryable, householdId: string, row: ApprovalRow): Promise<Approval> {
  const members = await listMembers(db, householdId);
  const dto: Approval = {
    id: row.id,
    kind: row.kind,
    payload: row.payload as Approval["payload"],
    requestedBy: row.requested_by,
    stepUpVerified: row.step_up_verified,
    requestedAt: new Date(row.requested_at).toISOString(),
    effect: effectOf(row),
  };
  const name = members.find((m) => m.id === row.requested_by)?.display_name;
  if (name) dto.requestedByName = name;
  if (row.decided_by) dto.decidedBy = row.decided_by;
  if (row.decision) dto.decision = row.decision;
  if (row.decided_at) dto.decidedAt = new Date(row.decided_at).toISOString();
  return dto;
}

function catName(id: unknown): string {
  return typeof id === "string" ? (CATEGORIES.find((c) => c.id === id)?.name ?? id) : "?";
}

/** Plain words for what approving does. */
export function effectOf(row: Pick<ApprovalRow, "kind" | "payload">): string {
  const p = row.payload;
  switch (row.kind) {
    case "budget_move":
      return `Moves ${formatUsd(Number(p["amountCents"] ?? 0))} from ${catName(p["fromCategoryId"])} to ${catName(p["toCategoryId"])} for ${String(p["month"] ?? "this month")}. The budget gets a new revision number in Business Central.`;
    case "rule":
      return `Turns on the rule "${String(p["name"] ?? "")}" so it can suggest a category.`;
    case "auto_post_rule":
      return `Lets the rule "${String(p["name"] ?? "")}" post to the books without a tap. Needs Cade's written note.`;
    case "business_flag":
      return `Marks this item as ${String(p["businessFlag"] ?? "business")} so it stays out of household spending.`;
    case "settings":
      return "Changes household settings; both of you must agree. A new settings version is recorded.";
    case "correction":
      return "Asks Cade to reverse and repost this item in Business Central with the corrected category.";
  }
}

// Requests ----------------------------------------------------------------------------------------

export interface BudgetMoveInput {
  fromCategoryId: string;
  toCategoryId: string;
  amountCents: number;
  month: string;
  note?: string;
}

export async function requestBudgetMove(db: Queryable, householdId: string, input: BudgetMoveInput, memberId: string): Promise<ApprovalRow> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw badRequest("amount", "The amount must be a positive number of cents");
  if (input.fromCategoryId === input.toCategoryId) throw badRequest("same_category", "Pick two different categories");
  const cats = await loadCategories(db, householdId);
  for (const id of [input.fromCategoryId, input.toCategoryId]) {
    const c = cats.get(id);
    if (!c) throw badRequest("category", `Unknown category ${id}`);
    if (c.is_transfer || c.group === "Income") throw badRequest("category", `${c.name} is not a spending category`);
  }
  const payload = { fromCategoryId: input.fromCategoryId, toCategoryId: input.toCategoryId, amountCents: input.amountCents, month: input.month, note: input.note ?? null };
  const r = await db.query<ApprovalRow>(`insert into approvals (household_id, kind, payload, requested_by) values ($1,'budget_move',$2,$3) returning ${COLS}`, [householdId, JSON.stringify(payload), memberId]);
  const row = r.rows[0]!;
  await audit(db, householdId, { actor: memberId, action: "approval.requested", entity: "approval", entityId: row.id, after: { kind: "budget_move", fromCategoryId: input.fromCategoryId, toCategoryId: input.toCategoryId, month: input.month } });
  return row;
}

export async function requestApproval(db: Queryable, householdId: string, kind: Exclude<ApprovalKind, "budget_move">, payload: Record<string, unknown>, memberId: string): Promise<ApprovalRow> {
  const r = await db.query<ApprovalRow>(`insert into approvals (household_id, kind, payload, requested_by) values ($1,$2,$3,$4) returning ${COLS}`, [householdId, kind, JSON.stringify(payload), memberId]);
  const row = r.rows[0]!;
  await audit(db, householdId, { actor: memberId, action: "approval.requested", entity: "approval", entityId: row.id, after: { kind } });
  return row;
}

// Decisions ---------------------------------------------------------------------------------------

export const STEP_UP_KINDS: ReadonlySet<ApprovalKind> = new Set(["budget_move", "rule", "auto_post_rule", "settings", "correction"]);

export interface DecideOptions {
  stepUp: boolean;
  note?: string;
}

export async function decideApproval(db: Queryable, householdId: string, approvalId: string, memberId: string, decision: "approved" | "declined", opts: DecideOptions): Promise<ApprovalRow> {
  const row = await loadApproval(db, approvalId);
  if (row.decided_by) throw conflict("already_decided", "This was already decided");
  if (row.requested_by === memberId) throw forbidden("other_spouse_decides", "The spouse who asked cannot decide it");
  if (STEP_UP_KINDS.has(row.kind) && !opts.stepUp) throw forbidden("step_up_required", "Confirm with Face ID (or your passcode) first");
  if (decision === "approved") await applyApproval(db, householdId, row, memberId, opts.note);
  await db.query("update approvals set decided_by = $2, decision = $3, step_up_verified = $4, decided_at = now() where id = $1", [approvalId, memberId, decision, opts.stepUp]);
  await audit(db, householdId, { actor: memberId, action: `approval.${decision}`, entity: "approval", entityId: approvalId, after: { kind: row.kind, stepUp: opts.stepUp, note: opts.note } });
  return loadApproval(db, approvalId);
}

async function applyApproval(db: Queryable, householdId: string, row: ApprovalRow, deciderId: string, note?: string): Promise<void> {
  const p = row.payload;
  switch (row.kind) {
    case "budget_move":
      await writeBudgetRevision(db, householdId, row, deciderId);
      return;
    case "rule":
    case "auto_post_rule": {
      const ruleId = String(p["ruleId"] ?? "");
      if (!ruleId) throw badRequest("rule_id", "The approval has no rule id");
      const o: { approvalNote?: string } = {};
      if (note) o.approvalNote = note;
      await approveRule(db, householdId, ruleId, deciderId, o);
      return;
    }
    case "business_flag": {
      const txId = String(p["transactionId"] ?? "");
      const flag = p["businessFlag"];
      if (!txId || (flag !== "none" && flag !== "ctj" && flag !== "lash")) throw badRequest("business_flag", "The approval has no transaction or flag");
      await correctTransaction(db, householdId, txId, { businessFlag: flag }, deciderId);
      return;
    }
    case "settings": {
      const hh = await getHousehold(db, householdId);
      const patch = (p["settings"] ?? p) as Partial<HouseholdSettings>;
      const next: HouseholdSettings = { ...hh.settings, ...patch };
      await writeSettingsVersion(db, householdId, next, [row.requested_by, deciderId], deciderId);
      return;
    }
    case "correction": {
      // The reversal and repost happen in BC under Cade's sign-in; the decision records that the request is accepted.
      if (typeof p["retireRuleId"] === "string") await retireRule(db, householdId, p["retireRuleId"], deciderId, "correction");
      return;
    }
  }
}

/** The next revision of the household's revision budget, written to BC by the worker (A8). ORIG is refused here and in BC. */
export async function writeBudgetRevision(db: Queryable, householdId: string, row: ApprovalRow, deciderId: string): Promise<{ revisionId: string; revisionNo: number; budgetName: string }> {
  const p = row.payload;
  const hh = await getHousehold(db, householdId);
  const budgetName = hh.settings.budget.revisionName;
  if (/-ORIG$/i.test(budgetName)) throw conflict("orig_refused", "The original budget is never changed; revisions go to the REV budget");
  const cats = await loadCategories(db, householdId);
  const from = cats.get(String(p["fromCategoryId"]));
  const to = cats.get(String(p["toCategoryId"]));
  if (!from || !to) throw badRequest("category", "Unknown category on the move");
  const amount = Number(p["amountCents"]);
  const month = String(p["month"]);
  const date = `${month}-01`;
  const next = await db.query<{ n: number }>("select coalesce(max(revision_no),0)::int + 1 as n from budget_revisions where household_id = $1 and bc_budget_name = $2", [householdId, budgetName]);
  const revisionNo = next.rows[0]!.n;
  const lines = [
    { account: from.gl_account, categoryId: from.id, dimensions: from.dimension_defaults as DimensionSet, period: month, amount_cents: -amount },
    { account: to.gl_account, categoryId: to.id, dimensions: to.dimension_defaults as DimensionSet, period: month, amount_cents: amount },
  ];
  const ins = await db.query<{ id: string }>("insert into budget_revisions (household_id, bc_budget_name, revision_no, lines, approval_id) values ($1,$2,$3,$4,$5) returning id", [householdId, budgetName, revisionNo, JSON.stringify(lines), row.id]);
  const revisionId = ins.rows[0]!.id;
  await enqueueOutbox(db, householdId, {
    aggregate: "budget_revision",
    aggregateId: revisionId,
    operation: "write_budget_revision",
    payload: {
      revisionId,
      budgetName,
      revisionNo,
      entries: lines.map((l) => ({ budgetName, glAccount: l.account, date, amountCents: l.amount_cents, dimensions: toBcDimensionSetLines(l.dimensions), description: String(revisionNo) })),
    },
  });
  await audit(db, householdId, { actor: deciderId, action: "budget.revision", entity: "budget_revision", entityId: revisionId, after: { budgetName, revisionNo, approvalId: row.id } });
  return { revisionId, revisionNo, budgetName };
}
