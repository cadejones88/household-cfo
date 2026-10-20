/**
 * Log scrubbing (spec: "Data protection"): logs keep the idempotency key only. Amounts, account masks,
 * merchant strings, tokens and image URLs never reach Application Insights.
 */
const SENSITIVE_KEYS = /^(amount|amount_cents|amountCents|mask|merchant|merchant_raw|merchantRaw|merchant_norm|token|access_token|accessToken|authorization|cookie|secret|password|public_token|blob_ref|blobRef|image|sas|signature)$/i;

export function scrub<T>(value: T, depth = 0): T {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? "[redacted]" : scrub(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

const BEARER_RE = /bearer\s+[a-z0-9._~+/=-]+/gi;
const MONEY_RE = /\$\s?\d[\d,]*(\.\d{2})?/g;
const ACCOUNT_RE = /\b(?:x|\*{2,})\d{4}\b/gi;
const SAS_RE = /[?&](sig|sv|se|sp)=[^&\s]+/gi;

export function redactString(s: string): string {
  return s.replace(BEARER_RE, "Bearer [redacted]").replace(MONEY_RE, "[amount]").replace(ACCOUNT_RE, "[mask]").replace(SAS_RE, "&$1=[redacted]");
}

export const scrubbingSerializers = {
  req(req: { method?: string; url?: string; headers?: Record<string, unknown>; id?: unknown }) {
    return { id: req.id, method: req.method, url: redactString(req.url ?? "") };
  },
  res(res: { statusCode?: number }) {
    return { statusCode: res.statusCode };
  },
  err(err: Error & { code?: string }) {
    return { type: err.name, message: redactString(err.message), code: err.code };
  },
};
