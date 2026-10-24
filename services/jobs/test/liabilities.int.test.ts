/**
 * Liabilities feed the minimum-payment bills only when Plaid describes an upcoming bill: a due date today or later and
 * a minimum above zero. Plaid's figures for a statement already due (or paid down to a $0 minimum) leave the known
 * bill alone (pilot, 10/23/2026: Capital One reported due 10/18 with a $0 minimum).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakePlaid, InMemorySecretStore, attachPlaidAccount, buildFakeDeps, closePool, linkItem, type SeedResult } from "@homestead/api";
import { plaidSyncHousehold } from "../src/jobs/feeds.js";
import { describeDb, inHh, seeded } from "./helpers.js";

describeDb("liabilities into bills", () => {
  let hh: SeedResult;
  const plaid = new FakePlaid();
  const secrets = new InMemorySecretStore();
  const token = "access-sandbox-public-cap";

  beforeAll(async () => {
    hh = await seeded("liab");
    await inHh(hh, async (db) => {
      const l = await linkItem(db, hh.householdId, hh.members.cade, plaid, secrets, { publicToken: "public-cap" });
      await attachPlaidAccount(db, hh.householdId, l.feedConnectionId, hh.accounts["CAPONE-CC"]!, "pa-cap", hh.members.cade);
    });
  });
  afterAll(async () => {
    await closePool();
  });

  const bill = () => inHh(hh, async (db) => (await db.query<{ next_due_date: string; amount_cents: number }>("select to_char(next_due_date, 'YYYY-MM-DD') as next_due_date, amount_cents::int from bills where household_id = $1 and name = 'Capital One · minimum'", [hh.householdId])).rows[0]!);

  it("leaves the bill alone for a past due date or a $0 minimum, and takes an upcoming one", async () => {
    const deps = buildFakeDeps({ plaid, secrets });
    const before = await bill();
    plaid.liabilities.set(token, [{ account_id: "pa-cap", kind: "credit", nextPaymentDueDate: "2026-10-18", minimumPaymentAmount: 0 }]);
    await inHh(hh, (db) => plaidSyncHousehold(db, hh.householdId, deps, new Date("2026-10-24T05:00:00Z")));
    expect(await bill()).toEqual(before);
    plaid.liabilities.set(token, [{ account_id: "pa-cap", kind: "credit", nextPaymentDueDate: "2026-11-17", minimumPaymentAmount: 371 }]);
    await inHh(hh, (db) => plaidSyncHousehold(db, hh.householdId, deps, new Date("2026-10-24T05:00:00Z")));
    expect(await bill()).toEqual({ next_due_date: "2026-11-17", amount_cents: 37100 });
  });
});
