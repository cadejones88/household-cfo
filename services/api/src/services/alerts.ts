/**
 * Alerts (spec: "Alerts and quiet hours"). Alerts come from the cash forecast, not from a balance crossing a
 * line; one open alert per fingerprint (kind plus account, category or item); it repeats only when the facts
 * change by more than $25 or the due date moves; it goes quiet while an agreed action is pending; allowance
 * categories never alert; quiet hours are 9 pm to 7 am Mountain and only the household's approved critical types
 * break them; watch alerts go into one 7 am digest.
 *
 * Levels: action (both spouses, push), watch (the relevant spouse, badge plus the daily digest), pulse (weekly).
 */
import { MATERIALITY_CENTS, amountBand, formatUsd, inBand, type Alert } from "@homestead/shared";
import { audit, type Queryable } from "../db/index.js";
import { addDays, dateIsoInTz, hoursBetween, localTime } from "../lib/dates.js";
import { budgetStatus } from "./budget.js";
import { listBillRows, nextOccurrence, nextPaydayFor } from "./bills.js";
import { getHousehold, type HouseholdSettings } from "./households.js";
import type { LedgerPort } from "./ledgerPort.js";
import { merchantHistory } from "./rules.js";
import { computeSafeToSpend } from "./safeToSpend.js";
import { listAccounts } from "./transactions.js";

export type AlertLevel = Alert["level"];

export interface AlertCandidate {
  kind: string;
  level: AlertLevel;
  fingerprint: string;
  /** null = both spouses */
  memberId: string | null;
  title: string;
  body: string;
  payload: Record<string, unknown> & { amountCents?: number; dueDate?: string };
}

export interface AlertRow {
  id: string;
  member_id: string | null;
  kind: string;
  level: AlertLevel;
  fingerprint: string;
  payload: AlertCandidate["payload"] & { title?: string; body?: string };
  created_at: string;
  delivered_at: string | null;
  snoozed_until: string | null;
  resolved_at: string | null;
}

const ALERT_COLS = "id, member_id, kind, level, fingerprint, payload, created_at, delivered_at, snoozed_until, resolved_at";

export function toAlertDto(a: AlertRow): Alert {
  const dto: Alert = { id: a.id, kind: a.kind, level: a.level, fingerprint: a.fingerprint, title: a.payload.title ?? a.kind, body: a.payload.body ?? "", createdAt: new Date(a.created_at).toISOString() };
  if (a.member_id) dto.memberId = a.member_id;
  if (a.delivered_at) dto.deliveredAt = new Date(a.delivered_at).toISOString();
  if (a.snoozed_until) dto.snoozedUntil = new Date(a.snoozed_until).toISOString();
  if (a.resolved_at) dto.resolvedAt = new Date(a.resolved_at).toISOString();
  return dto;
}

export async function listAlerts(db: Queryable, householdId: string, opts: { openOnly?: boolean; memberId?: string; limit?: number } = {}): Promise<AlertRow[]> {
  const where = ["household_id = $1"];
  const params: unknown[] = [householdId];
  if (opts.openOnly) where.push("resolved_at is null");
  if (opts.memberId) {
    params.push(opts.memberId);
    where.push(`(member_id is null or member_id = $${params.length})`);
  }
  params.push(Math.min(opts.limit ?? 100, 500));
  const r = await db.query<AlertRow>(`select ${ALERT_COLS} from alerts where ${where.join(" and ")} order by created_at desc limit $${params.length}`, params);
  return r.rows;
}

// Evaluation (pure) -----------------------------------------------------------------------------------

export interface AlertInputs {
  todayIso: string;
  nowIso: string;
  nextPaydayIso: string;
  liquidityFloorCents: number;
  /** Cash accounts with a balance; cards and loans are not here. */
  accounts: { id: string; name: string; balanceCents: number | null; balanceAsOf?: string; feedStaleHours: number; feedId?: string; feedOwnerMemberId?: string; needsRelink: boolean }[];
  /** Unpaid obligations in the next 14 days. */
  bills: { id: string; name: string; accountId: string | null; dueDate: string; amountCents: number; isMinimum: boolean }[];
  safeCents: number;
  /** Budget lines forecast over by month-end (allowances already excluded). */
  overruns: { categoryId: string; name: string; forecastCents: number; budgetCents: number }[];
  duplicates: { transactionId: string; amountCents: number; merchant: string }[];
  outOfPattern: { transactionId: string; amountCents: number; merchant: string }[];
  receiptsMissing: { transactionId: string; amountCents: number; merchant: string; daysWaiting: number }[];
  deadLetters: { outboxId: string; aggregateId: string; operation: string }[];
  /** Agreed actions still pending: approvals open for these transaction ids / bill ids. */
  pendingActionKeys: Set<string>;
}

