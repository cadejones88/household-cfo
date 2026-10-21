/**
 * /v1/alerts — the signed-in member's open alerts (both-spouse alerts plus the ones addressed to them), and a snooze
 * for an alert while an agreed action is pending (spec: "an alert goes quiet while an agreed action is pending and
 * reopens if the action is not taken by its date"). The Console's household-wide list is /v1/console/alerts.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db/index.js";
import { notFound } from "../lib/errors.js";
import { idParam, inHousehold, parse } from "../lib/http.js";
import { listAlerts, toAlertDto } from "../services/alerts.js";

export default async function alertsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/alerts", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    return inHousehold(req, async (db, p) => {
      const rows = await listAlerts(db, p.householdId, { openOnly: true, memberId: p.memberId, limit: q.limit });
      const now = app.deps.now();
      const newest = rows.reduce<string | undefined>((m, a) => {
        const at = new Date(a.created_at).toISOString();
        return !m || at > m ? at : m;
      }, undefined);
      return { alerts: rows.map(toAlertDto), dataThrough: { at: newest ?? now.toISOString(), quality: "imported_pending", pendingCount: rows.length } };
    });
  });

  app.post("/alerts/:id/snooze", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ until: z.string().datetime({ offset: true }), reason: z.string().max(300).optional() }), req.body);
    return inHousehold(req, async (db, p) => {
      const now = app.deps.now();
      const until = new Date(body.until);
      const max = new Date(now.getTime() + 14 * 86_400_000);
      const capped = until > max ? max : until;
      const r = await db.query<{ id: string; fingerprint: string }>(
        "update alerts set snoozed_until = $3 where id = $1 and household_id = $2 and resolved_at is null and (member_id is null or member_id = $4) returning id, fingerprint",
        [id, p.householdId, capped.toISOString(), p.memberId],
      );
      if (!r.rows[0]) throw notFound("alert");
      await audit(db, p.householdId, { actor: p.memberId, action: "alert.snoozed", entity: "alert", entityId: id, after: { until: capped.toISOString(), reason: body.reason } });
      const rows = await listAlerts(db, p.householdId, { openOnly: true, memberId: p.memberId, limit: 200 });
      const a = rows.find((x) => x.id === id);
      if (!a) throw notFound("alert");
      return toAlertDto(a);
    });
  });
}
