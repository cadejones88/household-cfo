/**
 * The LedgerPort shim over the real Business Central adapter, run against the adapter's MockBcServer (in process,
 * no network): master data, the pre-write check, one change set per document, post and read-back with the five
 * dimensions, bank ledger entries, the nightly poll's document list, goals' balance read, budgets (ORIG refused),
 * subscriptions with clientState, and the error translation the BC worker's retry policy reads.
 */
import { BANK_CARD_LIST, CHART, externalDocumentNo, idempotencyKey, toBcDimensionSetLines } from "@homestead/shared";
import { MockBcServer } from "@homestead/ledger-adapter-bc";
import { describe, expect, it } from "vitest";
import { LedgerError, type LedgerJournalLine } from "../src/services/ledgerPort.js";
import { bcLedgerPortForMock, prefixUpperBound } from "../src/services/ledgerPortBc.js";

function receiver() {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const token = new URL(url).searchParams.get("validationToken");
    if (token) return new Response(token, { status: 200, headers: { "content-type": "text/plain" } });
    void init;
    return new Response("", { status: 202 });
  };
}

function setup() {
  const server = new MockBcServer({ deliver: receiver(), budgets: ["BUD26-REV"] });
  return { server, port: bcLedgerPortForMock(server) };
}

function doc(key: string, date = "2026-10-15") {
  return externalDocumentNo(key, date);
}

/** A Walmart split as services/api's buildJournalLines produces it: bank side first, then one G/L line per split. */
function walmartLines(ext: string, date = "2026-10-15", bank = "CAPONE-CC"): LedgerJournalLine[] {
  const g = { SPEND_CLASS: "ESSENTIAL", FUND_GOAL: "OPERATING", FAMILY_AREA: "JOINT", TAX_TREATMENT: "NONDEDUCT" } as const;
  return [
    { lineNo: 10000, accountType: "Bank Account", accountNo: bank, amountCents: -4250, postingDate: date, description: "Walmart", externalDocumentNo: ext, dimensions: [] },
    { lineNo: 20000, accountType: "G/L Account", accountNo: "603101", amountCents: 3000, postingDate: date, description: "Groceries", externalDocumentNo: ext, dimensions: toBcDimensionSetLines(g) },
    { lineNo: 30000, accountType: "G/L Account", accountNo: "603301", amountCents: 1250, postingDate: date, description: "Household", externalDocumentNo: ext, dimensions: toBcDimensionSetLines(g) },
  ];
}

