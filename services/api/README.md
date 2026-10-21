# @homestead/api

The Homestead API (epics E3–E5): sign-in, the household's transactions and their state machine, bank feeds (Plaid and file import), receipts and paychecks, the "Needs your answer" queue, budget, goals, bills, safe to spend, Ask Homestead, approvals, rules, alerts, the Console's routes, and the Plaid and Business Central webhook receivers. Business Central is the ledger; this service stages, classifies and approves, then hands balanced journal lines to BC through an outbox. It never moves money and never posts outside the HHAPP batches Cade allows.

The phone app and the Console code against **`openapi.yaml`** (OpenAPI 3.1, in this folder). `test/openapi.test.ts` fails if a route is added or removed without updating it.

## What is in it

| Path | What it does |
| --- | --- |
| `src/app.ts`, `src/server.ts` | Fastify 5 app: helmet, CORS (`CORS_ORIGINS`), rate limit, multipart, auth, every route module under `/v1`; `app.routeList` for the OpenAPI sync test |
| `src/routes/` | `me`, `accounts`, `transactions`, `questions`, `receipts`, `paychecks`, `budget`, `goals`, `bills` (and `/v1/safe-to-spend`), `ask`, `approvals`, `rules`, `alerts`, `console`, `webhooks`, `devices` (push token, export), `health` |
| `src/services/transactions.ts` | Idempotent import, state moves through `assertTransition` with an audit row each, the `send_to_bc` outbox row in the same DB transaction as `approved`, read-back fields, exceptions, "This is wrong", business flags (CTJ → 404102, household-card business charge → 112101), splits |
| `src/services/duplicates.ts`, `pairing.ts` | Possible duplicates; transfer and card-payment pairs; BC-native matches (PennyMac, Frontier) reconciled from BC's bank ledger entries, never sent |
| `src/services/rules.ts`, `classify.ts`, `ruleSeeds.ts` | Rule register with versions, proposals from approved answers only, amount bands, drift guard, tiers, the auto-post decision |
| `src/services/questions.ts` | "Needs your answer" in plain words with a `why`; answers apply and teach only once approved |
| `src/services/bankData/` | Plaid client and `FakePlaid` (`/transactions/sync` with cursor, balances, liabilities, Link), CSV/OFX/QFX import with institution profiles |
| `src/services/receipts/` | Upload with sha256 dedupe, Document Intelligence (prebuilt-receipt, prebuilt-payStub.us), the Claude line mapper, split and match, Walmart/club/Amazon handling and the 10-day fallback, Amazon email parser |
| `src/services/paychecks/` | Employer deposits, stub intake, the template fallback, paycheck lines, the R1 check |
| `src/services/ask/` | The six read-only functions and the orchestration; a move request comes back as a draft action, never executed |
| `src/services/budget.ts`, `goals.ts`, `bills.ts`, `safeToSpend.ts`, `alerts.ts`, `approvals.ts`, `console.ts` | As named; every screen answer carries `dataThrough` |
| `src/services/ledgerPort.ts` | `LedgerPort` (this service's view of the ledger), `LedgerError`, and `InMemoryLedger` for unit tests |
| `src/services/ledgerPortBc.ts` | `BcLedgerPort`: the shim from `LedgerPort` to `@homestead/ledger-adapter-bc`'s `BusinessCentralAdapter`, `createBcLedgerPort` (certificate credential) and `bcLedgerPortForMock` (the adapter against `MockBcServer`) |
| `src/services/ports.ts` | Secret store (Key Vault 7.4 / in-memory), blob store (Azure Blob / in-memory), queue (Service Bus REST / in-memory), notifier, managed-identity tokens |
| `src/db/` | Pool (`DATABASE_URL`, or Entra sign-in with managed identity), `withHousehold` (RLS), migrations runner, seed |
| `db/migrations/` | `0001` schema … `0006` security-definer lookups (`household_ids_fn`, `plaid_feed_lookup_fn`, `bc_subscription_lookup_fn`), `0007` gives every lookup to the NOLOGIN role `homestead_lookup` with a read policy, because FORCE row-level security filters a non-superuser owner (Azure's administrator) |
| `test/` | Unit tests (no database) and integration tests against Postgres; fixtures under `test/fixtures` are synthetic |

## How to run it

```sh
# Postgres 16 locally, then:
export DATABASE_URL="postgres://homestead@localhost:5433/homestead_dev?host=/tmp" PGSSLMODE=disable
pnpm --filter @homestead/api db:migrate
pnpm --filter @homestead/api db:seed      # "Cade & Vanessa Jones Family", 14 accounts, R1–R7 proposed, bills
pnpm --filter @homestead/api dev          # http://localhost:8080/v1, AUTH_MODE=dev
curl -H "x-dev-member: <member id from the seed>" localhost:8080/v1/me
```

In dev mode (`AUTH_MODE=dev`, the default outside production) the header `x-dev-member` names the member and `x-step-up: true` stands in for a fresh Face ID / MFA step-up. Production verifies Entra External ID tokens (`ENTRA_*`).

Tests: `pnpm --filter @homestead/api test`. Without `DATABASE_URL` only the unit tests run and the integration files skip; with it, `test/helpers/globalSetup.ts` migrates once and every file seeds its own household. `test/rls.test.ts` also needs the `homestead_app_test` login role (it creates it when it can).

## Configuration

Names only; values live in Key Vault (cloud) or a local `.env` that is never committed. See `.env.example` for the full list.

- **Database.** `DATABASE_URL` for local work. In Azure leave it unset and set `PGHOST`, `PGUSER`, `PGDATABASE` (and `PGSSLMODE=require`): the pool then signs in with the user-assigned managed identity (`AZURE_CLIENT_ID`) and uses an Entra token for `https://ossrdbms-aad.database.windows.net/.default` as the password, fetched per connection and cached until five minutes before expiry. `src/db/migrate.ts` still takes a connection string.
- **Business Central.** `BC_TENANT_ID`, `BC_COMPANY_ID`, `BC_CLIENT_ID`, `BC_CERT_SECRET_REF` (Key Vault name of the PEM), `BC_ENVIRONMENT` (default `CADE_Sandbox_vs25`), `BC_JOURNAL_TEMPLATE` (`HHAPP`), `BC_CONNECTOR_INSTALLED` (`false` until the HH App Connector is published), `BC_API_BASE_URL`.
- **Plaid.** `PLAID_ENV` (`sandbox` | `production`), `PLAID_CLIENT_ID`, `PLAID_SECRET_REF`, `PLAID_WEBHOOK_URL`. Access tokens are stored in Key Vault; the database holds only the secret's name.
- **Azure.** `KEY_VAULT_URL`, `STORAGE_ACCOUNT_URL` + `BLOB_CONTAINER`, `SERVICE_BUS_NAMESPACE` + `OUTBOX_SUBSCRIPTION` (or `SERVICE_BUS_SUBSCRIPTION`; default `bc-worker`), `DOCUMENT_INTELLIGENCE_ENDPOINT` (+ optional `DOCUMENT_INTELLIGENCE_KEY_REF`), `FOUNDRY_ENDPOINT` + `FOUNDRY_MODEL` + `FOUNDRY_KEY_REF`, `AZURE_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`.

## What is faked and why

`buildDepsFromEnv()` uses the real client wherever the environment names one and a fake everywhere else; `deps.fakes` lists which (the Console's health page shows it). `buildFakeDeps()` is all fakes, for tests.

| Port | Real | Fake | Why the fake |
| --- | --- | --- | --- |
| ledger | `BcLedgerPort` over the E2 adapter | `InMemoryLedger`; integration and acceptance tests use the adapter against `MockBcServer` | No BC tenant in CI; the mock speaks BC's wire format |
| secrets | Key Vault 7.4 REST, managed identity | in-memory | No vault locally |
| blobs | Azure Blob REST, managed identity | in-memory | Receipt images never leave the test process |
| queue | Service Bus REST (topic `homestead-outbox`) | in-memory | The outbox table is the source of truth either way; see `services/jobs/README.md` |
| plaid, plaidWebhookVerifier | Plaid REST, JWT webhook verification | `FakePlaid`, `FakeWebhookVerifier` | Synthetic transactions; in production without Plaid configured the verifier refuses every webhook |
| docIntel | Document Intelligence 2024-11-30 | fixture reads by image hash | Synthetic receipts and stubs |
| mapper, askModel | Claude through Foundry (`/anthropic/v1/messages`) | keyword mapper, template answers | Deterministic tests; the model gets function results and category names only, never account numbers or images |
| notifier | — (not wired yet) | in-memory | Push delivery belongs to the phone-app epic; alerts are stored and shown in-app |

## How it talks to Business Central

Everything goes through `LedgerPort`. The shim maps it onto the adapter one-to-one (`findByExternalDocumentNo`, `createJournalLines` with the adapter's `outcome`, `postBatch`, G/L entry read-back, bank ledger entries, budget revisions, subscriptions), translates the adapter's errors into `LedgerError` (408/429/5xx and network are retryable; `Retry-After` is carried), and adds three reads the adapter does not have as named methods:

- `listAppDocuments` (the nightly poll's per-batch, per-date count and sum) reads HHAPP journal lines and G/L entries whose External Document No. starts with `HHAPP-`.
- Account-prefix G/L reads for goal balances (FUND_GOAL) use `generalLedgerEntries?$filter=accountNumber ge … and accountNumber lt …&$expand=dimensionSetLines`. Marked VERIFY in the code: confirm the filter and expand on the sandbox.
- `listWebhookSubscriptions` lets the renewal job recreate a subscription BC dropped before it would expire.

Transaction-to-journal-lines mapping is `src/services/journalLines.ts`; it builds the outbox payload, and `test/journalLinesParity.test.ts` checks it produces the same accounts, amounts and dimension sets as the adapter's `mapping.ts` for spend, split, transfer, card-payment and both CTJ cases.

## Notes

- Pending Plaid rows are stored with key `pending:<plaid pending id>` and `pending = true`, and are replaced when the settled transaction arrives.
- A posted Plaid row that the bank later removes becomes an exception for Cade; one removed before it reached BC is recorded as a "noted" exception without a state move (the shared state machine has no arrow for it).
- A receipt matches a bank line only above 0.9 similarity (shared constant); store-chain names are compared by chain key (`WAL-MART #1868` ↔ `Walmart`).
- Logs never carry amounts, account masks, merchants, tokens or image URLs (`lib/logScrub.ts`); the audit log is insert-only.
