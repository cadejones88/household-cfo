/**
 * Integration: the duplicate-import test from the spec. The same CSV twice adds nothing (same keys), the
 * overlapping OFX marks Possible Duplicates for a person (never merged silently), "same thing" drops the row and
 * keeps its key so a third import cannot bring it back, "not a repeat" lets it continue.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { importFile } from "../src/services/bankData/fileImport.js";
import { answerQuestion, listQuestions } from "../src/services/questions.js";
import { loadTx } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, count, describeDb, inHh, seeded } from "./helpers/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const csv = new Uint8Array(readFileSync(path.join(here, "fixtures/files/beehive-2026-10.csv")));
const ofx = new Uint8Array(readFileSync(path.join(here, "fixtures/files/beehive-2026-10.ofx")));

describeDb("duplicate import", () => {
  let hh: SeedResult;
  let acct: string;
  beforeAll(async () => {
    hh = await seeded("dup", { today: "2026-10-20" });
    acct = hh.accounts["BEEHIVE-CHK"]!;
  });
  afterAll(async () => {
    await closePool();
  });

  it("imports the CSV once; the same file again adds no row and no second key", async () => {
    const first = await inHh(hh, (db) => importFile(db, hh.householdId, { accountId: acct, profileName: "Beehive FCU CSV", bytes: csv }, hh.members.cade));
    expect(first).toMatchObject({ parsed: 6, imported: 6, alreadyHeld: 0, possibleDuplicates: 0 });
    const second = await inHh(hh, (db) => importFile(db, hh.householdId, { accountId: acct, profileName: "Beehive FCU CSV", bytes: csv }, hh.members.cade));
    expect(second).toMatchObject({ parsed: 6, imported: 0, alreadyHeld: 6 });
    await inHh(hh, async (db) => {
      expect(await count(db, "select 1 from transactions where household_id = $1 and source = 'csv'", [hh.householdId])).toBe(6);
      // Two identical $4.50 charges on one day stay two rows (sequence within the day in the key).
      expect(await count(db, "select 1 from transactions where household_id = $1 and merchant_norm like 'sodalicious%'", [hh.householdId])).toBe(2);
      expect(await count(db, "select idempotency_key from transactions where household_id = $1 group by idempotency_key having count(*) > 1", [hh.householdId])).toBe(0);
      const run = await db.query<{ status: string; counts: { imported: number } }>("select status, counts from sync_runs where household_id = $1 and kind = 'file_import' order by started_at desc limit 1", [hh.householdId]);
      expect(run.rows[0]).toMatchObject({ status: "ok", counts: { imported: 0 } });
    });
  });

  it("marks the overlapping OFX rows as Possible Duplicates of the CSV rows, never merging them", async () => {
    const r = await inHh(hh, (db) => importFile(db, hh.householdId, { accountId: acct, profileName: "OFX/QFX (any bank)", bytes: ofx }, hh.members.cade));
    expect(r).toMatchObject({ parsed: 3, imported: 3, possibleDuplicates: 2 });
    await inHh(hh, async (db) => {
      const dups = await db.query<{ merchant_raw: string; duplicate_of_id: string; source: string }>("select merchant_raw, duplicate_of_id, source from transactions where household_id = $1 and state = 'possible_duplicate' order by posted_date", [hh.householdId]);
      expect(dups.rows.map((d) => [d.source, d.merchant_raw])).toEqual([["ofx", "MAVERIK 417 REXBURG ID"], ["ofx", "BROULIMS"]]);
      for (const d of dups.rows) expect((await loadTx(db, d.duplicate_of_id)).source).toBe("csv");
      expect(await count(db, "select 1 from transactions where household_id = $1 and source = 'ofx'", [hh.householdId])).toBe(3);
    });
  });

  it("asks a person; 'same thing' drops the row and keeps its key, 'not a repeat' lets it continue", async () => {
    const qs = await inHh(hh, (db) => listQuestions(db, hh.householdId, hh.members.vanessa));
    const dupQs = qs.filter((q) => q.kind === "possible_duplicate");
    expect(dupQs).toHaveLength(2);
    expect(dupQs[0]!.why).toMatch(/never counts twice/);
    const [maverik, broulims] = dupQs;
    await inHh(hh, (db) => answerQuestion(db, hh.householdId, hh.members.vanessa, maverik!.id, { optionId: "same_thing", stepUp: false }));
    await inHh(hh, (db) => answerQuestion(db, hh.householdId, hh.members.cade, broulims!.id, { optionId: "not_repeat", stepUp: false }));
    await inHh(hh, async (db) => {
      expect((await loadTx(db, maverik!.transactionId!)).state).toBe("dropped");
      expect((await loadTx(db, broulims!.transactionId!)).state).toBe("needs_classification");
    });
    const third = await inHh(hh, (db) => importFile(db, hh.householdId, { accountId: acct, profileName: "OFX/QFX (any bank)", bytes: ofx }, hh.members.cade));
    expect(third).toMatchObject({ imported: 0, alreadyHeld: 3, possibleDuplicates: 0 });
    await inHh(hh, async (db) => expect((await loadTx(db, maverik!.transactionId!)).state).toBe("dropped"));
  });
});
