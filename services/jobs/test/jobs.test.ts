/** The jobs' pure parts: the retry schedule (1, 2, 4, 8, 16 minutes, then hourly for a day), job names, scrubbing. */
import { describe, expect, it } from "vitest";
import { JOB_NAMES, isJobName } from "../src/index.js";
import { retryDelayMinutes } from "../src/jobs/outbox.js";
import { scrubMessage } from "../src/runner.js";

describe("retry schedule", () => {
  it("backs off 1, 2, 4, 8, 16 minutes, then hourly for a day, then gives up", () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMinutes)).toEqual([1, 2, 4, 8, 16]);
    expect(retryDelayMinutes(6)).toBe(60);
    expect(retryDelayMinutes(29)).toBe(60);
    expect(retryDelayMinutes(30)).toBeUndefined();
    const totalHours = Array.from({ length: 29 }, (_, i) => retryDelayMinutes(i + 1)!).reduce((a, b) => a + b, 0) / 60;
    expect(totalHours).toBeCloseTo(24.5, 1);
  });
});

describe("job names and logs", () => {
  it("knows every scheduled and queue-driven job", () => {
    expect(JOB_NAMES).toEqual(["plaid-sync", "ocr", "matching", "outbox-relay", "bc-worker", "autopost-post", "bc-readback", "nightly-poll", "webhook-renewal", "alerts", "paycheck-template-fallback", "receipt-fallback", "rule-proposals", "all"]);
    expect(isJobName("nightly-poll")).toBe(true);
    expect(isJobName("drop-tables")).toBe(false);
  });
  it("keeps amounts out of the sync_runs error text", () => {
    expect(scrubMessage("Split 4517 does not equal -12999.00 for $45.17")).toBe("Split # does not equal -# for #");
  });
});
