/**
 * Webhook receivers (public paths; no member sign-in).
 *
 * Plaid: the `Plaid-Verification` header is a JWT (ES256) whose `request_body_sha256` must match the body;
 * the key comes from /webhook_verification_key/get by `kid` (https://plaid.com/docs/api/webhooks/webhook-verification/).
 * Verification sits behind `WebhookVerifierPort` so tests use a fake. TRANSACTIONS/SYNC_UPDATES_AVAILABLE
 * enqueues a sync for the Item; ITEM/ERROR with ITEM_LOGIN_REQUIRED marks the connection needs_relink and tells
 * only its owner. Unknown webhooks are acknowledged.
 *
 * Business Central: GET or POST with `validationToken` is the subscription handshake and must echo the token
 * as text/plain with 200 (https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-subscriptions).
 * Notifications are answered 202 at once; each one's clientState is checked against the stored name's value and
 * a `bc_readback` request is enqueued. BC deletes the subscription on any reply other than 408/429/5xx, so the
 * receiver never returns 4xx for its own errors.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { importJWK, jwtVerify, decodeProtectedHeader, type JWK } from "jose";
import { getPool, withHousehold } from "../db/index.js";
import { redactString } from "../lib/logScrub.js";
import type { SecretStore } from "../services/ports.js";

export interface WebhookVerifierPort {
  /** Returns true when the header proves Plaid sent this exact body. */
  verifyPlaid(header: string | undefined, rawBody: string): Promise<boolean>;
}

export class FakeWebhookVerifier implements WebhookVerifierPort {
  accept = true;
  async verifyPlaid(header: string | undefined): Promise<boolean> {
    return this.accept && header !== undefined;
  }
}

/** Real verification: fetch the JWK by kid, verify ES256, compare request_body_sha256, reject tokens older than 5 minutes. */
export class PlaidWebhookVerifier implements WebhookVerifierPort {
  private readonly keys = new Map<string, JWK>();
  constructor(
    private readonly env: "sandbox" | "production",
    private readonly clientId: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async verifyPlaid(header: string | undefined, rawBody: string): Promise<boolean> {
    if (!header) return false;
    try {
      const { kid, alg } = decodeProtectedHeader(header);
      if (alg !== "ES256" || !kid) return false;
      let jwk = this.keys.get(kid);
      if (!jwk) {
        const r = await this.fetchImpl(`https://${this.env}.plaid.com/webhook_verification_key/get`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: this.clientId, secret: this.secret, key_id: kid }) });
        if (!r.ok) return false;
        jwk = ((await r.json()) as { key: JWK }).key;
        this.keys.set(kid, jwk);
      }
      const { payload } = await jwtVerify(header, await importJWK(jwk, "ES256"), { maxTokenAge: "5 minutes" });
      const expected = createHash("sha256").update(rawBody).digest("hex");
      return payload["request_body_sha256"] === expected;
    } catch {
      return false;
    }
  }
}

interface PlaidWebhookBody {
  webhook_type?: string;
  webhook_code?: string;
  item_id?: string;
  error?: { error_code?: string };
}

/** Find the household and feed for a Plaid item id (no household context yet, so the pool is used directly). */
async function feedForItem(itemId: string): Promise<{ householdId: string; feedId: string; ownerMemberId: string; institutionName: string | null } | undefined> {
  const r = await getPool().query<{ household_id: string; id: string; owner_member_id: string; institution_name: string | null }>("select household_id, id, owner_member_id, institution_name from feed_connections where plaid_item_id = $1", [itemId]);
  const row = r.rows[0];
  return row ? { householdId: row.household_id, feedId: row.id, ownerMemberId: row.owner_member_id, institutionName: row.institution_name } : undefined;
}

