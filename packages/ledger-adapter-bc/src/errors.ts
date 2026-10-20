/**
 * Error classes. The caller (the BC worker in services/jobs) decides what to do by class:
 *   BcRetryableError    -> sleep nextRetryDelayMs(attempt), rerun (the adapter reruns the pre-write check itself)
 *   BcNonRetryableError -> dead-letter the message and raise an Exception on the transaction
 *   LedgerAdapterError  -> a client-side refusal (bad input, ORIG budget, missing config); never sent to BC
 * Messages are scrubbed at construction so they can be logged as they are.
 */
import { redactString } from "./scrub.js";

export class LedgerAdapterError extends Error {
  constructor(message: string) {
    super(redactString(message));
    this.name = "LedgerAdapterError";
  }
}

export interface BcErrorBody {
  code: string;
  message: string;
}

export class BcRetryableError extends Error {
  readonly retryable = true as const;
  constructor(
    public readonly status: number,
    public readonly bc: BcErrorBody | undefined,
    /** From a Retry-After header when BC sends one (429). */
    public readonly retryAfterMs: number | undefined,
    public override readonly cause?: unknown,
  ) {
    super(redactString(`BC ${status}${bc ? ` ${bc.code}: ${bc.message}` : ""}`));
    this.name = "BcRetryableError";
  }
}

export class BcNonRetryableError extends Error {
  readonly retryable = false as const;
  constructor(
    public readonly status: number,
    public readonly bc: BcErrorBody | undefined,
    public override readonly cause?: unknown,
  ) {
    super(redactString(`BC ${status}${bc ? ` ${bc.code}: ${bc.message}` : ""}`));
    this.name = "BcNonRetryableError";
  }
  /** The BC error code, scrubbed, for the exception row. */
  get code(): string {
    return this.bc?.code ?? `HTTP_${this.status}`;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function parseBcError(body: unknown): BcErrorBody | undefined {
  if (!body || typeof body !== "object") return undefined;
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== "object") return undefined;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : "Unknown",
    message: redactString(typeof message === "string" ? message : ""),
  };
}

/** Network failures (fetch threw: DNS, reset, timeout) count as retryable; the pre-write check makes that safe. */
export function errorFromFetchFailure(cause: unknown): BcRetryableError {
  return new BcRetryableError(0, { code: "Network", message: cause instanceof Error ? cause.message : String(cause) }, undefined, cause);
}
