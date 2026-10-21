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

# against a local API with dev auth (sends x-dev-member). The API needs AUTH_MODE=dev and
# CORS_ORIGINS=http://localhost:5174; VITE_DEV_MEMBER_ID is Cade's member id as `db:seed` prints it.
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
- `test/live-api.test.ts`: the same client against a running API with a seeded household (skipped unless `CONSOLE_LIVE_API_URL`, `CONSOLE_LIVE_MEMBER_ID` and `CONSOLE_LIVE_OTHER_MEMBER_ID` are set; it writes, so use a scratch database). It creates three manual lines, corrects one with a rule proposal, approves the rest, has the other spouse approve and retire the rule, records a post request, and reads all six screens.
- `test/http.test.ts`: the HTTP client against a fake of the API's routes: bulk approve answers `tx:<id>` with `confirm` (never `/correct`), step-up goes only on the guarded calls, the resolve body carries the BC keys, post-batch maps the API's reply, mapping proposals are refused without a request, the 14 cards and the "not reported" list, receipt candidates from the receipt detail, API error bodies become `ApiError`.
- `e2e/smoke.spec.ts`: every MVP page in mock mode with its data-through line, a placeholder page, bulk approve, exception resolve with the audit trail, Post batch, the 14 cards and 3 loans, the I-09 highlight, outbox retry and the nightly page. Run it with a pre-installed Chromium: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome pnpm --filter @homestead/console test:e2e` (14 tests, about 20 s), or let Playwright download one (`npx playwright install chromium`). The repository CI (`.github/workflows/ci.yml`) does not run it yet.

## What is faked and why

- **Mock API** (`src/api/mock/`): `VITE_API_MODE=mock` swaps in an in-memory `ConsoleApi` with synthetic households, transactions, receipts, rules, outbox rows, sync runs and audit entries. Mutations run `assertTransition` from `@homestead/shared`, write an audit row and, for anything bound for BC, an outbox row. Used by the smoke test and for design review without an API or a sandbox. It shows the designed flows, including two the API does not support yet (mapping proposals, loan rollforwards); in HTTP mode those say "not available yet".
- **`node:crypto` shim** (`src/shims/node-crypto.ts`): `@homestead/shared` hashes with `node:crypto`; Vite aliases it to a small synchronous SHA-256 so the shared helpers run unchanged in the browser.
- **Nightly acceptance** (`public/health.json`): a static file the CI `sandbox-acceptance` job overwrites after A1–A9 run against the BC sandbox. Until the first run the page says "No nightly run yet."
- **BC deep links**: URL templates in `src/config.ts` (General Journal page 39, G/L Entries page 20, Bank Account Ledger Entries page 372) filled from `VITE_BC_*`; shown only when tenant and company are configured. They carry no credential.

## API routes

`src/api/http.ts` is written against `services/api/openapi.yaml` and reconciled (Oct 20, 2026) with the routes as implemented in `services/api/src/routes/*.ts`; `test/live-api.test.ts` runs every screen's reads and the Console's writes against a running API. Every Console action and the route it uses:

| Console action | Route | Step-up |
| --- | --- | --- |
| Queues, counts, receipts, rule proposals, exceptions | `GET /v1/console/queues` (one read shared for 5 s) | |
| Account names and masks, feed status per bank card | `GET /v1/accounts` | |
| Bulk approve | `POST /v1/questions/tx:{id}/answer { optionId: "confirm" }` per row (the phone's "Looks right"; not logged as a correction, so rule statistics stay honest) | |
| This is wrong (+ optional rule proposal) | `POST /v1/transactions/{id}/correct`, then `POST /v1/rules` (kind `merchant`, `match { merchantNorm, band, direction }`) | |
| Business flag | `POST /v1/transactions/{id}/business` | |
| Possible duplicate | `POST /v1/questions/tx:{id}/answer { optionId: not_repeat \| same_thing }` | |
| Resolve exception | `POST /v1/console/exceptions/{id}/resolve { to, entryNos, documentNo, postingDate, note }` | yes |
| Receipt candidates; match | `GET /v1/receipts/{id}` (`candidates[]`), `GET /v1/transactions/{id}`; `POST /v1/receipts/{id}/match` | |
| Rules; approve; decline or retire | `GET /v1/rules?state=`; `POST /v1/rules/{id}/approve`; `POST /v1/rules/{id}/retire { reason }` | yes |
| BC sync and posting | `GET /v1/console/posting`, `/console/connections`, `/console/sync` (last poll status), `/console/audit?entity=batch` (last post request) | |
| Post batch | `POST /v1/console/posting/post-batch` (records or enqueues; the screen shows the API's message) | yes |
| Reconciliation | `GET /v1/console/reconciliation` (open = posted and not yet reconciled) | |
| Mappings (categories, dimensions, bank cards, employer templates) | `GET /v1/console/mappings` | |
| Authority matrix, settings versions | `GET /v1/console/authority-matrix`, `GET /v1/console/settings` | |
| Connections, sync runs | `GET /v1/console/connections`, `GET /v1/console/sync?limit=500` | |
| Outbox; retry a dead letter | `GET /v1/console/outbox?state=`; `POST /v1/console/outbox/{id}/retry` | yes |
| Audit log | `GET /v1/console/audit?limit&entity&entityId` | |
| Header (member, household, settings version, BC environment and company) | `GET /v1/me` | |

Step-up: in dev the client sends `x-step-up: true`; with Entra it sends a token issued just now (`forceRefresh`), which the API accepts when `iat` is inside two minutes and `amr` carries MFA or a passkey.

Console needs and where they stand (a screen says "not available yet" or "—" rather than show a zero):

| Console need | Status |
| --- | --- |
| Mapping change by proposal | Wired: `POST /v1/console/mappings/proposals` creates an approval the other spouse decides; on approval the API versions the category |
| Per-card open count and sum, last statement, reconciled-through | Wired from BC's bank ledger entries (HH App Connector) when the API can read them; counts from the app otherwise |
| BC-side draft count and sum per batch | Wired (`bcDraftCount`, `bcDraftSumCents`, read live by the API); journal id and last-posted time still not reported |
| Who captured a receipt | Wired (`memberName` on the queue's receipts) |
| Audit filter by actor | Wired (`actor` query parameter) |
| Whether BC answers right now | Wired (`ledger.apiReachable`, `checkedAt`) |
| Classify a `needs_classification` line by hand | Done in the API |
| Loan rollforwards (Frontier ×2, PennyMac) | Wired: `loans[]` on `/console/reconciliation`, read from BC's G/L by the accounts the recurring journals post to (shared `LOANS`); `loansUnavailable` when BC does not answer |
| Individual difference lines per card | Open: the page shows the count and points to the Exceptions queue |

Shapes live in `packages/shared/src/types.ts` under "Console DTOs (E7)"; add fields there, never change existing ones.

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
staticwebapp.config.json    SPA fallback and security headers for Azure Static Web Apps (CSP: scripts and styles
                            from the site only; connect-src is the API's *.azurecontainerapps.io host and the
                            sign-in hosts — add the API's host there if it moves to a custom domain)
e2e/, playwright.config.ts  smoke test in mock mode
```
