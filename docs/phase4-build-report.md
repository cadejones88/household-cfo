# Homestead — Phase 4 build report

October 21, 2026. Code: github.com/cadejones88/household-cfo, `main` at the commit this file was added in. CI on GitHub is green (build, typecheck, unit and database tests, secrets scan, Console smoke test; the sandbox acceptance job skips until its secrets exist).

## Where things stand

All seven MVP epics are built and pass their tests against in-process fakes of Business Central, Plaid, Document Intelligence and Claude. Gate 4 asks for the nine acceptance tests to pass against the **real BC sandbox**; that waits only on the hands-on setup below. Nothing has touched the sandbox, a bank, or production. Auto-posting is off.

| Epic | What it is | Tests |
| --- | --- | --- |
| E1 Foundation | Monorepo, shared contracts (integer-cent money, the 13-state transaction machine, idempotency keys, dimensions, chart, categories, paycheck lines, receipt split and match, confidence tiers, safe to spend), Postgres schema with row-level security and an insert-only audit log, CI | 35 shared |
| E2 BC adapter | Certificate auth, all-or-nothing `$batch` writes, pre-write duplicate check across every HHAPP batch, post and read-back, bank ledger, budgets, webhooks, retry schedule, transaction-to-journal mapping, `MockBcServer`; HH App Connector AL source and permission set HH-APP; runbook for BC changes 1–6 | 62 |
| E3–E5 API and jobs | Plaid sync (read-only products), file import, duplicates, transfer and card-payment pairing, BC-native matching, rule register with drift guard, Needs your answer, receipts (Document Intelligence, Claude line mapping, split, match), PDF-first pay stubs, Ask Homestead (read-only), budget, goals, alerts, approvals with step-up, Console routes, webhook receivers; outbox relay, BC worker, nightly poll, webhook renewal; managed-identity Postgres; OpenAPI 3.1 with a drift test | 173 API, 12 jobs |
| E6 Phone app | Expo SDK 58, built to the approved prototype: safe to spend, Needs your answer, Snap with an offline queue, Activity, Budget and Move money, Goals, Bills, Ask, alerts, Settings; Entra sign-in, Face ID unlock and step-up; mock mode | 69 |
| E7 Console and infra | The MVP six screens (work queues, BC posting status, reconciliation with loan rollforwards, mappings, authority matrix, health and audit); Bicep for dev, pilot and prod (validated), Dockerfile, deploy workflow guarded by `DEPLOY_ENABLED` | 46 unit, 14 browser |
| Acceptance | A1–A9 against `MockBcServer` by default, the BC sandbox when its secrets are set; refuses any environment without "sandbox" in its name | 11 |

About 420 automated tests in all. Every database-backed suite also passes on a freshly migrated, empty database.

## What is faked, and why

Business Central, Plaid, Azure Document Intelligence, Claude on Foundry, Key Vault, Blob Storage and Service Bus cannot be reached from the build environment. Each sits behind an interface with a thin real client (written to the vendor's documented API, with every assumption marked `VERIFY` and its doc link) and an in-process fake the tests use. The first sandbox run is where those assumptions get checked; the main ones are listed in `packages/ledger-adapter-bc/README.md` and `services/api/README.md`.

The phone app's camera, Face ID, push and the three-tap receipt flow need a real iPhone build (a Mac with Xcode or an EAS cloud build); the logic behind them is unit-tested.

## Found and fixed during the build

- The BC External Document No. is 27 characters, not 20 as the spec said; BC allows 35. Spec corrected.
- A resend routed to a different HHAPP batch could have written twice; the pre-write check now covers every batch.
- In Azure, the sign-in lookup and the jobs' household list would have returned nothing because the database administrator is not a superuser; migration 0007 gives those functions their own non-superuser owner.
- The phone app would have shipped with no screens (a stray empty folder) and without its settings; both fixed and confirmed with an export build.
- Two CI-only failures: the Console's React 18 types could be shadowed by the phone app's React 19 types depending on install order (now pinned), and a timer race in a phone test (now deterministic).
- The webhook-outage test (A6) would have deleted the pilot's live BC subscriptions during Phase 5; it now touches only its own.

## What Cade does by hand (GitHub issues)

| Issue | Step | Runbook |
| --- | --- | --- |
| #3 | Azure pay-as-you-go subscription under the firm, with the $100 budget alert | `docs/runbook-azure-setup.md` |
| #2 | Entra External ID tenant and the three app registrations | same |
| #5 | BC changes 1–6 in the sandbox (Claude can do these in the browser on request, as with the October 19 tests) | `bc/runbook-additions.md` |
| #7 | Plaid team on the Trial plan; Sandbox keys into Key Vault | `docs/runbook-azure-setup.md` |
| #11 | Apple Developer Program (organization) and TestFlight | same |

Then: add the `BC_SANDBOX_*` repository secrets and the nightly job runs A1–A9 against the sandbox.

## Decisions, with the default used until you say otherwise

Two needed information from you and are now answered; the rest have a default already built.

**Answered October 21, 2026**

1. BC version: at least 2025 wave 2 (Cade). The extension's target (application 27, runtime 16.0) stands; a newer sandbox runs it unchanged.
2. Henry's Fork payday: Friday, October 23, 2026, then every other Friday (Cade). The default anchor had been October 16, a week off; corrected, and the tests that encoded the old dates updated.

**Still open, not blocking**

- The standing weekly tithing amount for rule R5. R5 goes live only after the clean pilot month, so this can wait; the pilot's first weeks will also show it in the data.

**Defaults in place**

3. HHAUTO source code on auto-posted entries: stamped by the extension's event subscriber; fallback is a separate HHAUTO journal template.
4. Change Log on Gen. Journal Line: "Some Fields" on insert and modify.
5. A security filter `Journal Template Name = HHAPP` on the app's user in BC: yes.
6. Liquidity floor 0 and no unilateral budget moves (I-09) until the Constitution sets them.
7. Declining a budget move needs Face ID, same as approving.
8. Receipt photos on the phone rely on iOS data protection.
9. When a posted item is corrected, the app says "Cade will fix it in the books."
10. Activity's "Mine" filter means items tagged with your name.
11. Alerts check hourly so the digest lands at 7 am Boise time year-round.
12. The Foundry key is read from Key Vault by name until the API can use its Azure identity.
13. Custom sign-in domain `homestead.cadejonescpa.com`, as decided: it needs Azure Front Door, about $35 a month, which was not known when you chose it. The infra sets it up now. If you would rather save that through the pilot, the pilot can sign in on the default Entra domain and the two passkeys get re-registered once at production.
