/**
 * /v1/receipts — multipart upload with the device's SHA-256, capturedAt and offline id; list; detail with the
 * proposed split; Amazon order-email intake; Console match of an ambiguous receipt.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { badRequest, notFound } from "../lib/errors.js";
import { idParam, inHousehold, parse, readMultipart } from "../lib/http.js";
import { intakeAmazonEmail } from "../services/receipts/amazonEmail.js";
import { matchReceiptManually, matchReceiptToTransaction, readReceipt, receiptDetail } from "../services/receipts/pipeline.js";
import { listReceipts, loadReceipt, toReceiptSummary, uploadReceipt } from "../services/receipts/upload.js";
import { intakeStub, loadPaycheck } from "../services/paychecks/index.js";
import { listQuestions } from "../services/questions.js";
import { loadTransactionDto } from "./transactions.js";

export default async function receiptsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/receipts", async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), status: z.enum(["queued", "read", "failed", "needs_review"]).optional(), unmatched: z.coerce.boolean().optional() }), req.query);
    return inHousehold(req, async (db, p) => ({ receipts: (await listReceipts(db, p.householdId, { limit: q.limit, ...(q.status ? { ocrStatus: q.status } : {}), ...(q.unmatched ? { unmatchedOnly: true } : {}) })).map(toReceiptSummary) }));
  });

  app.post("/receipts", async (req, reply) => {
    const { file, fields } = await readMultipart(req);
    if (!file) throw badRequest("file", "Attach the image as the `file` part");
    const f = parse(
      z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/i), capturedAt: z.string().datetime({ offset: true }), offlineId: z.string().max(100).optional(), kind: z.enum(["receipt", "pay_stub"]).default("receipt"), paycheckId: z.string().uuid().optional() }),
      fields,
    );
    const { summary, created, questions } = await inHousehold(req, async (db, p) => {
      const r = await uploadReceipt(db, p.householdId, p.memberId, { bytes: file.bytes, contentType: file.contentType, sha256: f.sha256, capturedAt: f.capturedAt, kind: f.kind, ...(f.offlineId ? { offlineId: f.offlineId } : {}) }, app.deps.blobs);
      if (f.kind === "pay_stub" && f.paycheckId && r.created) {
        await loadPaycheck(db, f.paycheckId);
        await intakeStub(db, p.householdId, f.paycheckId, { bytes: file.bytes, contentType: file.contentType, receiptId: r.receipt.id }, { docIntel: app.deps.docIntel }, p.memberId);
        return { summary: toReceiptSummary(await loadReceipt(db, r.receipt.id)), created: true, questions: await listQuestions(db, p.householdId, p.memberId) };
      }
      if (f.kind === "receipt" && r.created) {
        // Read and match inline when the ports answer quickly (fakes, dev); the OCR job retries anything queued.
        try {
          const read = await readReceipt(db, p.householdId, r.receipt.id, app.deps, p.memberId);
          if (read.outcome === "read") await matchReceiptToTransaction(db, p.householdId, r.receipt.id, p.memberId);
        } catch (e) {
          req.log.warn({ err: { type: (e as Error).name } }, "receipt read deferred to the OCR job");
        }
      }
      return { summary: toReceiptSummary(await loadReceipt(db, r.receipt.id)), created: r.created, questions: undefined };
    });
    return reply.code(created ? 201 : 200).send(questions ? { ...summary, questions } : summary);
  });

  app.get("/receipts/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return inHousehold(req, async (db, p) => {
      const rec = await loadReceipt(db, id);
      const detail = await receiptDetail(db, p.householdId, rec);
      const out: Record<string, unknown> = { ...toReceiptSummary(rec), ...detail };
      if (rec.matched_transaction_id) out["transaction"] = await loadTransactionDto(db, p.householdId, rec.matched_transaction_id);
      return out;
    });
  });

  app.post("/receipts/:id/match", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ transactionId: z.string().uuid() }), req.body);
    return inHousehold(req, async (db, p) => {
      await loadTransactionDto(db, p.householdId, body.transactionId).catch(() => {
        throw notFound("transaction");
      });
      await matchReceiptManually(db, p.householdId, id, body.transactionId, p.memberId);
      return { ...toReceiptSummary(await loadReceipt(db, id)), transaction: await loadTransactionDto(db, p.householdId, body.transactionId) };
    });
  });

  app.post("/receipts/amazon-email", async (req) => {
    const body = parse(z.object({ text: z.string().min(10).max(200_000), receivedAt: z.string().datetime({ offset: true }).optional() }), req.body);
    return inHousehold(req, async (db, p) => ({ orders: await intakeAmazonEmail(db, p.householdId, p.memberId, body.text, app.deps.mapper, body.receivedAt ?? app.deps.now().toISOString(), p.memberId) }));
  });
}
