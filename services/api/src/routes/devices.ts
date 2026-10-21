/**
 * POST /v1/devices/push-token — register the phone's Expo push token for the signed-in member.
 * POST /v1/export — request the complete human-readable export (either spouse, step-up); the export job builds
 * the archive and the request is audited. Nothing here reads another member's devices.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit } from "../db/index.js";
import { inHousehold, parse, requireStepUp } from "../lib/http.js";

export default async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/devices/push-token", async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(1).max(300), platform: z.enum(["ios", "android"]), deviceName: z.string().max(100).optional() }), req.body);
    await inHousehold(req, async (db, p) => {
      await db.query(
        "insert into member_devices (household_id, member_id, platform, push_token, device_name) values ($1,$2,$3,$4,$5) on conflict (household_id, member_id, push_token) do update set platform = excluded.platform, device_name = excluded.device_name",
        [p.householdId, p.memberId, body.platform, body.token, body.deviceName ?? null],
      );
      await audit(db, p.householdId, { actor: p.memberId, action: "device.registered", entity: "member", entityId: p.memberId, after: { platform: body.platform } });
    });
    return reply.code(204).send();
  });

  app.post("/export", async (req, reply) => {
    requireStepUp(req);
    const id = await inHousehold(req, async (db, p) => {
      const r = await db.query<{ id: string }>("insert into outbox (household_id, aggregate, aggregate_id, operation, payload) values ($1,'household',$1,'export_household',$2) returning id", [p.householdId, JSON.stringify({ requestedBy: p.memberId, requestedAt: app.deps.now().toISOString() })]);
      await audit(db, p.householdId, { actor: p.memberId, action: "export.requested", entity: "household", entityId: p.householdId, after: { outboxId: r.rows[0]!.id } });
      return r.rows[0]!.id;
    });
    return reply.code(202).send({ requestId: id, status: "requested", message: "Your export is being prepared. You will get a time-limited link when it is ready." });
  });
}
