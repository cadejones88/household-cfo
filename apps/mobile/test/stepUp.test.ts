import { describe, expect, it } from "vitest";
import { BACKGROUND_GRACE_MS, PASSKEY_REAUTH_MS, REFRESH_WINDOW_MS, STEP_UP_WINDOW_MS, StepUpWindow, sessionVerdict, shouldLock, withStepUp } from "@/auth/stepUp";
import { StepUpRequiredError, ApiError } from "@/api/types";

describe("StepUpWindow (fresh Face ID inside 2 minutes)", () => {
  it("is closed until a local authentication is recorded", () => {
    const w = new StepUpWindow(() => 1_000);
    expect(w.isFresh()).toBe(false);
    expect(w.remainingMs()).toBe(0);
  });

  it("stays open for exactly two minutes, then closes", () => {
    let now = 10_000;
    const w = new StepUpWindow(() => now);
    w.record();
    expect(STEP_UP_WINDOW_MS).toBe(120_000);
    expect(w.isFresh()).toBe(true);
    now += 119_999;
    expect(w.isFresh()).toBe(true);
    expect(w.remainingMs()).toBe(1);
    now += 1;
    expect(w.isFresh()).toBe(true);
    now += 1;
    expect(w.isFresh()).toBe(false);
    expect(w.remainingMs()).toBe(0);
  });

  it("never counts a verification from the future (clock moved back) and forgets on sign-out", () => {
    let now = 50_000;
    const w = new StepUpWindow(() => now);
    w.record(60_000);
    expect(w.isFresh()).toBe(false);
    now = 60_500;
    expect(w.isFresh()).toBe(true);
    w.clear();
    expect(w.isFresh()).toBe(false);
  });
});

describe("withStepUp", () => {
  const isStepUpError = (e: unknown) => e instanceof StepUpRequiredError;

  it("asks first for an approval and runs with the proof", async () => {
    const calls: boolean[] = [];
    let asked = 0;
    const r = await withStepUp({ upfront: true, isStepUpError, confirm: async () => (asked++, true), run: async (s) => (calls.push(s), "done") });
    expect(r).toEqual({ ok: true, value: "done" });
    expect(asked).toBe(1);
    expect(calls).toEqual([true]);
  });

  it("does nothing when Face ID is refused", async () => {
    let ran = false;
    const r = await withStepUp({ upfront: true, isStepUpError, confirm: async () => false, run: async () => (ran = true) });
    expect(r).toEqual({ ok: false, reason: "not_confirmed" });
    expect(ran).toBe(false);
  });

  it("asks only when the API wants proof (Not now on a budget move), then retries once", async () => {
    const calls: boolean[] = [];
    let asked = 0;
    const r = await withStepUp({
      upfront: false,
      isStepUpError,
      confirm: async () => (asked++, true),
      run: async (s) => {
        calls.push(s);
        if (!s) throw new StepUpRequiredError();
        return "declined";
      },
    });
    expect(r).toEqual({ ok: true, value: "declined" });
    expect(asked).toBe(1);
    expect(calls).toEqual([false, true]);
  });

  it("passes other errors through without asking for Face ID", async () => {
    let asked = 0;
    await expect(
      withStepUp({
        upfront: false,
        isStepUpError,
        confirm: async () => (asked++, true),
        run: async () => {
          throw new ApiError(403, "other_spouse_decides");
        },
      }),
    ).rejects.toMatchObject({ code: "other_spouse_decides" });
    expect(asked).toBe(0);
  });
});

describe("Face ID on open", () => {
  const now = 1_000_000_000;
  it("locks a cold start, and never when Face ID is off", () => {
    expect(shouldLock({ faceIdEnabled: true, lastUnlockAt: now - 1000, now })).toBe(true);
    expect(shouldLock({ faceIdEnabled: true, now })).toBe(true);
    expect(shouldLock({ faceIdEnabled: false, now })).toBe(false);
  });

  it("does not ask again after a short trip to another app, but does after five minutes", () => {
    expect(shouldLock({ faceIdEnabled: true, lastUnlockAt: now - 60_000, backgroundedAt: now - 30_000, now })).toBe(false);
    expect(shouldLock({ faceIdEnabled: true, lastUnlockAt: now - 60_000, backgroundedAt: now - BACKGROUND_GRACE_MS - 1, now })).toBe(true);
  });
});

describe("session verdict (7-day refresh window, passkey every 30 days)", () => {
  const now = 2_000_000_000_000;
  it("uses the access token while it is fresh, refreshes near expiry", () => {
    expect(sessionVerdict({ signedInAt: now - 1000, lastRefreshAt: now - 1000, accessExpiresAt: now + 30 * 60_000, now })).toBe("ok");
    expect(sessionVerdict({ signedInAt: now - 1000, lastRefreshAt: now - 1000, accessExpiresAt: now + 30_000, now })).toBe("refresh");
  });

  it("asks for the passkey again after 7 days without a refresh or 30 days since sign-in", () => {
    expect(sessionVerdict({ signedInAt: now - 8 * 86_400_000, lastRefreshAt: now - REFRESH_WINDOW_MS - 1, accessExpiresAt: 0, now })).toBe("sign_in_again");
    expect(sessionVerdict({ signedInAt: now - PASSKEY_REAUTH_MS - 1, lastRefreshAt: now - 1000, accessExpiresAt: now + 3_600_000, now })).toBe("sign_in_again");
    expect(sessionVerdict({ signedInAt: now - 6 * 86_400_000, lastRefreshAt: now - 6 * 86_400_000, accessExpiresAt: 0, now })).toBe("refresh");
  });
});
