/**
 * GET /v1/accounts — the household's accounts with their last known balance (masked: last four only).
 * POST /v1/accounts/link-token, POST /v1/accounts/link — Plaid Link for the login's owner (tokens vaulted by name).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AccountSummary, DataThrough } from "@homestead/shared";
import { hoursBetween } from "../lib/dates.js";
import { inHousehold, parse, requireStepUp } from "../lib/http.js";
import { attachPlaidAccount, linkItem, listFeeds, unlinkItem } from "../services/bankData/plaid.js";
import { listAccounts, type AccountRow } from "../services/transactions.js";
import type { Queryable } from "../db/index.js";

export async function accountSummaries(db: Queryable, householdId: string, now: Date): Promise<{ accounts: AccountSummary[]; dataThrough: DataThrough }> {
  const rows = await listAccounts(db, householdId);
  const feeds = await listFeeds(db, householdId);
  const feedById = new Map(feeds.map((f) => [f.id, f]));
  let oldest: string | undefined;
  let newest: string | undefined;
  const accounts = rows.map((a: AccountRow) => {
    const f = a.feed_connection_id ? feedById.get(a.feed_connection_id) : undefined;
    let feedStatus: AccountSummary["feedStatus"] = "none";
    if (f) {
      if (f.needs_relink || f.status === "needs_relink") feedStatus = "needs_relink";
      else if (f.provider === "file") feedStatus = "file_only";
      else if (!f.last_synced_at || hoursBetween(f.last_synced_at, now) > 48) feedStatus = "stale";
      else feedStatus = "ok";
    }
    const dto: AccountSummary = { id: a.id, displayName: a.display_name, institution: a.institution, kind: a.kind as AccountSummary["kind"], mask: a.mask, feedStatus, isRestricted: a.is_restricted };
    if (a.bc_bank_account_code) dto.bcBankAccountCode = a.bc_bank_account_code;
    if (a.bc_gl_account) dto.bcGlAccount = a.bc_gl_account;
    if (a.balance_cents !== null && a.balance_cents !== undefined) dto.balanceCents = a.balance_cents;
    if (a.balance_as_of) {
      const at = new Date(a.balance_as_of).toISOString();
      dto.balanceAsOf = at;
      if (!oldest || at < oldest) oldest = at;
      if (!newest || at > newest) newest = at;
    }
    return dto;
  });
  const quality: DataThrough["quality"] = !oldest ? "missing" : hoursBetween(oldest, now) > 48 ? "stale" : "imported_pending";
  return { accounts, dataThrough: { at: oldest ?? now.toISOString(), quality, pendingCount: 0 } };
}

export default async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/accounts", async (req) => inHousehold(req, (db, p) => accountSummaries(db, p.householdId, app.deps.now())));

  app.post("/accounts/link-token", async (req) => {
    const body = parse(z.object({ institutionId: z.string().max(100).optional() }).default({}), req.body ?? {});
    return inHousehold(req, async (_db, p) => {
      const t = await app.deps.plaid.createLinkToken({ clientUserId: p.memberId, ...(process.env["PLAID_WEBHOOK_URL"] ? { webhookUrl: process.env["PLAID_WEBHOOK_URL"] } : {}), ...(body.institutionId ? { institutionId: body.institutionId } : {}) });
      return { linkToken: t.linkToken, expiration: t.expiration };
    });
  });

  app.post("/accounts/link", async (req, reply) => {
    requireStepUp(req);
    const body = parse(
      z.object({
        publicToken: z.string().min(1).max(500),
        institutionId: z.string().max(100).optional(),
        institutionName: z.string().max(200).optional(),
        /** Household account id -> Plaid account_id, chosen in Link's account picker. */
        accounts: z.array(z.object({ accountId: z.string().uuid(), plaidAccountId: z.string().min(1).max(200) })).max(20).default([]),
      }),
      req.body,
    );
    const r = await inHousehold(req, async (db, p) => {
      const linked = await linkItem(db, p.householdId, p.memberId, app.deps.plaid, app.deps.secrets, { publicToken: body.publicToken, ...(body.institutionId ? { institutionId: body.institutionId } : {}), ...(body.institutionName ? { institutionName: body.institutionName } : {}) });
      for (const a of body.accounts) await attachPlaidAccount(db, p.householdId, linked.feedConnectionId, a.accountId, a.plaidAccountId, p.memberId);
      return linked;
    });
    return reply.code(201).send({ feedConnectionId: r.feedConnectionId, itemId: r.itemId });
  });

  app.post("/accounts/feeds/:id/unlink", async (req) => {
    requireStepUp(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    await inHousehold(req, (db, p) => unlinkItem(db, p.householdId, p.memberId, id, app.deps.secrets, app.deps.plaid));
    return { ok: true };
  });

  app.get("/accounts/institutions", async (req) => {
    const q = parse(z.object({ q: z.string().min(2).max(100) }), req.query);
    const list = await app.deps.plaid.institutionsSearch(q.q);
    return { institutions: list.map((i) => ({ id: i.institution_id, name: i.name })) };
  });
}
