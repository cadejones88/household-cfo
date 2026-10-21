/**
 * /v1/console/* — the CFO Console's MVP six: work queues, BC sync and posting status with "post batch" (enqueue
 * only), reconciliation status, mappings, the authority matrix (read-only), connection health, logs and audit.
 * Plus: exception resolution, file import, alerts, settings, the outbox and a retry for dead letters.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest } from "../lib/errors.js";
import { idParam, inHousehold, parse, readMultipart, requireStepUp } from "../lib/http.js";
import { listAlerts, toAlertDto } from "../services/alerts.js";
import { importFile, listImportProfiles } from "../services/bankData/fileImport.js";
import { auditPage, connectionHealth, listOutbox, mappings, postingStatus, queues, reconciliationStatus, requestPostBatch, retryOutbox, settingsView, toOutboxItem } from "../services/console.js";
import { getHousehold } from "../services/households.js";
import { listReceipts, toReceiptSummary } from "../services/receipts/upload.js";
import { listRules } from "../services/rules.js";
import { resolveException } from "../services/transactions.js";
import { toRuleSummary } from "./rules.js";
import { loadTransactionDto } from "./transactions.js";

export default async function consoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/console/queues", async (req) =>
    inHousehold(req, async (db, p) => {
      const q = await queues(db, p.householdId, app.deps.now());
      const receipts = (await listReceipts(db, p.householdId, { limit: 100 })).filter((r) => r.kind === "receipt" && (r.ocr_status === "needs_review" || r.ocr_status === "failed" || (r.ocr_status === "read" && !r.matched_transaction_id))).map(toReceiptSummary);
      const rules = [];
      for (const r of await listRules(db, p.householdId, "proposed")) rules.push(await toRuleSummary(db, p.householdId, r));
      return { ...q, receipts, rules };
    }),
  );

  app.get("/console/sync", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }), req.query);
    return inHousehold(req, async (db, p) => {
      const runs = await db.query<{ id: string; kind: string; started_at: string; finished_at: string | null; status: string; counts: Record<string, number>; error: string | null }>("select id, kind, started_at, finished_at, status, counts, error from sync_runs where household_id = $1 order by started_at desc limit $2", [p.householdId, q.limit]);
      const health = await connectionHealth(db, p.householdId, app.deps.now());
      return {
        runs: runs.rows.map((r) => ({ id: r.id, kind: r.kind, startedAt: new Date(r.started_at).toISOString(), ...(r.finished_at ? { finishedAt: new Date(r.finished_at).toISOString() } : {}), status: r.status, counts: r.counts, ...(r.error ? { error: r.error } : {}) })),
        feeds: health.feeds,
      };
    });
  });

  app.get("/console/posting", async (req) => inHousehold(req, (db, p) => postingStatus(db, p.householdId)));

  app.post("/console/posting/post-batch", async (req, reply) => {
    requireStepUp(req);
    const body = parse(z.object({ batch: z.enum(["FEEDS", "RECEIPTS", "AUTOPOST"]) }), req.body);
    const r = await inHousehold(req, (db, p) => requestPostBatch(db, p.householdId, body.batch, p.memberId));
    return reply.code(202).send({ ...r, draftCount: r.lineCount });
  });

  app.get("/console/reconciliation", async (req) => inHousehold(req, (db, p) => reconciliationStatus(db, p.householdId)));

  app.get("/console/mappings", async (req) => inHousehold(req, (db, p) => mappings(db, p.householdId)));

  app.get("/console/authority-matrix", async (req) =>
    inHousehold(req, async (db, p) => {
      const hh = await getHousehold(db, p.householdId);
      const first = await db.query<{ approved_by: string[]; effective_from: string }>("select approved_by, effective_from from household_setting_versions where household_id = $1 and version = 1", [p.householdId]);
      const rules = await listRules(db, p.householdId);
      return {
        version: 1,
        rows: hh.settings.authorityMatrix,
        ...(first.rows[0] ? { approvedAt: new Date(first.rows[0].effective_from).toISOString(), approvedBy: first.rows[0].approved_by } : {}),
        settingsVersion: hh.settings_version,
        autoPostRules: rules.filter((r) => r.rule_no).map((r) => ({ ruleNo: r.rule_no, name: r.name, state: r.state, mayAutoPost: r.may_auto_post, ...(r.test_passed_at ? { testPassedAt: new Date(r.test_passed_at).toISOString() } : {}) })),
      };
    }),
  );

  app.get("/console/connections", async (req) => inHousehold(req, (db, p) => connectionHealth(db, p.householdId, app.deps.now())));

  app.get("/console/audit", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.string().datetime({ offset: true }).optional(), entity: z.string().max(60).optional(), entityId: z.string().max(100).optional() }), req.query);
    return inHousehold(req, (db, p) => auditPage(db, p.householdId, { limit: q.limit, ...(q.before ? { before: q.before } : {}), ...(q.entity ? { entity: q.entity } : {}), ...(q.entityId ? { entityId: q.entityId } : {}) }));
  });

  app.post("/console/exceptions/:id/resolve", async (req) => {
    requireStepUp(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ to: z.enum(["ready_for_review", "posted"]), entryNos: z.array(z.number().int()).optional(), documentNo: z.string().max(35).optional(), postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), note: z.string().max(1000).default("") }), req.body);
    return inHousehold(req, async (db, p) => {
      await resolveException(db, p.householdId, id, { to: body.to, note: body.note, ...(body.entryNos ? { entryNos: body.entryNos } : {}), ...(body.documentNo ? { documentNo: body.documentNo } : {}), ...(body.postingDate ? { postingDate: body.postingDate } : {}) }, p.memberId);
      return loadTransactionDto(db, p.householdId, id);
    });
  });

  app.post("/console/imports", async (req) => {
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest("file", "Attach the statement as the `file` part");
    const f = parse(z.object({ accountId: z.string().uuid(), profileName: z.string().min(1).max(120) }), fields);
    return inHousehold(req, (db, p) => importFile(db, p.householdId, { accountId: f.accountId, profileName: f.profileName, bytes: file.bytes, fileName: file.filename }, p.memberId, app.deps.docIntel));
  });

  app.get("/console/imports/profiles", async (req) => inHousehold(req, async (db, p) => ({ profiles: (await listImportProfiles(db, p.householdId)).map((x) => ({ name: x.name, institution: x.institution, format: x.format })) })));

  app.get("/console/alerts", async (req) => {
    const q = parse(z.object({ open: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return inHousehold(req, async (db, p) => ({ alerts: (await listAlerts(db, p.householdId, { openOnly: q.open, limit: q.limit })).map(toAlertDto) }));
  });

  app.get("/console/settings", async (req) => inHousehold(req, (db, p) => settingsView(db, p.householdId)));

  app.get("/console/outbox", async (req) => {
    const q = parse(z.object({ state: z.enum(["due", "dead", "done", "all"]).default("all"), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    return inHousehold(req, async (db, p) => ({ items: (await listOutbox(db, p.householdId, { state: q.state, limit: q.limit })).map(toOutboxItem) }));
  });

  app.post("/console/outbox/:id/retry", async (req) => {
    requireStepUp(req);
    const { id } = parse(idParam, req.params);
    return inHousehold(req, async (db, p) => toOutboxItem(await retryOutbox(db, p.householdId, id, p.memberId)));
  });
}
