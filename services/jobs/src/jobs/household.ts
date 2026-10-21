/**
 * The per-household jobs that need no extra plumbing: OCR, matching, alerts, the two fallbacks and the nightly
 * rule proposals. Each is a `HouseholdJob` run by the runner inside the household's transaction.
 */
import {
  applyReceiptFallbacks,
  applyTemplateFallbacks,
  dateIsoInTz,
  deliverAlerts,
  evaluateAlerts,
  gatherAlertInputs,
  getHousehold,
  getSettings,
  listReceipts,
  localTime,
  matchReceiptToTransaction,
  matchUnmatchedReceipts,
  proposeRulesFromHistory,
  purgeExpiredConversations,
  purgeOldAlerts,
  readReceipt,
  runMatching,
  upsertAlerts,
  weeklyPulse,
  type Deps,
  type Queryable,
} from "@homestead/api";

export async function ocrHousehold(db: Queryable, householdId: string, deps: Deps, actor = "ocr"): Promise<Record<string, number>> {
  const counts = { read: 0, failed: 0, needsReview: 0, matched: 0 };
  const queued = await listReceipts(db, householdId, { ocrStatus: "queued", kind: "receipt", limit: 100 });
  for (const r of queued) {
    const res = await readReceipt(db, householdId, r.id, deps, actor);
    if (res.outcome === "read") {
      counts.read += 1;
      const m = await matchReceiptToTransaction(db, householdId, r.id, actor);
      if (m.outcome === "matched") counts.matched += 1;
    } else if (res.outcome === "failed") counts.failed += 1;
    else counts.needsReview += 1;
  }
  return counts;
}

export async function matchingHousehold(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "matching"): Promise<Record<string, number>> {
  const m = await runMatching(db, householdId, { ledger: deps.ledger, actor, now });
  const r = await matchUnmatchedReceipts(db, householdId, actor);
  return { ...m, receiptsMatched: r.matched, receiptsAmbiguous: r.ambiguous, receiptsWaiting: r.waiting };
}

export async function alertsHousehold(db: Queryable, householdId: string, deps: Deps, now: Date, actor = "alerts"): Promise<Record<string, number>> {
  const inputs = await gatherAlertInputs(db, householdId, deps.ledger, now);
  const candidates = evaluateAlerts(inputs);
  const hh = await getHousehold(db, householdId);
  const settings = await getSettings(db, householdId);
  // The weekly pulse on council day inside a 30-minute window of its time.
  const lt = localTime(now, hh.timezone);
  const [ph, pm] = settings.pulse.time.split(":").map(Number);
  const pulseDue = new Date(`${dateIsoInTz(now, hh.timezone)}T00:00:00Z`).getUTCDay() === settings.pulse.weekday && Math.abs(lt.hour * 60 + lt.minute - ((ph ?? 19) * 60 + (pm ?? 0))) <= 30;
  if (pulseDue) candidates.push(await weeklyPulse(db, householdId, deps.ledger, now));
  const up = await upsertAlerts(db, householdId, candidates, actor);
  const d = await deliverAlerts(db, householdId, deps.notifier, now, actor);
  const purged = await purgeOldAlerts(db, householdId);
  const conversations = await purgeExpiredConversations(db, householdId);
  return { candidates: candidates.length, ...up, ...d, purged, conversationsPurged: conversations };
}

export async function paycheckFallbackHousehold(db: Queryable, householdId: string, now: Date, actor = "paycheck_fallback"): Promise<Record<string, number>> {
  const hh = await getHousehold(db, householdId);
  const done = await applyTemplateFallbacks(db, householdId, dateIsoInTz(now, hh.timezone), actor);
  return { estimated: done.length };
}

export async function receiptFallbackHousehold(db: Queryable, householdId: string, now: Date, actor = "receipt_fallback"): Promise<Record<string, number>> {
  const hh = await getHousehold(db, householdId);
  const done = await applyReceiptFallbacks(db, householdId, dateIsoInTz(now, hh.timezone), actor);
  return { estimated: done.length };
}

export async function ruleProposalsHousehold(db: Queryable, householdId: string): Promise<Record<string, number>> {
  const settings = await getSettings(db, householdId);
  const proposed = await proposeRulesFromHistory(db, householdId, settings);
  return { proposed: proposed.length };
}
