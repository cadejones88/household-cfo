// @vitest-environment node
/**
 * The status mapping: every state machine state has a Console label and tone, and the "plain" words match what
 * the phone app shows for the same state (PLAIN_STATUS_WORDS), so Cade and Vanessa talk about the same thing.
 */
import { PLAIN_STATUS_WORDS, TRANSACTION_STATES, plainStatus, type DataQuality, type TransactionState } from "@homestead/shared";
import { describe, expect, it } from "vitest";
import { feedStatusView, freshnessTone, hoursSince, qualityView, ruleStateView, stateView, syncRunStatusView } from "../src/lib/status";

const QUALITIES: readonly DataQuality[] = ["posted_reconciled", "posted_unreconciled", "imported_pending", "estimated", "stale", "missing"];

describe("stateView", () => {
  it("covers every transaction state with a label, a tone and the phone app's plain words", () => {
    for (const state of TRANSACTION_STATES as readonly TransactionState[]) {
      const v = stateView(state);
      expect(v.label.length, state).toBeGreaterThan(0);
      expect(["good", "watch", "action", "neutral", "muted"]).toContain(v.tone);
      expect(v.plain).toBe(PLAIN_STATUS_WORDS[plainStatus(state)]);
    }
  });

  it("uses calm tones: only exceptions are 'action', only posted and reconciled are 'good'", () => {
    const actions = (TRANSACTION_STATES as readonly TransactionState[]).filter((s) => stateView(s).tone === "action");
    expect(actions).toEqual(["exception"]);
    const good = (TRANSACTION_STATES as readonly TransactionState[]).filter((s) => stateView(s).tone === "good");
    expect(good.sort()).toEqual(["posted", "reconciled"]);
  });

  it("marks the queues a person works on as 'watch'", () => {
    for (const s of ["possible_duplicate", "needs_receipt", "needs_classification", "ready_for_review"] as const) expect(stateView(s).tone).toBe("watch");
  });
});

describe("qualityView", () => {
  it("has a label, tone and hint for every data quality", () => {
    for (const q of QUALITIES) {
      const v = qualityView(q);
      expect(v.label).toBeTruthy();
      expect(v.hint).toBeTruthy();
    }
    expect(qualityView("posted_reconciled").tone).toBe("good");
    expect(qualityView("stale").tone).toBe("action");
    expect(qualityView("missing").tone).toBe("action");
    expect(qualityView("imported_pending").tone).toBe("watch");
  });
});

describe("other status views", () => {
  it("maps feed statuses, including file-only and none", () => {
    expect(feedStatusView("ok").tone).toBe("good");
    expect(feedStatusView("stale").tone).toBe("watch");
    expect(feedStatusView("needs_relink").tone).toBe("action");
    expect(feedStatusView("needs_relink").plain).toMatch(/re-link/i);
    expect(feedStatusView("disabled").tone).toBe("muted");
    expect(feedStatusView("file_only").label).toBe("File import");
    expect(feedStatusView("none").tone).toBe("muted");
  });

  it("maps sync run and rule states", () => {
    expect(syncRunStatusView("failed").tone).toBe("action");
    expect(syncRunStatusView("ok").tone).toBe("good");
    expect(syncRunStatusView("running").tone).toBe("neutral");
    expect(ruleStateView("proposed").tone).toBe("watch");
    expect(ruleStateView("approved").tone).toBe("good");
    expect(ruleStateView("retired").tone).toBe("muted");
  });
});

describe("freshness", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it("computes hours since, tolerating missing or bad input", () => {
    expect(hoursSince(undefined)).toBeUndefined();
    expect(hoursSince("not a date")).toBeUndefined();
    expect(hoursSince(hoursAgo(3), now)).toBeCloseTo(3, 5);
  });

  it("applies the 48-hour stale rule with a watch band at half", () => {
    expect(freshnessTone(undefined, 48, now)).toBe("muted");
    expect(freshnessTone(hoursAgo(1), 48, now)).toBe("good");
    expect(freshnessTone(hoursAgo(23), 48, now)).toBe("good");
    expect(freshnessTone(hoursAgo(25), 48, now)).toBe("watch");
    expect(freshnessTone(hoursAgo(49), 48, now)).toBe("action");
  });

  it("accepts a different threshold for the nightly poll", () => {
    expect(freshnessTone(hoursAgo(20), 30, now)).toBe("watch");
    expect(freshnessTone(hoursAgo(31), 30, now)).toBe("action");
  });
});
