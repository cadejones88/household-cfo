import { formatUsd, type Cents } from "@homestead/shared";
import { config } from "../config";

export function money(cents: Cents | undefined, opts: { sign?: "auto" | "always" | "never" } = {}): string {
  if (cents === undefined || cents === null) return "—";
  return formatUsd(cents, opts);
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: config.timeZone });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: config.timeZone,
  timeZoneName: "short",
});

/** YYYY-MM-DD (America/Boise) to "Oct 18, 2026". */
export function date(iso: string | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) return dateFmt.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)));
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : dateFmt.format(new Date(t));
}

/** ISO timestamp to "Oct 18, 2026, 6:12 PM MDT". */
export function dateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : dateTimeFmt.format(new Date(t));
}

/** "3 minutes ago", "2 hours ago", "4 days ago". */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

export function pct(fraction: number | undefined): string {
  if (fraction === undefined) return "—";
  return `${Math.round(fraction * 100)}%`;
}
