/**
 * /v1/approvals — list (open first), open a non-budget approval, and decide one (the other spouse; step-up for
 * budget moves, rules, settings and corrections).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasFreshStepUp } from "../lib/auth.js";
import { idParam, inHousehold, parse } from "../lib/http.js";
import { decideApproval, listApprovals, requestApproval, toApprovalDto } from "../services/approvals.js";

export default async function approvalsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/approvals", async (req) => {
    const q = parse(z.object({ state: z.enum(["open", "decided", "all"]).default("open") }), req.query);
    return inHousehold(req, async (db, p) => {
      const rows = await listApprovals(db, p.householdId, q.state);
      const approvals = [];
      for (const r of rows) approvals.push(await toApprovalDto(db, p.householdId, r));
      return { approvals };
    });
  });

  app.post("/approvals", async (req, reply) => {
    const body = parse(z.object({ kind: z.enum(["settings", "business_flag", "correction", "rule", "auto_post_rule"]), payload: z.record(z.unknown()) }), req.body);
    const dto = await inHousehold(req, async (db, p) => toApprovalDto(db, p.householdId, await requestApproval(db, p.householdId, body.kind, body.payload, p.memberId)));
    return reply.code(201).send(dto);
  });

  app.post("/approvals/:id/decide", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ decision: z.enum(["approved", "declined"]), note: z.string().max(1000).optional() }), req.body);
    return inHousehold(req, async (db, p) => toApprovalDto(db, p.householdId, await decideApproval(db, p.householdId, id, p.memberId, body.decision, { stepUp: hasFreshStepUp(req), ...(body.note ? { note: body.note } : {}) })));
  });
}
