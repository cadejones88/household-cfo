/**
 * Idempotency keys and Business Central External Document Numbers.
 * One key follows a transaction from its source to its G/L entry (spec: "Idempotency and retries").
 */
import { createHash } from "node:crypto";

export type SourceKind = "plaid" | "ofx" | "csv" | "pdf" | "receipt" | "paycheck" | "manual";

export const SOURCE_CODES: Record<SourceKind, string> = {
  plaid: "PLD",
  ofx: "OFX",
  csv: "CSV",
  pdf: "PDF",
  receipt: "RCP",
  paycheck: "PAY",
  manual: "MAN",
};

export const KEY_PREFIX: Record<SourceKind, string> = {
  plaid: "plaid",
  ofx: "ofx",
  csv: "csv",
  pdf: "pdf",
  receipt: "rcpt",
  paycheck: "pay",
  manual: "man",
};

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export const idempotencyKey = {
  /** `plaid:<account_id>:<transaction_id>` of the settled transaction. Pending rows never get a key. */
  plaid(accountId: string, settledTransactionId: string): string {
    return `plaid:${req(accountId)}:${req(settledTransactionId)}`;
  },
  /** `ofx:<account_id>:<FITID>`. */
  ofx(accountId: string, fitid: string): string {
    return `ofx:${req(accountId)}:${req(fitid)}`;
  },
  /** `csv:<account_id>:sha256(date, amount, normalized description, sequence within the day)`. */
  csv(accountId: string, isoDate: string, amountCents: number, description: string, seqWithinDay: number): string {
    const norm = normalizeDescription(description);
    const h = sha256Hex(`${isoDate}|${amountCents}|${norm}|${seqWithinDay}`);
    return `csv:${req(accountId)}:${h}`;
  },
  /** `pdf:<account_id>:<statement_no>:<line_no>`. */
  pdf(accountId: string, statementNo: string, lineNo: number): string {
    return `pdf:${req(accountId)}:${req(statementNo)}:${lineNo}`;
  },
  /** `rcpt:<sha256 of the image>`. */
  receipt(imageSha256Hex: string): string {
    return `rcpt:${req(imageSha256Hex).toLowerCase()}`;
  },
  /** `pay:<employer_id>:<pay_date>:<net_cents>`. */
  paycheck(employerId: string, payDateIso: string, netCents: number): string {
    return `pay:${req(employerId)}:${payDateIso}:${netCents}`;
  },
  /** `man:<uuid>` minted once in the app. */
  manual(uuid: string): string {
    return `man:${req(uuid).toLowerCase()}`;
  },
};

function req(v: string): string {
  if (!v || /[\s:]/.test(v)) throw new Error(`Invalid key part: "${v}"`);
  return v;
}

/** Lower-case, collapse whitespace, strip punctuation and trailing reference numbers. */
export function normalizeDescription(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[#*]+\s*\d+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sourceKindOfKey(key: string): SourceKind {
  const prefix = key.split(":")[0];
  const entry = (Object.entries(KEY_PREFIX) as [SourceKind, string][]).find(([, p]) => p === prefix);
  if (!entry) throw new Error(`Unknown idempotency key prefix in "${key}"`);
  return entry[0];
}

/** BC's Gen. Journal Line "External Document No." is Code[35]. */
export const EXTERNAL_DOC_MAX_LENGTH = 35;
/** `HHAPP-` + 3 + `-` + 8 + `-` + 8 = 27 characters. */
export const EXTERNAL_DOC_LENGTH = 27;

/**
 * BC External Document No.: `HHAPP-<SRC>-<yyyymmdd>-<hash8>` (27 characters, inside BC's 35-character limit).
 * `hash8` is the first 8 hex characters of the SHA-256 of the idempotency key.
 * Splits of one transaction share the document number and differ by line.
 */
export function externalDocumentNo(key: string, postingDateIso: string): string {
  const src = SOURCE_CODES[sourceKindOfKey(key)];
  const ymd = postingDateIso.replace(/-/g, "");
  if (!/^\d{8}$/.test(ymd)) throw new Error(`postingDateIso must be YYYY-MM-DD, got "${postingDateIso}"`);
  const doc = `HHAPP-${src}-${ymd}-${sha256Hex(key).slice(0, 8).toUpperCase()}`;
  if (doc.length !== EXTERNAL_DOC_LENGTH || doc.length > EXTERNAL_DOC_MAX_LENGTH) {
    throw new Error(`External Document No. must be ${EXTERNAL_DOC_LENGTH} characters, got ${doc.length}`);
  }
  return doc;
}

export const EXTERNAL_DOC_RE = /^HHAPP-(PLD|OFX|CSV|PDF|RCP|PAY|MAN)-(\d{8})-([0-9A-F]{8})$/;

export function isHomesteadDocumentNo(docNo: string): boolean {
  return EXTERNAL_DOC_RE.test(docNo);
}
