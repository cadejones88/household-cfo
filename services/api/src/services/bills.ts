/**
 * The obligation calendar: bills and minimums with their next due date, whether each falls before the next
 * Henry's Fork payday, and whether it is paid. PennyMac and the Frontier loans are BC-native (R7): they appear
 * here for cash planning but the app never posts them.
 */
import { nextBiweeklyPayday, type Bill } from "@homestead/shared";
import type { Queryable } from "../db/index.js";
import { addDays, clampDay, monthOf, nextDueDate, nextMonth } from "../lib/dates.js";
import { getSettings, type HouseholdSettings } from "./households.js";

export interface BillRow {
  id: string;
  name: string;
  account_id: string | null;
  category_id: string | null;
  amount_cents: number;
  due_day: number | null;
  next_due_date: string;
  cadence: "weekly" | "biweekly" | "monthly" | "annual" | "once";
  is_minimum: boolean;
  autopay: boolean;
  paid_through: string | null;
  is_bc_native: boolean;
  updated_at: string;
}

export async function listBillRows(db: Queryable, householdId: string): Promise<BillRow[]> {
  const r = await db.query<BillRow>(
    `select id, name, account_id, category_id, amount_cents::bigint::int as amount_cents, due_day, to_char(next_due_date,'YYYY-MM-DD') as next_due_date,
            cadence, is_minimum, autopay, to_char(paid_through,'YYYY-MM-DD') as paid_through, is_bc_native, updated_at
       from bills where household_id = $1 order by next_due_date, name`,
    [householdId],
  );
  return r.rows;
}

/** The next due date on or after `fromIso` for a bill, from its cadence. */
export function nextOccurrence(b: Pick<BillRow, "due_day" | "next_due_date" | "cadence">, fromIso: string): string {
  if (b.cadence === "once") return b.next_due_date;
  if (b.cadence === "monthly" && b.due_day) return nextDueDate(b.due_day, fromIso);
  if (b.cadence === "annual") {
    let d = b.next_due_date;
    while (d < fromIso) d = `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
    return d;
  }
  const step = b.cadence === "weekly" ? 7 : 14;
  let d = b.next_due_date;
  while (d < fromIso) d = addDays(d, step);
  return d;
}

/** Every occurrence of a bill between two dates (inclusive), for the 13-week forecast. */
export function occurrencesBetween(b: Pick<BillRow, "due_day" | "next_due_date" | "cadence">, fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let d = nextOccurrence(b, fromIso);
  let guard = 0;
  while (d <= toIso && guard < 60) {
    out.push(d);
    guard += 1;
    if (b.cadence === "once") break;
    if (b.cadence === "monthly" && b.due_day) d = clampDay(nextMonth(monthOf(d)), b.due_day);
    else if (b.cadence === "annual") d = `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
    else d = addDays(d, b.cadence === "weekly" ? 7 : 14);
  }
  return out;
}

export function nextPaydayFor(settings: Pick<HouseholdSettings, "paydayAnchor">, todayIso: string): string {
  return nextBiweeklyPayday(todayIso, settings.paydayAnchor);
}

export function toBillDto(b: BillRow, todayIso: string, nextPaydayIso: string): Bill {
  const dueDate = nextOccurrence(b, todayIso);
  const dto: Bill = {
    id: b.id,
    name: b.name,
    dueDate,
    amountCents: b.amount_cents,
    isMinimum: b.is_minimum,
    isBcNative: b.is_bc_native,
    autopay: b.autopay,
    beforePayday: dueDate < nextPaydayIso,
    paid: b.paid_through !== null && b.paid_through >= dueDate,
  };
  if (b.account_id) dto.accountId = b.account_id;
  if (b.category_id) dto.categoryId = b.category_id;
  return dto;
}

export interface UpcomingBills {
  bills: Bill[];
  nextPayday: string;
  /** The obligation calendar's version: the newest change to any bill. */
  calendarVersionAt: string;
}

/** Bills due from today until `untilIso` (default 35 days), one entry per occurrence. */
export async function upcomingBills(db: Queryable, householdId: string, todayIso: string, untilIso?: string): Promise<UpcomingBills> {
  const settings = await getSettings(db, householdId);
  const nextPayday = nextPaydayFor(settings, todayIso);
  const until = untilIso ?? addDays(todayIso, 35);
  const rows = await listBillRows(db, householdId);
  const bills: Bill[] = [];
  let calendarVersionAt = "1970-01-01T00:00:00.000Z";
  for (const b of rows) {
    const at = new Date(b.updated_at).toISOString();
    if (at > calendarVersionAt) calendarVersionAt = at;
    for (const due of occurrencesBetween(b, todayIso, until)) {
      const dto = toBillDto(b, due, nextPayday);
      dto.dueDate = due;
      dto.beforePayday = due < nextPayday;
      dto.paid = b.paid_through !== null && b.paid_through >= due;
      bills.push(dto);
    }
  }
  bills.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  return { bills, nextPayday, calendarVersionAt };
}

/** Mark a bill paid through a date (the matching job calls this when a payment line for the bill is seen). */
export async function markBillPaid(db: Queryable, householdId: string, billId: string, throughIso: string): Promise<void> {
  await db.query("update bills set paid_through = greatest(coalesce(paid_through, $2::date), $2::date) where id = $1 and household_id = $3", [billId, throughIso, householdId]);
}
