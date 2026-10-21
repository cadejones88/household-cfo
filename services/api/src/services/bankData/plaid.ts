/**
 * Plaid (spec: "Bank data: Plaid and file import"). A thin client over fetch behind `PlaidPort`, with
 * `FakePlaid` for tests. Only the Transactions, Balance and Liabilities products are used: nothing here can
 * move money and the Auth product (full account numbers) is never requested.
 *
 * Access tokens live in Key Vault under `plaid-<household>-<item>`; the database holds the secret *name*
 * (feed_connections.plaid_item_ref) and the Item ID.
 *
 * Assumptions (Plaid API docs, https://plaid.com/docs/api/):
 *  - POST {env}/link/token/create { client_id, secret, user:{client_user_id}, client_name, products, country_codes, language, webhook }
 *      -> { link_token, expiration }   (https://plaid.com/docs/api/link/#linktokencreate)
 *  - POST /item/public_token/exchange { public_token } -> { access_token, item_id }   (https://plaid.com/docs/api/items/#itempublic_tokenexchange)
 *  - POST /transactions/sync { access_token, cursor?, count? } -> { added[], modified[], removed[], next_cursor, has_more, transactions_update_status }
 *      Transactions carry transaction_id, pending, pending_transaction_id, account_id, amount (positive = money out),
 *      date, authorized_date, name, merchant_name. Pages are applied in order; the cursor is stored after each page.
 *      (https://plaid.com/docs/api/products/transactions/#transactionssync)
 *  - POST /accounts/balance/get { access_token } -> { accounts[]: { account_id, balances:{ current, available, iso_currency_code } , mask, name, type, subtype } }
 *      (https://plaid.com/docs/api/products/balance/#accountsbalanceget)
 *  - POST /liabilities/get { access_token } -> { liabilities: { credit[], mortgage[], student[] } }  (https://plaid.com/docs/api/products/liabilities/#liabilitiesget)
 *  - POST /institutions/search { query, products, country_codes } -> { institutions[] }  (https://plaid.com/docs/api/institutions/#institutionssearch)
 *  - Errors: { error_type, error_code, error_message }; ITEM_LOGIN_REQUIRED is error_code "ITEM_LOGIN_REQUIRED" of type ITEM_ERROR.
 *      (https://plaid.com/docs/errors/item/#item_login_required)
 *  - Webhooks: TRANSACTIONS / SYNC_UPDATES_AVAILABLE { item_id }, ITEM / ERROR { item_id, error }; verification by the
 *      Plaid-Verification JWT header (https://plaid.com/docs/api/webhooks/webhook-verification/).
 */
import { idempotencyKey, type Alert } from "@homestead/shared";
import { audit, type Queryable } from "../../db/index.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { detectPossibleDuplicate } from "../duplicates.js";
import type { SecretStore } from "../ports.js";
import { dropPending, findTxByKey, importTransaction, raiseException, settlePending, updateImported, type TxRow } from "../transactions.js";

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Plaid sign: positive = money out. */
  amount: number;
  iso_currency_code?: string | null;
  date: string;
  authorized_date?: string | null;
  name: string;
  merchant_name?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
}

export interface PlaidSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string; account_id?: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidAccountBalance {
  account_id: string;
  mask?: string | null;
  name?: string;
  type?: string;
  subtype?: string | null;
  balances: { current?: number | null; available?: number | null; iso_currency_code?: string | null };
}

export interface PlaidLiability {
  account_id: string;
  kind: "credit" | "mortgage" | "student";
  aprPercent?: number;
  nextPaymentDueDate?: string;
  lastPaymentAmount?: number;
  lastPaymentDate?: string;
  minimumPaymentAmount?: number;
}

export interface PlaidInstitution {
  institution_id: string;
  name: string;
  routing_numbers?: string[];
}

export class PlaidError extends Error {
  constructor(
    public readonly errorType: string,
    public readonly errorCode: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PlaidError";
  }
}

