/**
 * Integration through HTTP (app.inject, dev sign-in): connecting a bank and looking after the login afterwards.
 * Linking checks the household side of the mapping before the public token is exchanged; the login's accounts can be
 * read by either spouse and changed only by its owner with step-up; a newly attached account replays the Item's
 * history without duplicating lines already imported; update mode (a fresh bank sign-in) keeps the Item and queues a
 * sync; unlinking frees the household accounts for another login.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildFakeDeps, type Deps } from "../src/deps.js";
import { FakePlaid, PlaidError, listFeeds, syncFeed } from "../src/services/bankData/plaid.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, count, describeDb, inHh, seeded } from "./helpers/db.js";
import { as } from "./helpers/http.js";

describeDb("bank linking", () => {
  let app: FastifyInstance;
  let hh: SeedResult;
  let deps: Deps;
  let plaid: FakePlaid;
  let feedId = "";
  const token = "access-sandbox-public-capone";
  const tx = (id: string, account: string, amount: number) => ({ transaction_id: id, account_id: account, amount, date: "2026-10-18", name: "MAVERIK REXBURG", merchant_name: "Maverik", pending: false });

  beforeAll(async () => {
    hh = await seeded("banklink", { today: "2026-10-23" });
    plaid = new FakePlaid();
    deps = buildFakeDeps({ plaid });
    plaid.itemAccounts.set(token, [
      { account_id: "pa-card", name: "Quicksilver", mask: "6450", type: "credit", subtype: "credit card" },
      { account_id: "pa-card2", name: "Savor", mask: "1188", type: "credit", subtype: "credit card" },
    ]);
    app = await buildApp({ logger: false, deps });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it("says Plaid refused (502 with Plaid's code) instead of a bare 500", async () => {
    const orig = plaid.createLinkToken.bind(plaid);
    plaid.createLinkToken = async () => {
      throw new PlaidError("INVALID_INPUT", "INVALID_PRODUCT", "Plaid request failed: INVALID_INPUT INVALID_PRODUCT (/link/token/create)", 400);
    };
    try {
      const r = await app.inject({ method: "POST", url: "/v1/accounts/link-token", headers: as(hh.members.cade), payload: {} });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "plaid_error", details: { plaidCode: "INVALID_PRODUCT" } });
    } finally {
      plaid.createLinkToken = orig;
    }
  });

  it("gives the signed-in member a Link token", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/accounts/link-token", headers: as(hh.members.cade), payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ linkToken: expect.stringMatching(/^link-sandbox-/), expiration: expect.any(String) });
  });

  it("links only with step-up, and attaches the chosen accounts", async () => {
    const body = { publicToken: "public-capone", institutionId: "ins_capone", institutionName: "Capital One", accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-card" }] };
    const denied = await app.inject({ method: "POST", url: "/v1/accounts/link", headers: as(hh.members.cade), payload: body });
    expect(denied.statusCode).toBe(403);
    const r = await app.inject({ method: "POST", url: "/v1/accounts/link", headers: as(hh.members.cade, true), payload: body });
    expect(r.statusCode).toBe(201);
    feedId = r.json().feedConnectionId;
    await inHh(hh, async (db) => {
      // Plaid's update webhooks start only after the first /transactions/sync, so linking asks for one at once.
      expect(await count(db, "select 1 from outbox where household_id = $1 and operation = 'plaid_sync' and aggregate_id = $2 and payload->>'reason' = 'linked'", [hh.householdId, feedId])).toBe(1);
      const a = await db.query<{ feed_connection_id: string; plaid_account_id: string }>("select feed_connection_id, plaid_account_id from accounts where id = $1", [hh.accounts["CAPONE-CC"]]);
      expect(a.rows[0]).toEqual({ feed_connection_id: feedId, plaid_account_id: "pa-card" });
    });
  });

  it("refuses an account another live login already feeds, before any token is exchanged", async () => {
    const exchanges = plaid.calls.filter((c) => c === "exchange").length;
    const r = await app.inject({ method: "POST", url: "/v1/accounts/link", headers: as(hh.members.vanessa, true), payload: { publicToken: "public-capone-v", accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-other" }] } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "account_already_connected", message: expect.stringContaining("Capital One") });
    expect(plaid.calls.filter((c) => c === "exchange").length).toBe(exchanges);
    const dup = await app.inject({ method: "POST", url: "/v1/accounts/link", headers: as(hh.members.vanessa, true), payload: { publicToken: "public-x", accounts: [{ accountId: hh.accounts["AFCU-VISA"]!, plaidAccountId: "p1" }, { accountId: hh.accounts["AFCU-CHK"]!, plaidAccountId: "p1" }] } });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error).toBe("duplicate_plaid_account");
  });

  it("shows the login's bank accounts and what each feeds to either spouse", async () => {
    const r = await app.inject({ method: "GET", url: `/v1/accounts/feeds/${feedId}/accounts`, headers: as(hh.members.vanessa) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      feedConnectionId: feedId,
      institutionName: "Capital One",
      ownerMemberId: hh.members.cade,
      accounts: [
        { plaidAccountId: "pa-card", name: "Quicksilver", mask: "6450", type: "credit", subtype: "credit card", balance: null, accountId: hh.accounts["CAPONE-CC"] },
        { plaidAccountId: "pa-card2", name: "Savor", mask: "1188", type: "credit", subtype: "credit card", balance: null, accountId: null },
      ],
    });
    expect(JSON.stringify(r.json())).not.toContain(token);
  });

  it("changing the accounts: owner only, step-up, Item's own accounts only", async () => {
    const url = `/v1/accounts/feeds/${feedId}/accounts`;
    const payload = { accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-card" }, { accountId: hh.accounts["CARECREDIT"]!, plaidAccountId: "pa-card2" }] };
    expect((await app.inject({ method: "PUT", url, headers: as(hh.members.cade), payload })).statusCode).toBe(403);
    const notOwner = await app.inject({ method: "PUT", url, headers: as(hh.members.vanessa, true), payload });
    expect(notOwner.statusCode).toBe(400);
    expect(notOwner.json().error).toBe("owner_only");
    const stray = await app.inject({ method: "PUT", url, headers: as(hh.members.cade, true), payload: { accounts: [{ accountId: hh.accounts["CARECREDIT"]!, plaidAccountId: "pa-elsewhere" }] } });
    expect(stray.statusCode).toBe(400);
    expect(stray.json().error).toBe("unknown_plaid_account");
  });

  it("a newly attached account replays the Item's history; lines already imported are not imported twice", async () => {
    plaid.queue(token, { added: [tx("t1", "pa-card", 45.17), tx("t2", "pa-card2", 12)], next_cursor: "c1", has_more: false });
    const first = await inHh(hh, async (db) => syncFeed(db, hh.householdId, (await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)!, plaid, deps.secrets));
    expect(first).toMatchObject({ added: 1, unknownAccounts: 1 });

    const r = await app.inject({ method: "PUT", url: `/v1/accounts/feeds/${feedId}/accounts`, headers: as(hh.members.cade, true), payload: { accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-card" }, { accountId: hh.accounts["CARECREDIT"]!, plaidAccountId: "pa-card2" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ attached: 1, detached: 0, syncQueued: true });
    await inHh(hh, async (db) => {
      expect((await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)!.cursor).toBeNull();
      expect(await count(db, "select 1 from outbox where household_id = $1 and operation = 'plaid_sync' and aggregate_id = $2 and payload->>'reason' = 'accounts_changed'", [hh.householdId, feedId])).toBe(1);
      expect(await count(db, "select 1 from audit_log where household_id = $1 and action = 'feed.accounts_set' and after->>'historyReplay' = 'true'", [hh.householdId])).toBe(1);
    });

    plaid.queue(token, { added: [tx("t1", "pa-card", 45.17), tx("t2", "pa-card2", 12)], next_cursor: "c2", has_more: false });
    const replay = await inHh(hh, async (db) => syncFeed(db, hh.householdId, (await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)!, plaid, deps.secrets));
    expect(replay).toMatchObject({ added: 1, unknownAccounts: 0 });
    await inHh(hh, async (db) => {
      expect(await count(db, "select 1 from transactions where household_id = $1 and source = 'plaid'", [hh.householdId])).toBe(2);
    });
  });

  it("the first pull skips lines dated before the opening balances (feedStartDate)", async () => {
    plaid.queue(token, { added: [{ ...tx("old1", "pa-card", 80), date: "2026-09-30" }, { ...tx("old2", "pa-card", 9), date: "2026-08-02", pending: true }, { ...tx("new1", "pa-card", 7), date: "2026-10-01" }], modified: [{ ...tx("old1", "pa-card", 81), date: "2026-09-30" }], next_cursor: "c3", has_more: false });
    const r = await inHh(hh, async (db) => syncFeed(db, hh.householdId, (await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)!, plaid, deps.secrets));
    expect(r).toMatchObject({ added: 1, pendingAdded: 0, beforeStart: 2, modified: 0 });
    await inHh(hh, async (db) => {
      expect(await count(db, "select 1 from transactions where household_id = $1 and source_ref in ('old1', 'old2')", [hh.householdId])).toBe(0);
      expect(await count(db, "select 1 from transactions where household_id = $1 and source_ref = 'new1'", [hh.householdId])).toBe(1);
    });
  });

  it("moves a bank account between household accounts without tripping the one-to-one key", async () => {
    const r = await app.inject({ method: "PUT", url: `/v1/accounts/feeds/${feedId}/accounts`, headers: as(hh.members.cade, true), payload: { accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-card2" }, { accountId: hh.accounts["CARECREDIT"]!, plaidAccountId: "pa-card" }] } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ attached: 2, detached: 0 });
    const back = await app.inject({ method: "PUT", url: `/v1/accounts/feeds/${feedId}/accounts`, headers: as(hh.members.cade, true), payload: { accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-card" }] } });
    expect(back.json()).toMatchObject({ attached: 1, detached: 1 });
  });

  it("update mode: a Link token for the owner names the Item; finishing queues a sync instead of clearing the flag", async () => {
    const other = await app.inject({ method: "POST", url: `/v1/accounts/feeds/${feedId}/link-token`, headers: as(hh.members.vanessa) });
    expect(other.statusCode).toBe(400);
    const r = await app.inject({ method: "POST", url: `/v1/accounts/feeds/${feedId}/link-token`, headers: as(hh.members.cade) });
    expect(r.statusCode).toBe(200);
    expect(r.json().linkToken).toMatch(/^link-sandbox-update-/);
    expect(plaid.calls).toContain(`linkToken:update:${token}`);
    expect(JSON.stringify(r.json())).not.toContain(token);

    await inHh(hh, (db) => db.query("update feed_connections set needs_relink = true, status = 'needs_relink' where id = $1", [feedId]));
    const done = await app.inject({ method: "POST", url: `/v1/accounts/feeds/${feedId}/reconnected`, headers: as(hh.members.cade) });
    expect(done.json()).toEqual({ syncQueued: true });
    await inHh(hh, async (db) => {
      expect((await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)!.needs_relink).toBe(true);
      expect(await count(db, "select 1 from outbox where household_id = $1 and operation = 'plaid_sync' and payload->>'reason' = 'reconnected'", [hh.householdId])).toBe(1);
    });
    const synced = await inHh(hh, async (db) => syncFeed(db, hh.householdId, (await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)!, plaid, deps.secrets));
    expect(synced).not.toEqual({ relink: true });
    await inHh(hh, async (db) => expect((await listFeeds(db, hh.householdId)).find((f) => f.id === feedId)).toMatchObject({ needs_relink: false, status: "ok" }));
  });

  it("unlinking frees the household accounts for another login", async () => {
    const r = await app.inject({ method: "POST", url: `/v1/accounts/feeds/${feedId}/unlink`, headers: as(hh.members.cade, true) });
    expect(r.statusCode).toBe(200);
    expect(plaid.removed).toContain(token);
    await inHh(hh, async (db) => {
      expect(await count(db, "select 1 from accounts where household_id = $1 and feed_connection_id is not null", [hh.householdId])).toBe(0);
      expect(await count(db, "select 1 from audit_log where household_id = $1 and action = 'feed.unlinked' and after->>'accountsDetached' = '1'", [hh.householdId])).toBe(1);
    });
    expect((await app.inject({ method: "GET", url: `/v1/accounts/feeds/${feedId}/accounts`, headers: as(hh.members.cade) })).statusCode).toBe(404);
    const again = await app.inject({ method: "POST", url: "/v1/accounts/link", headers: as(hh.members.vanessa, true), payload: { publicToken: "public-capone-v2", accounts: [{ accountId: hh.accounts["CAPONE-CC"]!, plaidAccountId: "pa-v" }] } });
    expect(again.statusCode).toBe(201);
  });
});
