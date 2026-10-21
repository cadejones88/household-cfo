# @homestead/jobs

The scheduled and queue-driven work behind Homestead: bank feeds, receipt reading, matching, the Business Central outbox, read-back, the nightly completeness check, webhook renewal, alerts and the fallbacks. Same container image as the API; one Container Apps Job per job name (`infra/modules/container-apps.bicep`).

Every job iterates households inside `withHousehold` (row-level security), records one `sync_runs` row per household with its counts or its failure (the error's name only, amounts scrubbed), and writes audit rows for what it changed. Household ids come from the security-definer function `household_ids_fn()` (migration 0006), so the app role sees them without a household set.

## Jobs

`node dist/index.js <job>` or `JOB_NAME=<job>`.

| Job | Trigger in Azure | What it does |
| --- | --- | --- |
| `plaid-sync` | every 4 hours; Plaid's `SYNC_UPDATES_AVAILABLE` webhook through the API | `/transactions/sync` by cursor (added, modified, removed in order), balances, liabilities; `ITEM_LOGIN_REQUIRED` → needs re-link and an alert to the owner only |
| `ocr` | every 30 minutes (`ocr-sweep`); event-triggered on subscription `ocr` | Document Intelligence on queued receipts and stubs, Claude line mapping, matching |
| `matching` | twice an hour (`matching-sweep`); event-triggered on subscription `matching` | Duplicates, BC-native matches, transfer and card-payment pairs, paychecks, receipts, the rule engine |
| `outbox-relay` | every 5 minutes | Publishes due outbox rows (`send_to_bc` moves the transaction to `sent_to_bc`), then works them in process like `bc-worker` |
| `bc-worker` | event-triggered on subscription `bc-worker` | Pre-write check by External Document No., `createJournalLines` (line ids → `bc_draft_created`), budget revisions, post requests, read-back requests; retryable errors reschedule 1, 2, 4, 8, 16 minutes then hourly for a day (a longer `Retry-After` wins), anything else dead-letters into an exception |
| `autopost-post` | hourly at :15 | Enqueues `post_batch` for HHAPP/AUTOPOST only when the household switch is on and drafts wait |
| `bc-readback` | no schedule of its own: a BC webhook adds a `bc_readback` outbox row that the outbox worker runs, and `nightly-poll` runs it too | G/L entries by External Document No. → `posted` with entry numbers; closed bank ledger entries → `reconciled`; unknown `HHAPP-` documents → exception |
| `nightly-poll` | 02:00 Mountain | Read-back plus count and sum per document and per (batch, posting date) over 45 days; any difference → exception with the keys on both sides; catches whatever a missed webhook would have said |
| `webhook-renewal` | daily | Renews BC's `generalLedgerEntries` and `journals` subscriptions inside 24 hours of their three-day expiry, recreates any BC no longer lists; the clientState is a random secret stored by name. `WEBHOOK_BASE_URL` is the API's public URL |
| `alerts` | hourly; event-triggered on subscription `alerts` | Forecast alerts, quiet hours (9 pm–7 am Mountain, critical types excepted), the 7 am digest, the weekly pulse, retention purges |
| `paycheck-template-fallback` | daily | Paychecks three days without a stub get the employer-template estimate |
| `receipt-fallback` | daily | Walmart, club and Amazon lines ten days without a receipt get the estimated split |
| `rule-proposals` | daily | Proposes merchant rules from approved history (proposals only; a spouse approves) |
| `all` | — | Everything once, in order (dev convenience) |

## The queue and acknowledgement

The outbox **table** is the source of truth; a queue message is only a pointer `{ outboxId, householdId, operation, target }`. In dev and tests the queue is in memory. In Azure (`SERVICE_BUS_NAMESPACE` set) it is Service Bus over REST with the managed identity: topic `homestead-outbox`, one subscription per consumer (`bc-worker`, `ocr`, `matching`, `alerts`), each filtered on the `target` property, `MessageId` = the outbox row id so duplicate detection drops a re-publish. Each event-triggered job reads the subscription named by `OUTBOX_SUBSCRIPTION` (the infra sets it).

**Every event-driven job completes the messages it receives**, or KEDA would keep starting it while they sit there:

- `bc-worker` (and `outbox-relay`, which calls the same code) peek-locks up to 500 messages, works the due rows in the table, then completes every message it received. A row that dead-letters is marked `dead_lettered` in the table and an exception is raised; its message is completed too, because the REST API cannot move a message to the dead-letter sub-queue. Messages for other households are completed as well: their rows are worked in those households' own pass of the same run.
- `ocr`, `matching` and `alerts`, when started for their own subscription (`OUTBOX_SUBSCRIPTION` equals the job name), complete all of that subscription's messages first and then sweep their tables as the scheduled runs do. Run on a schedule they leave the queue alone.
- If a lock expires before completion (lock duration one minute) the message comes back and finds its rows already handled; completion treats 404/410 as done.

Today every outbox operation is BC-side, so only `bc-worker` receives messages; the `ocr-sweep` and `matching-sweep` schedules can be slowed once the API publishes OCR and matching work to the topic.

## How to run it

```sh
export DATABASE_URL="postgres://homestead@localhost:5433/homestead_dev?host=/tmp" PGSSLMODE=disable
pnpm --filter @homestead/api db:migrate && pnpm --filter @homestead/api db:seed
pnpm --filter @homestead/jobs build
node services/jobs/dist/index.js all          # every job once, against fakes unless the environment names real services
```

Configuration is the API's (`services/api/.env.example`) plus `JOB_NAME`, `OUTBOX_SUBSCRIPTION` and `WEBHOOK_BASE_URL`.

## What is faked and why

The jobs use the API's `buildDepsFromEnv()`: the real client for each service the environment names, a fake for the rest (see `services/api/README.md`). Tests use `MockBcServer` from `@homestead/ledger-adapter-bc` behind the real adapter and the `BcLedgerPort` shim, so a job's calls to BC go over BC's wire format without a tenant.

## Tests

`pnpm --filter @homestead/jobs test`. `test/jobs.test.ts` needs no database (retry schedule, job names, log scrubbing, queue acknowledgement). `test/worker.int.test.ts` needs `DATABASE_URL` and skips without it: relay and write with line ids, a 503 then a cut connection that the pre-write check finds, a 400 that dead-letters into an exception, AUTOPOST post and read-back, Cade posting FEEDS then read-back and reconciliation, the nightly poll catching a deleted draft and a document only BC has, a budget revision through the connector, and webhook create, keep, renew and recreate.
