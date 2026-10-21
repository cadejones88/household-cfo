/**
 * Step-up: approvals, rule changes, settings and export need a fresh Face ID (or passcode) inside the last
 * 2 minutes (Phase 3 spec, "Identity and sign-in"). The API checks the same window: in dev mode through the
 * `x-step-up: true` header, in Entra mode through a token issued after the local authentication.
 */

export const STEP_UP_WINDOW_MS = 2 * 60 * 1000;

export class StepUpWindow {
  private verifiedAt: number | undefined;

  constructor(private readonly now: () => number = () => Date.now(), private readonly windowMs: number = STEP_UP_WINDOW_MS) {}

  /** Record a successful local authentication. */
  record(at: number = this.now()): void {
    this.verifiedAt = at;
  }

  /** True when a local authentication happened inside the window. */
  isFresh(at: number = this.now()): boolean {
    if (this.verifiedAt === undefined) return false;
    const age = at - this.verifiedAt;
    return age >= 0 && age <= this.windowMs;
  }

  /** Milliseconds until the window closes; 0 when it is already closed. */
  remainingMs(at: number = this.now()): number {
    if (this.verifiedAt === undefined) return 0;
    return Math.max(0, this.windowMs - (at - this.verifiedAt));
  }

  /** Forget the verification (sign-out, app sent to background for a long time). */
  clear(): void {
    this.verifiedAt = undefined;
  }
}

/**
 * Face ID unlock policy (spec: "Face ID unlock on the device with a 7-day refresh token; re-authentication
 * with the passkey every 30 days or after a sign-out").
 */
export const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSKEY_REAUTH_MS = 30 * 24 * 60 * 60 * 1000;
/** Returning from the background within this many ms does not ask for Face ID again. */
export const BACKGROUND_GRACE_MS = 5 * 60 * 1000;

export interface LockInput {
  faceIdEnabled: boolean;
  /** When the app was last unlocked with Face ID or passcode in this install; undefined on first run. */
  lastUnlockAt?: number | undefined;
  /** When the app went to the background; undefined on a cold start. */
  backgroundedAt?: number | undefined;
  now: number;
}

/** Whether to show the Face ID gate before the Home screen. */
export function shouldLock(input: LockInput): boolean {
  if (!input.faceIdEnabled) return false;
  if (input.lastUnlockAt === undefined) return true;
  if (input.backgroundedAt === undefined) return true; // cold start
  return input.now - input.backgroundedAt > BACKGROUND_GRACE_MS;
}

export interface SessionInput {
  /** When the passkey sign-in happened (the tokens' original issue). */
  signedInAt: number;
  /** When the refresh token was last exercised. */
  lastRefreshAt: number;
  /** When the access token expires. */
  accessExpiresAt: number;
  now: number;
}

export type SessionVerdict = "ok" | "refresh" | "sign_in_again";

/** Access token fresh: ok. Inside the 7-day refresh window: refresh. After 30 days (or a sign-out): the passkey again. */
export function sessionVerdict(input: SessionInput, marginMs = 60_000): SessionVerdict {
  if (input.now - input.signedInAt > PASSKEY_REAUTH_MS) return "sign_in_again";
  if (input.now - input.lastRefreshAt > REFRESH_WINDOW_MS) return "sign_in_again";
  if (input.now < input.accessExpiresAt - marginMs) return "ok";
  return "refresh";
}
