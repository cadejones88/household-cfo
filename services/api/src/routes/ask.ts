/**
 * /v1/ask — Ask Homestead over the six read-only functions; /v1/ask/history — the member's last 90 days.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dateIsoInTz } from "../lib/dates.js";
import { inHousehold, parse } from "../lib/http.js";
import { ask, askHistory } from "../services/ask/orchestrate.js";
import { getHousehold } from "../services/households.js";

export default async function askRoutes(app: FastifyInstance): Promise<void> {
  app.post("/ask", async (req) => {
    const body = parse(z.object({ question: z.string().min(1).max(1000) }), req.body);
    return inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const now = app.deps.now();
      return ask({ db, householdId: p.householdId, memberId: p.memberId, ledger: app.deps.ledger, todayIso: dateIsoInTz(now, hh.timezone), now }, app.deps.askModel, body.question);
    });
  });

  app.get("/ask/history", async (req) => inHousehold(req, async (db, p) => ({ conversations: await askHistory(db, p.householdId, p.memberId) })));
}
