# Homestead

Household finance app for the Jones family: a phone-first app for both spouses, a desktop console for the CFO, and a backend that keeps Business Central as the single ledger. Built for the family first; structured so a client version is configuration, not a rewrite.

**Status (Oct 21, 2026):** Gates 1–3 approved. Phase 4 MVP code is complete for all seven epics and green against in-process fakes (Business Central, Plaid, Document Intelligence, Claude): about 420 tests across the packages, including the A1–A9 acceptance suite against `MockBcServer`. See `docs/phase4-build-report.md`. Gate 4 needs the same suite to pass against the real BC sandbox, which waits on the hands-on setup in GitHub issues #2, #3, #5, #7 and #11. Auto-posting is off. No real accounts connected, nothing in Business Central production.

Run it: `pnpm install && pnpm build && pnpm test`. Database-backed tests run when `DATABASE_URL` points at a Postgres 16 (see `docs/dev-setup.md`).

## What's here

| Path | What it is |
| --- | --- |
| `docs/phase1-product-spec.md` | The approved product spec: journeys, screens, decisions, Gate 1 outcome |
| `docs/phase2-prototype-guide.md` | How to try the prototype and what to watch for at Gate 2 |
| `docs/phase3-architecture-spec.md` | The architecture and integration spec: stack, data model, state machine, BC mapping, HH App Connector, auto-post rules, security, cost, DR, tests, backlog (approved at Gate 3) |
| `docs/gate4-checklist.md` | Cade's steps for Gate 4, in order (about 45 minutes): install the connector, BC master data, app registration, test certificate, BC application card |
| `docs/phase4-build-report.md` | What Phase 4 built, test counts, what is faked, the hands-on steps for Gate 4, and the open decisions with their defaults |
| `prototype/homestead.html` | The Phase 2 clickable prototype (single file, sample data, works offline once loaded). Published as a private artifact for phone testing |
| `apps/mobile/` | Homestead, the phone app for both spouses (Expo SDK 58, Expo Router, development builds): safe to spend, Needs your answer, receipt snap with an offline queue, Activity, Budget and Move money with Face ID approvals, Goals, Bills, Ask Homestead, Settings, push. Mock mode runs with no API; `apps/mobile/docs/vanessa-guide.md` is the how-to |
| `apps/console/` | Homestead Console, the desktop CFO view (React + Vite): work queues, BC sync and posting, reconciliation, mappings, authority matrix, health/logs/audit, plus six "after the pilot" tiles. Mock mode runs with no API; see its README for the API-route gaps |
| `infra/` | Bicep for `rg-homestead-dev/pilot/prod` (Postgres, Key Vault, storage, Service Bus, Container Apps + jobs, Static Web App, registry, monitoring, RBAC, budget) and the per-environment parameter files; `infra/README.md` for deploy commands |
| `services/api/` | The API (Fastify 5, Postgres with row-level security): transactions and their state machine, Plaid and file import, receipts and paychecks, Needs your answer, budget, goals, bills, safe to spend, Ask Homestead, approvals, rules, alerts, the Console's routes, Plaid and BC webhooks, and the outbox to BC through the adapter. `services/api/openapi.yaml` (OpenAPI 3.1) is the contract the phone app and the Console code against |
| `services/jobs/` | The scheduled and queue-driven jobs: Plaid sync, OCR, matching, the BC outbox worker, AUTOPOST, read-back, the nightly completeness poll, webhook renewal, alerts, the paycheck and receipt fallbacks, rule proposals |
| `test/` | The A1–A9 acceptance suite end to end through the API, the jobs and the ledger: against the BC sandbox when its secrets are set, otherwise against `MockBcServer`; writes the health report the Console shows |
| `services/api/Dockerfile` | The one image for the API and the jobs (multi-stage, pnpm deploy, non-root) |
| `.github/workflows/deploy-dev.yml` | Deploys dev on push to `main` with OIDC once the repository variable `DEPLOY_ENABLED` is `true` |
| `docs/runbook-azure-setup.md` | Cade's one-time checklist: subscription, GitHub OIDC, Entra External ID tenant and app registrations, custom domain, BC app registration and certificate, Plaid, Apple, where every secret lives |
| `packages/ledger-adapter-bc/` | The ledger adapter interface and its Business Central implementation: certificate auth, `$batch` splits, pre-write check, post and read-back, bank ledger entries, budget revisions, webhooks, the retry schedule, the transaction-to-journal-lines mapping, and `MockBcServer` (the in-process BC fake the tests run against) |
| `bc/hh-app-connector/`, `bc/runbook-additions.md` | The HH App Connector AL extension (`hhBankLedgerEntries`, `hhBudgetEntries`, `hhJournalLineChecks`, permission set HH-APP) with its publishing guide, and the by-hand sandbox steps for BC changes 1–6 |

## Layout

```
apps/mobile          Expo (React Native) app — Homestead
apps/console         React web app — Homestead Console
services/api         TypeScript API on Azure Container Apps
services/jobs        Scheduled jobs: Plaid sync, BC poll, webhook renewal, alerts, OCR, auto-post
packages/shared      Categories, states, money math, validation (shared by app, console, API)
packages/ledger-bc   The Business Central adapter (journals, G/L entries, budgets, bank ledger entries)
infra/               Azure infrastructure as code
docs/                Specs and design records
prototype/           Phase 2 prototype
```

## Ground rules

- The app never moves money. Bank connections are read-only.
- Nothing posts to Business Central without a person's approval or a written, tested, approved auto-post rule.
- Every accounting transaction has a stable idempotency key, a source reference, and, after posting, the BC document and entry identifiers. If the app and BC disagree, BC wins and the app shows the difference.
- Secrets never live in code, phones, logs or prompts.

## Gates

1. Spec approved (done, Oct 19, 2026)
2. Vanessa uses the prototype on her phone without help and says she'd use it (done, Oct 20, 2026)
3. Cade approves the architecture and integration spec (done, Oct 20, 2026)
4. All nine acceptance tests pass against the BC sandbox
5. Both spouses approve production in writing
