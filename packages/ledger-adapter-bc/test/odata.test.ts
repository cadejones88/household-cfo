import { describe, expect, it } from "vitest";
import { buildJsonBatch, buildMultipartChangeset, odataDate, odataString, parseJsonBatchResponse, parseMultipartBatchResponse } from "../src/odata.js";
import { buildMultipartBatchResponse, parseJsonBatch, parseMultipartBatch } from "../src/mock/multipart.js";
import { redactString } from "../src/scrub.js";

describe("OData literals", () => {
  it("quotes strings and doubles embedded quotes", () => {
    expect(odataString("FEEDS")).toBe("'FEEDS'");
    expect(odataString("O'Brien")).toBe("'O''Brien'");
  });
  it("accepts only YYYY-MM-DD for dates", () => {
    expect(odataDate("2026-10-20")).toBe("2026-10-20");
    expect(() => odataDate("10/20/2026")).toThrow();
  });
});

describe("$batch multipart/mixed (OData 4 §11.7)", () => {
  const requests = [
    { method: "POST" as const, url: "https://bc.example/api/v2.0/companies(1)/journals(2)/journalLines", body: { amount: 30, description: "a" } },
    { method: "POST" as const, url: "https://bc.example/api/v2.0/companies(1)/journals(2)/journalLines", body: { amount: -30, description: "b" } },
  ];

  it("puts every request in one change set with Content-IDs, and the mock parser reads it back", () => {
    const built = buildMultipartChangeset(requests);
    expect(built.contentType).toMatch(/^multipart\/mixed; boundary=batch_/);
    expect(built.body).toContain("Content-Type: multipart/mixed; boundary=changeset_");
    expect(built.body).toContain("Content-Transfer-Encoding: binary");
    expect(built.body).toContain("Content-ID: 1");
    expect(built.body).toContain("Content-ID: 2");
    expect(built.body).toContain("POST https://bc.example/api/v2.0/companies(1)/journals(2)/journalLines HTTP/1.1");
    expect((built.body.match(/--changeset_[^\r\n]+--/g) ?? []).length).toBe(1);
    const parsed = parseMultipartBatch(built.contentType, built.body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.method).toBe("POST");
    expect(parsed[0]?.body).toEqual({ amount: 30, description: "a" });
    expect(parsed[0]?.group).toBeDefined();
    expect(parsed[0]?.group).toBe(parsed[1]?.group);
  });

  it("round-trips a multipart response, including a failed change set", () => {
    const ok = buildMultipartBatchResponse([
      { contentId: "1", status: 201, headers: {}, body: { id: "a" } },
      { contentId: "2", status: 201, headers: {}, body: { id: "b" } },
    ]);
    const parts = parseMultipartBatchResponse(ok.contentType, ok.body);
    expect(parts.map((p) => [p.contentId, p.status, (p.body as { id: string }).id])).toEqual([
      ["1", 201, "a"],
      ["2", 201, "b"],
    ]);
    const failed = buildMultipartBatchResponse([{ contentId: "2", status: 400, headers: {}, body: { error: { code: "BadRequest", message: "no" } } }]);
    const fparts = parseMultipartBatchResponse(failed.contentType, failed.body);
    expect(fparts).toHaveLength(1);
    expect(fparts[0]?.status).toBe(400);
  });

  it("builds the JSON batch BC documents, with one atomicity group", () => {
    const built = buildJsonBatch(requests);
    const body = JSON.parse(built.body) as { requests: { id: string; atomicityGroup: string; method: string; url: string }[] };
    expect(body.requests.map((r) => r.id)).toEqual(["1", "2"]);
    expect(new Set(body.requests.map((r) => r.atomicityGroup)).size).toBe(1);
    const parsed = parseJsonBatch(body);
    expect(parsed[1]?.url).toBe(requests[1]?.url);
    const responses = parseJsonBatchResponse({ responses: [{ id: "1", status: 201, headers: {}, body: { id: "x" } }] });
    expect(responses[0]?.status).toBe(201);
  });
});

describe("scrub", () => {
  it("removes tokens, amounts, masks, PEM blocks and correlation ids", () => {
    const s = redactString("Bearer abc.def.ghi paid $1,234.56 and 42.50 on x6450 CorrelationId:  12ab-34cd. eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl");
    expect(s).not.toContain("abc.def.ghi");
    expect(s).not.toContain("1,234.56");
    expect(s).not.toContain("42.50");
    expect(s).not.toContain("x6450");
    expect(s).not.toContain("CorrelationId");
    expect(s).not.toContain("eyJhbGci");
    expect(redactString(`-----BEGIN ${"CERTIFICATE"}-----\nabc\n-----END ${"CERTIFICATE"}-----`)).toBe("[pem]");
  });
  it("leaves account numbers and document numbers alone", () => {
    expect(redactString("account 603101 document HHAPP-PLD-20261020-ABCDEF12")).toBe("account 603101 document HHAPP-PLD-20261020-ABCDEF12");
  });
});
