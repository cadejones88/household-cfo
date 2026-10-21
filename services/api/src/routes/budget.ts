/**
 * /v1/budget — budget status for a month (sample until an approved budget is in BC) and a proposed budget move.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dateIsoInTz } from "../lib/dates.js";
import { cents, inHousehold, month, parse } from "../lib/http.js";
import { requestBudgetMove, toApprovalDto } from "../services/approvals.js";
import { budgetStatus } from "../services/budget.js";
import { getHousehold } from "../services/households.js";

export default async function budgetRoutes(app: FastifyInstance): Promise<void> {
  app.get("/budget", async (req) => {
    const q = parse(z.object({ month: month.optional() }), req.query);
    return inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const today = dateIsoInTz(app.deps.now(), hh.timezone);
      return budgetStatus(db, p.householdId, app.deps.ledger, q.month ?? today.slice(0, 7), today);
    });
  });

  app.post("/budget/moves", async (req, reply) => {
    const body = parse(z.object({ fromCategoryId: z.string().min(1).max(64), toCategoryId: z.string().min(1).max(64), amountCents: cents.positive(), month: month.optional(), note: z.string().max(500).optional() }), req.body);
    const dto = await inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const m = body.month ?? dateIsoInTz(app.deps.now(), hh.timezone).slice(0, 7);
      const row = await requestBudgetMove(db, p.householdId, { fromCategoryId: body.fromCategoryId, toCategoryId: body.toCategoryId, amountCents: body.amountCents, month: m, ...(body.note ? { note: body.note } : {}) }, p.memberId);
      return toApprovalDto(db, p.householdId, row);
    });
    return reply.code(201).send(dto);
  });
}
