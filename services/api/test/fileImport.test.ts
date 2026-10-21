/** File import parsers (pure): institution profiles, sign conventions, OFX SGML, the PDF port stub. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvText, parseDate, parseOfx, parsePdfStatement } from "../src/services/bankData/fileImport.js";
import { IMPORT_PROFILE_SEEDS, type CsvProfileSpec, type OfxProfileSpec, type PdfProfileSpec } from "../src/services/bankData/profiles.js";
import { FakeDocumentIntelligence } from "../src/services/receipts/documentIntelligence.js";

const fx = (p: string) => readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", p), "utf8");
const profile = <T>(name: string) => IMPORT_PROFILE_SEEDS.find((p) => p.name === name)!.spec as T;

describe("CSV", () => {
  it("parses quoted fields and doubled quotes", () => {
    expect(parseCsvText('a,"b, c","d ""q"""\r\n1,2,3\n')).toEqual([["a", "b, c", 'd "q"'], ["1", "2", "3"]]);
  });

  it("reads the Beehive export with the profile: balance lines skipped, bank sign kept, same-day repeats kept", () => {
    const rows = parseCsv(fx("files/beehive-2026-10.csv"), profile<CsvProfileSpec>("Beehive FCU CSV"));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ date: "2026-10-02", amountCents: -4517, description: "MAVERIK #417 REXBURG Card 1234" });
    expect(rows.filter((r) => r.description.startsWith("SODALICIOUS"))).toHaveLength(2);
    expect(rows.find((r) => r.amountCents > 0)?.amountCents).toBe(25000);
  });

  it("debit/credit columns (America First, Capital One) become one signed amount", () => {
    const spec = profile<CsvProfileSpec>("Capital One CSV");
    const rows = parseCsv("Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n2026-10-03,2026-10-04,6450,WALMART,Merchandise,34.96,\n2026-10-10,2026-10-10,6450,PAYMENT THANK YOU,Payment,,363.00\n", spec);
    expect(rows.map((r) => [r.date, r.postedDate, r.amountCents])).toEqual([["2026-10-03", "2026-10-04", -3496], ["2026-10-10", "2026-10-10", 36300]]);
  });

  it("refuses a file without the profile's columns", () => {
    expect(() => parseCsv("When,What\n10/02/2026,x\n", profile<CsvProfileSpec>("Beehive FCU CSV"))).toThrow(/columns/);
  });

  it("parses the date formats the profiles name", () => {
    expect(parseDate("1/5/26", "M/D/YYYY")).toBe("2026-01-05");
    expect(parseDate("10-31-2026", "MM-DD-YYYY")).toBe("2026-10-31");
    expect(() => parseDate("2026/10/31", "YYYY-MM-DD")).toThrow();
  });
});

describe("OFX/QFX", () => {
  it("reads SGML STMTTRN blocks with FITID, and inverts card files when the profile says so", () => {
    const rows = parseOfx(fx("files/beehive-2026-10.ofx"), profile<OfxProfileSpec>("OFX/QFX (any bank)"));
    expect(rows.map((r) => [r.date, r.amountCents, r.sourceId])).toEqual([["2026-10-03", -4517, "202610030001"], ["2026-10-06", -6233, "202610060002"], ["2026-10-08", -1999, "202610080003"]]);
    const inverted = parseOfx(fx("files/beehive-2026-10.ofx"), profile<OfxProfileSpec>("OFX/QFX (card, charges positive)"));
    expect(inverted[0]!.amountCents).toBe(4517);
  });
});

describe("statement PDF", () => {
  const spec = profile<PdfProfileSpec>("Synchrony CareCredit statement PDF");
  it("is parked with needs: document_intelligence when no port is configured", async () => {
    expect(await parsePdfStatement(new Uint8Array([1, 2, 3]), spec)).toEqual({ rows: [], needs: "document_intelligence" });
  });
  it("reads the layout model's table with the profile and finds the statement number", async () => {
    const di = new FakeDocumentIntelligence(() => "x");
    di.layoutResult = { text: "CareCredit\nStatement Closing Date: 10/12/2026\n", tables: [{ headers: ["Date", "Description", "Amount"], rows: [["09/20/2026", "PEDIATRIC DENTAL", "180.00"], ["10/01/2026", "PAYMENT", "-75.00"], ["", "Total", "105.00"]] }] };
    const r = await parsePdfStatement(new Uint8Array([1]), spec, di);
    expect(r.statementNo).toBe("10122026");
    expect(r.rows.map((x) => [x.date, x.amountCents, x.sourceId])).toEqual([["2026-09-20", -18000, "1"], ["2026-10-01", 7500, "2"]]);
  });
});