describe("BcLedgerPort over MockBcServer", () => {
  it("lists the chart, the five dimensions and the bank cards with their G/L accounts", async () => {
    const { port } = setup();
    expect((await port.listAccounts()).map((a) => a.number)).toEqual(CHART.map((a) => a.no));
    expect((await port.listDimensions()).map((d) => d.code).sort()).toEqual(["FAMILY_AREA", "FUND_GOAL", "PROJECT", "SPEND_CLASS", "TAX_TREATMENT"]);
    const banks = await port.listBankAccounts();
    expect(banks.map((b) => [b.code, b.glAccount])).toEqual(BANK_CARD_LIST.map((b) => [b.code, b.glAccount]));
  });

  it("writes one document in one change set; a resend finds it (already_in_journal) and writes nothing", async () => {
    const { server, port } = setup();
    const ext = doc(idempotencyKey.plaid("acct-1", "txn-1"));
    const first = await port.createJournalLines({ batch: "RECEIPTS", externalDocumentNo: ext, lines: walmartLines(ext) });
    expect(first.outcome).toBe("written");
    expect(first.lineIds).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      const again = await port.createJournalLines({ batch: "RECEIPTS", externalDocumentNo: ext, lines: walmartLines(ext) });
      expect(again.outcome).toBe("already_in_journal");
    }
    expect(server.draftLines("RECEIPTS")).toHaveLength(3);
    const found = await port.findByExternalDocumentNo(ext);
    expect(found).toMatchObject({ externalDocumentNo: ext, batch: "RECEIPTS", glEntryNos: [], lineCount: 3, sumCents: 0 });
    expect([...found.journalLineIds].sort()).toEqual([...first.lineIds].sort());
    const dims = Object.fromEntries(server.draftLines("RECEIPTS")[1]!.dimensionSetLines.map((d) => [d.code, d.valueCode]));
    expect(dims).toEqual({ SPEND_CLASS: "ESSENTIAL", FUND_GOAL: "OPERATING", FAMILY_AREA: "JOINT", TAX_TREATMENT: "NONDEDUCT" });
  });

  it("posts the batch and reads back entry numbers, the document no. and dimensions; a resend is already_posted", async () => {
    const { port } = setup();
    const ext = doc(idempotencyKey.plaid("acct-1", "txn-2"));
    await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines: walmartLines(ext) });
    await port.postBatch("FEEDS");
    const entries = await port.readGlEntriesByExternalDocNo({ externalDocumentNo: ext });
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.documentNo)).size).toBe(1);
    expect(entries.map((e) => e.accountNo).sort()).toEqual(["201101", "603101", "603301"]);
    expect(entries.reduce((s, e) => s + e.amountCents, 0)).toBe(0);
    expect(entries.find((e) => e.accountNo === "603101")!.dimensions).toEqual(expect.arrayContaining([{ code: "SPEND_CLASS", valueCode: "ESSENTIAL" }]));
    const found = await port.findByExternalDocumentNo(ext);
    expect(found.glEntryNos).toHaveLength(3);
    expect(found.journalLineIds).toEqual([]);
    const resend = await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines: walmartLines(ext) });
    expect(resend).toMatchObject({ outcome: "already_posted", lineIds: [] });
    expect(resend.glEntryNos).toHaveLength(3);
  });

  it("reads bank ledger entries and BC's bank reconciliation closing them", async () => {
    const { server, port } = setup();
    const ext = doc(idempotencyKey.plaid("acct-1", "txn-3"));
    await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines: walmartLines(ext) });
    await port.postBatch("FEEDS");
    const open = await port.readBankLedgerEntries({ bankAccountCode: "CAPONE-CC", externalDocumentNo: ext });
    expect(open).toEqual([expect.objectContaining({ bankAccountCode: "CAPONE-CC", amountCents: -4250, open: true, reversed: false, externalDocumentNo: ext })]);
    server.closeBankLedgerEntry(open[0]!.entryNo, "STMT-2026-10", 4, "2026-10-31");
    const closed = await port.readBankLedgerEntries({ bankAccountCode: "CAPONE-CC", externalDocumentNo: ext });
    expect(closed[0]).toMatchObject({ open: false, statementNo: "STMT-2026-10", statementLineNo: 4, closedAtDate: "2026-10-31" });
  });

  it("lists the app's documents (drafts and posted, with their batch) for the nightly poll", async () => {
    const { port } = setup();
    const a = doc(idempotencyKey.plaid("acct-1", "p1"), "2026-10-10");
    const b = doc(idempotencyKey.plaid("acct-1", "p2"), "2026-10-11");
    await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: a, lines: walmartLines(a, "2026-10-10") });
    await port.postBatch("FEEDS");
    await port.createJournalLines({ batch: "RECEIPTS", externalDocumentNo: b, lines: walmartLines(b, "2026-10-11") });
    const rows = await port.listAppDocuments({ externalDocumentNoStartsWith: "HHAPP-", postingDateFrom: "2026-09-01" });
    expect(rows.filter((r) => r.source === "ledger").map((r) => [r.externalDocumentNo, r.batch])).toEqual([[a, "FEEDS"], [a, "FEEDS"], [a, "FEEDS"]]);
    expect(rows.filter((r) => r.source === "journal").map((r) => r.batch)).toEqual(["RECEIPTS", "RECEIPTS", "RECEIPTS"]);
    const posted = await port.readGlEntriesByExternalDocNo({ externalDocumentNoStartsWith: "HHAPP-", postingDateFrom: "2026-09-01" });
    expect(posted.map((e) => e.externalDocumentNo)).toEqual([a, a, a]);
  });

  it("reads FUND_GOAL balances on the cash accounts by account-number prefix (goals and set-asides)", async () => {
    const { port } = setup();
    expect(prefixUpperBound("10")).toBe("11");
    const ext = doc(idempotencyKey.manual("6f1c2e1a-1111-4111-8111-111111111111"), "2026-10-01");
    const lines: LedgerJournalLine[] = [
      { lineNo: 10000, accountType: "Bank Account", accountNo: "BEEHIVE-SAV", amountCents: 200000, postingDate: "2026-10-01", description: "Emergency fund deposit", externalDocumentNo: ext, dimensions: toBcDimensionSetLines({ FUND_GOAL: "EMERG-1M", FAMILY_AREA: "JOINT" }) },
      { lineNo: 20000, accountType: "G/L Account", accountNo: "115101", amountCents: -200000, postingDate: "2026-10-01", description: "Transfer", externalDocumentNo: ext, dimensions: toBcDimensionSetLines({ SPEND_CLASS: "TRANSFER" }) },
    ];
    await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines });
    await port.postBatch("FEEDS");
    const cash = await port.readGlEntriesByExternalDocNo({ accountNoPrefix: "10" });
    expect(cash.map((e) => [e.accountNo, e.amountCents])).toEqual([["102101", 200000]]);
    expect(cash[0]!.dimensions).toEqual(expect.arrayContaining([{ code: "FUND_GOAL", valueCode: "EMERG-1M" }]));
    expect(await port.readGlEntriesByExternalDocNo({ accountNoPrefix: "10", dimension: { code: "FUND_GOAL", valueCode: "SINK-GIFTS" } })).toEqual([]);
  });

  it("writes a budget revision, reads it back, and refuses an -ORIG budget without calling BC", async () => {
    const { server, port } = setup();
    const lines = toBcDimensionSetLines({ SPEND_CLASS: "ESSENTIAL", FUND_GOAL: "OPERATING" });
    const r = await port.writeBudgetEntries([
      { budgetName: "BUD26-REV", glAccount: "603101", date: "2026-10-01", amountCents: 5000, dimensions: lines, description: "1" },
      { budgetName: "BUD26-REV", glAccount: "603501", date: "2026-10-01", amountCents: -5000, dimensions: lines, description: "1" },
    ]);
    expect(r.written).toBe(2);
    const back = await port.readBudget("BUD26-REV");
    expect(back.map((b) => [b.glAccount, b.amountCents, b.description])).toEqual([["603101", 5000, "1"], ["603501", -5000, "1"]]);
    expect(back[0]!.dimensions).toEqual(lines);
    const calls = server.log.length;
    const err = await port.writeBudgetEntries([{ budgetName: "2026-ORIG", glAccount: "603101", date: "2026-10-01", amountCents: 1, dimensions: [], description: "1" }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerError);
    expect(err).toMatchObject({ retryable: false, code: "refused_by_adapter" });
    expect(server.log.length).toBe(calls);
  });

  it("creates and renews webhook subscriptions, resending the clientState; renewal without it is refused", async () => {
    const { server, port } = setup();
    const sub = await port.createWebhookSubscription("generalLedgerEntries", "https://homestead.example.invalid/v1/webhooks/bc", "client-state-secret");
    expect(sub.subscriptionId).toBeTruthy();
    expect(server.listSubscriptions()).toHaveLength(1);
    const before = Date.parse(sub.expiresAt);
    server.advanceTime(60_000);
    const renewed = await port.renewWebhookSubscription(sub.subscriptionId, "client-state-secret");
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(before);
    await expect(port.renewWebhookSubscription(sub.subscriptionId)).rejects.toMatchObject({ code: "client_state_required", retryable: false });
    await port.deleteWebhookSubscription(sub.subscriptionId);
    expect(server.listSubscriptions()).toHaveLength(0);
  });

  it("translates BC errors: 503 and a dropped connection retry, a bad account dead-letters", async () => {
    const { server, port } = setup();
    const ext = doc(idempotencyKey.plaid("acct-1", "e1"));
    server.failNext({ pathIncludes: "$batch" }, { status: 503, body: { error: { code: "ServiceUnavailable", message: "busy" } } });
    const busy = await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines: walmartLines(ext) }).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(LedgerError);
    expect(busy).toMatchObject({ retryable: true, status: 503 });
    server.cutConnectionAfterNext({ pathIncludes: "$batch" });
    const cut = await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines: walmartLines(ext) }).catch((e: unknown) => e);
    expect(cut).toMatchObject({ retryable: true });
    // The retry after a timeout-after-write finds the first write instead of doubling it.
    expect((await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: ext, lines: walmartLines(ext) })).outcome).toBe("already_in_journal");
    expect(server.draftLines("FEEDS")).toHaveLength(3);
    const bad = walmartLines(doc(idempotencyKey.plaid("acct-1", "e2")));
    bad[1] = { ...bad[1]!, accountNo: "999999" };
    const refused = await port.createJournalLines({ batch: "FEEDS", externalDocumentNo: bad[0]!.externalDocumentNo, lines: bad }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ retryable: false });
    expect(server.draftLines("FEEDS")).toHaveLength(3);
  });
});
