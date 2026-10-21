# Homestead Console

The desktop CFO view for Cade: React 18 + Vite + TypeScript, react-router, TanStack Query, MSAL for Entra External ID. Deploys to Azure Static Web Apps (free tier) and talks only to the API at `services/api`. It never holds a bank token or a BC credential; deep links into Business Central open BC in the browser under Cade's own sign-in.

## What it does

MVP six (Phase 3 backlog, epic E7), each screen with a data-through line and a quality tag:

| # | Page | Route | What it shows |
| --- | --- | --- | --- |
| 1 | Work queues | `/queues` | Transactions by state (ready for review, needs classification, needs receipt, possible duplicate), receipts (unmatched, needs review), rule proposals, exceptions with the keys on both sides and a resolve dialog (→ ready for review, or → posted against an existing BC entry). Bulk approve, "This is wrong", business flag. |
| 2 | BC sync and posting | `/sync` | HHAPP/FEEDS, RECEIPTS, AUTOPOST: drafts in the app vs BC, in flight, differences, last webhook and poll, outbox depth and dead letters, **Post batch** (only queues; posting runs with Cade's BC sign-in or the AUTOPOST job, and the screen says so), deep link to each batch. |
| 3 | Reconciliation | `/reconciliation` | The 14 bank cards from `BANK_CARD_LIST`: open vs reconciled, last statement, differences; loan rollforward tiles for the two Frontier loans and PennyMac. |
| 4 | Mappings | `/mappings` | Categories → G/L + dimension defaults (editable only through a proposal to the other spouse; version shown), dimension dictionary, bank cards, employers and paycheck component accounts. |
| 11 | Authority matrix | `/authority` | Read-only draft from the spec with the I-09 TBD highlighted; settings versions; auto-post rule states. |
| 12 | Health, logs and audit | `/health` | Feed connections, BC webhook subscriptions, sync runs, dead-lettered outbox with retry, the paged and filterable audit log, and the nightly acceptance result (`/health.json`). |

Six "After the pilot" tiles (`/later/*`): budget builder and scenarios, 13-week cash forecast, debt payoff model, net worth and ASC 274 workbench, close checklist, reports and lineage.

## Run it

```sh
# from the repo root, once
flock /tmp/homestead-pnpm.lock pnpm install

# mock mode: no API, no sign-in, synthetic data (the in-browser mock enforces the shared state machine)
pnpm --filter @homestead/console dev:mock            # http://localhost:5174

# against a local API with dev auth (sends x-dev-member)
cp apps/console/.env.example apps/console/.env       # names only; nothing here is a secret
pnpm --filter @homestead/console dev

# build and tests
pnpm --filter @homestead/console build               # tsc --noEmit, then vite build → dist/
pnpm --filter @homestead/console test                # vitest + Testing Library (jsdom)
pnpm --filter @homestead/console test:e2e            # Playwright smoke in mock mode
```

Modes come from `VITE_*` variables at build time (`src/config.ts`): `VITE_API_MODE=http|mock`, `VITE_AUTH_MODE=dev|entra`. In `entra` mode the sign-in is a redirect to the External ID tenant (passkey through the browser), tokens live in `sessionStorage`, and the Console signs out after 12 hours (`VITE_SESSION_HOURS`). Step-up for approvals sends `x-step-up: true` in dev; with Entra the API reads the fresh token's `amr` claim.

## Tests

- `test/status.test.ts`: every state has a label, a calm tone and the phone app's plain words; freshness thresholds.
- `test/QueueTable.test.tsx`: rows, masks (last four only), selection and select-all, keyboard (arrows, Space, A, Enter), per-state actions, business flag, busy state, BC keys.
- `test/ExceptionResolveDialog.test.tsx`: keys on both sides, note required, "posted" needs entry numbers, error shown instead of closing.
- `test/mockApi.test.ts`: the mock follows the state machine, writes audit and outbox rows, refuses empty posts, lets only the other spouse approve a rule.
- `test/sha256.test.ts`: the browser `node:crypto` shim hashes exactly like Node (the shared package derives idempotency keys and External Document Nos. with it).
- `e2e/smoke.spec.ts`: every MVP page in mock mode with its data-through line, a placeholder page, bulk approve, exception resolve with the audit trail, Post batch, the 14 cards and 3 loans, the I-09 highlight, outbox retry and the nightly page. CI installs Chromium; locally set `PW_CHROMIUM_PATH` to a pre-installed Chromium executable to skip the download.

## What is faked and why

- **Mock API** (`src/api/mock/`): `VITE_API_MODE=mock` swaps in an in-memory `ConsoleApi` with synthetic households, transactions, receipts, rules, outbox rows, sync runs and audit entries. Mutations run `assertTransition` from `@homestead/shared`, write an audit row and, for anything bound for BC, an outbox row. Used by the smoke test and for design review without an API or a sandbox.
- **`node:crypto` shim** (`src/shims/node-crypto.ts`): `@homestead/shared` hashes with `node:crypto`; Vite aliases it to a small synchronous SHA-256 so the shared helpers run unchanged in the browser.
- **Nightly acceptance** (`public/health.json`): a static file the CI `sandbox-acceptance` job overwrites after A1–A9 run against the BC sandbox. Until the first run the page says "No nightly run yet."
- **BC deep links**: URL templates in `src/config.ts` (General Journal page 39, G/L Entries page 20, Bank Account Ledger Entries page 372) filled from `VITE_BC_*`; shown only when tenant and company are configured. They carry no credential.

## API routes

`src/api/http.ts` is written against `services/api/openapi.yaml` (Oct 20, 2026). Where the Console needs something the API does not document yet, the client composes it from what exists or throws `ApiError 501 not_in_api` so the screen says so instead of guessing. The gaps, for the API builder:

| Console need | What the client does today | Suggested API change |
| --- | --- | --- |
| Bulk approve (`approveTransactions`) | One `POST /v1/transactions/{id}/correct` per row with the row's current category ("approves with the new values") | `POST /v1/console/transactions/approve { ids }` returning `{ approved, skipped[] }` |
| Match a receipt to a candidate line from the Console | 501 `not_in_api` | `POST /v1/receipts/{id}/match { transactionId }` |
| Outbox listing and retry (Health → Failed jobs; Sync → recent dead letters) | 501 `not_in_api` (counts come from `/v1/console/connections.outbox`) | `GET /v1/console/outbox?deadLettered=`, `POST /v1/console/outbox/{id}/retry` (step-up) |
| Loan rollforwards (Frontier ×2, PennyMac) | `loans: []` | Add `loans[]` (`LoanRollforward` in shared types) to `GET /v1/console/reconciliation` |
| Employer templates and paycheck component accounts | `employers: []` | Add `employers[]` (`EmployerMapping`) to `GET /v1/console/mappings` |
| Draft sums, journal IDs and BC-side counts per batch | `appDraftSumCents: 0`, `bcDraftCount` undefined (the "differs" tag cannot fire) | Extend `GET /v1/console/posting.batches[]` with `journalId`, `appDraftSumCents`, `bcDraftCount`, `bcDraftSumCents`, `lastPostRequestedAt`, `lastPostedAt` |
| Subscription IDs | `subscriptionId: "—"` | Add `subscriptionId` to `connections.webhooks[]` |
| Per-card statement number and date, reconciled-through, open sum, per-line differences | Derived: open = posted − reconciled; differences shown as a count with a pointer to Exceptions | Extend `reconciliation.accounts[]` with `lastStatementNo`, `lastStatementDate`, `reconciledThrough`, `openSumCents`, `differences[]` |
| Audit filter by actor | Not sent (entity and entityId are) | Add `actor` query parameter to `GET /v1/console/audit` |
| Resolve exception with a BC Document No. | Only `entryNos`, `postingDate`, `note` are sent; the dialog's Document No. is dropped | Add optional `documentNo` to `POST /v1/console/exceptions/{id}/resolve` |
| Mapping proposal | `POST /v1/approvals { kind: "settings", payload: { kind: "mapping", categoryId, glAccount, dims, reason } }` — a convention, not documented | Document `payload.kind = "mapping"` for `settings` approvals, or add `POST /v1/console/mappings/propose` |
| Who am I / household name and settings version | No `/v1/me`; the client reads `/v1/console/settings` for the version and shows "Household" | `GET /v1/me { member, household, ledger }` (`ConsoleMe` in shared types) |
| Receipt capturer's name | `memberName: "—"` | Add `memberName` to `ReceiptSummary` |
| Decline a proposed rule | `POST /v1/rules/{id}/retire` (the API has approve and retire only) | Fine as is; note it in the OpenAPI description |
| Possible duplicate decision | `POST /v1/questions/tx:{id}/answer { optionId: not_repeat | same_thing }` | Fine as is if the question id convention `tx:<transaction id>` holds; otherwise return the question id on the transaction |

Everything else (`/v1/console/queues`, `/sync`, `/posting`, `/posting/post-batch`, `/reconciliation`, `/mappings`, `/authority-matrix`, `/connections`, `/audit`, `/settings`, `/exceptions/{id}/resolve`, `/v1/rules*`, `/v1/transactions/{id}/business`, `/v1/accounts`) matches the OpenAPI as written. Shapes live in `packages/shared/src/types.ts` under "Console DTOs (E7)"; add fields there, never change existing ones.

## Layout

```
src/
  App.tsx, main.tsx         routes and providers
  config.ts                 VITE_* configuration (public), BC URL templates
  auth/                     MSAL (Entra External ID) and the dev/mock auth provider
  api/                      ConsoleApi interface, HTTP client, react-query hooks, mock
  components/               Shell, QueueTable, dialogs, small UI pieces
  pages/                    the six MVP pages, Overview, Placeholder
  lib/                      status mapping, formatting, BC deep links
  shims/node-crypto.ts      SHA-256 for the browser
  styles/app.css            tokens from prototype/homestead.html (light and dark)
public/health.json          written by the nightly acceptance job
staticwebapp.config.json    SPA fallback and security headers for Azure Static Web Apps
e2e/, playwright.config.ts  smoke test in mock mode
```
