/**
 * /v1/bills — upcoming bills and minimums with whether each falls before the next Henry's Fork payday, and
 * /v1/safe-to-spend (also /v1/bills/safe-to-spend) — the safe-to-spend figure with every input it was computed from.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { dateIsoInTz } from "../lib/dates.js";
import { inHousehold, isoDate, parse } from "../lib/http.js";
import { upcomingBills } from "../services/bills.js";
import { getHousehold } from "../services/households.js";
import { computeSafeToSpend } from "../services/safeToSpend.js";

export default async function billsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/bills", async (req) => {
    const q = parse(z.object({ until: isoDate.optional() }), req.query);
    return inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const today = dateIsoInTz(app.deps.now(), hh.timezone);
      const r = await upcomingBills(db, p.householdId, today, q.until);
      return { bills: r.bills, nextPayday: r.nextPayday, dataThrough: { at: r.calendarVersionAt, quality: "posted_unreconciled", pendingCount: 0 } };
    });
  });

  const safeToSpendHandler = async (req: FastifyRequest) =>
    inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const today = dateIsoInTz(app.deps.now(), hh.timezone);
      return computeSafeToSpend(db, p.householdId, app.deps.ledger, today, app.deps.now());
    });
  app.get("/safe-to-spend", safeToSpendHandler);
  // The original path, kept so nothing that already calls it breaks.
  app.get("/bills/safe-to-spend", safeToSpendHandler);
}
