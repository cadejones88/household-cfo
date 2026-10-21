import { BANK_CARD_LIST, CHART, DIMENSION_CODES, externalDocumentNo, idempotencyKey, toBcDimensionSetLines } from "@homestead/shared";
import { describe, expect, it } from "vitest";
import { assertWritableBudgetName, isOrigBudgetName } from "../src/bcAdapter.js";
import { BcNonRetryableError, BcRetryableError, LedgerAdapterError } from "../src/errors.js";
import { GROCERY_DIMS, makeAdapter, makeReceiver, walmartSplit } from "./helpers.js";

describe("master data", () => {
  it("lists the household chart, the five dimensions with their values, and the bank cards", async () => {
    const { adapter } = makeAdapter();
    const accounts = await adapter.listAccounts();
    expect(accounts.map((a) => a.number)).toEqual(CHART.map((a) => a.no));
    expect(accounts.every((a) => a.accountType === "Posting" && a.directPosting)).toBe(true);
    const dims = await adapter.listDimensions();
    expect(dims.map((d) => d.code).sort()).toEqual(Object.keys(DIMENSION_CODES).sort());
    expect(dims.find((d) => d.code === "FUND_GOAL")?.values.map((v) => v.code)).toContain("EMERG-3-6M");
    const banks = await adapter.listBankAccounts();
    expect(banks.map((b) => b.number)).toEqual(BANK_CARD_LIST.map((b) => b.code));
  });

  it("resolves HHAPP batches by template (journals default to GENERAL without the filter)", async () => {
    const { adapter, server } = makeAdapter();
    const j = await adapter.resolveJournal("FEEDS");
    expect(j.id).toBe(server.journalId("FEEDS"));
    const call = server.log.find((l) => l.url.includes("/journals?"));
    expect(new URL(call?.url ?? "").searchParams.get("$filter")).toContain("templateDisplayName eq 'HHAPP'");
    await expect(adapter.resolveJournal("NOPE")).rejects.toThrow(LedgerAdapterError);
    const plain = await server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/journals`, { headers: { authorization: "Bearer x" } });
    const body = (await plain.json()) as { value: { code: string; templateDisplayName: string }[] };
    expect(body.value.map((b) => b.templateDisplayName)).toEqual(["GENERAL"]);
  });
});

describe("createJournalLines: one change set, all or nothing", () => {
  it("writes a three-line split with the five dimensions, one document number, in one $batch", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    const res = await adapter.createJournalLines({ journalCode: "RECEIPTS", lines });
    expect(res.outcome).toBe("written");
    if (res.outcome !== "written") return;
    expect(res.lines).toHaveLength(3);
    expect(new Set(res.lines.map((l) => l.documentNumber)).size).toBe(1);
    expect(res.lines.map((l) => l.amountCents)).toEqual([3000, 1250, -4250]);
    expect(res.lines.map((l) => l.lineNumber)).toEqual([10000, 20000, 30000]);
    expect(res.lines[0]?.externalDocumentNumber).toBe(lines[0]?.externalDocumentNumber);
    const batchCalls = server.log.filter((l) => l.url.endsWith("/$batch"));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]?.headers.isolation).toBe("snapshot");
    expect(batchCalls[0]?.headers["content-type"]).toMatch(/^multipart\/mixed; boundary=/);
    const drafts = server.draftLines("RECEIPTS");
    expect(drafts).toHaveLength(3);
    const dimsOnGroceries = Object.fromEntries(drafts[0]!.dimensionSetLines.map((d) => [d.code, d.valueCode]));
    expect(dimsOnGroceries).toEqual(GROCERY_DIMS);
    expect(drafts.every((d) => d.comment === "plaid:acct1:txn-1")).toBe(true);
  });

  it("forced-failure batch: one invalid line in a three-line split leaves zero lines in BC", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    lines[1] = { ...lines[1]!, dimensionSetLines: [...lines[1]!.dimensionSetLines, { code: "FUND_GOAL", valueCode: "NOT-A-FUND" }] };
    await expect(adapter.createJournalLines({ journalCode: "RECEIPTS", lines })).rejects.toThrow(BcNonRetryableError);
    expect(server.draftLines("RECEIPTS")).toHaveLength(0);
    const again = walmartSplit();
    again[2] = { ...again[2]!, accountNumber: "NOT-A-BANK" };
    await expect(adapter.createJournalLines({ journalCode: "RECEIPTS", lines: again })).rejects.toThrow(/accountNumber/);
    expect(server.draftLines("RECEIPTS")).toHaveLength(0);
  });

  it("the same proof holds with the JSON batch format", async () => {
    const { adapter, server } = makeAdapter({ batchFormat: "json" });
    const lines = walmartSplit();
    lines[0] = { ...lines[0]!, accountNumber: "000000" };
    await expect(adapter.createJournalLines({ journalCode: "FEEDS", lines })).rejects.toThrow(BcNonRetryableError);
    expect(server.draftLines("FEEDS")).toHaveLength(0);
    const ok = await adapter.createJournalLines({ journalCode: "FEEDS", lines: walmartSplit() });
    expect(ok.outcome).toBe("written");
    expect(server.draftLines("FEEDS")).toHaveLength(3);
    expect(server.log.filter((l) => l.url.endsWith("/$batch"))[0]?.headers["content-type"]).toBe("application/json");
  });

  it("validates client-side before touching BC: zero sum, mixed document numbers, bad doc no, empty", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    await expect(adapter.createJournalLines({ journalCode: "FEEDS", lines: [lines[0]!, lines[1]!] })).rejects.toThrow(/sum to zero/);
    await expect(adapter.createJournalLines({ journalCode: "FEEDS", lines: [lines[0]!, { ...lines[1]!, externalDocumentNumber: externalDocumentNo(idempotencyKey.plaid("acct1", "other"), "2026-10-20") }] })).rejects.toThrow(/share/);
    await expect(adapter.createJournalLines({ journalCode: "FEEDS", lines: [] })).rejects.toThrow(LedgerAdapterError);
    await expect(adapter.createJournalLines({ journalCode: "FEEDS", lines: lines.map((l) => ({ ...l, externalDocumentNumber: "HHAPP-BAD" })) })).rejects.toThrow(/External Document No/);
    expect(server.log.filter((l) => l.url.endsWith("/$batch"))).toHaveLength(0);
  });

  it("truncates descriptions to 100 characters (BC's Text[100]) and comments to 250", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit().map((l) => ({ ...l, description: "D".repeat(180), comment: "C".repeat(400) }));
    const res = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    expect(res.outcome).toBe("written");
    expect(server.draftLines("FEEDS").every((d) => d.description.length === 100 && d.comment.length === 250)).toBe(true);
    // The mock refuses an over-long description, so the truncation is what made the write succeed.
    const raw = await server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/journals(${server.journalId("FEEDS")})/journalLines`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ accountNumber: "603101", postingDate: "2026-10-20", amount: 1, description: "D".repeat(101) }),
    });
    expect(raw.status).toBe(400);
  });
});

