/**
 * Scrubbing for anything the adapter puts in an error message or a log line (brief: logs never carry amounts,
 * masks, merchants, tokens or image URLs). The API service has its own scrubber for its pino logger; this one
 * runs at the source so a BC error message is already clean when it leaves the adapter.
 */

const BEARER_RE = /bearer\s+[a-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const MONEY_RE = /\$\s?\d[\d,]*(\.\d{2})?/g;
/** A bare decimal with two places inside an error message is almost always an amount. */
const DECIMAL_RE = /(?<![\w.-])-?\d{1,3}(,\d{3})*\.\d{2}(?![\w])/g;
const ACCOUNT_RE = /\b(?:x|\*{2,})\d{4}\b/gi;
const SAS_RE = /[?&](sig|sv|se|sp|validationToken)=[^&\s]+/gi;
const PEM_RE = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g;
const CORRELATION_RE = /\s*CorrelationId:\s*[0-9a-f-]+\.?/gi;

export function redactString(s: string): string {
  return s
    .replace(PEM_RE, "[pem]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(JWT_RE, "[jwt]")
    .replace(MONEY_RE, "[amount]")
    .replace(DECIMAL_RE, "[amount]")
    .replace(ACCOUNT_RE, "[mask]")
    .replace(SAS_RE, "&$1=[redacted]")
    .replace(CORRELATION_RE, "");
}
