/**
 * Plain-language dates and money for the screens. Dates are YYYY-MM-DD strings in America/Boise
 * (the household's time zone); timestamps are ISO 8601. Money is integer cents via @homestead/shared.
 */
import { formatUsd, daysBetween, type Cents } from "@homestead/shared";

export const HOUSEHOLD_TZ = "America/Boise";
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Today's date in the household's time zone, YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: HOUSEHOLD_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // Intl without time zone data: fall through to the device's local date.
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Hour of day in the household's time zone (0–23), for "Good morning". */
export function hourNow(now: Date = new Date()): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: HOUSEHOLD_TZ, hour: "numeric", hour12: false }).format(now);
    const n = Number.parseInt(h, 10);
    if (Number.isFinite(n)) return n % 24;
  } catch {
    // fall through
  }
  return now.getHours();
}

function parts(iso: string): { y: number; m: number; d: number; dow: number } {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dow };
}

/** "Fri, Oct 24" */
export function fmtDate(iso: string): string {
  const { m, d, dow } = parts(iso);
  return `${WD[dow]}, ${MO[m - 1]} ${d}`;
}

/** "Oct 24" */
export function fmtShort(iso: string): string {
  const { m, d } = parts(iso);
  return `${MO[m - 1]} ${d}`;
}

export function weekdayOf(iso: string): string {
  return WD[parts(iso).dow] ?? "";
}

export function dayOf(iso: string): string {
  return String(parts(iso).d);
}

export function monthName(iso: string): string {
  return MONTHS[parts(iso).m - 1] ?? "";
}

/** "Today", "Yesterday", "Tomorrow" or "Fri, Oct 24" relative to `today`. */
export function relDate(iso: string, today: string): string {
  const off = daysBetween(today, iso);
  if (off === 0) return "Today";
  if (off === -1) return "Yesterday";
  if (off === 1) return "Tomorrow";
  return fmtDate(iso);
}

/** ISO timestamp -> "Oct 19" in the household time zone. */
export function fmtStampDate(isoTimestamp: string): string {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return isoTimestamp.slice(5, 10);
  return fmtShort(todayIso(d));
}

/** "$1,234.56"; `sign: "always"` adds a plus on inflows. */
export function money(cents: Cents, sign: "auto" | "always" = "auto"): string {
  return formatUsd(cents, { sign });
}

/** "$1,235" (no cents) for budgets and goals, like the prototype's money0. */
export function money0(cents: Cents): string {
  const whole = Math.round(Math.abs(cents) / 100).toLocaleString("en-US");
  return `${cents < 0 ? "−" : ""}$${whole}`;
}

/** Fraction of the month gone, 0..1, for the budget pace line. */
export function monthProgress(today: string): { fraction: number; daysInMonth: number; day: number } {
  const { y, m, d } = parts(today);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { fraction: d / daysInMonth, daysInMonth, day: d };
}

export function firstOfMonth(today: string): string {
  return `${today.slice(0, 7)}-01`;
}
