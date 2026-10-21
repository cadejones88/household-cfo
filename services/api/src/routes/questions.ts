/**
 * /v1/questions — "Needs your answer" for the signed-in member, and the answer endpoint.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { hasFreshStepUp } from "../lib/auth.js";
import { idParam, inHousehold, parse, splitInput } from "../lib/http.js";
import { answerQuestion, listQuestions } from "../services/questions.js";
import { listApprovals, toApprovalDto } from "../services/approvals.js";
import { transactionsDataThrough } from "./transactions.js";

export default async function questionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/questions", async (req) =>
    inHousehold(req, async (db, p) => ({ questions: await listQuestions(db, p.householdId, p.memberId), dataThrough: await transactionsDataThrough(db, p.householdId, app.deps.now()) })),
  );

  app.post("/questions/:id/answer", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ optionId: z.string().min(1).max(100), categoryId: z.string().max(64).optional(), splits: z.array(splitInput).min(1).optional(), note: z.string().max(500).optional() }), req.body);
    return inHousehold(req, async (db, p) => {
      const r = await answerQuestion(db, p.householdId, p.memberId, id, { optionId: body.optionId, ...(body.categoryId ? { categoryId: body.categoryId } : {}), ...(body.splits ? { splits: body.splits } : {}), ...(body.note ? { note: body.note } : {}), stepUp: hasFreshStepUp(req) });
      const out: Record<string, unknown> = {};
      if (r.transaction) out["transaction"] = r.transaction;
      if (r.approvalId) {
        const a = (await listApprovals(db, p.householdId, "all")).find((x) => x.id === r.approvalId);
        if (a) out["approval"] = await toApprovalDto(db, p.householdId, a);
      }
      if (r.paycheckOutcome) out["paycheckOutcome"] = r.paycheckOutcome;
      const next = (await listQuestions(db, p.householdId, p.memberId))[0];
      if (next) out["nextQuestion"] = next;
      return out;
    });
  });
}
