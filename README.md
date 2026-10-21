# Homestead

Household finance app for the Jones family: a phone-first app for both spouses, a desktop console for the CFO, and a backend that keeps Business Central as the single ledger. Built for the family first; structured so a client version is configuration, not a rewrite.

**Status (Oct 20, 2026):** Gates 1–3 approved. Phase 4 (MVP against the BC sandbox and Plaid Sandbox) in progress. No real accounts connected, nothing in Business Central production.

## What's here

| Path | What it is |
| --- | --- |
| `docs/phase1-product-spec.md` | The approved product spec: journeys, screens, decisions, Gate 1 outcome |
| `docs/phase2-prototype-guide.md` | How to try the prototype and what to watch for at Gate 2 |
| `docs/phase3-architecture-spec.md` | The architecture and integration spec: stack, data model, state machine, BC mapping, HH App Connector, auto-post rules, security, cost, DR, tests, backlog (approved at Gate 3) |
| `prototype/homestead.html` | The Phase 2 clickable prototype (single file, sample data, works offline once loaded). Published as a private artifact for phone testing |
| `packages/ledger-adapter-bc/` | The ledger adapter interface and its Business Central implementation: certificate auth, `$batch` splits, pre-write check, post and read-back, bank ledger entries, budget revisions, webhooks, the retry schedule, the transaction-to-journal-lines mapping, and `MockBcServer` (the in-process BC fake the tests run against) |
| `bc/hh-app-connector/`, `bc/runbook-additions.md` | The HH App Connector AL extension (`hhBankLedgerEntries`, `hhBudgetEntries`, `hhJournalLineChecks`, permission set HH-APP) with its publishing guide, and the by-hand sandbox steps for BC changes 1–6 |

## Planned layout (Phase 3)

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