describe("pre-write check (idempotency)", () => {
  it("resending the same transaction three times leaves one document", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    const first = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    expect(first.outcome).toBe("written");
    for (let i = 0; i < 3; i += 1) {
      const again = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
      expect(again.outcome).toBe("already_in_journal");
      if (again.outcome === "already_in_journal") {
        expect(again.lines.map((l) => l.id).sort()).toEqual((first as { lines: { id: string }[] }).lines.map((l) => l.id).sort());
      }
    }
    expect(server.draftLines("FEEDS")).toHaveLength(3);
    expect(server.log.filter((l) => l.url.endsWith("/$batch"))).toHaveLength(1);
    expect(server.log.filter((l) => l.url.includes("hhJournalLineChecks"))).toHaveLength(4);
  });

  it("a timeout after a successful write is retryable, and the retry finds the lines instead of writing again", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    server.cutConnectionAfterNext({ method: "POST", pathIncludes: "$batch" });
    await expect(adapter.createJournalLines({ journalCode: "FEEDS", lines })).rejects.toThrow(BcRetryableError);
    expect(server.draftLines("FEEDS")).toHaveLength(3); // BC committed; the client never saw the response
    const retry = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    expect(retry.outcome).toBe("already_in_journal");
    expect(server.draftLines("FEEDS")).toHaveLength(3);
    expect(server.log.filter((l) => l.url.endsWith("/$batch"))).toHaveLength(1);
  });

  it("after posting, a resend reports already_posted with the entry numbers", async () => {
    const { adapter } = makeAdapter();
    const lines = walmartSplit();
    await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    await adapter.postBatch("FEEDS");
    const res = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    expect(res.outcome).toBe("already_posted");
    if (res.outcome === "already_posted") expect(res.entries.map((e) => e.entryNumber)).toEqual([1, 2, 3]);
  });

  it("without the connector the journal side still checks; the ledger side needs a known document number", async () => {
    const { adapter, server } = makeAdapter({ connectorInstalled: false });
    const lines = walmartSplit();
    const first = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    expect(first.outcome).toBe("written");
    const again = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    expect(again.outcome).toBe("already_in_journal");
    const docNo = first.outcome === "written" ? first.lines[0]!.documentNumber : "";
    await adapter.postBatch("FEEDS");
    const blind = await adapter.findByExternalDocumentNo(lines[0]!.externalDocumentNumber, "FEEDS");
    expect(blind.answeredBy).toBe("odata");
    expect(blind.ledgerCheckIncomplete).toBe(true);
    const hinted = await adapter.findByExternalDocumentNo(lines[0]!.externalDocumentNumber, "FEEDS", { documentNumber: docNo });
    expect(hinted.ledgerCheckIncomplete).toBe(false);
    expect(hinted.ledgerEntries).toHaveLength(3);
    expect(server.log.some((l) => l.url.includes("hhJournalLineChecks"))).toBe(false);
  });
});

