/**
 * /v1/goals — goals from BC FUND_GOAL balances with the targets from household settings.
 */
import type { FastifyInstance } from "fastify";
import { inHousehold } from "../lib/http.js";
import { listGoals } from "../services/goals.js";

export default async function goalsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/goals", async (req) => inHousehold(req, (db, p) => listGoals(db, p.householdId, app.deps.ledger, app.deps.now())));
}
