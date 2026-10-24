/**
 * Plaid sync (every 4 hours and on SYNC_UPDATES_AVAILABLE), balances once a day, liabilities for the debt register.
 */
import { audit, listFeeds, refreshBalances, syncFeed, type Deps, type Queryable } from "@homestead/api";

export async function plaidSyncHousehold(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "plaid-sync"): Promise<Record<string, number>> {
  const counts: Record<string, number> = { feeds: 0, added: 0, pendingAdded: 0, settled: 0, modified: 0, removedPending: 0, removedPosted: 0, duplicates: 0, relink: 0, balances: 0, unknownAccounts: 0 };
  for (const feed of await listFeeds(db, householdId)) {
    if (feed.provider !== "plaid" || feed.status === "disabled") continue;
    counts["feeds"] = (counts["feeds"] ?? 0) + 1;
    const r = await syncFeed(db, householdId, feed, deps.plaid, deps.secrets, actor);
    if ("relink" in r) {
      counts["relink"] = (counts["relink"] ?? 0) + 1;
      continue;
    }
    for (const k of ["added", "pendingAdded", "settled", "modified", "removedPending", "removedPosted", "duplicates", "unknownAccounts"] as const) counts[k] = (counts[k] ?? 0) + r[k];
    counts["balances"] = (counts["balances"] ?? 0) + (await refreshBalances(db, householdId, feed, deps.plaid, deps.secrets, now, actor));
    // Liabilities (rate, next due, last payment) feed the debt register; the ledger balance still comes from BC.
    if (feed.plaid_item_ref) {
      const token = await deps.secrets.get(feed.plaid_item_ref);
      if (token) {
        try {
          const liabilities = await deps.plaid.liabilitiesGet(token);
          for (const l of liabilities) {
            const acct = await db.query<{ id: string }>("select id from accounts where household_id = $1 and plaid_account_id = $2", [householdId, l.account_id]);
            if (!acct.rows[0]) continue;
            // Plaid reports the last statement: once its due date has passed (or the minimum shows $0 because it
            // was paid) it says nothing about the next bill, so the known bill stays until a new statement arrives.
            if (l.nextPaymentDueDate && l.nextPaymentDueDate >= now.toISOString().slice(0, 10) && typeof l.minimumPaymentAmount === "number" && l.minimumPaymentAmount > 0) {
              await db.query("update bills set next_due_date = $2, amount_cents = case when is_minimum then $3 else amount_cents end where household_id = $4 and account_id = $1 and is_minimum", [acct.rows[0].id, l.nextPaymentDueDate, Math.round(l.minimumPaymentAmount * 100), householdId]);
            }
            await audit(db, householdId, { actor, action: "account.liability_read", entity: "account", entityId: acct.rows[0].id, after: { kind: l.kind, aprPercent: l.aprPercent, nextDue: l.nextPaymentDueDate } });
          }
        } catch {
          // Liabilities are optional per Item (not every institution supports the product).
        }
      }
    }
  }
  return counts;
}