export function evaluateAlerts(i: AlertInputs): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const soon = addDays(i.todayIso, 3);
  // Cash forecast per account over the next 3 days: bills drawn in date order.
  const byAccount = new Map<string | null, number | null>();
  for (const a of i.accounts) byAccount.set(a.id, a.balanceCents);
  const bills = [...i.bills].filter((b) => b.dueDate <= soon).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const running = new Map<string | null, number>();
  for (const b of bills) {
    const key = b.accountId && byAccount.has(b.accountId) ? b.accountId : null;
    const start = key ? (byAccount.get(key) ?? null) : i.accounts.reduce((s, a) => s + (a.balanceCents ?? 0), 0);
    if (start === null) continue;
    const before = running.get(key) ?? start;
    const after = before - b.amountCents;
    running.set(key, after);
    if (before < b.amountCents && !i.pendingActionKeys.has(`bill:${b.id}`)) {
      out.push({
        kind: "bill_uncovered",
        level: "action",
        fingerprint: `bill_uncovered:${b.id}`,
        memberId: null,
        title: `${b.name} may not clear`,
        body: `${formatUsd(b.amountCents)} is due ${b.dueDate} and the account it draws from has ${formatUsd(Math.max(0, before))} after earlier bills.`,
        payload: { billId: b.id, amountCents: b.amountCents, dueDate: b.dueDate, accountId: b.accountId, shortCents: b.amountCents - before },
      });
    }
  }
  for (const [key, bal] of running) {
    if (bal < 0) {
      const acct = key ? i.accounts.find((a) => a.id === key) : undefined;
      const fp = `cash_short:${key ?? "household"}`;
      if (!out.some((o) => o.fingerprint === fp) && !i.pendingActionKeys.has(fp)) {
        out.push({
          kind: "cash_short",
          level: "action",
          fingerprint: fp,
          memberId: null,
          title: acct ? `${acct.name} goes below zero within 3 days` : "Cash goes below zero within 3 days",
          body: `After the bills due by ${soon}, the forecast balance is ${formatUsd(bal)}.`,
          payload: { accountId: key, amountCents: bal, dueDate: soon },
        });
      }
    }
  }
  for (const d of i.duplicates) {
    if (Math.abs(d.amountCents) < MATERIALITY_CENTS) continue;
    out.push({ kind: "possible_duplicate", level: "action", fingerprint: `possible_duplicate:${d.transactionId}`, memberId: null, title: `Possible repeat: ${formatUsd(Math.abs(d.amountCents))} at ${d.merchant}`, body: "The same amount appeared twice within three days. One tap in the app says whether it is the same purchase.", payload: { transactionId: d.transactionId, amountCents: d.amountCents } });
  }
  for (const o of i.outOfPattern) {
    if (Math.abs(o.amountCents) < MATERIALITY_CENTS) continue;
    out.push({ kind: "out_of_pattern", level: "action", fingerprint: `out_of_pattern:${o.transactionId}`, memberId: null, title: `Unusual charge: ${formatUsd(Math.abs(o.amountCents))} at ${o.merchant}`, body: "This is well outside what this merchant usually charges. Check it is yours.", payload: { transactionId: o.transactionId, amountCents: o.amountCents } });
  }
  for (const a of i.accounts) {
    if (a.feedStaleHours > 48 && a.feedId) {
      const due = i.bills.find((b) => b.accountId === a.id && b.dueDate <= soon);
      if (due) {
        out.push({ kind: "feed_down_bill_due", level: "action", fingerprint: `feed_down_bill_due:${a.feedId}`, memberId: null, title: `${a.name} has not updated in ${Math.floor(a.feedStaleHours)} hours`, body: `${due.name} (${formatUsd(due.amountCents)}) is due ${due.dueDate} and we cannot see the balance.`, payload: { feedId: a.feedId, accountId: a.id, dueDate: due.dueDate, amountCents: due.amountCents } });
      }
    }
    if (a.needsRelink && a.feedId) {
      out.push({ kind: "needs_relink", level: "watch", fingerprint: `needs_relink:${a.feedId}`, memberId: a.feedOwnerMemberId ?? null, title: `${a.name} needs a fresh sign-in`, body: "The bank asked for a new login. Reconnect when you have a minute; nothing is lost in the meantime.", payload: { feedId: a.feedId, accountId: a.id } });
    }
  }
  for (const d of i.deadLetters) {
    out.push({ kind: "bc_dead_letter", level: "action", fingerprint: `bc_dead_letter:${d.outboxId}`, memberId: null, title: "A write to Business Central was set aside", body: `The ${d.operation} for item ${d.aggregateId.slice(0, 8)} failed with an error that will not clear by retrying. It is in the Console's exception queue.`, payload: { outboxId: d.outboxId, aggregateId: d.aggregateId } });
  }
  for (const o of i.overruns) {
    out.push({ kind: "category_overrun", level: "watch", fingerprint: `category_overrun:${o.categoryId}`, memberId: null, title: `${o.name} is on pace to go over`, body: `At this pace ${o.name} ends the month at ${formatUsd(o.forecastCents)} against ${formatUsd(o.budgetCents)}.`, payload: { categoryId: o.categoryId, amountCents: o.forecastCents - o.budgetCents } });
  }
  if (i.safeCents < i.liquidityFloorCents || i.safeCents < 0) {
    out.push({ kind: "safe_below_floor", level: "watch", fingerprint: "safe_below_floor", memberId: null, title: "Safe to spend is below the floor", body: `${formatUsd(i.safeCents)} is safe to spend before ${i.nextPaydayIso}; the floor is ${formatUsd(i.liquidityFloorCents)}.`, payload: { amountCents: i.safeCents, dueDate: i.nextPaydayIso } });
  }
  for (const r of i.receiptsMissing) {
    if (r.daysWaiting < 7) continue;
    out.push({ kind: "receipt_missing", level: "watch", fingerprint: `receipt_missing:${r.transactionId}`, memberId: null, title: `Still no receipt for ${formatUsd(Math.abs(r.amountCents))} at ${r.merchant}`, body: `It has waited ${r.daysWaiting} days. After 10 it goes in as an estimate.`, payload: { transactionId: r.transactionId, amountCents: r.amountCents } });
  }
  return out;
}

