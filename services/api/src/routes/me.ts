/**
 * GET /v1/me — the signed-in member, both members of the household, the household (time zone, quiet hours, next
 * Henry's Fork payday, settings version) and the Business Central connection without any credential (for deep
 * links into BC). The phone app and the Console both start here.
 */
import type { FastifyInstance } from "fastify";
import type { MemberSummary } from "@homestead/shared";
import { dateIsoInTz } from "../lib/dates.js";
import { inHousehold } from "../lib/http.js";
import { nextPaydayFor } from "../services/bills.js";
import { getHousehold, ledgerConnection, listMembers } from "../services/households.js";

export default async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req) =>
    inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const members: MemberSummary[] = (await listMembers(db, p.householdId)).map((m) => ({ id: m.id, displayName: m.display_name, role: m.role }));
      const conn = await ledgerConnection(db, p.householdId);
      const today = dateIsoInTz(app.deps.now(), hh.timezone);
      const out: Record<string, unknown> = {
        member: { id: p.memberId, displayName: p.displayName, role: p.role },
        members,
        household: {
          id: hh.id,
          name: hh.name,
          timezone: hh.timezone,
          currency: hh.currency,
          settingsVersion: hh.settings_version,
          quietHours: hh.settings.quietHours,
          nextPayday: nextPaydayFor(hh.settings, today),
          today,
        },
      };
      if (conn) out["ledger"] = { tenantId: conn.bc_tenant_id, environment: conn.bc_environment, companyId: conn.bc_company_id, journalTemplate: conn.journal_template, autoPostEnabled: conn.auto_post_enabled };
      return out;
    }),
  );
}
