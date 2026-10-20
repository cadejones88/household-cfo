/**
 * Calendar helpers. Dates are YYYY-MM-DD strings in the household's time zone (America/Boise by default).
 * Timestamps are ISO 8601. Nothing here uses the machine's local zone.
 */
import { addDays, daysBetween } from "@homestead/shared";

export const DEFAULT_TZ = "America/Boise";

/** Today's date in `tz`. */
export function todayIso(tz = DEFAULT_TZ, now: Date = new Date()): string {
  return dateIsoInTz(now, tz);
}

/** The YYYY-MM-DD of an instant in `tz`. */
export function dateIsoInTz(instant: Date, tz = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Local hour (0-23) and minute of an instant in `tz`. */
export function localTime(instant: Date, tz = DEFAULT_TZ): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { hour: get("hour"), minute: get("minute") };
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

export function daysInMonth(month: string): number {
  return Number(monthEnd(month).slice(8, 10));
}

/** First day of the following month. */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** The next occurrence of a monthly due day on or after `fromIso` (day 31 clamps to the month's last day). */
export function nextDueDate(dueDay: number, fromIso: string): string {
  const month = monthOf(fromIso);
  const candidate = clampDay(month, dueDay);
  if (candidate >= fromIso) return candidate;
  return clampDay(nextMonth(month), dueDay);
}

export function clampDay(month: string, day: number): string {
  const last = daysInMonth(month);
  return `${month}-${String(Math.min(Math.max(1, day), last)).padStart(2, "0")}`;
}

export { addDays, daysBetween };

/** Hours between two instants, never negative. */
export function hoursBetween(fromIso: string | Date, toIso: string | Date): number {
  const a = typeof fromIso === "string" ? Date.parse(fromIso) : fromIso.getTime();
  const b = typeof toIso === "string" ? Date.parse(toIso) : toIso.getTime();
  return Math.max(0, (b - a) / 3_600_000);
}
