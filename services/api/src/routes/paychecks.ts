/**
 * /v1/paychecks — list, one paycheck with its components, and the stub upload (PDF from Paychex or Gusto, or a
 * photo) that reads it with prebuilt-payStub.us and maps the components with the employer template.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { idParam, inHousehold, parse, readMultipart } from "../lib/http.js";
import { intakeStub, listPaychecks, loadPaycheck, paycheckSummary } from "../services/paychecks/index.js";
import { listQuestions } from "../services/questions.js";
import { uploadReceipt } from "../services/receipts/upload.js";

export default async function paychecksRoutes(app: FastifyInstance): Promise<void> {
  app.get("/paychecks", async (req) =>
    inHousehold(req, async (db, p) => {
      const rows = await listPaychecks(db, p.householdId);
      const paychecks = [];
      for (const r of rows) paychecks.push(await paycheckSummary(db, p.householdId, r));
      return { paychecks };
    }),
  );

  app.get("/paychecks/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return inHousehold(req, async (db, p) => paycheckSummary(db, p.householdId, await loadPaycheck(db, id)));
  });

  app.post("/paychecks/:id/stub", async (req) => {
    const { id } = parse(idParam, req.params);
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest("file", "Attach the stub as the `file` part");
    const f = parse(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/i) }), fields);
    return inHousehold(req, async (db, p) => {
      await loadPaycheck(db, id);
      const up = await uploadReceipt(db, p.householdId, p.memberId, { bytes: file.bytes, contentType: file.contentType, sha256: f.sha256, capturedAt: app.deps.now().toISOString(), kind: "pay_stub" }, app.deps.blobs);
      const r = await intakeStub(db, p.householdId, id, { bytes: file.bytes, contentType: file.contentType, receiptId: up.receipt.id }, { docIntel: app.deps.docIntel }, p.memberId);
      const questions = (await listQuestions(db, p.householdId, p.memberId)).filter((q) => q.kind === "paycheck_component" && q.id.startsWith(`pay:${id}:`));
      return { paycheck: await paycheckSummary(db, p.householdId, r.paycheck), outcome: r.outcome, unmapped: r.unmapped, questions };
    });
  });
}