// Gathering ------------------------------------------------------------------------------------------

export async function gatherAlertInputs(db: Queryable, householdId: string, ledger: LedgerPort, now: Date): Promise<AlertInputs> {
  const hh = await getHousehold(db, householdId);
  const todayIso = dateIsoInTz(now, hh.timezone);
  const settings = hh.settings;
  const accounts = await listAccounts(db, householdId);
  const feeds = await db.query<{ id: string; owner_member_id: string; needs_relink: boolean; last_synced_at: string | null }>("select id, owner_member_id, needs_relink, last_synced_at from feed_connections where household_id = $1", [householdId]);
  const feedById = new Map(feeds.rows.map((f) => [f.id, f]));
  const cashKinds = new Set(["checking", "savings", "share", "wallet", "cash"]);
  const accts: AlertInputs["accounts"] = accounts
    .filter((a) => cashKinds.has(a.kind))
    .map((a) => {
      const f = a.feed_connection_id ? feedById.get(a.feed_connection_id) : undefined;
      const row: AlertInputs["accounts"][number] = { id: a.id, name: a.display_name, balanceCents: a.balance_cents, feedStaleHours: f?.last_synced_at ? hoursBetween(f.last_synced_at, now) : 0, needsRelink: f?.needs_relink ?? false };
      if (a.balance_as_of) row.balanceAsOf = new Date(a.balance_as_of).toISOString();
      if (f) {
        row.feedId = f.id;
        row.feedOwnerMemberId = f.owner_member_id;
      }
      return row;
    });
  const horizon = addDays(todayIso, 14);
  const bills: AlertInputs["bills"] = [];
  for (const b of await listBillRows(db, householdId)) {
    const due = nextOccurrence(b, todayIso);
    if (due > horizon) continue;
    if (b.paid_through && b.paid_through >= due) continue;
    bills.push({ id: b.id, name: b.name, accountId: b.account_id, dueDate: due, amountCents: b.amount_cents, isMinimum: b.is_minimum });
  }
  const sts = await computeSafeToSpend(db, householdId, ledger, todayIso, now);
  const budget = await budgetStatus(db, householdId, ledger, todayIso.slice(0, 7), todayIso);
  const overruns = budget.lines.filter((l) => !l.isAllowance && l.budgetCents > 0 && l.forecastCents > l.budgetCents && (l.pace === "watch" || l.pace === "over")).map((l) => ({ categoryId: l.categoryId, name: l.name, forecastCents: l.forecastCents, budgetCents: l.budgetCents }));
  const dups = await db.query<{ id: string; amount_cents: number; merchant_raw: string }>("select id, amount_cents::bigint::int as amount_cents, merchant_raw from transactions where household_id = $1 and state = 'possible_duplicate'", [householdId]);
  const recent = await db.query<{ id: string; amount_cents: number; merchant_raw: string; merchant_norm: string }>(
    "select id, amount_cents::bigint::int as amount_cents, merchant_raw, merchant_norm from transactions where household_id = $1 and state in ('needs_classification','ready_for_review') and kind = 'spend' and posted_date >= $2::date",
    [householdId, addDays(todayIso, -7)],
  );
  const outOfPattern: AlertInputs["outOfPattern"] = [];
  for (const t of recent.rows) {
    if (Math.abs(t.amount_cents) < MATERIALITY_CENTS) continue;
    const h = await merchantHistory(db, householdId, t.merchant_norm, 6, t.id);
    if (h.count < 3) continue;
    const band = amountBand(h.amountsCents.map((a) => Math.abs(a)));
    if (!inBand(t.amount_cents, band) && Math.abs(t.amount_cents) > band.maxCents * 2) outOfPattern.push({ transactionId: t.id, amountCents: t.amount_cents, merchant: t.merchant_raw });
  }
  const missing = await db.query<{ id: string; amount_cents: number; merchant_raw: string; days: number }>(
    "select id, amount_cents::bigint::int as amount_cents, merchant_raw, ($2::date - posted_date)::int as days from transactions where household_id = $1 and state = 'needs_receipt' and kind <> 'paycheck'",
    [householdId, todayIso],
  );
  const dead = await db.query<{ id: string; aggregate_id: string; operation: string }>("select id, aggregate_id, operation from outbox where household_id = $1 and dead_lettered and completed_at is null", [householdId]);
  const open = await db.query<{ payload: Record<string, unknown> }>("select payload from approvals where household_id = $1 and decided_by is null", [householdId]);
  const pendingActionKeys = new Set<string>();
  for (const a of open.rows) {
    if (typeof a.payload["transactionId"] === "string") pendingActionKeys.add(`tx:${a.payload["transactionId"]}`);
    if (typeof a.payload["billId"] === "string") pendingActionKeys.add(`bill:${a.payload["billId"]}`);
    if (typeof a.payload["holdFingerprint"] === "string") pendingActionKeys.add(a.payload["holdFingerprint"]);
  }
  return {
    todayIso,
    nowIso: now.toISOString(),
    nextPaydayIso: nextPaydayFor(settings, todayIso),
    liquidityFloorCents: settings.liquidityFloorCents,
    accounts: accts,
    bills,
    safeCents: sts.safeCents,
    overruns,
    duplicates: dups.rows.map((d) => ({ transactionId: d.id, amountCents: d.amount_cents, merchant: d.merchant_raw })),
    outOfPattern,
    receiptsMissing: missing.rows.map((m) => ({ transactionId: m.id, amountCents: m.amount_cents, merchant: m.merchant_raw, daysWaiting: m.days })),
    deadLetters: dead.rows.map((d) => ({ outboxId: d.id, aggregateId: d.aggregate_id, operation: d.operation })),
    pendingActionKeys,
  };
}

