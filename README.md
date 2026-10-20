# Homestead

Household finance app for the Jones family: a phone-first app for both spouses, a desktop console for the CFO, and a backend that keeps Business Central as the single ledger. Built for the family first; structured so a client version is configuration, not a rewrite.

**Status (Oct 20, 2026):** Phase 1 spec approved. Phase 2 prototype published for Vanessa's test (Gate 2 open). Phase 3 architecture complete with all open questions decided; awaiting Cade's Gate 3 sign-off. No real accounts connected, nothing in Business Central production.

## What's here

| Path | What it is |
| --- | --- |
| `docs/phase1-product-spec.md` | The approved product spec: journeys, screens, decisions, Gate 1 outcome |
| `docs/phase2-prototype-guide.md` | How to try the prototype and what to watch for at Gate 2 |
| `docs/phase3-architecture-spec.md` | The architecture and integration spec: stack, data model, state machine, BC mapping, HH App Connector, auto-post rules, security, cost, DR, tests, backlog (awaiting Gate 3) |
| `prototype/homestead.html` | The Phase 2 clickable prototype (single file, sample data, works offline once loaded). Published as a private artifact for phone testing |

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
2. Vanessa uses the prototype on her phone without help and says she'd use it
3. Cade approves the architecture and integration spec
4. All nine acceptance tests pass against the BC sandbox
5. Both spouses approve production in writing
