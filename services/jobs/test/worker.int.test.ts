/**
 * Integration (homestead_e3 + MockBcServer behind the real adapter): the outbox relay and the BC worker. An approved
 * item reaches BC as one document with line ids stored; a 503 waits on the retry schedule; a timeout after a
 * successful write is found by the pre-write check, never doubled; a refused write dead-letters and becomes an
 * exception; the AUTOPOST job posts and reads back entry numbers; bank reconciliation in BC moves items to
 * Reconciled; the nightly poll raises differences with the keys on both sides; budget revisions reach the HH App
 * Connector; webhook subscriptions are created and renewed with their clientState.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { closePool, enqueueOutbox, loadTx, type InMemoryQueue, type SeedResult } from "@homestead/api";
import { externalDocumentNo, idempotencyKey, toBcDimensionSetLines } from "@homestead/shared";
import { runJob } from "../src/index.js";
import { approvedTx, bcCall, describeDb, inHh, mockBc, seeded } from "./helpers.js";

describeDb("outbox relay, BC worker, read-back and nightly poll", () => {
  let hh: SeedResult;
  const { server, deps } = mockBc();
  // The outbox's next_attempt_at defaults to the database's now(), so the jobs' clock starts at the real time.
  let clock = new Date();
  const later = (minutes: number) => new Date(clock.getTime() + minutes * 60_000);
  deps.now = () => clock;
  const run = (job: Parameters<typeof runJob>[0]) => {
    if (clock.getTime() < Date.now()) clock = new Date(); // rows written since are due
    return runJob(job, deps, [hh.householdId]);
  };

  beforeAll(async () => {
    hh = await seeded("worker");
  });
  afterAll(async () => {
    await closePool();
  });

  it("relays an approved item and writes it to HHAPP/FEEDS as one document with its line ids", async () => {
    const id = await approvedTx(hh);
    const r = await run("outbox-relay");
    expect(r).toMatchObject({ ok: 1, failed: 0 });
    const t = await inHh(hh, (db) => loadTx(db, id));
    expect(t).toMatchObject({ state: "bc_draft_created", sync_status: "in_sync" });
    const drafts = server.draftLines("FEEDS");
    expect(drafts.map((l) => [l.accountNumber, l.amount, l.externalDocumentNumber])).toEqual([["CAPONE-CC", -62.33, t.bc_external_doc_no], ["603101", 62.33, t.bc_external_doc_no]]);
    expect([...(t.bc_line_ids ?? [])].sort()).toEqual(drafts.map((d) => d.id).sort());
    expect((deps.queue as InMemoryQueue).depth("homestead-outbox")).toBe(0); // every message acknowledged
    expect(Object.fromEntries(drafts[1]!.dimensionSetLines.map((d) => [d.code, d.valueCode]))).toMatchObject({ SPEND_CLASS: "ESSENTIAL", FAMILY_AREA: "JOINT" });
    await inHh(hh, async (db) => {
      const split = await db.query<{ bc_line_id: string }>("select bc_line_id from transaction_splits where transaction_id = $1", [id]);
      expect(split.rows[0]!.bc_line_id).toBe(drafts[1]!.id);
      const runs = await db.query<{ kind: string; status: string }>("select kind, status from sync_runs where household_id = $1", [hh.householdId]);
      expect(runs.rows).toContainEqual({ kind: "outbox_relay", status: "ok" });
    });
  });

  it("a 503 waits for the next slot on the schedule; a timeout after the write is found by the pre-write check, not doubled", async () => {
    const id = await approvedTx(hh, { amountCents: -1999, merchant: "NETFLIX.COM", categoryId: "streaming" });
    server.failNext({ pathIncludes: "$batch" }, { status: 503, body: { error: { code: "ServiceUnavailable", message: "busy" } } });
    expect(await run("outbox-relay")).toMatchObject({ ok: 1 });
    const row = await inHh(hh, async (db) => (await db.query<{ attempts: number; next_attempt_at: Date; last_error: string }>("select attempts, next_attempt_at, last_error from outbox where aggregate_id = $1", [id])).rows[0]!);
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at.toISOString()).toBe(later(1).toISOString());
    expect(row.last_error).toBe("LedgerError 503 ServiceUnavailable: BC 503 ServiceUnavailable: busy");
    expect((await inHh(hh, (db) => loadTx(db, id))).state).toBe("sent_to_bc");
    // Second try: BC does the write but the connection drops before the reply.
    clock = later(2);
    server.cutConnectionAfterNext({ pathIncludes: "$batch" });
    await run("outbox-relay");
    const t1 = await inHh(hh, (db) => loadTx(db, id));
    expect(t1.state).toBe("sent_to_bc");
    // Third try: the pre-write check finds the lines the second try wrote.
    clock = later(10);
    await run("outbox-relay");
    const t2 = await inHh(hh, (db) => loadTx(db, id));
    expect(t2.state).toBe("bc_draft_created");
    expect(server.draftLines("FEEDS").filter((l) => l.externalDocumentNumber === t2.bc_external_doc_no)).toHaveLength(2);
  });

  it("a write BC refuses is dead-lettered and becomes an exception with the reason (no retry)", async () => {
    const id = await approvedTx(hh, { amountCents: -2599, merchant: "ULTA", categoryId: "beauty" });
    server.failNext({ pathIncludes: "$batch" }, { status: 400, body: { error: { code: "Internal_FieldNotFound", message: "bad" } } });
    await run("outbox-relay");
    const t = await inHh(hh, (db) => loadTx(db, id));
    expect(t).toMatchObject({ state: "exception", sync_status: "error" });
    expect(t.exception_reason).toMatch(/will not clear by retrying/);
    const ob = await inHh(hh, async (db) => (await db.query<{ dead_lettered: boolean }>("select dead_lettered from outbox where aggregate_id = $1", [id])).rows[0]!);
    expect(ob.dead_lettered).toBe(true);
    expect((deps.queue as InMemoryQueue).deadLetters).toHaveLength(1);
  });

  it("the AUTOPOST job posts the batch (switch on) and reads back entry numbers and the posting date", async () => {
    const id = await approvedTx(hh, { amountCents: -4517, merchant: "MAVERIK", categoryId: "fuel", batch: "AUTOPOST" });
    await run("outbox-relay");
    expect(server.draftLines("AUTOPOST")).toHaveLength(2);
    expect(await run("autopost-post")).toMatchObject({ ok: 1, counts: { [hh.householdId]: { enqueued: 0 } } }); // switch off: nothing
    await inHh(hh, (db) => db.query("update ledger_connections set auto_post_enabled = true where household_id = $1", [hh.householdId]));
    await run("autopost-post");
    const t = await inHh(hh, (db) => loadTx(db, id));
    expect(t.state).toBe("posted");
    expect(t.bc_entry_nos).toHaveLength(2);
    expect(t.bc_posting_date).toBe("2026-10-15");
    expect(server.draftLines("AUTOPOST")).toHaveLength(0);
    expect(server.postedEntries().filter((e) => e.externalDocumentNumber === t.bc_external_doc_no).every((e) => e.journalBatchName === "AUTOPOST")).toBe(true);
    await inHh(hh, (db) => db.query("update ledger_connections set auto_post_enabled = false where household_id = $1", [hh.householdId]));
  });

  it("Cade posts FEEDS in BC; the read-back marks the drafts Posted; bank reconciliation in BC marks them Reconciled", async () => {
    const res = await bcCall(server, "POST", `journals(${server.journalId("FEEDS")})/Microsoft.NAV.post`);
    expect(res.status).toBe(204);
    await run("bc-readback");
    const posted = await inHh(hh, async (db) => (await db.query<{ id: string; bc_external_doc_no: string }>("select id, bc_external_doc_no from transactions where household_id = $1 and state = 'posted' and bc_batch = 'FEEDS'", [hh.householdId])).rows);
    expect(posted).toHaveLength(2);
    for (const b of server.bankLedgerEntries().filter((e) => posted.some((p) => p.bc_external_doc_no === e.externalDocumentNo))) server.closeBankLedgerEntry(b.entryNo, "STMT-1031", b.entryNo, "2026-10-31");
    await run("bc-readback");
    const rec = await inHh(hh, async (db) => (await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and state = 'reconciled'", [hh.householdId])).rows[0]!.n);
    expect(rec).toBe(2);
  });

  it("the nightly poll raises a deleted draft as an exception and an unknown HHAPP document for Cade", async () => {
    const id = await approvedTx(hh, { amountCents: -3300, merchant: "WINCO", date: "2026-10-16" });
    await run("outbox-relay");
    const t = await inHh(hh, (db) => loadTx(db, id));
    // Cade deletes the draft in BC's own client.
    for (const lineId of t.bc_line_ids ?? []) expect((await bcCall(server, "DELETE", `journalLines(${lineId})`)).status).toBe(204);
    // A document with an HHAPP number that the app never wrote.
    const ghost = externalDocumentNo(idempotencyKey.manual("0b9f6a52-2b3c-4d5e-8f70-112233445566"), "2026-10-16");
    await deps.ledger.createJournalLines({ batch: "RECEIPTS", externalDocumentNo: ghost, lines: [
      { lineNo: 10000, accountType: "Bank Account", accountNo: "AFCU-CHK", amountCents: -1000, postingDate: "2026-10-16", description: "ghost", externalDocumentNo: ghost, dimensions: [] },
      { lineNo: 20000, accountType: "G/L Account", accountNo: "603101", amountCents: 1000, postingDate: "2026-10-16", description: "ghost", externalDocumentNo: ghost, dimensions: toBcDimensionSetLines({ SPEND_CLASS: "ESSENTIAL" }) },
    ] });
    const r = await run("nightly-poll");
    expect(r).toMatchObject({ ok: 1 });
    const counts = (r as { counts: Record<string, Record<string, number>> }).counts[hh.householdId]!;
    expect(counts["differences"]).toBe(1);
    expect(counts["batchDateDifferences"]).toBeGreaterThanOrEqual(2);
    const ex = await inHh(hh, (db) => loadTx(db, id));
    expect(ex).toMatchObject({ state: "exception", sync_status: "difference" });
    expect(ex.exception_reason).toMatch(/draft is gone/);
    expect(ex.sync_difference).toContain(t.idempotency_key);
    const alerts = await inHh(hh, async (db) => (await db.query<{ fingerprint: string }>("select fingerprint from alerts where household_id = $1 and kind = 'bc_unknown_document'", [hh.householdId])).rows);
    expect(alerts.map((a) => a.fingerprint)).toEqual([`bc_unknown_document:${ghost}`]);
    await inHh(hh, async (db) => expect((await db.query("select 1 from ledger_connections where household_id = $1 and last_poll_at is not null", [hh.householdId])).rowCount).toBe(1));
  });

  it("writes an approved budget revision through the HH App Connector", async () => {
    await inHh(hh, (db) => enqueueOutbox(db, hh.householdId, { aggregate: "budget_revision", aggregateId: hh.householdId, operation: "write_budget_revision", payload: { revisionId: hh.householdId, entries: [
      { budgetName: "BUD26-REV", glAccount: "603101", date: "2026-10-01", amountCents: 5000, dimensions: toBcDimensionSetLines({ SPEND_CLASS: "ESSENTIAL" }), description: "1" },
      { budgetName: "BUD26-REV", glAccount: "603501", date: "2026-10-01", amountCents: -5000, dimensions: toBcDimensionSetLines({ SPEND_CLASS: "FLEXIBLE" }), description: "1" },
    ] } }));
    await run("outbox-relay");
    const back = await deps.ledger.readBudget("BUD26-REV");
    expect(back.map((b) => [b.glAccount, b.amountCents])).toEqual([["603101", 5000], ["603501", -5000]]);
  });

  it("creates both webhook subscriptions, then renews them inside 24 hours of expiry with the stored clientState", async () => {
    clock = new Date(server.now());
    expect(await run("webhook-renewal")).toMatchObject({ ok: 1, counts: { [hh.householdId]: { created: 2 } } });
    expect(server.listSubscriptions().map((s) => s.resource.split("/").pop()).sort()).toEqual(["generalLedgerEntries", "journals"]);
    const states = await Promise.all(server.listSubscriptions().map(async (s) => s.clientState));
    expect(states.every((x) => x.length >= 24)).toBe(true);
    await inHh(hh, async (db) => {
      const subs = await db.query<{ client_state_ref: string }>("select client_state_ref from bc_webhook_subscriptions where household_id = $1", [hh.householdId]);
      for (const s of subs.rows) expect(states).toContain(await deps.secrets.get(s.client_state_ref));
      expect(JSON.stringify(subs.rows)).not.toContain(states[0]);
    });
    expect(await run("webhook-renewal")).toMatchObject({ counts: { [hh.householdId]: { kept: 2 } } });
    server.advanceTime(2.5 * 86_400_000);
    clock = new Date(server.now());
    expect(await run("webhook-renewal")).toMatchObject({ counts: { [hh.householdId]: { renewed: 2 } } });
    // BC drops one (a non-2xx reply, an environment update): the next run recreates it although it is not near expiry.
    const dropped = server.listSubscriptions().find((s) => s.resource.endsWith("journals"))!;
    await deps.ledger.deleteWebhookSubscription(dropped.id);
    expect(await run("webhook-renewal")).toMatchObject({ counts: { [hh.householdId]: { kept: 1, recreated: 1, created: 1 } } });
    expect(server.listSubscriptions()).toHaveLength(2);
  });
});
