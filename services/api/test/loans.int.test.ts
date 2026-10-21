/**
 * Integration: the Console's loan rollforward. The opening balance, the month's principal, interest, fees and escrow
 * come from BC's G/L by the accounts the recurring journals post to (shared LOANS); the matched BC-native payment
 * comes from the app's R7 match. Figures use the mortgage split from sandbox test T08.
 */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildFakeDeps } from "../src/deps.js";
import { InMemoryLedger, type GlEntry } from "../src/services/ledgerPort.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, describeDb, inHh, seeded } from "./helpers/db.js";
import { as } from "./helpers/http.js";

function gl(entryNo: number, postingDate: string, accountNo: string, amountCents: number): GlEntry {
  return { entryNo, postingDate, accountNo, amountCents, documentNo: `GJ-${entryNo}`, externalDocumentNo: "", dimensions: [] };
}

describeDb("Console loan rollforward", () => {
  let app: FastifyInstance;
  let hh: SeedResult;
  const ledger = new InMemoryLedger();

  beforeAll(async () => {
    hh = await seeded("loans", { today: "2026-10-20" });
    // Opening balances at 9/30/2026 (records/bc-setup/Opening Balances 2026-09-30.csv), as credits.
    ledger.glEntries.push(gl(1, "2026-09-30", "271101", -71928989), gl(2, "2026-09-30", "251101", -6003492), gl(3, "2026-09-30", "251201", -9576578));
    // October mortgage payment split (T08): principal 598.84, escrow 1,990.84 deposit shown here as 650.91, interest + PMI.
    ledger.glEntries.push(gl(10, "2026-10-01", "271101", 59884), gl(11, "2026-10-01", "601101", 442064), gl(12, "2026-10-01", "601102", 19986), gl(13, "2026-10-01", "121101", 65091));
    // October Suburban payment: principal 697.42, interest 349.69 (sums to 1,047.11).
    ledger.glEntries.push(gl(20, "2026-10-16", "251101", 69742), gl(21, "2026-10-16", "711501", 34969));
    // An entry on another account the rollforward must ignore.
    ledger.glEntries.push(gl(30, "2026-10-05", "603101", 4213));
    await inHh(hh.householdId, async (db) => {
      const acct = await db.query<{ id: string }>("select id from accounts where household_id = $1 and bc_bank_account_code = 'AFCU-CHK'", [hh.householdId]);
      await db.query(
        `insert into transactions (household_id, account_id, source, source_ref, idempotency_key, posted_date, amount_cents, merchant_raw, kind, state, bc_bank_ledger_entry_no)
         values ($1, $2, 'plaid', 'pm-oct', 'plaid:loans:pm-oct', '2026-10-01', -567039, 'PENNYMAC LOAN SERVICES', 'bc_native', 'imported', 7001)`,
        [hh.householdId, acct.rows[0]!.id],
      );
    });
    app = await buildApp({ logger: false, deps: buildFakeDeps({ ledger, now: () => new Date("2026-10-20T16:00:00Z") }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it("rolls each loan forward from BC's G/L for the current month", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/console/reconciliation", headers: as(hh.members.cade) });
    expect(r.statusCode).toBe(200);
    const loans = r.json().loans as Array<Record<string, unknown>>;
    expect(loans.map((l) => l["id"])).toEqual(["pennymac", "frontier-suburban", "frontier-f350"]);

    const pm = loans[0]!;
    expect(pm).toMatchObject({ period: "2026-10", glAccount: "271101", openingCents: 71928989, principalCents: 59884, interestCents: 442064, feesCents: 19986, escrowCents: 65091, closingCents: 71928989 - 59884, matchedEntryNo: 7001, matchedAt: "2026-10-01" });
    expect(pm["nextDueDate"]).toMatch(/^\d{4}-\d{2}-01$/);

    const sub = loans[1]!;
    expect(sub).toMatchObject({ openingCents: 6003492, principalCents: 69742, interestCents: 34969, feesCents: 0, closingCents: 6003492 - 69742 });
    expect(sub["escrowCents"]).toBeUndefined();
    expect(sub["matchedEntryNo"]).toBeUndefined();

    const f350 = loans[2]!;
    expect(f350).toMatchObject({ openingCents: 9576578, principalCents: 0, interestCents: 0, closingCents: 9576578 });
  });

  it("says the loans are unavailable instead of estimating when BC does not answer", async () => {
    const original = ledger.readGlEntriesByExternalDocNo.bind(ledger);
    ledger.readGlEntriesByExternalDocNo = async () => {
      throw new Error("BC is down");
    };
    try {
      const r = (await app.inject({ method: "GET", url: "/v1/console/reconciliation", headers: as(hh.members.cade) })).json();
      expect(r.loans).toBeUndefined();
      expect(r.loansUnavailable).toBe(true);
    } finally {
      ledger.readGlEntriesByExternalDocNo = original;
    }
  });
});
