/**
 * Jobs entry point. One container image, one job name per Container Apps Job: `node dist/index.js <job>` or
 * JOB_NAME=<job>. Every job iterates households inside `withHousehold` and records a `sync_runs` row.
 *
 *   plaid-sync                  every 4 hours and on SYNC_UPDATES_AVAILABLE: /transactions/sync with the cursor, balances, liabilities
 *   ocr                         read queued receipts (Document Intelligence), map lines (Claude), match
 *   matching                    duplicates, BC-native matches, transfer and card-payment pairs, paychecks, receipts, the rule engine
 *   outbox-relay                publish due outbox rows to the queue and move send_to_bc items to sent_to_bc; then work them in-process
 *   bc-worker                   consume published rows: pre-write check, createJournalLines, budget revisions, post_batch, readback requests
 *   autopost-post               enqueue post_batch for AUTOPOST where drafts wait and the household switch is on, then work the outbox
 *   bc-readback                 G/L entries by External Document No. -> posted; bank ledger closed -> reconciled; unknown HHAPP- documents -> exception
 *   nightly-poll                02:00 Mountain: read-back plus count/sum comparison per document over 45 days
 *   webhook-renewal             daily: renew or recreate the generalLedgerEntries and journals subscriptions
 *   alerts                      forecast-based alerts, quiet hours, the 7 am digest, the weekly pulse, retention purges
 *   paycheck-template-fallback  paychecks 3 days without a stub -> template estimate
 *   receipt-fallback            Walmart/club/Amazon lines 10 days without a receipt -> estimated split
 *   rule-proposals              nightly: propose merchant rules from approved history
 *   all                         everything once, in order (dev convenience)
 */
import { buildDepsFromEnv, closePool, type Deps } from "@homestead/api";
import { log, runForHouseholds, type JobRunResult } from "./runner.js";
import { alertsHousehold, matchingHousehold, ocrHousehold, paycheckFallbackHousehold, receiptFallbackHousehold, ruleProposalsHousehold } from "./jobs/household.js";
import { plaidSyncHousehold } from "./jobs/feeds.js";
import { acknowledgeSignals, relayOutbox, workOutbox } from "./jobs/outbox.js";
import { nightlyPoll, readBackHousehold } from "./jobs/readback.js";
import { renewWebhooks } from "./jobs/webhooks.js";
import { enqueueOutbox, ledgerConnection } from "@homestead/api";

export const JOB_NAMES = ["plaid-sync", "ocr", "matching", "outbox-relay", "bc-worker", "autopost-post", "bc-readback", "nightly-poll", "webhook-renewal", "alerts", "paycheck-template-fallback", "receipt-fallback", "rule-proposals", "all"] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Jobs that run event-triggered on their own outbox subscription (infra: container-apps.bicep eventJobs). */
const SIGNAL_JOBS: ReadonlySet<string> = new Set(["ocr", "matching", "alerts"]);

