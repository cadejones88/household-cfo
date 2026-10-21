/**
 * Integration: the Console additions. Mapping proposals become a new category version once the other spouse
 * approves; posting status shows BC's own drafts per batch; reconciliation shows each card's open bank entries and
 * last statement; connection health says whether BC answers; the audit log filters by actor; receipts in the queue
 * name who captured them; Cade can classify a line the rule engine has not reached yet.
 */
import { externalDocumentNo, idempotencyKey, toBcDimensionSetLines } from "@homestead/shared";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildFakeDeps } from "../src/deps.js";
import { InMemoryLedger } from "../src/services/ledgerPort.js";
import { importTransaction, loadTx } from "../src/services/transactions.js";
import type { SeedResult } from "../src/db/seed.js";
import { closePool, describeDb, inHh, seeded } from "./helpers/db.js";
import { as } from "./helpers/http.js";

describeDb("Console additions", () => {
  let app: FastifyInstance;
  let hh: SeedResult;
  const ledger = new InMemoryLedger();
  beforeAll(async () => {
    hh = await seeded("console", { today: "2026-10-20" });
    app = await buildApp({ logger: false, deps: buildFakeDeps({ ledger, now: () => new Date("2026-10-20T16:00:00Z") }) });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await closePool();
  });

  it("a mapping proposal becomes the category's next version when the other spouse approves it", async () => {
    const bad = await app.inject({ method: "POST", url: "/v1/console/mappings/proposals", headers: as(hh.members.cade), payload: { categoryId: "treats", glAccount: "101101", dims: {}, reason: "x" } });
    expect(bad.json().error).toBe("gl_account");
    const p = await app.inject({ method: "POST", url: "/v1/console/mappings/proposals", headers: as(hh.members.cade), payload: { categoryId: "treats", glAccount: "603501", dims: { SPEND_CLASS: "DISCRETIONARY", FAMILY_AREA: "JOINT" }, reason: "Treats are eating out in the budget" } });
    expect(p.statusCode).toBe(201);
    expect(p.json().effect).toMatch(/Maps Coffee and treats to account 603501/);
    const m = (await app.inject({ method: "GET", url: "/v1/console/mappings", headers: as(hh.members.cade) })).json();
    expect(m.pendingProposals).toEqual([expect.objectContaining({ approvalId: p.json().id, categoryId: "treats", glAccount: "603501", requestedByName: "Cade" })]);
    const d = await app.inject({ method: "POST", url: `/v1/approvals/${p.json().id}/decide`, headers: as(hh.members.vanessa, true), payload: { decision: "approved" } });
    expect(d.statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/v1/console/mappings", headers: as(hh.members.cade) })).json();
    expect(after.categories.find((c: { id: string }) => c.id === "treats")).toMatchObject({ glAccount: "603501", version: 2, dims: { SPEND_CLASS: "DISCRETIONARY", FAMILY_AREA: "JOINT" } });
    expect(after.pendingProposals).toEqual([]);
    const settings = (await app.inject({ method: "GET", url: "/v1/console/settings", headers: as(hh.members.cade) })).json();
    expect(settings.version).toBe(1); // a mapping is not a settings change
  });

  it("posting status reads BC's own drafts per batch; reconciliation reads each card's bank ledger", async () => {
    const doc = externalDocumentNo(idempotencyKey.plaid("x", "draft-1"), "2026-10-15");
    await ledger.createJournalLines({ batch: "FEEDS", externalDocumentNo: doc, lines: [
      { lineNo: 10000, accountType: "Bank Account", accountNo: "BEEHIVE-CHK", amountCents: -2500, postingDate: "2026-10-15", description: "x", externalDocumentNo: doc, dimensions: [] },
      { lineNo: 20000, accountType: "G/L Account", accountNo: "603101", amountCents: 2500, postingDate: "2026-10-15", description: "x", externalDocumentNo: doc, dimensions: toBcDimensionSetLines({ SPEND_CLASS: "ESSENTIAL" }) },
    ] });
    const posting = (await app.inject({ method: "GET", url: "/v1/console/posting", headers: as(hh.members.cade) })).json();
    expect(posting.batches.find((b: { batch: string }) => b.batch === "FEEDS")).toMatchObject({ bcDraftCount: 1, bcDraftLines: 2, bcDraftSumCents: 2500, draftCreated: 0 });
    expect(posting.bcCheckedAt).toBeTruthy();
    await ledger.postBatch("FEEDS");
    const entry = ledger.bankLedgerEntries.find((e) => e.externalDocumentNo === doc)!;
    ledger.closeBankEntry(entry.entryNo, "STMT-0930", "2026-10-16");
    ledger.addNativeBankEntry({ bankAccountCode: "BEEHIVE-CHK", postingDate: "2026-10-18", amountCents: -4000, documentNo: "RJ-7" });
    const rec = (await app.inject({ method: "GET", url: "/v1/console/reconciliation", headers: as(hh.members.cade) })).json();
    expect(rec.accounts.find((a: { bcBankAccountCode: string }) => a.bcBankAccountCode === "BEEHIVE-CHK")).toMatchObject({ openCount: 1, openSumCents: -4000, bcReconciledCount: 1, lastStatementNo: "STMT-0930", reconciledThrough: "2026-10-16" });
  });

  it("connection health says BC answered; the audit log filters by actor", async () => {
    const c = (await app.inject({ method: "GET", url: "/v1/console/connections", headers: as(hh.members.cade) })).json();
    expect(c.ledger).toMatchObject({ apiReachable: true, checkedAt: expect.any(String) });
    const a = (await app.inject({ method: "GET", url: `/v1/console/audit?actor=${hh.members.vanessa}`, headers: as(hh.members.cade) })).json();
    expect(a.entries.length).toBeGreaterThan(0);
    expect(a.entries.every((e: { actor: string }) => e.actor === hh.members.vanessa)).toBe(true);
  });

  it("Cade classifies a line the rule engine has not reached; receipts in the queue name who captured them", async () => {
    const id = await inHh(hh, async (db) => {
      const t = await importTransaction(db, hh.householdId, { accountId: hh.accounts["CAPONE-CC"]!, source: "plaid", sourceRef: "hand-1", idempotencyKey: idempotencyKey.plaid("c", "hand-1"), postedDate: "2026-10-19", amountCents: -1299, merchantRaw: "SQ *THE MERC" }, "t");
      const { transition } = await import("../src/services/transactions.js");
      await transition(db, hh.householdId, t.transaction.id, "needs_classification", "jobs");
      await db.query("insert into receipts (household_id, member_id, blob_ref, sha256, captured_at, ocr_status) values ($1,$2,'x','abc123','2026-10-19T10:00:00Z','failed')", [hh.householdId, hh.members.vanessa]);
      return t.transaction.id;
    });
    const r = await app.inject({ method: "POST", url: `/v1/questions/${encodeURIComponent(`tx:${id}`)}/answer`, headers: as(hh.members.cade), payload: { optionId: "category:gifts" } });
    expect(r.statusCode).toBe(200);
    await inHh(hh, async (db) => expect(await loadTx(db, id)).toMatchObject({ state: "approved", category_id: "gifts" }));
    const q = (await app.inject({ method: "GET", url: "/v1/console/queues", headers: as(hh.members.cade) })).json();
    expect(q.receipts.find((x: { sha256: string }) => x.sha256 === "abc123")).toMatchObject({ memberName: "Vanessa", ocrStatus: "failed" });
  });
});
