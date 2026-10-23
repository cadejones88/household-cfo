// @vitest-environment node
/** The Console's recent-sign-in rule for protected actions (Cade, 10/23/2026): 15 minutes. */
import { describe, expect, it } from "vitest";
import { STEP_UP_RECENT_MINUTES, needsReauth } from "../src/auth/msal";

describe("recent sign-in", () => {
  const now = Date.parse("2026-10-23T18:00:00Z");
  it("is 15 minutes by default", () => {
    expect(STEP_UP_RECENT_MINUTES).toBe(15);
    expect(needsReauth(now - 14 * 60_000, now, STEP_UP_RECENT_MINUTES)).toBe(false);
    expect(needsReauth(now - 16 * 60_000, now, STEP_UP_RECENT_MINUTES)).toBe(true);
  });
  it("treats an unknown sign-in time as stale", () => {
    expect(needsReauth(0, now, STEP_UP_RECENT_MINUTES)).toBe(true);
  });
  it("lets the save after Plaid Link use the wider window", () => {
    expect(needsReauth(now - 40 * 60_000, now, 45)).toBe(false);
    expect(needsReauth(now - 50 * 60_000, now, 45)).toBe(true);
  });
});
