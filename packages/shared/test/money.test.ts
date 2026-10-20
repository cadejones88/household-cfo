import { describe, expect, it } from "vitest";
import { centsToDecimalString, formatUsd, parseCents, prorateCents, sumCents, withinTolerance } from "../src/money.js";

describe("parseCents", () => {
  it("parses plain, formatted, negative and parenthesised amounts", () => {
    expect(parseCents("1,234.56")).toBe(123456);
    expect(parseCents("$12.3")).toBe(1230);
    expect(parseCents("-5")).toBe(-500);
    expect(parseCents("(42.00)")).toBe(-4200);
    expect(parseCents(" 0.07 ")).toBe(7);
    expect(parseCents(19.99)).toBe(1999);
  });
  it("rejects junk", () => {
    expect(() => parseCents("12.345")).toThrow();
    expect(() => parseCents("abc")).toThrow();
    expect(() => parseCents(Number.NaN)).toThrow();
  });
});

describe("formatting", () => {
  it("renders BC decimals and display strings", () => {
    expect(centsToDecimalString(123456)).toBe("1234.56");
    expect(centsToDecimalString(-5)).toBe("-0.05");
    expect(formatUsd(123456)).toBe("$1,234.56");
    expect(formatUsd(-30000)).toBe("−$300.00");
    expect(formatUsd(500, { sign: "always" })).toBe("+$5.00");
  });
});

describe("prorateCents", () => {
  it("sums exactly to the total and gives the residue to the largest weight", () => {
    const parts = prorateCents(1000, [3333, 3333, 3334]);
    expect(sumCents(parts)).toBe(1000);
    expect(parts[2]).toBeGreaterThanOrEqual(parts[0]!);
  });
  it("handles a zero weight sum", () => {
    expect(prorateCents(7, [0, 0])).toEqual([7, 0]);
  });
  it("is exact for the Walmart example (tax 8.42 across 88.20 / 31.17 / 23.00)", () => {
    const parts = prorateCents(842, [8820, 3117, 2300]);
    expect(sumCents(parts)).toBe(842);
  });
});

describe("withinTolerance", () => {
  it("supports cents and fraction tolerances", () => {
    expect(withinTolerance(10000, 10200, { fraction: 0.02 })).toBe(true);
    expect(withinTolerance(10000, 10300, { fraction: 0.02 })).toBe(false);
    expect(withinTolerance(10000, 10499, { cents: 500 })).toBe(true);
  });
});