// Upsert ---------------------------------------------------------------------------------------------

export interface UpsertCounts {
  created: number;
  changed: number;
  unchanged: number;
  resolved: number;
}

/** The facts changed enough to repeat an alert: more than $25 or a moved due date. */
export function factsChanged(prev: AlertCandidate["payload"], next: AlertCandidate["payload"]): boolean {
  if ((prev.dueDate ?? "") !== (next.dueDate ?? "")) return true;
  const a = prev.amountCents ?? 0;
  const b = next.amountCents ?? 0;
  return Math.abs(a - b) > MATERIALITY_CENTS;
}

export async function upsertAlerts(db: Queryable, householdId: string, candidates: readonly AlertCandidate[], actor = "alerts"): Promise<UpsertCounts> {
  const counts: UpsertCounts = { created: 0, changed: 0, unchanged: 0, resolved: 0 };
  const open = await listAlerts(db, householdId, { openOnly: true, limit: 500 });
  const byFp = new Map(open.map((a) => [a.fingerprint, a]));
  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.fingerprint);
    const existing = byFp.get(c.fingerprint);
    const payload = { ...c.payload, title: c.title, body: c.body };
    if (!existing) {
      await db.query("insert into alerts (household_id, member_id, kind, level, fingerprint, payload) values ($1,$2,$3,$4,$5,$6)", [householdId, c.memberId, c.kind, c.level, c.fingerprint, JSON.stringify(payload)]);
      counts.created += 1;
      continue;
    }
    if (factsChanged(existing.payload, c.payload)) {
      // Repeat: the facts moved, so it is delivered again.
      await db.query("update alerts set payload = $2, delivered_at = null, snoozed_until = null where id = $1", [existing.id, JSON.stringify(payload)]);
      counts.changed += 1;
    } else {
      counts.unchanged += 1;
    }
  }
  for (const a of open) {
    if (seen.has(a.fingerprint) || a.level === "pulse") continue;
    await db.query("update alerts set resolved_at = now() where id = $1", [a.id]);
    counts.resolved += 1;
  }
  await audit(db, householdId, { actor, action: "alerts.evaluated", entity: "household", entityId: householdId, after: counts });
  return counts;
}

