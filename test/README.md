# @homestead/acceptance

The Gate 4 acceptance tests A1–A9 (spec: "Test strategy"), run end to end through the API (`app.inject`), the jobs (`runJob`) and the ledger. Results are read back from the ledger, never inferred. After a run the health report the Console's Health page reads is written to `HEALTH_REPORT_PATH` (default `test/test-results/health.json`).

| Test | What it proves |
| --- | --- |
| A1 | A Broulim's receipt matches its bank line, drafts in HHAPP/RECEIPTS on 603101 with its dimension set, gets its G/L entry numbers back after Cade posts, reconciles from BC's bank ledger, and three resends still leave one document |
| A2 | A transfer, a card payment and the PennyMac payment never show as spending; 115101 and 115201 net to zero in BC |
| A3 | Five Walmart receipts split by line into the right categories and BC lines |
| A4 | A card payment CTJ made lands in 404102; a household-card business charge in 112101 |
| A5 | Server half: offline captures replayed twice land once each with the same hash. The device half is `apps/mobile`'s queue tests and the Maestro flow |
| A6 | With every webhook subscription gone, the nightly poll still moves the line to posted, and the renewal recreates the subscriptions |
| A7 | Safe to spend leaves out restricted money and FUND_GOAL set-asides and covers bills due before the next paycheck |
| A8 | A budget move needs the other spouse with step-up and writes revision 1 to BUD26-REV; ORIG is refused |
| A9 | Every screen carries its data-through date; the goal balance is BC's FUND_GOAL entries; the nightly poll finds no difference |

## Where it runs

- **Mock (default).** No sandbox secrets: `MockBcServer` from `@homestead/ledger-adapter-bc` in process, behind the real adapter and the API's `BcLedgerPort` shim. Cade's own BC actions (posting a batch, bank reconciliation, a recurring-journal payment, a goal deposit) are done through BC's API on the mock. BC's webhook calls are routed into the app's own receiver.
- **Sandbox.** Set `BC_SANDBOX_TENANT_ID`, `BC_SANDBOX_COMPANY_ID`, `BC_SANDBOX_CLIENT_ID`, `BC_SANDBOX_CERT_PEM` (and `BC_SANDBOX_ENVIRONMENT`, default `CADE_Sandbox_vs25`; anything without "sandbox" in its name is refused). Steps that need Cade's own BC sign-in are reported as skipped with the reason ("Manual in the sandbox: …"); webhooks need a public receiver, so there the poll does the work.

Plaid, Document Intelligence and the line mapper are fakes fed from synthetic fixtures (`fixtures/`, and the Walmart receipts in `services/api/test/fixtures/walmart`).

## How to run it

```sh
pnpm --filter @homestead/api build && pnpm --filter @homestead/jobs build
DATABASE_URL="postgres://homestead@localhost:5433/homestead_e3?host=/tmp" PGSSLMODE=disable pnpm --filter @homestead/acceptance test
```

Without `DATABASE_URL` only the harness's own tests run (target choice, the health report) and A1–A9 are recorded as skipped.
