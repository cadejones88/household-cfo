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
 *  - POST /link/token/create with { access_token } and no products launches Link in update mode for an existing Item
 *      (a fresh bank sign-in after ITEM_LOGIN_REQUIRED); no new public token is exchanged (https://plaid.com/docs/link/update-mode/)
 *  - POST /accounts/get { access_token } -> { accounts[]: { account_id, name, official_name, mask, type, subtype } } (no charge)
 *      (https://plaid.com/docs/api/accounts/#accountsget)
 *  - POST /item/remove { access_token, reason_code? } -> { request_id }: the token stops working, and for Transactions
 *      and Liabilities it is the only way to end the Item's subscription billing (https://plaid.com/docs/api/items/#itemremove)
 *  - Errors: { error_type, error_code, error_message }; ITEM_LOGIN_REQUIRED is error_code "ITEM_LOGIN_REQUIRED" of type ITEM_ERROR.
 *      (https://plaid.com/docs/errors/item/#item_login_required)
 *  - Webhooks: TRANSACTIONS / SYNC_UPDATES_AVAILABLE { item_id }, ITEM / ERROR { item_id, error }; verification by the
 *      Plaid-Verification JWT header (https://plaid.com/docs/api/webhooks/webhook-verification/).
 */
import { idempotencyKey, type Alert } from "@homestead/shared";
import { audit, enqueueOutbox, type Queryable } from "../../db/index.js";
import { badRequest, conflict, notFound } from "../../lib/errors.js";
import { detectPossibleDuplicate } from "../duplicates.js";
import { getSettings } from "../households.js";
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

/** One account on an Item, as /accounts/get (and Link's onSuccess metadata) describe it. Mask: last 2-4 characters. */
export interface PlaidItemAccount {
  account_id: string;
  name?: string;
  official_name?: string | null;
  mask?: string | null;
  type?: string;
  subtype?: string | null;
  /** Plaid's cached balances (refreshed with each transactions update); the real-time Balance product is not used. */
  balances?: { current?: number | null; available?: number | null; iso_currency_code?: string | null };
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

export interface LinkTokenInput {
  clientUserId: string;
  webhookUrl?: string;
  institutionId?: string;
  /** Update mode: a fresh bank sign-in for this Item (no products, no new public token). */
  accessToken?: string;
}

export interface PlaidPort {
  createLinkToken(input: LinkTokenInput): Promise<{ linkToken: string; expiration: string }>;
  exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }>;
  transactionsSync(accessToken: string, cursor: string | null): Promise<PlaidSyncPage>;
  balanceGet(accessToken: string): Promise<PlaidAccountBalance[]>;
  /** The Item's accounts (names and masks only); free, unlike balance. */
  accountsGet(accessToken: string): Promise<PlaidItemAccount[]>;
  liabilitiesGet(accessToken: string): Promise<PlaidLiability[]>;
  institutionsSearch(query: string): Promise<PlaidInstitution[]>;
  /** Ends Plaid's access to the Item; the access token is useless afterwards. */
  removeItem(accessToken: string): Promise<void>;
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
    if (!r.ok || typeof j["error_code"] === "string") {
      const type = String(j["error_type"] ?? "API_ERROR");
      const code = String(j["error_code"] ?? "UNKNOWN");
      // Plaid's type and code are safe to log (no tokens, no account data); its message text is not kept.
      throw new PlaidError(type, code, `Plaid request failed: ${type} ${code} (${path})`, r.status);
    }
    return j as T;
  }
  /**
   * Liabilities is requested as optional, so a bank without it still links. A Plaid team that has not been granted
   * Liabilities gets INVALID_PRODUCT for the whole request (production, 10/23/2026): then the token is made with
   * Transactions alone and the client stops asking until it restarts. Once granted, Reconnect (update mode) asks
   * for consent to Liabilities (additional_consented_products) on logins made before.
   */
  private liabilitiesRefused = false;
  async createLinkToken(input: LinkTokenInput): Promise<{ linkToken: string; expiration: string }> {
    const body = (withLiabilities: boolean) => ({
      user: { client_user_id: input.clientUserId },
      client_name: "Homestead",
      // Update mode names the Item instead of products; Plaid rejects products alongside an access token. It can
      // still ask the person to consent to Liabilities for a login made before Plaid granted it.
      ...(input.accessToken
        ? { access_token: input.accessToken, ...(withLiabilities ? { additional_consented_products: ["liabilities"] } : {}) }
        : { products: ["transactions"], ...(withLiabilities ? { optional_products: ["liabilities"] } : {}) }),
      country_codes: ["US"],
      language: "en",
      ...(input.webhookUrl ? { webhook: input.webhookUrl } : {}),
      ...(input.institutionId && !input.accessToken ? { institution_id: input.institutionId } : {}),
    });
    const ask = !this.liabilitiesRefused;
    try {
      const j = await this.call<{ link_token: string; expiration: string }>("/link/token/create", body(ask));
      return { linkToken: j.link_token, expiration: j.expiration };
    } catch (e) {
      if (!(ask && e instanceof PlaidError && e.errorCode === "INVALID_PRODUCT")) throw e;
      this.liabilitiesRefused = true;
      const j = await this.call<{ link_token: string; expiration: string }>("/link/token/create", body(false));
      return { linkToken: j.link_token, expiration: j.expiration };
    }
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
  async accountsGet(accessToken: string): Promise<PlaidItemAccount[]> {
    const j = await this.call<{ accounts: PlaidItemAccount[] }>("/accounts/get", { access_token: accessToken });
    return (j.accounts ?? []).map((a) => ({ account_id: a.account_id, ...(a.name ? { name: a.name } : {}), ...(a.official_name ? { official_name: a.official_name } : {}), mask: a.mask ?? null, ...(a.type ? { type: a.type } : {}), subtype: a.subtype ?? null, ...(a.balances ? { balances: { current: a.balances.current ?? null, available: a.balances.available ?? null, iso_currency_code: a.balances.iso_currency_code ?? null } } : {}) }));
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
  async removeItem(accessToken: string): Promise<void> {
    await this.call<{ request_id: string }>("/item/remove", { access_token: accessToken });
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

  /** The Item's accounts by access token, for /accounts/get. */
  readonly itemAccounts = new Map<string, PlaidItemAccount[]>();
  async createLinkToken(input: LinkTokenInput): Promise<{ linkToken: string; expiration: string }> {
    this.calls.push(input.accessToken ? `linkToken:update:${input.accessToken}` : "linkToken");
    return { linkToken: `link-sandbox-${input.accessToken ? "update-" : ""}${input.clientUserId}`, expiration: new Date(Date.now() + 4 * 3_600_000).toISOString() };
  }
  async accountsGet(accessToken: string): Promise<PlaidItemAccount[]> {
    this.calls.push("accounts");
    return this.itemAccounts.get(accessToken) ?? (this.balances.get(accessToken) ?? []).map((b) => ({ account_id: b.account_id, mask: b.mask ?? null, balances: b.balances }));
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
  readonly removed: string[] = [];
  async removeItem(accessToken: string): Promise<void> {
    this.calls.push("remove");
    this.removed.push(accessToken);
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

/**
 * Only the login's owner may remove it (authority matrix). Plaid is told first (/item/remove ends its access and
 * the Item's billing), then the token is deleted from the vault. Already-imported transactions stay: they are the
 * household's records under the retention schedule. An Item Plaid no longer knows (the person revoked it at
 * my.plaid.com) is still unlinked here.
 */
export async function unlinkItem(db: Queryable, householdId: string, memberId: string, feedConnectionId: string, secrets: SecretStore, plaid: PlaidPort): Promise<void> {
  const r = await db.query<{ owner_member_id: string; plaid_item_ref: string | null }>("select owner_member_id, plaid_item_ref from feed_connections where id = $1 and household_id = $2", [feedConnectionId, householdId]);
  const row = r.rows[0];
  if (!row) throw notFound("connection");
  if (row.owner_member_id !== memberId) throw badRequest("owner_only", "Only the person who connected this login can remove it");
  let plaidRemoved: "removed" | "already_gone" | "no_token" = "no_token";
  if (row.plaid_item_ref) {
    const token = await secrets.get(row.plaid_item_ref);
    if (token) {
      try {
        await plaid.removeItem(token);
        plaidRemoved = "removed";
      } catch (e) {
        if (!(e instanceof PlaidError && ["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"].includes(e.errorCode))) throw e;
        plaidRemoved = "already_gone";
      }
    }
    await secrets.delete(row.plaid_item_ref);
  }
  await db.query("update feed_connections set status = 'disabled', plaid_item_ref = null, cursor = null where id = $1", [feedConnectionId]);
  // The household's accounts are free again (for another login or statement files); their imported lines keep their keys.
  const detached = await db.query("update accounts set feed_connection_id = null, plaid_account_id = null where household_id = $1 and feed_connection_id = $2", [householdId, feedConnectionId]);
  await audit(db, householdId, { actor: memberId, action: "feed.unlinked", entity: "feed_connection", entityId: feedConnectionId, after: { plaid: plaidRemoved, accountsDetached: detached.rowCount ?? 0 } });
}

// Re-link (update mode) and which household accounts a login feeds ----------------------------------------------

export interface AccountMapping {
  /** Household account id. */
  accountId: string;
  plaidAccountId: string;
}

interface OwnedFeed {
  id: string;
  owner_member_id: string;
  plaid_item_ref: string | null;
  institution_name: string | null;
  status: string;
}

async function feedRow(db: Queryable, householdId: string, feedConnectionId: string): Promise<OwnedFeed> {
  const r = await db.query<OwnedFeed>("select id, owner_member_id, plaid_item_ref, institution_name, status from feed_connections where id = $1 and household_id = $2 and provider = 'plaid'", [feedConnectionId, householdId]);
  const row = r.rows[0];
  if (!row || row.status === "disabled") throw notFound("connection");
  return row;
}

async function ownedFeedToken(db: Queryable, householdId: string, memberId: string, feedConnectionId: string, secrets: SecretStore, action: string): Promise<{ feed: OwnedFeed; token: string }> {
  const feed = await feedRow(db, householdId, feedConnectionId);
  if (feed.owner_member_id !== memberId) throw badRequest("owner_only", `Only the person who connected this login can ${action}`);
  const token = feed.plaid_item_ref ? await secrets.get(feed.plaid_item_ref) : undefined;
  if (!token) throw conflict("no_token", "This login has no saved access; connect the bank again");
  return { feed, token };
}

/** A Link token in update mode for the login's owner: the bank asks for a fresh sign-in; the Item and its history stay. */
export async function createUpdateLinkToken(db: Queryable, householdId: string, memberId: string, feedConnectionId: string, plaid: PlaidPort, secrets: SecretStore, webhookUrl?: string): Promise<{ linkToken: string; expiration: string }> {
  const { token } = await ownedFeedToken(db, householdId, memberId, feedConnectionId, secrets, "reconnect it");
  return plaid.createLinkToken({ clientUserId: memberId, accessToken: token, ...(webhookUrl ? { webhookUrl } : {}) });
}

/**
 * After update mode succeeds: queue a sync for the Item. A successful sync clears needs_relink (syncFeed), so the
 * flag is never cleared on the browser's word alone.
 */
export async function markReconnected(db: Queryable, householdId: string, memberId: string, feedConnectionId: string): Promise<{ syncQueued: boolean }> {
  const feed = await feedRow(db, householdId, feedConnectionId);
  if (feed.owner_member_id !== memberId) throw badRequest("owner_only", "Only the person who connected this login can reconnect it");
  await enqueueSync(db, householdId, feedConnectionId, "reconnected");
  await audit(db, householdId, { actor: memberId, action: "feed.reconnected", entity: "feed_connection", entityId: feedConnectionId, after: { syncQueued: true } });
  return { syncQueued: true };
}

async function enqueueSync(db: Queryable, householdId: string, feedConnectionId: string, reason: string): Promise<void> {
  // Same shape as the webhook's sync request (routes/webhooks.ts); the outbox worker runs syncFeed for it.
  await enqueueOutbox(db, householdId, { aggregate: "transaction", aggregateId: feedConnectionId, operation: "plaid_sync", payload: { feedConnectionId, reason } });
}

/**
 * Checks a mapping against the household before anything is written: every account is the household's, none is
 * named twice, no Plaid account feeds two household accounts, and no household account is already fed by another
 * live login (unlink that one first). `feedConnectionId` is the login being mapped (absent while linking a new one).
 */
export async function checkMapping(db: Queryable, householdId: string, mapping: readonly AccountMapping[], feedConnectionId?: string): Promise<void> {
  const ids = mapping.map((m) => m.accountId);
  const plaidIds = mapping.map((m) => m.plaidAccountId);
  if (new Set(ids).size !== ids.length) throw badRequest("duplicate_account", "Each household account can take one bank account");
  if (new Set(plaidIds).size !== plaidIds.length) throw badRequest("duplicate_plaid_account", "Each bank account can feed one household account");
  if (ids.length === 0) return;
  const r = await db.query<{ id: string; display_name: string; feed_connection_id: string | null; feed_status: string | null; institution_name: string | null }>(
    `select a.id, a.display_name, a.feed_connection_id, f.status as feed_status, f.institution_name
       from accounts a left join feed_connections f on f.id = a.feed_connection_id
      where a.household_id = $1 and a.id = any($2::uuid[])`,
    [householdId, ids],
  );
  if (r.rows.length !== new Set(ids).size) throw badRequest("unknown_account", "One of those accounts is not in this household");
  const taken = r.rows.filter((a) => a.feed_connection_id && a.feed_connection_id !== feedConnectionId && a.feed_status !== "disabled");
  if (taken.length > 0) {
    const a = taken[0]!;
    throw conflict("account_already_connected", `${a.display_name} is already connected through ${a.institution_name ?? "another login"}; remove that login first`, { accountIds: taken.map((t) => t.id) });
  }
}

/** The Item's accounts from Plaid with the household account each one feeds. Either spouse may look (read-only). */
export async function feedAccounts(db: Queryable, householdId: string, feedConnectionId: string, plaid: PlaidPort, secrets: SecretStore): Promise<{ feedConnectionId: string; institutionName: string | null; ownerMemberId: string; accounts: (PlaidItemAccount & { accountId: string | null })[] }> {
  const feed = await feedRow(db, householdId, feedConnectionId);
  const token = feed.plaid_item_ref ? await secrets.get(feed.plaid_item_ref) : undefined;
  if (!token) throw conflict("no_token", "This login has no saved access; connect the bank again");
  const list = await plaid.accountsGet(token);
  const mapped = await db.query<{ id: string; plaid_account_id: string }>("select id, plaid_account_id from accounts where household_id = $1 and feed_connection_id = $2 and plaid_account_id is not null", [householdId, feedConnectionId]);
  const byPlaid = new Map(mapped.rows.map((m) => [m.plaid_account_id, m.id]));
  return { feedConnectionId, institutionName: feed.institution_name, ownerMemberId: feed.owner_member_id, accounts: list.map((a) => ({ ...a, accountId: byPlaid.get(a.account_id) ?? null })) };
}

/**
 * Replaces which household accounts this login feeds (the login's owner; the route requires step-up). Plaid account
 * ids must belong to the Item. When an account is newly attached, the stored cursor is cleared and a sync is queued:
 * transactions/sync then replays the Item's history, and the per-transaction keys make every line already imported
 * a no-op while the newly attached account's history comes in.
 */
export async function setFeedAccounts(db: Queryable, householdId: string, memberId: string, feedConnectionId: string, mapping: readonly AccountMapping[], plaid: PlaidPort, secrets: SecretStore): Promise<{ attached: number; detached: number; syncQueued: boolean }> {
  const { token } = await ownedFeedToken(db, householdId, memberId, feedConnectionId, secrets, "change its accounts");
  await checkMapping(db, householdId, mapping, feedConnectionId);
  const itemIds = new Set((await plaid.accountsGet(token)).map((a) => a.account_id));
  const stray = mapping.find((m) => !itemIds.has(m.plaidAccountId));
  if (stray) throw badRequest("unknown_plaid_account", "That bank account is not part of this login");
  const before = await db.query<{ id: string; plaid_account_id: string }>("select id, plaid_account_id from accounts where household_id = $1 and feed_connection_id = $2", [householdId, feedConnectionId]);
  const was = new Map(before.rows.map((b) => [b.id, b.plaid_account_id]));
  const wanted = new Map(mapping.map((m) => [m.accountId, m.plaidAccountId]));
  // Detach first so a Plaid account can move between household accounts without tripping the unique key.
  let detached = 0;
  for (const [id, plaidId] of was) {
    if (wanted.get(id) === plaidId) continue;
    await db.query("update accounts set feed_connection_id = null, plaid_account_id = null where id = $1 and household_id = $2", [id, householdId]);
    if (!wanted.has(id)) detached += 1;
  }
  let attached = 0;
  for (const [id, plaidId] of wanted) {
    if (was.get(id) === plaidId) continue;
    await db.query("update accounts set feed_connection_id = $2, plaid_account_id = $3 where id = $1 and household_id = $4", [id, feedConnectionId, plaidId, householdId]);
    attached += 1;
  }
  if (attached > 0) {
    await db.query("update feed_connections set cursor = null where id = $1", [feedConnectionId]);
    await enqueueSync(db, householdId, feedConnectionId, "accounts_changed");
  }
  await audit(db, householdId, {
    actor: memberId,
    action: "feed.accounts_set",
    entity: "feed_connection",
    entityId: feedConnectionId,
    before: { accounts: before.rows.map((b) => b.id) },
    after: { accounts: [...wanted.keys()], attached, detached, historyReplay: attached > 0 },
  });
  return { attached, detached, syncQueued: attached > 0 };
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
  /** Lines dated before the household's feedStartDate: already inside the opening balances, not imported. */
  beforeStart: number;
}

export function pendingKey(plaidTransactionId: string): string {
  return `pending:${plaidTransactionId}`;
}

/** Plaid amount is positive for money out; Homestead stores bank sign (negative = money out). */
export function toCents(plaidAmount: number): number {
  return -Math.round(plaidAmount * 100);
}

/**
 * Apply `/transactions/sync` pages in order for one Item. Lines dated before the household's feedStartDate are
 * skipped (they are inside the opening balances). Added pending rows get a `pending:` key; a settled
 * row with `pending_transaction_id` replaces its pending row; removed pending rows are dropped; removed posted
 * rows raise an exception. The cursor is stored after each page is applied so a crash resumes, never repeats.
 */
export async function syncFeed(db: Queryable, householdId: string, feed: FeedRow, plaid: PlaidPort, secrets: SecretStore, actor = "plaid-sync"): Promise<SyncCounts | { relink: true }> {
  const counts: SyncCounts = { added: 0, pendingAdded: 0, settled: 0, modified: 0, removedPending: 0, removedPosted: 0, duplicates: 0, pages: 0, unknownAccounts: 0, beforeStart: 0 };
  if (feed.provider !== "plaid" || !feed.plaid_item_ref || feed.status === "disabled") return counts;
  const startDate = (await getSettings(db, householdId)).feedStartDate;
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
      if (startDate && t.date < startDate) {
        counts.beforeStart += 1;
        continue;
      }
      await applyAdded(db, householdId, accountId, t, counts, actor);
    }
    for (const t of page.modified) {
      const accountId = acctByPlaid.get(t.account_id);
      if (!accountId || (startDate && t.date < startDate)) continue;
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
  // Cached balances from /accounts/get (part of every Item, no charge): the household needs today's balance, not a
  // real-time one, and the team has Transactions only (Balance is a separate product, not enabled, 10/23/2026).
  let balances: { account_id: string; balances: NonNullable<PlaidItemAccount["balances"]> }[];
  try {
    balances = (await plaid.accountsGet(token)).filter((a): a is PlaidItemAccount & { balances: NonNullable<PlaidItemAccount["balances"]> } => a.balances !== undefined);
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
