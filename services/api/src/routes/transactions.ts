/**
 * /v1/transactions — recent activity (plain status words), one item, "This is wrong", the business flag,
 * splits, and a manual entry (idempotent by the device-minted clientId).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idempotencyKey, type DataThrough, type PlainStatus, type TransactionState } from "@homestead/shared";
import { cents, idParam, inHousehold, isoDate, parse, splitInput } from "../lib/http.js";
import { notFound } from "../lib/errors.js";
import { correctTransaction, importTransaction, listTransactions, loadSplits, loadSplitsFor, loadTx, setBusinessFlag, setSplits, toTransactionDto, transition, type ListFilter } from "../services/transactions.js";
import { loadCategories } from "../services/categories.js";
import { classifyOne } from "../services/classify.js";
import { getSettings, ledgerConnection } from "../services/households.js";
import { listRules } from "../services/rules.js";
import type { Queryable } from "../db/index.js";

const STATES_FOR_STATUS: Record<PlainStatus, TransactionState[]> = {
  needs_answer: ["possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review"],
  recorded: ["imported", "approved", "sent_to_bc", "bc_draft_created"],
  in_books: ["posted", "reversed"],
  matched: ["reconciled"],
  being_checked: ["exception"],
  dropped: ["dropped"],
};

export async function transactionsDataThrough(db: Queryable, householdId: string, now: Date): Promise<DataThrough> {
  const r = await db.query<{ posted: string | null; recorded: string | null; pending: number }>(
    `select max(case when state in ('posted','reconciled') then updated_at end) as posted,
            max(case when state in ('approved','sent_to_bc','bc_draft_created') then updated_at end) as recorded,
            count(*) filter (where pending or state in ('imported','possible_duplicate','needs_receipt','needs_classification','ready_for_review'))::int as pending
       from transactions where household_id = $1`,
    [householdId],
  );
  const m = r.rows[0];
  const at = [m?.posted, m?.recorded].filter((x): x is string => Boolean(x)).map((x) => new Date(x).toISOString()).sort().pop() ?? now.toISOString();
  return { at, quality: m?.posted ? "posted_unreconciled" : "imported_pending", pendingCount: m?.pending ?? 0 };
}

export async function loadTransactionDto(db: Queryable, householdId: string, id: string) {
  const row = await loadTx(db, id);
  if (row.household_id !== householdId) throw notFound("transaction");
  return toTransactionDto(row, await loadSplits(db, id));
}

export default async function transactionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/transactions", async (req) => {
    const q = parse(
      z.object({
        from: isoDate.optional(),
        to: isoDate.optional(),
        q: z.string().max(200).optional(),
        categoryId: z.string().max(64).optional(),
        accountId: z.string().uuid().optional(),
        status: z.enum(["needs_answer", "recorded", "in_books", "matched", "being_checked", "dropped"]).optional(),
        kind: z.enum(["spend", "income", "transfer", "loan_payment", "paycheck", "bc_native"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().max(100).optional(),
        includePending: z.coerce.boolean().default(true),
      }),
      req.query,
    );
    return inHousehold(req, async (db, p) => {
      const f: ListFilter = { limit: q.limit, includePending: q.includePending };
      if (q.from) f.from = q.from;
      if (q.to) f.to = q.to;
      if (q.q) f.q = q.q;
      if (q.categoryId) f.categoryId = q.categoryId;
      if (q.accountId) f.accountId = q.accountId;
      if (q.status) f.states = STATES_FOR_STATUS[q.status];
      if (q.kind) f.kind = q.kind;
      if (q.cursor) f.cursor = q.cursor;
      const { rows, next } = await listTransactions(db, p.householdId, f);
      const visible = rows.filter((r) => q.includePending || !r.pending);
      const splits = await loadSplitsFor(db, visible.map((r) => r.id));
      const out: Record<string, unknown> = { transactions: visible.map((r) => toTransactionDto(r, splits.get(r.id) ?? [])), dataThrough: await transactionsDataThrough(db, p.householdId, app.deps.now()) };
      if (next) out["next"] = next;
      return out;
    });
  });

  app.post("/transactions", async (req, reply) => {
    const body = parse(
      z.object({
        clientId: z.string().uuid(),
        accountId: z.string().uuid(),
        postedDate: isoDate,
        amountCents: cents,
        merchant: z.string().min(1).max(200),
        categoryId: z.string().max(64).optional(),
        note: z.string().max(500).optional(),
      }),
      req.body,
    );
    const { dto, created } = await inHousehold(req, async (db, p) => {
      const r = await importTransaction(db, p.householdId, { accountId: body.accountId, source: "manual", sourceRef: body.clientId, idempotencyKey: idempotencyKey.manual(body.clientId), postedDate: body.postedDate, amountCents: body.amountCents, merchantRaw: body.note ? `${body.merchant} (${body.note})` : body.merchant, ...(body.categoryId ? { categoryId: body.categoryId } : {}) }, p.memberId);
      if (r.created) {
        const moved = await transition(db, p.householdId, r.transaction.id, "needs_classification", "jobs", { actorId: p.memberId, reason: "manual entry" });
        const cats = await loadCategories(db, p.householdId);
        const rules = await listRules(db, p.householdId);
        const settings = await getSettings(db, p.householdId);
        const conn = await ledgerConnection(db, p.householdId);
        await classifyOne(db, p.householdId, moved, { rules, settings, autoPostOn: conn?.auto_post_enabled ?? false, cats, actor: p.memberId });
      }
      return { dto: await loadTransactionDto(db, p.householdId, r.transaction.id), created: r.created };
    });
    return reply.code(created ? 201 : 200).send(dto);
  });

  app.get("/transactions/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return inHousehold(req, (db, p) => loadTransactionDto(db, p.householdId, id));
  });

  app.post("/transactions/:id/correct", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ categoryId: z.string().max(64).optional(), splits: z.array(splitInput).min(1).optional(), reason: z.string().max(500).optional() }), req.body ?? {});
    return inHousehold(req, async (db, p) => {
      const r = await correctTransaction(db, p.householdId, id, { ...(body.categoryId ? { categoryId: body.categoryId } : {}), ...(body.splits ? { splits: body.splits } : {}), ...(body.reason ? { reason: body.reason } : {}) }, p.memberId);
      const out: Record<string, unknown> = { transaction: await loadTransactionDto(db, p.householdId, id) };
      if (r.correctionRequestId) out["correctionRequestId"] = r.correctionRequestId;
      return out;
    });
  });

  app.post("/transactions/:id/business", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ flag: z.enum(["none", "ctj", "lash"]) }), req.body);
    return inHousehold(req, async (db, p) => {
      await setBusinessFlag(db, p.householdId, id, body.flag, p.memberId);
      return loadTransactionDto(db, p.householdId, id);
    });
  });

  app.put("/transactions/:id/splits", async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ splits: z.array(splitInput).min(1).max(50) }), req.body);
    return inHousehold(req, async (db, p) => {
      await setSplits(db, p.householdId, id, body.splits, p.memberId);
      return loadTransactionDto(db, p.householdId, id);
    });
  });
}
