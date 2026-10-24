/**
 * /v1/rules — the rule register: list, propose (a new rule or a new version), approve (the spouse who did not
 * propose it, step-up; an auto-post flag needs Cade's written note unless the rule is approved for sorting only,
 * which turns the flag off), retire (step-up).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RuleSummary } from "@homestead/shared";
import { idParam, inHousehold, parse, requireStepUp } from "../lib/http.js";
import { approveRule, listRules, proposeRule, retireRule, type RuleRow } from "../services/rules.js";
import { listMembers } from "../services/households.js";
import type { Queryable } from "../db/index.js";

const ruleMatch = z
  .object({
    merchantPattern: z.string().max(200).optional(),
    merchantNorm: z.string().max(200).optional(),
    merchants: z.array(z.object({ pattern: z.string().max(200), categoryId: z.string().max(64).optional(), billName: z.string().max(120).optional() })).max(50).optional(),
    accountId: z.string().uuid().optional(),
    bcBankAccountCode: z.string().max(20).optional(),
    band: z.object({ minCents: z.number().int().min(0), maxCents: z.number().int().min(0) }).optional(),
    cadence: z.enum(["weekly", "biweekly", "monthly", "annual", "any"]).optional(),
    tolerance: z.object({ cents: z.number().int().min(0).optional(), fraction: z.number().min(0).max(1).optional() }).optional(),
    maxCents: z.number().int().min(0).optional(),
    minApprovedCount: z.number().int().min(1).optional(),
    windowMonths: z.number().int().min(1).max(24).optional(),
    direction: z.enum(["in", "out", "any"]).optional(),
    standingAmountCents: z.number().int().min(0).nullable().optional(),
    billId: z.string().uuid().optional(),
    requires: z.array(z.string().max(80)).max(20).optional(),
  })
  .strict();

const ruleAction = z
  .object({
    categoryId: z.string().max(64).optional(),
    kind: z.enum(["spend", "income", "transfer", "loan_payment", "paycheck", "bc_native"]).optional(),
    dims: z.record(z.string()).optional(),
    businessFlag: z.enum(["none", "ctj", "lash"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export async function toRuleSummary(db: Queryable, householdId: string, r: RuleRow): Promise<RuleSummary & { approvalNote?: string; supersedesRuleId?: string }> {
  const members = await listMembers(db, householdId);
  const stats = await db.query<{ fired: number; corrected: number }>(
    `select count(*)::int as fired,
            count(*) filter (where exists (select 1 from audit_log a where a.entity = 'transaction' and a.entity_id = t.id::text and a.action in ('transaction.correction','transaction.correction_before_posting','correction.requested')))::int as corrected
       from transactions t where t.household_id = $1 and t.rule_id = $2`,
    [householdId, r.id],
  );
  const dto: RuleSummary & { approvalNote?: string; supersedesRuleId?: string } = {
    id: r.id,
    kind: r.kind,
    name: r.name,
    match: r.match as Record<string, unknown>,
    action: r.action as Record<string, unknown>,
    mayAutoPost: r.may_auto_post,
    state: r.state,
    proposedBy: r.proposed_by,
    version: r.version,
    stats: { fired: stats.rows[0]?.fired ?? 0, corrected: stats.rows[0]?.corrected ?? 0 },
  };
  if (r.rule_no) dto.ruleNo = r.rule_no;
  const name = r.proposed_by === "system" ? "Homestead" : members.find((m) => m.id === r.proposed_by)?.display_name;
  if (name) dto.proposedByName = name;
  if (r.approved_by) dto.approvedBy = r.approved_by;
  if (r.approved_at) dto.approvedAt = new Date(r.approved_at).toISOString();
  if (r.approval_note) dto.approvalNote = r.approval_note;
  if (r.effective_from) dto.effectiveFrom = r.effective_from;
  if (r.test_passed_at) dto.testPassedAt = new Date(r.test_passed_at).toISOString();
  if (r.supersedes_rule_id) dto.supersedesRuleId = r.supersedes_rule_id;
  return dto;
}

export default async function rulesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/rules", async (req) => {
    const q = parse(z.object({ state: z.enum(["proposed", "approved", "retired", "all"]).default("all") }), req.query);
    return inHousehold(req, async (db, p) => {
      const rows = await listRules(db, p.householdId, q.state === "all" ? undefined : q.state);
      const rules = [];
      for (const r of rows) rules.push(await toRuleSummary(db, p.householdId, r));
      return { rules };
    });
  });

  app.post("/rules", async (req, reply) => {
    const body = parse(
      z.object({
        kind: z.enum(["merchant", "transfer", "card_payment", "recurring_bill", "paycheck", "loan_payment", "bc_native", "small_merchant"]),
        name: z.string().min(1).max(120),
        match: ruleMatch,
        action: ruleAction,
        mayAutoPost: z.boolean().default(false),
        supersedesRuleId: z.string().uuid().optional(),
        ruleNo: z.string().max(10).optional(),
      }),
      req.body,
    );
    const dto = await inHousehold(req, async (db, p) => {
      const row = await proposeRule(db, p.householdId, { kind: body.kind, name: body.name, match: body.match as Parameters<typeof proposeRule>[2]["match"], action: body.action as Parameters<typeof proposeRule>[2]["action"], mayAutoPost: body.mayAutoPost, ...(body.supersedesRuleId ? { supersedesRuleId: body.supersedesRuleId } : {}), ...(body.ruleNo ? { ruleNo: body.ruleNo } : {}) }, p.memberId);
      return toRuleSummary(db, p.householdId, row);
    });
    return reply.code(201).send(dto);
  });

  app.post("/rules/:id/approve", async (req) => {
    requireStepUp(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ approvalNote: z.string().max(2000).optional(), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), classifyOnly: z.boolean().optional() }).default({}), req.body ?? {});
    return inHousehold(req, async (db, p) =>
      toRuleSummary(db, p.householdId, await approveRule(db, p.householdId, id, p.memberId, { ...(body.approvalNote ? { approvalNote: body.approvalNote } : {}), ...(body.effectiveFrom ? { effectiveFrom: body.effectiveFrom } : {}), ...(body.classifyOnly ? { classifyOnly: true } : {}) })),
    );
  });

  app.post("/rules/:id/retire", async (req) => {
    requireStepUp(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ reason: z.string().max(500).optional() }).default({}), req.body ?? {});
    return inHousehold(req, async (db, p) => toRuleSummary(db, p.householdId, await retireRule(db, p.householdId, id, p.memberId, body.reason)));
  });
}