export async function runJob(name: JobName, deps: Deps, householdIds?: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<JobRunResult | JobRunResult[]> {
  const now = deps.now();
  // Started by KEDA for messages on its own subscription: complete them, then sweep the tables as usual. (bc-worker
  // completes its messages inside workOutbox, after the rows they point at are handled.)
  if (SIGNAL_JOBS.has(name) && env["OUTBOX_SUBSCRIPTION"] === name) {
    const acknowledged = await acknowledgeSignals(deps);
    if (acknowledged) log.info({ acknowledged }, `${name} completed its queue messages`);
  }
  switch (name) {
    case "plaid-sync":
      return runForHouseholds("plaid", "plaid-sync", deps, (db, hh) => plaidSyncHousehold(db, hh, deps, now), householdIds);
    case "ocr":
      return runForHouseholds("ocr", "ocr", deps, (db, hh) => ocrHousehold(db, hh, deps), householdIds);
    case "matching":
      return runForHouseholds("matching", "matching", deps, (db, hh) => matchingHousehold(db, hh, deps, now), householdIds);
    case "outbox-relay":
      return runForHouseholds("outbox_relay", "outbox-relay", deps, async (db, hh) => ({ ...(await relayOutbox(db, hh, deps, now)), ...(await workOutbox(db, hh, deps, now)) }), householdIds);
    case "bc-worker":
      return runForHouseholds("bc_worker", "bc-worker", deps, async (db, hh) => ({ ...(await workOutbox(db, hh, deps, now)) }), householdIds);
    case "autopost-post":
      return runForHouseholds(
        "autopost",
        "autopost-post",
        deps,
        async (db, hh) => {
          const conn = await ledgerConnection(db, hh);
          const drafts = await db.query<{ n: number }>("select count(*)::int as n from transactions where household_id = $1 and bc_batch = 'AUTOPOST' and state = 'bc_draft_created'", [hh]);
          let enqueued = 0;
          if (conn?.auto_post_enabled && (drafts.rows[0]?.n ?? 0) > 0) {
            await enqueueOutbox(db, hh, { aggregate: "household", aggregateId: hh, operation: "post_batch", payload: { batch: "AUTOPOST", requestedBy: "autopost-post", enqueued: true, draftCount: drafts.rows[0]?.n } });
            enqueued = 1;
          }
          const r = await relayOutbox(db, hh, deps, now, "autopost-post");
          const w = await workOutbox(db, hh, deps, now, "autopost-post");
          return { enqueued, drafts: drafts.rows[0]?.n ?? 0, ...r, ...w };
        },
        householdIds,
      );
    case "bc-readback":
      return runForHouseholds("bc_readback", "bc-readback", deps, async (db, hh) => ({ ...(await readBackHousehold(db, hh, deps, now)) }), householdIds);
    case "nightly-poll":
      return runForHouseholds("bc_poll", "nightly-poll", deps, async (db, hh) => ({ ...(await nightlyPoll(db, hh, deps, now)) }), householdIds);
    case "webhook-renewal": {
      const url = `${(process.env["WEBHOOK_BASE_URL"] ?? "https://homestead-dev-api.example.invalid").replace(/\/$/, "")}/v1/webhooks/bc`;
      return runForHouseholds("webhook_renewal", "webhook-renewal", deps, (db, hh) => renewWebhooks(db, hh, deps, now, url), householdIds);
    }
    case "alerts":
      return runForHouseholds("alerts", "alerts", deps, (db, hh) => alertsHousehold(db, hh, deps, now), householdIds);
    case "paycheck-template-fallback":
      return runForHouseholds("paycheck_fallback", "paycheck-template-fallback", deps, (db, hh) => paycheckFallbackHousehold(db, hh, now), householdIds);
    case "receipt-fallback":
      return runForHouseholds("receipt_fallback", "receipt-fallback", deps, (db, hh) => receiptFallbackHousehold(db, hh, now), householdIds);
    case "rule-proposals":
      return runForHouseholds("rule_proposals", "rule-proposals", deps, (db, hh) => ruleProposalsHousehold(db, hh), householdIds);
    case "all": {
      const out: JobRunResult[] = [];
      for (const j of ["plaid-sync", "ocr", "matching", "outbox-relay", "bc-readback", "paycheck-template-fallback", "receipt-fallback", "rule-proposals", "alerts"] as const) out.push((await runJob(j, deps, householdIds)) as JobRunResult);
      return out;
    }
  }
}

export function isJobName(s: string | undefined): s is JobName {
  return JOB_NAMES.includes(s as JobName);
}

const invokedDirectly = process.argv[1] && /services\/jobs\/(dist|src)\/index\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  const name = process.argv[2] ?? process.env["JOB_NAME"];
  if (!isJobName(name)) {
    log.error(`Usage: node dist/index.js <${JOB_NAMES.join("|")}>`);
    process.exit(2);
  }
  const deps = await buildDepsFromEnv();
  try {
    const r = await runJob(name, deps);
    const list = Array.isArray(r) ? r : [r];
    for (const x of list) log.info({ households: x.households, ok: x.ok, failed: x.failed }, `${name} finished`);
    process.exitCode = list.some((x) => x.failed > 0) ? 1 : 0;
  } finally {
    await closePool();
  }
}
