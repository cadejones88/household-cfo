/**
 * Integration: Plaid read-only sync. Link stores the access token in the vault by name (the database holds only the
 * name and the Item ID); /transactions/sync pages apply in order with the cursor stored after each; a pending line is
 * replaced when the settled one arrives; a removed pending line is dropped; a removed posted line becomes an
 * exception for Cade; ITEM_LOGIN_REQUIRED marks the login for re-link and tells only its owner; balances carry
 * their timestamp; unlinking tells Plaid (/item/remove) before the vaulted token is deleted, and keeps the imported lines.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakePlaid, PlaidError, attachPlaidAccount, linkItem, listFeeds, refreshBalances, syncFeed, unlinkItem } from "../src/services/bankData/plaid.js";
import { InMemorySecretStore } from "../src/services/ports.js";
import { listQuestions } from "../src/services/questions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, count, describeDb, inHh, seeded } from "./helpers/db.js";

describeDb("Plaid sync", () => {
  let hh: SeedResult;
  const plaid = new FakePlaid();
  const secrets = new InMemorySecretStore();
  let feedId = "";
  const token = "access-sandbox-public-beehive";

  beforeAll(async () => {
    hh = await seeded("plaid", { today: "2026-10-20" });
    const linked = await inHh(hh, async (db) => {
      const l = await linkItem(db, hh.householdId, hh.members.vanessa, plaid, secrets, { publicToken: "public-beehive", institutionId: "ins_beehive", institutionName: "Beehive FCU" });
      await attachPlaidAccount(db, hh.householdId, l.feedConnectionId, hh.accounts["BEEHIVE-CHK"]!, "plaid-chk", hh.members.vanessa);
      return l;
    });
    feedId = linked.feedConnectionId;
    const tx = (id: string, amount: number, pending: boolean, extra: Record<string, unknown> = {}) => ({ transaction_id: id, account_id: "plaid-chk", amount, date: "2026-10-18", name: "SODALICIOUS REXBURG", merchant_name: "Sodalicious", pending, ...extra });
    plaid.queue(token, { added: [tx("p1", 20, true), tx("t1", 45.17, false, { merchant_name: "Maverik" }), tx("x9", 5, false, { account_id: "plaid-unknown" })], next_cursor: "c1", has_more: true });
    plaid.queue(token, { added: [tx("t2", 20.1, false, { pending_transaction_id: "p1" }), tx("p3", 9.99, true)], modified: [tx("t1", 46, false, { merchant_name: "Maverik" })], next_cursor: "c2", has_more: true });
    plaid.queue(token, { removed: [{ transaction_id: "p3" }, { transaction_id: "t1" }], next_cursor: "c3", has_more: false });
    plaid.balances.set(token, [{ account_id: "plaid-chk", balances: { current: 1234.56 } }]);
  });
  afterAll(async () => {
    await closePool();
  });

  it("vaults the access token by name; the database holds only the name and the Item ID", async () => {
    await inHh(hh, async (db) => {
      const f = (await listFeeds(db, hh.householdId))[0]!;
      expect(f).toMatchObject({ provider: "plaid", plaid_item_id: "item-public-beehive", owner_member_id: hh.members.vanessa });
      expect(f.plaid_item_ref).toMatch(/^plaid-/);
      expect(await secrets.get(f.plaid_item_ref!)).toBe(token);
      const raw = JSON.stringify((await db.query("select * from feed_connections where household_id = $1", [hh.householdId])).rows);
      expect(raw).not.toContain(token);
    });
  });

  it("applies the pages in order: pending replaced on settlement, removed pending dropped, removed posted raised for Cade", async () => {
    const r = await inHh(hh, async (db) => syncFeed(db, hh.householdId, (await listFeeds(db, hh.householdId))[0]!, plaid, secrets));
    expect(r).toEqual({ added: 2, pendingAdded: 2, settled: 1, modified: 1, removedPending: 1, removedPosted: 1, duplicates: 0, pages: 3, unknownAccounts: 1 });
    await inHh(hh, async (db) => {
      const rows = await db.query<{ idempotency_key: string; amount_cents: number; pending: boolean; state: string; exception_reason: string | null }>("select idempotency_key, amount_cents::int, pending, state, exception_reason from transactions where household_id = $1 order by idempotency_key", [hh.householdId]);
      expect(rows.rows.map((x) => [x.idempotency_key, x.amount_cents, x.pending, x.exception_reason])).toEqual([
        ["plaid:plaid-chk:t1", -4600, false, "The bank removed this transaction after it was recorded"],
        ["plaid:plaid-chk:t2", -2010, false, null],
      ]);
      expect((await listFeeds(db, hh.householdId))[0]!.cursor).toBe("c3");
      const qs = await listQuestions(db, hh.householdId, hh.members.cade);
      expect(qs.some((q) => q.merchant === "Maverik")).toBe(false);
    });
  });

  it("refreshes balances with their timestamp", async () => {
    const now = new Date("2026-10-20T14:00:00Z");
    const n = await inHh(hh, async (db) => refreshBalances(db, hh.householdId, (await listFeeds(db, hh.householdId))[0]!, plaid, secrets, now));
    expect(n).toBe(1);
    await inHh(hh, async (db) => {
      const a = await db.query<{ balance_cents: number; balance_as_of: Date }>("select balance_cents::int, balance_as_of from accounts where id = $1", [hh.accounts["BEEHIVE-CHK"]]);
      expect(a.rows[0]).toEqual({ balance_cents: 123456, balance_as_of: now });
    });
  });

  it("ITEM_LOGIN_REQUIRED marks the login for re-link and puts a calm card in front of its owner only", async () => {
    plaid.failNextSync = new PlaidError("ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "login required");
    const r = await inHh(hh, async (db) => syncFeed(db, hh.householdId, (await listFeeds(db, hh.householdId))[0]!, plaid, secrets));
    expect(r).toEqual({ relink: true });
    await inHh(hh, async (db) => {
      expect((await listFeeds(db, hh.householdId))[0]).toMatchObject({ status: "needs_relink", needs_relink: true });
      const a = await db.query<{ member_id: string; level: string; payload: { title: string } }>("select member_id, level, payload from alerts where household_id = $1 and kind = 'needs_relink'", [hh.householdId]);
      expect(a.rows).toEqual([{ member_id: hh.members.vanessa, level: "watch", payload: expect.objectContaining({ title: "Beehive FCU needs a fresh sign-in" }) }]);
      expect(await count(db, "select 1 from feed_connections where id = $1 and cursor = 'c3'", [feedId])).toBe(1);
    });
  });

  it("unlinking: only the owner; Plaid's /item/remove first, then the vaulted token is deleted; imported lines stay", async () => {
    const ref = (await inHh(hh, async (db) => (await listFeeds(db, hh.householdId))[0]!)).plaid_item_ref!;
    await expect(inHh(hh, (db) => unlinkItem(db, hh.householdId, hh.members.cade, feedId, secrets, plaid))).rejects.toThrow(/Only the person who connected/);
    expect(plaid.removed).toEqual([]);
    await inHh(hh, (db) => unlinkItem(db, hh.householdId, hh.members.vanessa, feedId, secrets, plaid));
    expect(plaid.removed).toEqual([token]);
    expect(await secrets.get(ref)).toBeUndefined();
    await inHh(hh, async (db) => {
      expect(await count(db, "select 1 from feed_connections where id = $1 and status = 'disabled' and plaid_item_ref is null and cursor is null", [feedId])).toBe(1);
      expect(await count(db, "select 1 from transactions where household_id = $1", [hh.householdId])).toBeGreaterThan(0);
      expect(await count(db, "select 1 from audit_log where household_id = $1 and action = 'feed.unlinked' and after->>'plaid' = 'removed'", [hh.householdId])).toBe(1);
    });
  });

  it("unlinking a login the person already revoked at my.plaid.com still deletes the token", async () => {
    const l = await inHh(hh, (db) => linkItem(db, hh.householdId, hh.members.cade, plaid, secrets, { publicToken: "public-capone", institutionId: "ins_capone", institutionName: "Capital One" }));
    const ref = (await inHh(hh, (db) => db.query<{ plaid_item_ref: string }>("select plaid_item_ref from feed_connections where id = $1", [l.feedConnectionId]))).rows[0]!.plaid_item_ref;
    expect(await secrets.get(ref)).toBeDefined();
    const gone = new FakePlaid();
    gone.removeItem = async () => { throw new PlaidError("INVALID_INPUT", "ITEM_NOT_FOUND", "gone", 400); };
    await inHh(hh, (db) => unlinkItem(db, hh.householdId, hh.members.cade, l.feedConnectionId, secrets, gone));
    expect(await secrets.get(ref)).toBeUndefined();
    await inHh(hh, async (db) => {
      expect(await count(db, "select 1 from feed_connections where id = $1 and status = 'disabled' and plaid_item_ref is null", [l.feedConnectionId])).toBe(1);
      expect(await count(db, "select 1 from audit_log where household_id = $1 and action = 'feed.unlinked' and after->>'plaid' = 'already_gone'", [hh.householdId])).toBe(1);
    });
  });
});
