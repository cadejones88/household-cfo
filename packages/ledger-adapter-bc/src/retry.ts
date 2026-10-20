/**
 * Retry schedule from the spec ("Idempotency and retries", item 4): 408, 429 and 5xx retry with exponential
 * backoff of 1, 2, 4, 8, 16 minutes, then hourly for a day. Any other error is not retried.
 * The function is pure; the caller sleeps. Attempt 1 is the first retry after the first failure.
 */
import { BcRetryableError } from "./errors.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const BACKOFF_MINUTES = [1, 2, 4, 8, 16] as const;
/** "Hourly for a day": 24 hourly retries after the five backoff steps. */
export const HOURLY_RETRIES = 24;
export const MAX_RETRY_ATTEMPTS = BACKOFF_MINUTES.length + HOURLY_RETRIES;

/**
 * Milliseconds to wait before retry number `attempt` (1-based), or `undefined` when the schedule is exhausted
 * and the message should be dead-lettered.
 */
export function nextRetryDelayMs(attempt: number): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  if (attempt <= BACKOFF_MINUTES.length) return (BACKOFF_MINUTES[attempt - 1] ?? 1) * MINUTE_MS;
  if (attempt <= MAX_RETRY_ATTEMPTS) return HOUR_MS;
  return undefined;
}

/** The schedule plus BC's own Retry-After when it is longer. */
export function retryDelayFor(error: unknown, attempt: number): number | undefined {
  const scheduled = nextRetryDelayMs(attempt);
  if (scheduled === undefined) return undefined;
  if (error instanceof BcRetryableError && error.retryAfterMs !== undefined) return Math.max(scheduled, error.retryAfterMs);
  return scheduled;
}

export function isRetryable(error: unknown): error is BcRetryableError {
  return error instanceof BcRetryableError;
}

/** Sum of the whole schedule, for the dead-letter alert copy ("gave up after ~25 hours"). */
export function totalScheduleMs(): number {
  let total = 0;
  for (let a = 1; a <= MAX_RETRY_ATTEMPTS; a += 1) total += nextRetryDelayMs(a) ?? 0;
  return total;
}
