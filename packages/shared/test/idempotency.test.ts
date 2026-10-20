import { describe, expect, it } from "vitest";
import { EXTERNAL_DOC_RE, externalDocumentNo, idempotencyKey, isHomesteadDocumentNo, normalizeDescription, sourceKindOfKey } from "../src/idempotency.js";

describe("idempotency keys", () => {
  it("builds stable keys per source", () => {
    expect(idempotencyKey.plaid("acc1", "txn9")).toBe("plaid:acc1:txn9");
    expect(idempotencyKey.ofx("acc1", "2026102000123")).toBe("ofx:acc1:2026102000123");
    expect(idempotencyKey.pdf("acc1", "S-2026-10", 7)).toBe("pdf:acc1:S-2026-10:7");
    expect(idempotencyKey.paycheck("HFH", "2026-10-24", 313559)).toBe("pay:HFH:2026-10-24:313559");
    expect(idempotencyKey.manual("A1B2")).toBe("man:a1b2");
  });
  it("gives two identical CSV rows on one day different keys by sequence", () => {
    const a = idempotencyKey.csv("acc1", "2026-10-20", -1250, "MAVERIK #123 REXBURG", 1);
    const b = idempotencyKey.csv("acc1", "2026-10-20", -1250, "MAVERIK #123 REXBURG", 2);
    expect(a).not.toBe(b);
    expect(idempotencyKey.csv("acc1", "2026-10-20", -1250, "maverik  #123 rexburg", 1)).toBe(a);
  });
  it("rejects parts with whitespace or colons", () => {
    expect(() => idempotencyKey.plaid("a b", "c")).toThrow();
    expect(() => idempotencyKey.ofx("a", "x:y")).toThrow();
  });
  it("normalizes descriptions", () => {
    expect(normalizeDescription("WAL-MART #1234 REXBURG ID")).toBe("wal mart rexburg id");
  });
});

describe("External Document No.", () => {
  it("is 27 characters and stable for the same key and date", () => {
    const key = idempotencyKey.plaid("acc1", "txn9");
    const doc = externalDocumentNo(key, "2026-10-20");
    expect(doc).toHaveLength(27);
    expect(doc.startsWith("HHAPP-PLD-20261020-")).toBe(true);
    expect(externalDocumentNo(key, "2026-10-20")).toBe(doc);
    expect(EXTERNAL_DOC_RE.test(doc)).toBe(true);
    expect(isHomesteadDocumentNo("GJ-000123")).toBe(false);
  });
  it("uses the source code per kind", () => {
    expect(externalDocumentNo(idempotencyKey.receipt("ab".repeat(32)), "2026-01-02").slice(0, 9)).toBe("HHAPP-RCP");
    expect(externalDocumentNo(idempotencyKey.paycheck("HFH", "2026-01-02", 1), "2026-01-02").slice(0, 9)).toBe("HHAPP-PAY");
    expect(sourceKindOfKey("csv:a:b")).toBe("csv");
  });
});
