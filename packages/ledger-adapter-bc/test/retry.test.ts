import { describe, expect, it } from "vitest";
import { BcNonRetryableError, BcRetryableError, isRetryableStatus, parseBcError } from "../src/errors.js";
import { MAX_RETRY_ATTEMPTS, isRetryable, nextRetryDelayMs, retryDelayFor, totalScheduleMs } from "../src/retry.js";

const MIN = 60_000;

describe("retry schedule (spec: 1, 2, 4, 8, 16 minutes, then hourly for a day)", () => {
  it("backs off exponentially for five attempts", () => {
    expect([1, 2, 3, 4, 5].map(nextRetryDelayMs)).toEqual([1 * MIN, 2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN]);
  });

  it("then retries hourly 24 times", () => {
    for (let a = 6; a <= 29; a += 1) expect(nextRetryDelayMs(a)).toBe(60 * MIN);
    expect(MAX_RETRY_ATTEMPTS).toBe(29);
  });

  it("gives up after the day", () => {
    expect(nextRetryDelayMs(30)).toBeUndefined();
    expect(nextRetryDelayMs(999)).toBeUndefined();
  });

  it("rejects a bad attempt number", () => {
    expect(() => nextRetryDelayMs(0)).toThrow(RangeError);
    expect(() => nextRetryDelayMs(1.5)).toThrow(RangeError);
  });

  it("spans about 24.5 hours in total", () => {
    expect(totalScheduleMs()).toBe(31 * MIN + 24 * 60 * MIN);
  });

  it("honors a longer Retry-After from BC", () => {
    const err = new BcRetryableError(429, { code: "Throttled", message: "" }, 3 * MIN);
    expect(retryDelayFor(err, 1)).toBe(3 * MIN);
    expect(retryDelayFor(err, 3)).toBe(4 * MIN);
    expect(retryDelayFor(new Error("x"), 2)).toBe(2 * MIN);
    expect(retryDelayFor(err, 30)).toBeUndefined();
  });
});

describe("error classification", () => {
  it("408, 429 and 5xx are retryable; everything else is not", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
  });

  it("parses the BC error envelope and scrubs the message", () => {
    const bc = parseBcError({ error: { code: "Application_DialogException", message: "Document HHF00001 is out of balance by 42.50 for card x6450  CorrelationId:  abc-123." } });
    expect(bc?.code).toBe("Application_DialogException");
    expect(bc?.message).not.toContain("42.50");
    expect(bc?.message).not.toContain("x6450");
    expect(bc?.message).not.toContain("CorrelationId");
    expect(bc?.message).toContain("[amount]");
  });

  it("non-retryable errors carry the BC code and the type guard distinguishes them", () => {
    const e = new BcNonRetryableError(400, { code: "BadRequest", message: "bad" });
    expect(e.code).toBe("BadRequest");
    expect(e.retryable).toBe(false);
    expect(isRetryable(e)).toBe(false);
    expect(isRetryable(new BcRetryableError(503, undefined, undefined))).toBe(true);
    expect(new BcNonRetryableError(404, undefined).code).toBe("HTTP_404");
  });
});