describe("pre-write check without a batch, and the nightly poll's range read", () => {
  it("finds a draft in any HHAPP batch when no batch is named (connector and plain OData)", async () => {
    for (const connectorInstalled of [true, false]) {
      const { adapter, server } = makeAdapter({ connectorInstalled });
      const lines = walmartSplit();
      await adapter.createJournalLines({ journalCode: "RECEIPTS", lines });
      const found = await adapter.findByExternalDocumentNo(lines[0]!.externalDocumentNumber);
      expect(found.journalLines).toHaveLength(3);
      expect(found.journalLines.every((l) => l.journalCode === "RECEIPTS")).toBe(true);
      expect(found.answeredBy).toBe(connectorInstalled ? "connector" : "odata");
      // A resend aimed at another batch must not write a second document.
      const again = await adapter.createJournalLines({ journalCode: "FEEDS", lines });
      expect(again.outcome).toBe("already_in_journal");
      expect(server.draftLines("FEEDS")).toHaveLength(0);
      expect(server.draftLines("RECEIPTS")).toHaveLength(3);
      if (!connectorInstalled) {
        const journalListCalls = server.log.filter((l) => l.url.includes("/journals?") && new URL(l.url).searchParams.get("$filter") === "templateDisplayName eq 'HHAPP'");
        expect(journalListCalls.length).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("lists every app-owned draft and entry in a posting-date window, by batch, with source and reason codes", async () => {
    const { adapter, server } = makeAdapter();
    await adapter.createJournalLines({ journalCode: "FEEDS", lines: walmartSplit(idempotencyKey.plaid("acct1", "a"), "2026-10-01") });
    await adapter.createJournalLines({ journalCode: "AUTOPOST", lines: walmartSplit(idempotencyKey.plaid("acct1", "b"), "2026-10-10") });
    await adapter.createJournalLines({ journalCode: "RECEIPTS", lines: walmartSplit(idempotencyKey.receipt("ab".repeat(32)), "2026-10-15") });
    await adapter.postBatch("AUTOPOST");
    // A line Cade typed himself with no HHAPP- document number is not the app's.
    await server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/journals(${server.journalId("FEEDS")})/journalLines`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ accountNumber: "603101", postingDate: "2026-10-12", amount: 5, description: "manual", externalDocumentNumber: "INV-42" }),
    });

    const all = await adapter.listAppDocuments({ postingDateFrom: "2026-10-01", postingDateTo: "2026-10-31" });
    expect(all).toHaveLength(9);
    expect(all.every((r) => r.externalDocumentNumber.startsWith("HHAPP-"))).toBe(true);
    const bySource = { journal: all.filter((r) => r.source === "journal").length, ledger: all.filter((r) => r.source === "ledger").length };
    expect(bySource).toEqual({ journal: 6, ledger: 3 });
    const posted = all.filter((r) => r.source === "ledger");
    expect(posted.map((r) => r.entryNumber)).toEqual([1, 2, 3]);
    expect(posted.every((r) => r.journalCode === "AUTOPOST" && r.sourceCode === "HHAUTO" && r.reasonCode === "AUTOPOST")).toBe(true);
    expect(posted.reduce((s, r) => s + r.amountCents, 0)).toBe(0);
    const drafts = all.filter((r) => r.source === "journal");
    expect(drafts.every((r) => r.lineId && r.lineNumber && r.entryNumber === undefined)).toBe(true);
    expect(drafts.filter((r) => r.journalCode === "FEEDS").every((r) => r.sourceCode === "GENJNL" && r.reasonCode === undefined)).toBe(true);

    const window = await adapter.listAppDocuments({ postingDateFrom: "2026-10-05", postingDateTo: "2026-10-12", source: "journal" });
    expect(window).toHaveLength(0); // the AUTOPOST drafts were posted; FEEDS is on the 1st, RECEIPTS on the 15th
    const receipts = await adapter.listAppDocuments({ externalDocumentNoStartsWith: "HHAPP-RCP-" });
    expect(receipts).toHaveLength(3);
    expect(receipts.every((r) => r.journalCode === "RECEIPTS")).toBe(true);
    const oneBatch = await adapter.listAppDocuments({ journalCode: "FEEDS" });
    expect(oneBatch).toHaveLength(3);
    const call = new URL(server.log.filter((l) => l.url.includes("hhJournalLineChecks")).at(-1)?.url ?? "https://x");
    expect(call.searchParams.get("$filter")).toBe("startswith(externalDocumentNo,'HHAPP-') and journalBatchName eq 'FEEDS'");

    await expect(adapter.listAppDocuments({ externalDocumentNoStartsWith: "INV-" })).rejects.toThrow(/HHAPP-/);
    await expect(makeAdapter({ connectorInstalled: false }).adapter.listAppDocuments({})).rejects.toThrow(/HH App Connector/);
  });
});

describe("post and read-back", () => {
  it("posts the batch (204), then reads back entry numbers, document no, posting date and the five dimensions", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    await adapter.createJournalLines({ journalCode: "RECEIPTS", lines });
    await adapter.postBatch("RECEIPTS");
    const postCall = server.log.find((l) => l.url.endsWith("/Microsoft.NAV.post"));
    expect(postCall?.method).toBe("POST");
    expect(postCall?.status).toBe(204);
    expect(server.draftLines("RECEIPTS")).toHaveLength(0);

    const entries = await adapter.readGlEntriesByExternalDocNo(lines[0]!.externalDocumentNumber);
    expect(entries.map((e) => e.entryNumber)).toEqual([1, 2, 3]);
    expect(new Set(entries.map((e) => e.documentNumber)).size).toBe(1);
    expect(entries.every((e) => e.postingDate === "2026-10-20")).toBe(true);
    expect(entries.map((e) => [e.accountNumber, e.amountCents])).toEqual([
      ["603101", 3000],
      ["603301", 1250],
      ["201101", -4250], // the card's bank line lands on its posting account
    ]);
    expect(entries[0]?.dimensions).toEqual(GROCERY_DIMS);
    expect(entries[0]?.dimensionSetLines.map((d) => d.code)).toEqual(["SPEND_CLASS", "FUND_GOAL", "FAMILY_AREA", "TAX_TREATMENT", "PROJECT"]);
    expect(entries[2]?.dimensions).toEqual({ FUND_GOAL: "OPERATING", FAMILY_AREA: "JOINT", TAX_TREATMENT: "TAXABLE" });
    const readCall = new URL(server.log.find((l) => l.url.includes("generalLedgerEntries?"))?.url ?? "https://x");
    expect(readCall.searchParams.get("$expand")).toBe("dimensionSetLines");
    expect(readCall.searchParams.get("$filter")).toBe("documentNumber eq 'HHR00001' and postingDate eq 2026-10-20");
  });

  it("generalLedgerEntries refuses a filter on externalDocumentNumber, as the real page 30018 does", async () => {
    const { server } = makeAdapter();
    const res = await server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/generalLedgerEntries?$filter=${encodeURIComponent("externalDocumentNumber eq 'X'")}`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(400);
  });

  it("posting an empty batch or an unbalanced document is a non-retryable BC error", async () => {
    const { adapter, server } = makeAdapter();
    await expect(adapter.postBatch("FEEDS")).rejects.toThrow(/nothing to post/);
    await server.fetch(`${server.baseUrl}/api/v2.0/companies(${server.companyId})/journals(${server.journalId("FEEDS")})/journalLines`, {
      method: "POST",
      headers: { authorization: "Bearer x", "content-type": "application/json" },
      body: JSON.stringify({ accountNumber: "603101", postingDate: "2026-10-20", amount: 5, description: "lonely", externalDocumentNumber: "HHAPP-MAN-20261020-AAAAAAAA" }),
    });
    const err = await adapter.postBatch("FEEDS").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BcNonRetryableError);
    expect((err as BcNonRetryableError).code).toBe("Application_DialogException");
    expect((err as Error).message).not.toMatch(/5\.00/);
  });

  it("a 503 from BC is retryable and carries Retry-After", async () => {
    const { adapter, server } = makeAdapter();
    server.failNext({ pathIncludes: "accounts" }, { status: 503, headers: { "retry-after": "120" }, body: { error: { code: "Internal_ServerError", message: "busy" } } });
    const err = await adapter.listAccounts().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BcRetryableError);
    expect((err as BcRetryableError).retryAfterMs).toBe(120_000);
    expect(await adapter.listAccounts()).toHaveLength(CHART.length);
  });

  it("reads bank ledger entries through the connector and sees reconciliation close them", async () => {
    const { adapter, server } = makeAdapter();
    const lines = walmartSplit();
    await adapter.createJournalLines({ journalCode: "FEEDS", lines });
    await adapter.postBatch("FEEDS");
    const open = await adapter.readBankLedgerEntries({ bankAccountNumber: "CAPONE-CC", open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ entryNumber: 1, amountCents: -4250, externalDocumentNumber: lines[0]!.externalDocumentNumber, open: true, reversed: false });
    expect(open[0]?.closedAtDate).toBeUndefined();
    server.closeBankLedgerEntry(1, "STMT-2026-10", 7, "2026-10-31");
    const byDoc = await adapter.readBankLedgerEntries({ externalDocumentNumber: lines[0]!.externalDocumentNumber });
    expect(byDoc[0]).toMatchObject({ open: false, statementNumber: "STMT-2026-10", statementLineNumber: 7, closedAtDate: "2026-10-31" });
    await expect(makeAdapter({ connectorInstalled: false }).adapter.readBankLedgerEntries({})).rejects.toThrow(/HH App Connector/);
  });
});

describe("budgets", () => {
  it("refuses any -ORIG budget name client-side and enforces the whitelist", () => {
    expect(isOrigBudgetName("2026-ORIG")).toBe(true);
    expect(isOrigBudgetName("2026-orig ")).toBe(true);
    expect(isOrigBudgetName("2026-REV1")).toBe(false);
    expect(() => assertWritableBudgetName("2026-ORIG")).toThrow(/-ORIG/);
    expect(() => assertWritableBudgetName("2026-BASE")).toThrow(/revision/);
    expect(() => assertWritableBudgetName("2026-REV-10")).toThrow(/10 characters/);
    expect(() => assertWritableBudgetName("")).toThrow();
    expect(() => assertWritableBudgetName("2026-REV1")).not.toThrow();
    expect(() => assertWritableBudgetName("FCST2026Q4")).not.toThrow();
  });

  it("A8: writes a versioned revision through hhBudgetEntries and reads it back through the Analytics API", async () => {
    const { adapter, server } = makeAdapter({ budgets: ["2026-REV1"] });
    await expect(adapter.writeBudgetEntries("2026-ORIG", [{ glAccount: "603101", date: "2026-11-01", amountCents: 60000, description: "REV 1", dimensions: {} }])).rejects.toThrow(/-ORIG/);
    expect(server.log.filter((l) => l.url.includes("hhBudgetEntries"))).toHaveLength(0);

    const res = await adapter.writeBudgetEntries("2026-REV1", [
      { glAccount: "603101", date: "2026-11-01", amountCents: 60000, description: "REV 1", dimensions: { SPEND_CLASS: "ESSENTIAL", FAMILY_AREA: "JOINT" } },
      { glAccount: "603501", date: "2026-11-01", amountCents: 20000, description: "REV 1", dimensions: { SPEND_CLASS: "DISCRETIONARY", FAMILY_AREA: "JOINT", PROJECT: "XMAS-2026" } },
    ]);
    expect(res.entryNumbers).toEqual([1, 2]);
    const batch = server.log.find((l) => l.url.endsWith("homestead/v1.0/$batch"));
    expect(batch).toBeDefined();

    const read = await adapter.readBudget("2026-REV1", { dateFrom: "2026-11-01", dateTo: "2026-11-30" });
    expect(read.lines).toHaveLength(2);
    expect(read.lines[0]).toMatchObject({ glAccount: "603101", amountCents: 60000, description: "REV 1", dimensions: { SPEND_CLASS: "ESSENTIAL", FAMILY_AREA: "JOINT" } });
    expect(read.lines[1]?.dimensions.PROJECT).toBe("XMAS-2026");
    const analyticsCalls = server.log.filter((l) => l.url.includes("/api/microsoft/analytics/v1.0/"));
    expect(analyticsCalls.every((c) => c.method === "GET")).toBe(true);
  });

  it("the connector page refuses -ORIG even when the client guard is bypassed, and a bad dimension rolls the revision back", async () => {
    const { server, http } = makeAdapter({ budgets: ["2026-REV2"] });
    const url = `${server.baseUrl}/api/cadejonescpa/homestead/v1.0/companies(${server.companyId})/hhBudgetEntries`;
    const direct = await server.fetch(url, { method: "POST", headers: { authorization: "Bearer x", "content-type": "application/json" }, body: JSON.stringify({ budgetName: "2026-ORIG", glAccountNo: "603101", date: "2026-11-01", amount: 600 }) });
    expect(direct.status).toBe(400);
    expect(((await direct.json()) as { error: { message: string } }).error.message).toMatch(/original budget/);
    await expect(
      http.batchChangeset(
        [
          { method: "POST", url, body: { budgetName: "2026-REV2", glAccountNo: "603101", date: "2026-11-01", amount: 600 } },
          { method: "POST", url, body: { budgetName: "2026-REV2", glAccountNo: "603101", date: "2026-12-01", amount: 600, globalDimension1Code: "BOGUS" } },
        ],
        "api/cadejonescpa/homestead/v1.0",
      ),
    ).rejects.toThrow(BcNonRetryableError);
    const list = await server.fetch(`${url}?$filter=${encodeURIComponent("budgetName eq '2026-REV2'")}`, { headers: { authorization: "Bearer x" } });
    expect(((await list.json()) as { value: unknown[] }).value).toHaveLength(0);
  });
});

describe("webhook subscriptions", () => {
  it("creates with the validationToken handshake and clientState, lists supported resources, renews, expires after 3 days, deletes", async () => {
    const receiver = makeReceiver();
    const fixedNow = Date.parse("2026-10-20T20:00:00Z");
    const { adapter, server } = makeAdapter({ deliver: receiver.deliver, now: () => fixedNow });
    const supported = await adapter.webhookSupportedResources();
    expect(supported).toContain(adapter.resourcePath("generalLedgerEntries"));
    expect(supported).toContain(adapter.resourcePath("journals"));

    const sub = await adapter.subscriptions.create({ resource: "generalLedgerEntries", notificationUrl: "https://homestead-dev-api.example/webhooks/bc", clientState: "shared-secret-1" });
    expect(receiver.handshakes).toHaveLength(1);
    expect(sub.resource).toBe(adapter.resourcePath("generalLedgerEntries"));
    expect(Date.parse(sub.expirationDateTime) - server.now()).toBe(3 * 24 * 3600 * 1000);
    const createCall = server.log.find((l) => l.method === "POST" && l.url.endsWith("/api/v2.0/subscriptions"));
    expect(JSON.parse(createCall?.body ?? "{}")).toEqual({ notificationUrl: "https://homestead-dev-api.example/webhooks/bc", resource: sub.resource, clientState: "shared-secret-1" });

    server.advanceTime(2 * 24 * 3600 * 1000);
    const renewed = await adapter.subscriptions.renew(sub.id, "shared-secret-2");
    expect(receiver.handshakes).toHaveLength(2);
    expect(Date.parse(renewed.expirationDateTime) - server.now()).toBe(3 * 24 * 3600 * 1000);
    const patchCall = server.log.find((l) => l.method === "PATCH");
    expect(patchCall?.headers["if-match"]).toBe("*");
    expect(patchCall?.url).toContain(`subscriptions('${sub.id}')`);

    // A posting notifies with the new clientState; an expired subscription is dropped silently.
    await adapter.createJournalLines({ journalCode: "FEEDS", lines: walmartSplit() });
    await adapter.postBatch("FEEDS");
    expect(receiver.notifications).toHaveLength(1);
    const n = receiver.notifications[0] as { value: { clientState: string; resource: string; changeType: string; subscriptionId: string }[] };
    expect(n.value[0]).toMatchObject({ clientState: "shared-secret-2", changeType: "collection", subscriptionId: sub.id });
    expect(n.value[0]?.resource).toContain("generalLedgerEntries");

    server.advanceTime(4 * 24 * 3600 * 1000);
    expect(await adapter.subscriptions.list()).toHaveLength(0);
    await adapter.createJournalLines({ journalCode: "FEEDS", lines: walmartSplit(idempotencyKey.plaid("acct1", "txn-2")) });
    await adapter.postBatch("FEEDS");
    expect(receiver.notifications).toHaveLength(1);

    const fresh = await adapter.subscriptions.create({ resource: "journals", notificationUrl: "https://homestead-dev-api.example/webhooks/bc", clientState: "s3" });
    await adapter.subscriptions.delete(fresh.id);
    expect(await adapter.subscriptions.list()).toHaveLength(0);
  });

  it("a receiver that does not echo the token cannot subscribe; a non-retry reply deletes the subscription", async () => {
    const receiver = makeReceiver();
    const { adapter, server } = makeAdapter({ deliver: receiver.deliver });
    receiver.mode = "reject_handshake";
    await expect(adapter.subscriptions.create({ resource: "generalLedgerEntries", notificationUrl: "https://x.example/hook", clientState: "s" })).rejects.toThrow(/validationToken/);
    receiver.mode = "ok";
    const sub = await adapter.subscriptions.create({ resource: "generalLedgerEntries", notificationUrl: "https://x.example/hook", clientState: "s" });
    receiver.mode = "server_error"; // 5xx: BC retries, keeps the subscription
    await adapter.createJournalLines({ journalCode: "FEEDS", lines: walmartSplit() });
    await adapter.postBatch("FEEDS");
    expect(server.listSubscriptions().map((s) => s.id)).toEqual([sub.id]);
    receiver.mode = "bad_request"; // 4xx: no retry, subscription deleted
    await adapter.createJournalLines({ journalCode: "FEEDS", lines: walmartSplit(idempotencyKey.plaid("acct1", "txn-3")) });
    await adapter.postBatch("FEEDS");
    expect(server.listSubscriptions()).toHaveLength(0);
  });
});

describe("transport details", () => {
  it("sends a bearer token on every call and retries once with a fresh token after a 401", async () => {
    const { adapter, server } = makeAdapter();
    server.failNext({ pathIncludes: "bankAccounts" }, { status: 401, body: { error: { code: "Unauthorized", message: "expired" } } });
    expect(await adapter.listBankAccounts()).toHaveLength(BANK_CARD_LIST.length);
    expect(server.log.every((l) => /^Bearer /.test(l.headers.authorization ?? ""))).toBe(true);
    expect(server.log.filter((l) => l.url.includes("bankAccounts"))).toHaveLength(2);
  });

  it("works over a real loopback HTTP server too (for other packages and the acceptance suite)", async () => {
    const receiver = makeReceiver();
    const server = new (await import("../src/mock/MockBcServer.js")).MockBcServer({ deliver: receiver.deliver });
    const baseUrl = await server.listen();
    try {
      const { BcHttp } = await import("../src/http.js");
      const { StaticTokenProvider } = await import("../src/auth.js");
      const { BusinessCentralAdapter } = await import("../src/bcAdapter.js");
      const adapter = new BusinessCentralAdapter({ http: new BcHttp({ baseUrl, tokenProvider: new StaticTokenProvider("loopback") }), companyId: server.companyId, journalTemplate: "HHAPP", connectorInstalled: true });
      expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
      const written = await adapter.createJournalLines({ journalCode: "AUTOPOST", lines: walmartSplit() });
      expect(written.outcome).toBe("written");
      await adapter.postBatch("AUTOPOST");
      const entries = await adapter.readGlEntriesByExternalDocNo(walmartSplit()[0]!.externalDocumentNumber);
      expect(entries).toHaveLength(3);
      expect(server.postedEntries()[0]?.sourceCode).toBe("HHAUTO");
      expect(server.postedEntries()[0]?.reasonCode).toBe("AUTOPOST");
    } finally {
      await server.close();
    }
  });

  it("toBcDimensionSetLines refuses an illegal combination before anything is sent", () => {
    expect(() => toBcDimensionSetLines({ SPEND_CLASS: "TRANSFER", TAX_TREATMENT: "DED-CHAR" })).toThrow();
  });
});