// Delivery and quiet hours -----------------------------------------------------------------------------

export function parseHm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True inside the household's quiet hours (which may wrap midnight, as 21:00-07:00 does). */
export function inQuietHours(now: Date, settings: Pick<HouseholdSettings, "quietHours">, tz: string): boolean {
  const { hour, minute } = localTime(now, tz);
  const cur = hour * 60 + minute;
  const start = parseHm(settings.quietHours.start);
  const end = parseHm(settings.quietHours.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** The next instant quiet hours end (today or tomorrow at the end time). */
export function quietHoursEnd(now: Date, settings: Pick<HouseholdSettings, "quietHours">, tz: string): Date {
  const end = parseHm(settings.quietHours.end);
  const today = dateIsoInTz(now, tz);
  for (const day of [today, addDays(today, 1)]) {
    const candidate = instantAtLocal(day, end, tz);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return instantAtLocal(addDays(today, 2), end, tz);
}

/** The UTC instant of a local wall-clock time in `tz` (iterates once to absorb the offset). */
export function instantAtLocal(dayIso: string, minutes: number, tz: string): Date {
  const guess = new Date(`${dayIso}T${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00Z`);
  const lt = localTime(guess, tz);
  const localDay = dateIsoInTz(guess, tz);
  let diff = lt.hour * 60 + lt.minute - minutes;
  if (localDay > dayIso) diff += 1440;
  if (localDay < dayIso) diff -= 1440;
  return new Date(guess.getTime() - diff * 60_000);
}

export interface NotifierPort {
  push(memberIds: readonly string[], alert: Alert): Promise<void>;
}

export class InMemoryNotifier implements NotifierPort {
  readonly sent: { memberIds: readonly string[]; alert: Alert }[] = [];
  async push(memberIds: readonly string[], alert: Alert): Promise<void> {
    this.sent.push({ memberIds, alert });
  }
}

export interface DeliveryCounts {
  pushed: number;
  held: number;
  digested: number;
}

/**
 * Deliver what is due: action alerts push at once (inside quiet hours only the approved critical kinds); watch
 * alerts wait for the 7 am digest (one card); pulse alerts push at their time. Snoozed alerts wait.
 */
export async function deliverAlerts(db: Queryable, householdId: string, notifier: NotifierPort, now: Date, actor = "alerts"): Promise<DeliveryCounts> {
  const hh = await getHousehold(db, householdId);
  const settings = hh.settings;
  const members = (await db.query<{ id: string }>("select id from members where household_id = $1 and role = 'member'", [householdId])).rows.map((m) => m.id);
  const quiet = inQuietHours(now, settings, hh.timezone);
  const counts: DeliveryCounts = { pushed: 0, held: 0, digested: 0 };
  const due = (await listAlerts(db, householdId, { openOnly: true, limit: 500 })).filter((a) => !a.delivered_at && (!a.snoozed_until || new Date(a.snoozed_until) <= now));
  const digestEnd = quietHoursEnd(now, settings, hh.timezone);
  const digestWindow = !quiet && Math.abs(now.getTime() - instantAtLocal(dateIsoInTz(now, hh.timezone), parseHm(settings.quietHours.end), hh.timezone).getTime()) <= 30 * 60_000;
  const digestItems: AlertRow[] = [];
  for (const a of due) {
    const to = a.member_id ? [a.member_id] : members;
    if (a.level === "action" || a.level === "pulse") {
      if (quiet && !settings.criticalAlertKinds.includes(a.kind)) {
        counts.held += 1;
        continue;
      }
      await notifier.push(to, toAlertDto(a));
      await db.query("update alerts set delivered_at = now() where id = $1", [a.id]);
      counts.pushed += 1;
      continue;
    }
    if (digestWindow) digestItems.push(a);
    else counts.held += 1;
  }
  if (digestItems.length > 0) {
    const digest: Alert = {
      id: `digest:${dateIsoInTz(now, hh.timezone)}`,
      kind: "daily_digest",
      level: "watch",
      fingerprint: `daily_digest:${dateIsoInTz(now, hh.timezone)}`,
      title: `${digestItems.length} thing${digestItems.length === 1 ? "" : "s"} to keep an eye on`,
      body: digestItems.map((a) => `• ${a.payload.title ?? a.kind}`).join("\n"),
      createdAt: now.toISOString(),
    };
    await notifier.push(members, digest);
    for (const a of digestItems) await db.query("update alerts set delivered_at = now() where id = $1", [a.id]);
    counts.digested = digestItems.length;
  }
  await audit(db, householdId, { actor, action: "alerts.delivered", entity: "household", entityId: householdId, after: { ...counts, quiet, nextDigestAt: digestEnd.toISOString() } });
  return counts;
}

/** An agreed action is pending (for example "hold the $400 card payment"): the alert goes quiet until the date. */
export async function snoozeAlert(db: Queryable, householdId: string, fingerprint: string, untilIso: string, actor: string): Promise<void> {
  await db.query("update alerts set snoozed_until = $3 where household_id = $1 and fingerprint = $2 and resolved_at is null", [householdId, fingerprint, untilIso]);
  await audit(db, householdId, { actor, action: "alert.snoozed", entity: "alert", entityId: fingerprint, after: { until: untilIso } });
}

/** Purge alerts older than a year (spec: alerts kept 1 year). */
export async function purgeOldAlerts(db: Queryable, householdId: string): Promise<number> {
  const r = await db.query("delete from alerts where household_id = $1 and created_at < now() - interval '1 year' and resolved_at is not null", [householdId]);
  return r.rowCount ?? 0;
}

/** The weekly pulse (spec: "Weekly pulse"): one short card, pushed on council day. */
export async function weeklyPulse(db: Queryable, householdId: string, ledger: LedgerPort, now: Date): Promise<AlertCandidate> {
  const hh = await getHousehold(db, householdId);
  const todayIso = dateIsoInTz(now, hh.timezone);
  const sts = await computeSafeToSpend(db, householdId, ledger, todayIso, now);
  const budget = await budgetStatus(db, householdId, ledger, todayIso.slice(0, 7), todayIso);
  const top = budget.lines.filter((l) => !l.isAllowance).sort((a, b) => b.forecastCents - b.budgetCents - (a.forecastCents - a.budgetCents)).slice(0, 3);
  const queue = await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and state in ('possible_duplicate','needs_receipt','ready_for_review')", [householdId]);
  const fired = await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and bc_batch = 'AUTOPOST' and updated_at >= now() - interval '7 days'", [householdId]);
  const week = isoWeek(todayIso);
  const lines = [
    `Safe to spend before ${sts.nextPaydayIso}: ${formatUsd(sts.safeCents)} (cash ${formatUsd(sts.cashCents)} as of ${sts.balanceAsOf.slice(0, 10)}).`,
    `Bills before payday: ${formatUsd(sts.billsBeforePaydayCents)}.`,
    top.length ? `Watch: ${top.map((l) => `${l.name} ${formatUsd(l.forecastCents)} of ${formatUsd(l.budgetCents)}`).join("; ")}.` : "Budget is on track.",
    `${queue.rows[0]?.n ?? 0} item${(queue.rows[0]?.n ?? 0) === 1 ? "" : "s"} waiting for a quick answer.`,
    (fired.rows[0]?.n ?? 0) > 0 ? `${fired.rows[0]!.n} item(s) posted by rules this week.` : "No rule posted anything without you this week.",
  ];
  return { kind: "weekly_pulse", level: "pulse", fingerprint: `weekly_pulse:${week}`, memberId: null, title: "This week's money pulse", body: lines.join("\n"), payload: { week, safeCents: sts.safeCents } };
}

export function isoWeek(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