export interface PlaidPort {
  createLinkToken(input: { clientUserId: string; webhookUrl?: string; institutionId?: string }): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage>;
  balanceGet(accessToken: string): Promise<PlaidAccountBalance[]>;
  liabilitiesGet(accessToken: string): Promise<PlaidLiability[]>;
  institutionsSearch(query: string): Promise<PlaidInstitution[]>;
}

export class PlaidClient implements PlaidPort {
  constructor(
    private readonly env: "sandbox" | "production",
    private readonly clientId: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private get base(): string {
    return this.env === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";
  }
  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const r = await this.fetchImpl(`${this.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }) });
    const j = (await r.json()) as Record<string, unknown>;
    if (!r.ok || typeof j["error_code"] === "string") throw new PlaidError(String(j["error_type"] ?? "API_ERROR"), String(j["error_code"] ?? "UNKNOWN"), "Plaid request failed", r.status);
    return j as T;
  }
  async createLinkToken(input: { clientUserId: string; webhookUrl?: string; institutionId?: string }): Promise<{ linkToken: string; expiration: string }> {
    const j = await this.call<{ link_token: string; expiration: string }>("/link/token/create", {
      user: { client_user_id: input.clientUserId },
      client_name: "Homestead",
      products: ["transactions"],
      optional_products: ["liabilities"],
      country_codes: ["US"],
      language: "en",
      ...(input.webhookUrl ? { webhook: input.webhookUrl } : {}),
      ...(input.institutionId ? { institution_id: input.institutionId } : {}),
    });
    return { linkToken: j.link_token, expiration: j.expiration };
  }
  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    const j = await this.call<{ access_token: string; item_id: string }>("/item/public_token/exchange", { public_token: publicToken });
    return { accessToken: j.access_token, itemId: j.item_id };
  }
  async transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    return this.call<PlaidSyncPage>("/transactions/sync", { access_token: accessToken, ...(cursor ? { cursor } : {}), count: 250 });
  }
  async balanceGet(accessToken: string): Promise<PlaidAccountBalance[]> {
    const j = await this.call<{ accounts: PlaidAccountBalance[] }>("/accounts/balance/get", { access_token: accessToken });
    return j.accounts;
  }
  async liabilitiesGet(accessToken: string): Promise<PlaidLiability[]> {
    const j = await this.call<{ liabilities: { credit?: Record<string, unknown>[]; mortgage?: Record<string, unknown>[]; student?: Record<string, unknown>[] } }>("/liabilities/get", { access_token: accessToken });
    const out: PlaidLiability[] = [];
    const num = (v: unknown) => (typeof v === "number" ? v : undefined);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    for (const kind of ["credit", "mortgage", "student"] as const) {
      for (const l of j.liabilities[kind] ?? []) {
        const item: PlaidLiability = { account_id: String(l["account_id"]), kind };
        const apr = Array.isArray(l["aprs"]) ? num((l["aprs"] as Record<string, unknown>[])[0]?.["apr_percentage"]) : num(l["interest_rate_percentage"]);
        if (apr !== undefined) item.aprPercent = apr;
        const due = str(l["next_payment_due_date"]);
        if (due) item.nextPaymentDueDate = due;
        const lastAmt = num(l["last_payment_amount"]);
        if (lastAmt !== undefined) item.lastPaymentAmount = lastAmt;
        const lastDate = str(l["last_payment_date"]);
        if (lastDate) item.lastPaymentDate = lastDate;
        const min = num(l["minimum_payment_amount"]) ?? num(l["next_monthly_payment"]);
        if (min !== undefined) item.minimumPaymentAmount = min;
        out.push(item);
      }
    }
    return out;
  }
  async institutionsSearch(query: string): Promise<PlaidInstitution[]> {
    const j = await this.call<{ institutions: PlaidInstitution[] }>("/institutions/search", { query, products: ["transactions"], country_codes: ["US"], options: { include_optional_metadata: false } });
    return j.institutions;
  }
}

/** Scripted fake: pages of sync results per access token, balances, and an error to throw on the next sync. */
export class FakePlaid implements PlaidPort {
  readonly pages = new Map<string, PlaidSyncPage[]>();
  readonly balances = new Map<string, PlaidAccountBalance[]>();
  readonly liabilities = new Map<string, PlaidLiability[]>();
  readonly institutions: PlaidInstitution[] = [
    { institution_id: "ins_beehive", name: "Beehive Federal Credit Union" },
    { institution_id: "ins_afcu", name: "America First Credit Union" },
    { institution_id: "ins_macu", name: "Mountain America Credit Union" },
    { institution_id: "ins_capone", name: "Capital One" },
    { institution_id: "ins_venmo", name: "Venmo" },
    { institution_id: "ins_synchrony", name: "Synchrony Bank" },
  ];
  failNextSync: PlaidError | undefined;
  readonly calls: string[] = [];
  private cursorSeq = 0;

  async createLinkToken(input: { clientUserId: string }): Promise<{ linkToken: string; expiration: string }> {
    this.calls.push("linkToken");
    return { linkToken: `link-sandbox-${input.clientUserId}`, expiration: new Date(Date.now() + 4 * 3_600_000).toISOString() };
  }
  async exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
    this.calls.push("exchange");
    return { accessToken: `access-sandbox-${publicToken}`, itemId: `item-${publicToken}` };
  }
  async transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage> {
    this.calls.push(`sync:${cursor ?? "start"}`);
    if (this.failNextSync) {
      const e = this.failNextSync;
      this.failNextSync = undefined;
      throw e;
    }
    const list = this.pages.get(accessToken) ?? [];
    const page = list.shift();
    if (!page) return { added: [], modified: [], removed: [], next_cursor: cursor ?? `cursor-${++this.cursorSeq}`, has_more: false };
    return { ...page, has_more: page.has_more && list.length > 0 };
  }
  async balanceGet(accessToken: string): Promise<PlaidAccountBalance[]> {
    this.calls.push("balance");
    return this.balances.get(accessToken) ?? [];
  }
  async liabilitiesGet(accessToken: string): Promise<PlaidLiability[]> {
    this.calls.push("liabilities");
    return this.liabilities.get(accessToken) ?? [];
  }
  async institutionsSearch(query: string): Promise<PlaidInstitution[]> {
    this.calls.push(`institutions:${query}`);
    return this.institutions.filter((i) => i.name.toLowerCase().includes(query.toLowerCase()));
  }
  /** Queue a page for an access token. */
  queue(accessToken: string, page: Partial<PlaidSyncPage> & Pick<PlaidSyncPage, "next_cursor">): void {
    const list = this.pages.get(accessToken) ?? [];
    list.push({ added: [], modified: [], removed: [], has_more: true, ...page });
    this.pages.set(accessToken, list);
  }
}

// Linking and token vaulting -------------------------------------------------------------------------------

export function secretNameFor(householdId: string, itemId: string): string {
  return `plaid-${householdId.slice(0, 8)}-${itemId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 40)}`;
}

/** The app received a public token from Link; exchange it on the server and vault the access token by name. */
export async function linkItem(db: Queryable, householdId: string, memberId: string, plaid: PlaidPort, secrets: SecretStore, input: { publicToken: string; institutionId?: string; institutionName?: string }, actor = memberId): Promise<{ feedConnectionId: string; itemId: string }> {
  const { accessToken, itemId } = await plaid.exchangePublicToken(input.publicToken);
  const name = secretNameFor(householdId, itemId);
  await secrets.set(name, accessToken);
  const r = await db.query<{ id: string }>(
    `insert into feed_connections (household_id, owner_member_id, provider, plaid_item_ref, plaid_item_id, institution_id, institution_name, status)
     values ($1,$2,'plaid',$3,$4,$5,$6,'ok') returning id`,
    [householdId, memberId, name, itemId, input.institutionId ?? null, input.institutionName ?? null],
  );
  const id = r.rows[0]!.id;
  await audit(db, householdId, { actor, action: "feed.linked", entity: "feed_connection", entityId: id, after: { provider: "plaid", institutionId: input.institutionId, owner: memberId } });
  return { feedConnectionId: id, itemId };
}

/** Only the login's owner may remove it (authority matrix). The token is deleted from the vault. */
export async function unlinkItem(db: Queryable, householdId: string, memberId: string, feedConnectionId: string, secrets: SecretStore): Promise<void> {
  const r = await db.query<{ owner_member_id: string; plaid_item_ref: string | null }>("select owner_member_id, plaid_item_ref from feed_connections where id = $1 and household_id = $2", [feedConnectionId, householdId]);
  const row = r.rows[0];
  if (!row) throw notFound("connection");
  if (row.owner_member_id !== memberId) throw badRequest("owner_only", "Only the person who connected this login can remove it");
  if (row.plaid_item_ref) await secrets.delete(row.plaid_item_ref);
  await db.query("update feed_connections set status = 'disabled', plaid_item_ref = null, cursor = null where id = $1", [feedConnectionId]);
  await audit(db, householdId, { actor: memberId, action: "feed.unlinked", entity: "feed_connection", entityId: feedConnectionId });
}

// Sync ------------------------------------------------------------------------------------------------------

export interface FeedRow {
  id: string;
  owner_member_id: string;
  provider: string;
  plaid_item_ref: string | null;
  plaid_item_id: string | null;
  institution_name: string | null;
  cursor: string | null;
  status: "ok" | "stale" | "needs_relink" | "disabled";
  needs_relink: boolean;
  last_synced_at: string | null;
}

export async function listFeeds(db: Queryable, householdId: string): Promise<FeedRow[]> {
  const r = await db.query<FeedRow>("select id, owner_member_id, provider, plaid_item_ref, plaid_item_id, institution_name, cursor, status, needs_relink, last_synced_at from feed_connections where household_id = $1 order by created_at", [householdId]);
  return r.rows;
}

export interface SyncCounts {
  added: number;
  pendingAdded: number;
  settled: number;
  modified: number;
  removedPending: number;
  removedPosted: number;
  duplicates: number;
  pages: number;
  unknownAccounts: number;
}

export function pendingKey(plaidTransactionId: string): string {
  return `pending:${plaidTransactionId}`;
}

/** Plaid amount is positive for money out; Homestead stores bank sign (negative = money out). */
export function toCents(plaidAmount: number): number {
  return -Math.round(plaidAmount * 100);
}

/**
 * Apply `/transactions/sync` pages in order for one Item. Added pending rows get a `pending:` key; a settled
 * row with `pending_transaction_id` replaces its pending row; removed pending rows are dropped; removed posted
 * rows raise an exception. The cursor is stored after each page is applied so a crash resumes, never repeats.
 */
export async function syncFeed(db: Queryable, householdId: string, feed: FeedRow, plaid: PlaidPort, secrets: SecretStore, actor = "plaid-sync"): Promise<SyncCounts | { relink: true }> {
  const counts: SyncCounts = { added: 0, pendingAdded: 0, settled: 0, modified: 0, removedPending: 0, removedPosted: 0, duplicates: 0, pages: 0, unknownAccounts: 0 };
  if (feed.provider !== "plaid" || !feed.plaid_item_ref || feed.status === "disabled") return counts;
  const token = await secrets.get(feed.plaid_item_ref);
  if (!token) {
    await markRelink(db, householdId, feed, "token missing from the vault", actor);
    return { relink: true };
  }
  const accounts = await db.query<{ id: string; plaid_account_id: string }>("select id, plaid_account_id from accounts where household_id = $1 and feed_connection_id = $2 and plaid_account_id is not null", [householdId, feed.id]);
  const acctByPlaid = new Map(accounts.rows.map((a) => [a.plaid_account_id, a.id]));
  let cursor = feed.cursor;
  let hasMore = true;
  while (hasMore) {
    let page: PlaidSyncPage;
    try {
      page = await plaid.transactionsSync(token, cursor);
    } catch (e) {
      if (e instanceof PlaidError && e.errorCode === "ITEM_LOGIN_REQUIRED") {
        await markRelink(db, householdId, feed, "ITEM_LOGIN_REQUIRED", actor);
        return { relink: true };
      }
      throw e;
    }
    counts.pages += 1;
    for (const t of page.added) {
      const accountId = acctByPlaid.get(t.account_id);
      if (!accountId) {
        counts.unknownAccounts += 1;
        continue;
      }
      await applyAdded(db, householdId, accountId, t, counts, actor);
    }
    for (const t of page.modified) {
      const accountId = acctByPlaid.get(t.account_id);
      if (!accountId) continue;
      await applyModified(db, householdId, accountId, t, counts, actor);
    }
    for (const r of page.removed) {
      await applyRemoved(db, householdId, r.transaction_id, acctByPlaid, counts, actor);
    }
    cursor = page.next_cursor;
    await db.query("update feed_connections set cursor = $2, last_synced_at = now(), status = 'ok', needs_relink = false where id = $1", [feed.id, cursor]);
    hasMore = page.has_more;
  }
  await audit(db, householdId, { actor, action: "feed.synced", entity: "feed_connection", entityId: feed.id, after: counts });
  return counts;
}

async function applyAdded(db: Queryable, householdId: string, accountId: string, t: PlaidTransaction, counts: SyncCounts, actor: string): Promise<void> {
  const merchant = t.merchant_name || t.name;
  if (t.pending) {
    const r = await importTransaction(db, householdId, { accountId, source: "plaid", sourceRef: t.transaction_id, idempotencyKey: pendingKey(t.transaction_id), postedDate: t.date, ...(t.authorized_date ? { authorizedDate: t.authorized_date } : {}), amountCents: toCents(t.amount), merchantRaw: merchant, pending: true }, actor);
    if (r.created) counts.pendingAdded += 1;
    return;
  }
  if (t.pending_transaction_id) {
    const settled = await settlePending(db, householdId, pendingKey(t.pending_transaction_id), actor);
    if (settled) counts.settled += 1;
  }
  const key = idempotencyKey.plaid(t.account_id, t.transaction_id);
  const r = await importTransaction(db, householdId, { accountId, source: "plaid", sourceRef: t.transaction_id, idempotencyKey: key, postedDate: t.date, ...(t.authorized_date ? { authorizedDate: t.authorized_date } : {}), amountCents: toCents(t.amount), merchantRaw: merchant }, actor);
  if (r.created) {
    counts.added += 1;
    const d = await detectPossibleDuplicate(db, householdId, r.transaction, actor);
    if (d.duplicateOf) counts.duplicates += 1;
  }
}

async function applyModified(db: Queryable, householdId: string, accountId: string, t: PlaidTransaction, counts: SyncCounts, actor: string): Promise<void> {
  const merchant = t.merchant_name || t.name;
  const key = t.pending ? pendingKey(t.transaction_id) : idempotencyKey.plaid(t.account_id, t.transaction_id);
  const row = await updateImported(db, householdId, key, { amountCents: toCents(t.amount), postedDate: t.date, merchantRaw: merchant }, actor);
  if (row) counts.modified += 1;
  else await applyAdded(db, householdId, accountId, t, counts, actor);
}

async function applyRemoved(db: Queryable, householdId: string, transactionId: string, acctByPlaid: Map<string, string>, counts: SyncCounts, actor: string): Promise<void> {
  if (await dropPending(db, householdId, pendingKey(transactionId), actor)) {
    counts.removedPending += 1;
    return;
  }
  // A posted transaction Plaid removed: find it by any of the Item's accounts.
  let row: TxRow | undefined;
  for (const plaidAccountId of acctByPlaid.keys()) {
    row = await findTxByKey(db, householdId, idempotencyKey.plaid(plaidAccountId, transactionId));
    if (row) break;
  }
  if (!row) return;
  counts.removedPosted += 1;
  // Spec: removed posted transactions raise an Exception. Along an allowed arrow (sent_to_bc, bc_draft_created) the
  // state moves; before BC there is no arrow out, so the reason is recorded on the row (sync_status `difference`),
  // the item leaves the household's questions and waits in the Console's exception queue for Cade. The key stays.
  await raiseException(db, householdId, row.id, "The bank removed this transaction after it was recorded", row.state === "bc_draft_created" ? "poll" : "bc_worker", actor);
  await audit(db, householdId, { actor, action: "transaction.removed_by_feed", entity: "transaction", entityId: row.id, before: { state: row.state } });
}

async function markRelink(db: Queryable, householdId: string, feed: FeedRow, reason: string, actor: string): Promise<void> {
  await db.query("update feed_connections set status = 'needs_relink', needs_relink = true where id = $1", [feed.id]);
  await audit(db, householdId, { actor, action: "feed.needs_relink", entity: "feed_connection", entityId: feed.id, after: { reason } });
  // A calm card to the owner of that login only; alerts that depend on its accounts pause (alerts.ts reads needs_relink).
  const title = `${feed.institution_name ?? "A bank"} needs a fresh sign-in`;
  const alert: Omit<Alert, "id" | "createdAt"> = { kind: "needs_relink", level: "watch", fingerprint: `needs_relink:${feed.id}`, title, body: "The bank asked for a new login. Reconnect when you have a minute; nothing is lost in the meantime." };
  await db.query(
    "insert into alerts (household_id, member_id, kind, level, fingerprint, payload) values ($1,$2,$3,$4,$5,$6) on conflict do nothing",
    [householdId, feed.owner_member_id, alert.kind, alert.level, alert.fingerprint, JSON.stringify({ title: alert.title, body: alert.body, feedId: feed.id })],
  );
}

/** `/accounts/balance/get` once a day and before safe-to-spend; the balance shown always carries its timestamp. */
export async function refreshBalances(db: Queryable, householdId: string, feed: FeedRow, plaid: PlaidPort, secrets: SecretStore, now = new Date(), actor = "plaid-sync"): Promise<number> {
  if (feed.provider !== "plaid" || !feed.plaid_item_ref || feed.status === "disabled") return 0;
  const token = await secrets.get(feed.plaid_item_ref);
  if (!token) return 0;
  let balances: PlaidAccountBalance[];
  try {
    balances = await plaid.balanceGet(token);
  } catch (e) {
    if (e instanceof PlaidError && e.errorCode === "ITEM_LOGIN_REQUIRED") {
      await markRelink(db, householdId, feed, "ITEM_LOGIN_REQUIRED", actor);
      return 0;
    }
    throw e;
  }
  let n = 0;
  for (const b of balances) {
    const current = b.balances.current;
    if (current === null || current === undefined) continue;
    const acct = await db.query<{ id: string; kind: string }>("select id, kind from accounts where household_id = $1 and feed_connection_id = $2 and plaid_account_id = $3", [householdId, feed.id, b.account_id]);
    const a = acct.rows[0];
    if (!a) continue;
    // Plaid reports card balances as positive amounts owed; Homestead keeps cards negative like BC.
    const cents = Math.round(current * 100) * (a.kind === "card" || a.kind === "line" || a.kind === "loan" || a.kind === "mortgage" ? -1 : 1);
    await db.query("update accounts set balance_cents = $2, balance_as_of = $3 where id = $1", [a.id, cents, now.toISOString()]);
    n += 1;
  }
  return n;
}

/** Map a Plaid account onto a household account (after Link): by the account's mask or an explicit choice. */
export async function attachPlaidAccount(db: Queryable, householdId: string, feedConnectionId: string, accountId: string, plaidAccountId: string, actor: string): Promise<void> {
  await db.query("update accounts set feed_connection_id = $2, plaid_account_id = $3 where id = $1 and household_id = $4", [accountId, feedConnectionId, plaidAccountId, householdId]);
  await audit(db, householdId, { actor, action: "account.feed_attached", entity: "account", entityId: accountId, after: { feedConnectionId } });
}
