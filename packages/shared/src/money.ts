/**
 * Money math. Every amount in Homestead is an integer number of cents.
 * Floating point never touches a balance; strings are parsed, cents are added.
 */

export type Cents = number;

const CENTS_RE = /^\s*(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/;
const PAREN_RE = /^\s*\(\s*(.+?)\s*\)\s*$/;

/** Parse "1,234.56", "$12.3", "-5", "(42.00)" to cents. Throws on anything else. */
export function parseCents(input: string | number): Cents {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`Not a finite amount: ${input}`);
    return Math.round(input * 100);
  }
  let s = input;
  let negative = false;
  const paren = PAREN_RE.exec(s);
  if (paren) {
    negative = true;
    s = paren[1] ?? "";
  }
  const m = CENTS_RE.exec(s);
  if (!m) throw new Error(`Not an amount: "${input}"`);
  if (m[1]) negative = !negative;
  const whole = (m[2] ?? "0").replace(/,/g, "");
  const frac = (m[3] ?? "").padEnd(2, "0");
  const cents = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount too large: "${input}"`);
  return negative ? -cents : cents;
}

/** Cents to a decimal string with two places and no symbol: 123456 -> "1234.56". BC wants this shape. */
export function centsToDecimalString(cents: Cents): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac.toString().padStart(2, "0")}`;
}

/** Cents to a number with two decimals (for JSON bodies that require a number, e.g. BC `amount`). */
export function centsToNumber(cents: Cents): number {
  assertCents(cents);
  return Number(centsToDecimalString(cents));
}

/** "$1,234.56" / "−$5.00" for display. Uses a real minus sign. */
export function formatUsd(cents: Cents, opts: { sign?: "auto" | "always" | "never" } = {}): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  const frac = (abs % 100).toString().padStart(2, "0");
  const body = `$${whole}.${frac}`;
  const sign = opts.sign ?? "auto";
  if (cents < 0) return `−${body}`;
  if (sign === "always" && cents > 0) return `+${body}`;
  return body;
}

export function assertCents(cents: unknown): asserts cents is Cents {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents)) {
    throw new Error(`Amount must be an integer number of cents, got ${String(cents)}`);
  }
}

export function sumCents(values: Iterable<Cents>): Cents {
  let total = 0;
  for (const v of values) {
    assertCents(v);
    total += v;
  }
  return total;
}

/**
 * Prorate `total` across `weights` (all non-negative) so the parts sum exactly to `total`.
 * Rounding residue goes to the largest weight (ties: the first of them). Used for tax proration on receipts.
 */
export function prorateCents(total: Cents, weights: readonly Cents[]): Cents[] {
  assertCents(total);
  if (weights.length === 0) throw new Error("prorateCents needs at least one weight");
  for (const w of weights) {
    assertCents(w);
    if (w < 0) throw new Error("prorateCents weights must be non-negative");
  }
  const weightSum = sumCents(weights);
  if (weightSum === 0) {
    // Nothing to weight by: put it all on the first line.
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const parts = weights.map((w) => Math.floor((total * w) / weightSum));
  const residue = total - sumCents(parts);
  let largest = 0;
  for (let i = 1; i < weights.length; i += 1) {
    if ((weights[i] ?? 0) > (weights[largest] ?? 0)) largest = i;
  }
  parts[largest] = (parts[largest] ?? 0) + residue;
  return parts;
}

/** |a - b| <= tolerance, where tolerance may be absolute cents or a fraction of |b|. */
export function withinTolerance(a: Cents, b: Cents, tolerance: { cents?: Cents; fraction?: number }): boolean {
  assertCents(a);
  assertCents(b);
  const diff = Math.abs(a - b);
  if (tolerance.cents !== undefined && diff <= tolerance.cents) return true;
  if (tolerance.fraction !== undefined && diff <= Math.abs(b) * tolerance.fraction) return true;
  return false;
}