export async function handlePlaidWebhook(body: PlaidWebhookBody): Promise<{ handled: string }> {
  const itemId = body.item_id;
  if (!itemId) return { handled: "ignored" };
  const feed = await feedForItem(itemId);
  if (!feed) return { handled: "unknown_item" };
  const type = `${body.webhook_type ?? ""}/${body.webhook_code ?? ""}`;
  if (type === "TRANSACTIONS/SYNC_UPDATES_AVAILABLE") {
    await withHousehold(feed.householdId, async (db) => {
      await db.query("insert into outbox (household_id, aggregate, aggregate_id, operation, payload) values ($1,'transaction',$2,'plaid_sync',$3)", [feed.householdId, feed.feedId, JSON.stringify({ feedConnectionId: feed.feedId, reason: "webhook" })]);
    });
    return { handled: "sync_enqueued" };
  }
  if (type === "ITEM/ERROR" && body.error?.error_code === "ITEM_LOGIN_REQUIRED") {
    await withHousehold(feed.householdId, async (db) => {
      await db.query("update feed_connections set status = 'needs_relink', needs_relink = true where id = $1", [feed.feedId]);
      await db.query(
        "insert into alerts (household_id, member_id, kind, level, fingerprint, payload) values ($1,$2,'needs_relink','watch',$3,$4) on conflict do nothing",
        [feed.householdId, feed.ownerMemberId, `needs_relink:${feed.feedId}`, JSON.stringify({ title: `${feed.institutionName ?? "A bank"} needs a fresh sign-in`, body: "The bank asked for a new login. Reconnect when you have a minute; nothing is lost in the meantime.", feedId: feed.feedId })],
      );
      await db.query("insert into audit_log (household_id, actor, action, entity, entity_id, after) values ($1,'plaid-webhook','feed.needs_relink','feed_connection',$2,$3)", [feed.householdId, feed.feedId, JSON.stringify({ reason: "ITEM_LOGIN_REQUIRED" })]);
    });
    return { handled: "needs_relink" };
  }
  return { handled: "acknowledged" };
}

interface BcNotification {
  subscriptionId?: string;
  clientState?: string;
  lastModifiedDateTime?: string;
  changeType?: string;
  resource?: string;
}

export async function handleBcNotifications(notifications: BcNotification[], secrets: SecretStore): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  for (const n of notifications) {
    if (!n.subscriptionId) {
      rejected += 1;
      continue;
    }
    const r = await getPool().query<{ household_id: string; id: string; client_state_ref: string; resource: string }>("select household_id, id, client_state_ref, resource from bc_webhook_subscriptions where subscription_id = $1", [n.subscriptionId]);
    const sub = r.rows[0];
    if (!sub) {
      rejected += 1;
      continue;
    }
    const expected = await secrets.get(sub.client_state_ref);
    if (!expected || expected !== n.clientState) {
      rejected += 1;
      await getPool().query("insert into audit_log (household_id, actor, action, entity, entity_id, after) values ($1,'bc-webhook','webhook.client_state_rejected','bc_webhook_subscription',$2,$3)", [sub.household_id, sub.id, JSON.stringify({ resource: sub.resource })]);
      continue;
    }
    await withHousehold(sub.household_id, async (db) => {
      await db.query("update ledger_connections set last_webhook_at = now() where household_id = $1", [sub.household_id]);
      await db.query("insert into outbox (household_id, aggregate, aggregate_id, operation, payload) values ($1,'transaction',$2,'bc_readback',$3)", [sub.household_id, sub.id, JSON.stringify({ resource: n.resource ?? sub.resource, changeType: n.changeType ?? "", lastModifiedDateTime: n.lastModifiedDateTime ?? "" })]);
    });
    accepted += 1;
  }
  return { accepted, rejected };
}

function rawBodyOf(req: FastifyRequest): string {
  const raw = (req as FastifyRequest & { rawBody?: string }).rawBody;
  if (typeof raw === "string") return raw;
  return typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
}

export default async function webhooksRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw body for signature checks.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, (body as string).length ? JSON.parse(body as string) : {});
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  app.post("/webhooks/plaid", async (req, reply) => {
    const header = req.headers["plaid-verification"];
    const ok = await app.deps.plaidWebhookVerifier.verifyPlaid(typeof header === "string" ? header : undefined, rawBodyOf(req));
    if (!ok) return reply.code(401).send({ error: "not_verified" });
    try {
      const r = await handlePlaidWebhook((req.body ?? {}) as PlaidWebhookBody);
      return reply.code(200).send(r);
    } catch (e) {
      req.log.error({ err: { type: (e as Error).name, message: redactString((e as Error).message) } }, "plaid webhook");
      return reply.code(200).send({ handled: "error_logged" });
    }
  });

  const bcHandler = async (req: FastifyRequest, reply: import("fastify").FastifyReply) => {
    const q = req.query as { validationToken?: string };
    if (q.validationToken) return reply.code(200).type("text/plain").send(q.validationToken);
    if (req.method === "GET") return reply.code(200).type("text/plain").send("");
    // 202 at once; processing is queued. Own errors never become 4xx (BC would delete the subscription).
    const body = (req.body ?? {}) as { value?: BcNotification[] };
    const list = Array.isArray(body.value) ? body.value : [];
    try {
      const r = await handleBcNotifications(list, app.deps.secrets);
      return reply.code(202).send(r);
    } catch (e) {
      req.log.error({ err: { type: (e as Error).name, message: redactString((e as Error).message) } }, "bc webhook");
      return reply.code(202).send({ accepted: 0, rejected: list.length, note: "error_logged" });
    }
  };
  app.get("/webhooks/bc", bcHandler);
  app.post("/webhooks/bc", bcHandler);
}
