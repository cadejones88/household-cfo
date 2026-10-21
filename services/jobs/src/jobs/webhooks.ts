/**
 * BC webhook subscription renewal (spec: "Webhooks and polling"): subscriptions to generalLedgerEntries and
 * journals expire after three days, so this runs daily, renews anything expiring inside 24 hours and recreates
 * anything missing (from the app's table, or from BC's own list when the ledger port can read it). The clientState is a random secret stored by name; the receiver checks every notification.
 */
import { randomBytes } from "node:crypto";
import { LedgerError, audit, ledgerConnection, type Deps, type Queryable } from "@homestead/api";

export const WEBHOOK_RESOURCES = ["generalLedgerEntries", "journals"] as const;

export async function renewWebhooks(db: Queryable, householdId: string, deps: Deps, now: Date, notificationUrl: string, actor = "webhook-renewal"): Promise<Record<string, number>> {
  const counts = { renewed: 0, created: 0, kept: 0, recreated: 0 };
  const conn = await ledgerConnection(db, householdId);
  if (!conn) return counts;
  const existing = await db.query<{ id: string; resource: string; subscription_id: string; client_state_ref: string; expires_at: string }>("select id, resource, subscription_id, client_state_ref, expires_at from bc_webhook_subscriptions where household_id = $1", [householdId]);
  const byResource = new Map(existing.rows.map((s) => [s.resource, s]));
  // What BC holds now, when the ledger can say: a subscription BC dropped is recreated today, not when it would expire.
  const inBc = deps.ledger.listWebhookSubscriptions ? new Set((await deps.ledger.listWebhookSubscriptions()).map((s) => s.subscriptionId)) : undefined;
  for (const resource of WEBHOOK_RESOURCES) {
    const sub = byResource.get(resource);
    if (sub && inBc && !inBc.has(sub.subscription_id)) {
      await db.query("delete from bc_webhook_subscriptions where id = $1", [sub.id]);
      await deps.secrets.delete(sub.client_state_ref);
      counts.recreated += 1;
    } else if (sub) {
      const msLeft = new Date(sub.expires_at).getTime() - now.getTime();
      if (msLeft > 24 * 3_600_000) {
        counts.kept += 1;
        continue;
      }
      try {
        const clientState = await deps.secrets.get(sub.client_state_ref);
        const renewed = await deps.ledger.renewWebhookSubscription(sub.subscription_id, clientState);
        await db.query("update bc_webhook_subscriptions set expires_at = $2, last_renewed_at = $3 where id = $1", [sub.id, renewed.expiresAt, now.toISOString()]);
        counts.renewed += 1;
        continue;
      } catch (e) {
        if (!(e instanceof LedgerError) || e.retryable) throw e;
        // BC no longer has it (deleted after a non-2xx reply, or an environment update): recreate.
        await db.query("delete from bc_webhook_subscriptions where id = $1", [sub.id]);
        await deps.secrets.delete(sub.client_state_ref);
        counts.recreated += 1;
      }
    }
    const clientState = randomBytes(24).toString("base64url");
    const ref = `bc-webhook-${householdId.slice(0, 8)}-${resource}-${now.getTime().toString(36)}`;
    await deps.secrets.set(ref, clientState);
    const created = await deps.ledger.createWebhookSubscription(resource, notificationUrl, clientState);
    await db.query("insert into bc_webhook_subscriptions (household_id, resource, subscription_id, client_state_ref, expires_at, last_renewed_at) values ($1,$2,$3,$4,$5,$6) on conflict (household_id, resource) do update set subscription_id = excluded.subscription_id, client_state_ref = excluded.client_state_ref, expires_at = excluded.expires_at, last_renewed_at = excluded.last_renewed_at", [
      householdId,
      resource,
      created.subscriptionId,
      ref,
      created.expiresAt,
      now.toISOString(),
    ]);
    counts.created += 1;
  }
  await audit(db, householdId, { actor, action: "webhooks.renewed", entity: "household", entityId: householdId, after: counts });
  return counts;
}
