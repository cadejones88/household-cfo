# Homestead — Phase 3 Architecture and Integration Spec

Snapshot of the live Claude Doc as of Oct 20, 2026 (https://claude.ai/code/artifact/0f25a801-eaf1-47cb-926f-818ff21286e0). Status: approved at Gate 3 on Oct 20, 2026 (Gate 2 approved the same day). The live doc wins if they differ.

Oct 19, 2026 · @Cade Jones

## Summary

Homestead is one Azure-hosted service that owns every connection to Business Central, with an Expo phone app for the household, a React console for Cade, Plaid for read-only bank data, and a staging database that mirrors BC's journal state line by line. Every transaction carries one stable key from its source to its BC entry number, so a retry, a webhook outage or a second import can never post twice.

This spec applies the Gate 1 decisions of October 19, 2026: all transactions default to personal; every paycheck posts by component; auto-posting is designed in from the start and switched on rule by rule; Cade T. Jones CPA, P.C. owns the accounts; the code lives in `cadejones88/household-cfo`.

**Gate 3 approved by Cade on October 20, 2026** (together with Gate 2, Vanessa's prototype verdict). What was approved:

1. The stack, hosting and environment split (section 2) and the repository layout (section 3).
2. The data model, state machine and idempotency design (sections 5–7).
3. The BC API mapping and the HH App Connector extension (section 8), plus the six proposed BC changes (section 19).
4. The initial auto-post rule candidates and the draft authority matrix (section 12), which stay off until each rule passes its test.
5. The security model (section 13), the running cost (section 15) and the test strategy (section 17).

Phase 4 began the same day: the MVP is built against the BC sandbox and Plaid's Sandbox environment; nothing in this spec touches production or a live account.

## Stack and hosting

One new pay-as-you-go Azure subscription under Cade T. Jones CPA, P.C.'s Microsoft tenant (the firm has none today; Cade creates it with a $100 monthly budget alert before anything deploys), one resource group per environment, and TypeScript everywhere so the phone app, console, API and jobs share one language and one package of money math.

| Part | Choice | Notes |
| --- | --- | --- |
| Phone app | Expo SDK 55 (React Native), TypeScript, Expo Router; development builds, not Expo Go | Camera, offline queue, push, Face ID and passkeys all need native modules |
| Console | React + Vite single-page app on Azure Static Web Apps (free tier) | Desktop-first; same API and auth as the phone app |
| API | Node 22 + Fastify on Azure Container Apps, consumption plan, scale to zero | One container image; OpenAPI schema shared with the clients |
| Jobs | Container Apps Jobs: schedule-triggered (Plaid sync, webhook renewal, nightly BC poll, alerts) and event-triggered (queue consumers) | Same image, different entry points |
| Queue | Azure Service Bus Standard, one topic `homestead-outbox` with subscriptions per consumer, dead-letter enabled | Fed only from the outbox table |
| Database | Azure Database for PostgreSQL Flexible Server 16, Burstable B1ms, 32 GB, 7-day PITR, zone-redundant backups | Row-level security by household |
| Blobs | Storage account, private containers `receipts` and `imports`, customer-managed key in Key Vault, versioning and 90-day soft delete | One container prefix per household |
| Secrets | Key Vault; managed identities for API and jobs; BC app credential is a certificate, rotated yearly | No connection strings in app settings |
| Identity | Entra External ID external tenant `homesteadfamily` (name to confirm), custom URL domain homestead.cadejonescpa.com, Face ID unlock in the app | Separate from the firm's workforce tenant |
| Documents | Azure AI Document Intelligence S0: `prebuilt-receipt`, `prebuilt-payStub.us` | 500 free pages a month on F0 for dev |
| Model | Claude on Microsoft Foundry, hosted on Azure, US Data Zone Standard | Receipt line mapping and Ask Homestead |
| Monitoring | Application Insights + Log Analytics with a telemetry processor that drops account numbers, tokens and image bytes | 30-day retention |
| Infrastructure as code | Bicep modules under `infra/`, deployed by GitHub Actions with OIDC federation (no stored cloud secrets) |  |

### Environments

| Environment | Resource group | Business Central | Plaid | Data |
| --- | --- | --- | --- | --- |
| dev | `rg-homestead-dev` | CADE\_Sandbox\_vs25 | Sandbox (fake institutions) | Synthetic only |
| pilot | `rg-homestead-pilot` | CADE\_Sandbox\_vs25 | Trial plan, live read-only logins | Real feeds, sandbox ledger (Phase 5) |
| prod | `rg-homestead-prod` | Production company, after written approval by both spouses | Trial plan | Real |

Region: West US 3 for everything except Document Intelligence and Foundry, which use whichever US region hosts the models; data stays in the United States. Naming: `homestead-<env>-<resource>` (for example `homestead-pilot-api`, `psql-homestead-pilot`).

## Repository layout

`cadejones88/household-cfo` is a pnpm + Turborepo monorepo; one `pnpm install` and one `turbo run build` cover every package. Nothing in it is specific to one household: per-family values live in the database and in environment settings.

| Path | What lives there | Deploys to |
| --- | --- | --- |
| `apps/mobile/` | Expo app: Household Home, camera, offline queue, Face ID, push | TestFlight, then App Store |
| `apps/console/` | React console for the CFO view | Azure Static Web Apps |
| `services/api/` | Fastify API: auth, households, transactions, receipts, paychecks, approvals, Ask Homestead, Plaid and BC webhooks | Container Apps |
| `services/jobs/` | Scheduled and queue-driven jobs: Plaid sync, OCR, matching, BC outbox dispatcher, webhook renewal, nightly reconciliation, alerts | Container Apps Jobs |
| `packages/shared/` | Types, money math (integer cents), category catalog, state machine, validation schemas, idempotency key builders | npm workspace |
| `packages/ledger-adapter-bc/` | The ledger adapter interface and its Business Central implementation (API v2.0 client, Analytics client, HH App Connector client, dimension set builder) | npm workspace |
| `packages/ui/` | Shared components and the calm status system for phone and console | npm workspace |
| `bc/hh-app-connector/` | AL extension source (API pages, permission set HH-APP), per-tenant | BC sandbox, then production |
| `infra/` | Bicep modules and parameter files per environment; GitHub Actions workflows | Azure |
| `prototype/` | The Phase 2 HTML prototype of Household Home (sample data, no accounts) | Artifact link |
| `docs/` | Snapshots of the Phase 1 and Phase 3 specs, ADRs, runbooks, Vanessa's guide |  |
| `test/` | End-to-end and sandbox test suites, synthetic fixtures, the 12-month alert replay set |  |

Branching: `main` is deployable to dev on every merge; `pilot` and `prod` deploy by tag after the gate sign-offs. Secrets never enter the repo; `.env.example` files list names only.

## How the parts connect

&#91;embedded content: architecture · 14 parts, who calls whom\]

The phone and the Console talk only to the API; the API and the Jobs share the database and the queue; only the Jobs talk to Plaid and Business Central, and the API also calls Claude for Ask Homestead. Secrets stay in Key Vault, reached by managed identity.

## Data model

One PostgreSQL database, every table keyed by `household_id`, with row-level security so a query can only ever see one household. Money is stored as integer cents; dates as `date`, timestamps as `timestamptz`; every mutable table carries `created_at`, `updated_at`, and the `member_id` or job that changed it.

| Table | Key columns | Notes |
| --- | --- | --- |
| households | id, name, timezone, currency, ledger\_kind (`bc`), settings jsonb (thresholds, quiet hours, payday rule) | Settings are versioned through `household_setting_versions` |
| members | id, household\_id, entra\_object\_id, display\_name, role (`member`, `adviser`), passkey\_registered, face\_id\_enabled | No owner role; both members have equal approval rights |
| ledger\_connections | id, household\_id, bc\_tenant\_id, bc\_environment, bc\_company\_id, journal\_template, batch\_feeds, batch\_receipts, batch\_autopost, api\_base\_url, cert\_secret\_ref | One row per household; the certificate itself lives in Key Vault |
| accounts | id, household\_id, kind (checking, savings, card, loan, mortgage, wallet, cash), institution, display\_name, mask (last 4), bc\_bank\_account\_code or bc\_gl\_account, feed\_connection\_id, is\_restricted | 101101, CAPONE-CC and so on come from BC design §6 |
| feed\_connections | id, household\_id, provider (`plaid`, `file`), plaid\_item\_ref (vault), institution\_id, cursor, status, last\_synced\_at, needs\_relink | Plaid access tokens are stored in Key Vault, not here |
| transactions | id, household\_id, account\_id, source (`plaid`, `ofx`, `csv`, `pdf`, `receipt`, `manual`), source\_ref, idempotency\_key (unique), posted\_date, amount\_cents, merchant\_raw, merchant\_norm, pending, state, category\_id, dimension\_set jsonb, business\_flag (`none`, `ctj`, `lash`), kind (`spend`, `income`, `transfer`, `loan_payment`, `paycheck`, `bc_native`), confidence, rule\_id, bc\_external\_doc\_no, bc\_journal\_id, bc\_line\_id, bc\_document\_no, bc\_entry\_nos int\[\], bc\_posting\_date, last\_sync\_at, sync\_status | The heart of the model; `state` follows the state machine below |
| transaction\_splits | id, transaction\_id, line\_no, amount\_cents, category\_id, gl\_account, dimension\_set jsonb, receipt\_line\_id | Sum must equal the parent amount |
| receipts | id, household\_id, member\_id, blob\_ref, sha256 (unique per household), captured\_at, uploaded\_at, ocr\_status, ocr\_result jsonb, merchant, total\_cents, tax\_cents, receipt\_date, matched\_transaction\_id, match\_confidence | Images in the household's Blob container, encrypted with its key |
| receipt\_lines | id, receipt\_id, line\_no, description, qty, amount\_cents, suggested\_category\_id, suggested\_confidence | Output of Document Intelligence plus Claude mapping |
| paychecks | id, household\_id, employer\_id, member\_id, pay\_date, period\_start, period\_end, net\_cents, source (`stub_image`, `stub_pdf`, `template`), transaction\_id, stub\_receipt\_id | One per net-pay deposit |
| paycheck\_components | id, paycheck\_id, kind (`regular`, `bonus`, `overtime`, `fit`, `state_tax`, `social_security`, `medicare`, `benefit`, `other_deduction`), label, amount\_cents, gl\_account, dimension\_set jsonb | Posted as lines of one BC document |
| employers | id, household\_id, member\_id, name, bc\_gross\_account, bc\_bonus\_account, template jsonb (component ratios, withholding accounts), last\_stub\_at | HFH and CTJ to start |
| categories | id, household\_id, name, group, gl\_account, dimension\_defaults jsonb, spend\_class, is\_allowance, is\_restricted\_source, version | The household's words for the BC chart; versioned |
| rules | id, household\_id, kind (`merchant`, `transfer`, `recurring_bill`, `paycheck`, `loan_payment`), match jsonb (merchant pattern, account, amount band, cadence), action jsonb (category, dimensions, split, business flag), may\_auto\_post, state (`proposed`, `approved`, `retired`), proposed\_by, approved\_by, approved\_at, effective\_from, version | Rules apply only in `approved` state; every change is a new version |
| approvals | id, household\_id, kind (`budget_move`, `correction`, `rule`, `business_flag`, `auto_post_rule`), payload jsonb, requested\_by, decided\_by, decision, step\_up\_verified, requested\_at, decided\_at | The other spouse decides; step-up is recorded |
| budget\_revisions | id, household\_id, bc\_budget\_name, revision\_no, lines jsonb (account, dimensions, period, amount), approval\_id, written\_to\_bc\_at | Written through the HH App Connector |
| alerts | id, household\_id, member\_id, kind, level (`action`, `watch`, `pulse`), fingerprint (unique while open), payload jsonb, created\_at, delivered\_at, snoozed\_until, resolved\_at | One open alert per fingerprint |
| sync\_runs | id, household\_id, kind (`plaid`, `bc_poll`, `bc_webhook`, `webhook_renewal`, `autopost`, `ocr`), started\_at, finished\_at, status, counts jsonb, error | Visible in Console function 12 |
| outbox | id, household\_id, aggregate (`transaction`, `budget_revision`), aggregate\_id, operation, payload jsonb, attempts, next\_attempt\_at, dead\_lettered | Written in the same DB transaction as the state change; a relay publishes to Service Bus |
| audit\_log | id, household\_id, actor (member or job), action, entity, entity\_id, before jsonb, after jsonb, at | Append-only: insert-only grant, no update or delete |

Two invariants are enforced in the database, not just in code: `idempotency_key` is unique per household, and a transaction cannot enter `sent_to_bc` or later without a `bc_external_doc_no`.

## Transaction state machine

&#91;embedded content: transaction states · 12 states, main path and side paths\]

A transaction moves only along these arrows; every move writes an audit row, and the states from Sent to BC onward require a BC External Document No.

| From | To | Trigger | Who or what |
| --- | --- | --- | --- |
| (new) | Imported | Settled feed line, file row, receipt or manual entry with a fresh idempotency key | Jobs or API |
| Imported | Possible duplicate | Same account, amount and date within 3 days as an existing transaction from another source | Jobs |
| Possible duplicate | Needs receipt / dropped | A person says "not a repeat" (continues) or "same thing" (dropped, key kept so it cannot return) | Either spouse, or Cade in the Console |
| Imported | Needs receipt | Walmart, club or Amazon line of $25 or more without a matched receipt | Jobs |
| Needs receipt | Needs classification | Receipt matched, or 10 days pass (estimated split applied) | Jobs |
| Imported / Needs receipt | Needs classification | Any other line | Jobs |
| Needs classification | Approved | An approved rule matches with high confidence inside its band | Rule engine |
| Needs classification | Ready for review | Medium confidence (one-tap confirm) or low confidence (pick a category) | Rule engine |
| Ready for review | Approved | One tap in the app, or a Console approval | Either spouse |
| Approved | Sent to BC | Outbox row relayed to the queue; batch chosen: FEEDS, RECEIPTS, or AUTOPOST when `may_auto_post` is true and the household switch is on | Relay |
| Sent to BC | BC draft created | Journal lines written (or found by the pre-write check); line IDs stored | BC worker |
| Sent to BC | Exception | Non-retryable error, or BC reports a line the app doesn't know | BC worker |
| BC draft created | Posted | Cade posts the batch in BC or the Console, or the auto-post job posts AUTOPOST; G/L entries read back by webhook or poll | Cade, or Jobs |
| BC draft created | Exception | Draft edited or deleted in BC; nightly poll count or sum differs | Poll |
| Posted | Reconciled | The bank ledger entry is closed by BC's bank reconciliation | HH App Connector read |
| Posted | Reversed / superseded | A correction: reversal in BC with reason REVERSE, new entry with CORRECT; the new entry is a new transaction linked to this one | Cade |
| Exception | Ready for review / Posted | A person resolves it; the resolution is recorded with the keys on both sides | Cade |

Vanessa's app shows these as five words: Needs a quick answer (Needs receipt, Needs classification, Ready for review, Possible duplicate), Recorded (Approved, Sent to BC, BC draft created), In the books (Posted), Matched to the bank (Reconciled), Being checked (Exception). Reversed items show the new entry instead.

## Idempotency and retries

A transaction can be imported twice, sent twice and polled twice without ever producing two BC lines, because one key follows it from its source to its G/L entry and every write checks for that key first.

| Source | Idempotency key | Why it is stable |
| --- | --- | --- |
| Plaid | `plaid:<account_id>:<transaction_id>` of the settled transaction | Plaid keeps the posted transaction's ID; the pending ID is dropped when it settles, so pending rows never carry a BC key |
| OFX/QFX | `ofx:<account_id>:<FITID>` | FITID is the bank's own unique ID |
| CSV | `csv:<account_id>:sha256(date, amount, normalized description, running sequence within the day)` | The sequence number separates two identical charges on one day |
| Statement PDF | `pdf:<account_id>:<statement_no>:<line_no>` | Statement numbers are unique per account |
| Receipt | `rcpt:<sha256 of the image>` | The same photo uploaded twice is the same receipt |
| Paycheck | `pay:<employer_id>:<pay_date>:<net_cents>` | One deposit per employer per pay date |
| Manual | `man:<uuid>` minted once in the app, kept on the device until acknowledged | A resend carries the same uuid |

BC's External Document No. is `HHAPP-<SRC>-<yyyymmdd>-<hash8>` (20 characters, BC's limit): `SRC` is one of PLD, OFX, CSV, PDF, RCP, PAY, MAN; `hash8` is the first 8 hex characters of the SHA-256 of the idempotency key. Splits of one transaction share the document number and differ by line.

1. **Write path.** The approval (or the auto-post rule) changes the state and writes an `outbox` row in the same database transaction. A relay publishes the row to Service Bus; the BC worker consumes it.
2. **Pre-write check.** Before creating lines, the worker queries `journalLines` in the target batch and `generalLedgerEntries` for the External Document No. If either exists, the worker records the found IDs and moves on instead of writing.
3. **All-or-nothing splits.** All lines of one transaction go in one OData `$batch` changeset, so a failure leaves no partial document. Phase 4's first sandbox test proves this by forcing a failing line.
4. **Retries.** 408, 429 and 5xx from BC retry with exponential backoff (1, 2, 4, 8, 16 minutes, then hourly for a day). Any other error sends the message to the dead-letter queue and raises an Exception on the transaction. Retries always rerun the pre-write check, so a timeout after a successful write cannot double it.
5. **Posting.** The post action posts a whole batch. Lines awaiting a person stay in the app until approved, so HHAPP/FEEDS and HHAPP/RECEIPTS contain only approved drafts and HHAPP/AUTOPOST contains only rule-approved lines. A posting job for AUTOPOST posts the batch, then reads back the G/L entries by External Document No.
6. **Read-back.** After posting, the webhook or the nightly poll finds the G/L entries, stores `bc_entry_nos` and `bc_posting_date`, and moves the transaction to Posted. A G/L entry whose External Document No. starts with HHAPP- but matches no app transaction becomes an Exception.
7. **BC-native entries.** Mortgage, loan, prepaid and allocation entries are posted by BC's own recurring journals. Their bank lines (the PennyMac and Frontier payments) are matched to BC's existing bank ledger entries through the HH App Connector and go straight to Reconciled; the app never creates lines for them.

## Business Central API mapping, webhooks and the HH App Connector

The standard API v2.0 covers every write the app needs and most reads; two reads and one write need a small AL extension. Nothing depends on the finance reports API, which Microsoft marks obsolete in 2026 release wave 2 and removes in 2027 release wave 1 (version 30).

| Need | Endpoint | Verified fact |
| --- | --- | --- |
| Create draft lines | `POST /companies({id})/journals({id})/journalLines`, batched in `$batch` | Lines carry only the two global dimensions unless the dimension set is sent explicitly (Test finding 1), so every line sends SPEND\_CLASS, FUND\_GOAL, FAMILY\_AREA, TAX\_TREATMENT and PROJECT through `dimensionSetLines` |
| Post a batch | `POST /journals({id})/Microsoft.NAV.post` | Posts the whole batch; response 204 |
| Read drafts | `GET /journals({id})/journalLines?$filter=externalDocumentNumber eq '…'` | Pre-write check and draft poll |
| Read posted entries | `GET /generalLedgerEntries?$filter=… and $expand=dimensionSetLines` | Entry numbers, posting date, dimensions |
| Chart, dimensions, bank cards | `accounts`, `dimensions`, `dimensionValues`, `bankAccounts` | Cached nightly for the mapping screen |
| Budgets (read) | Analytics API `microsoft/analytics/v1.0` → `generalLedgerBudget`, `generalLedgerBudgetEntry` | Read-only by design; same OAuth model |
| Budgets (write) | HH App Connector custom API | No standard write path survives 2027 wave 1 |
| Reconciliation state | HH App Connector custom API over Bank Account Ledger Entry | API v2.0 has no bank ledger entry entity |
| Companies, environment | `companies`, the runtime `webhookSupportedResources` endpoint | Confirms the webhook list per environment |

### Webhooks and polling

- Subscribe to `generalLedgerEntries` and `journals` (both on Microsoft's supported list; `journalLines` is not). Subscriptions expire after three days, so a job renews them daily and re-registers after any environment update; the handshake echoes `validationToken` and every notification's `clientState` is checked.
- The receiver returns 202 at once and processes from a queue. BC retries only on 408, 429 or 5xx and deletes the subscription on any other reply, so the receiver never returns 4xx for its own errors.
- Notifications carry no data, only resource URLs; the worker reads the entries and matches them by External Document No.
- Nightly poll (02:00 Mountain): for each batch and posting date in the last 45 days, compare count and sum of HHAPP lines in the app with `journalLines` plus `generalLedgerEntries`; any difference opens an Exception with the keys on each side. The poll is the completeness guarantee; the webhook only makes things faster.

### HH App Connector (per-tenant AL extension, approved at Gate 1)

| API page | Purpose | Shape |
| --- | --- | --- |
| `hhBankLedgerEntries` (read) | Reconciled status for Console function 3 and for BC-native payments | Entry No., Bank Account No., Posting Date, Amount, External Document No., Open, Statement No., Statement Line No., Closed at Date, Reversed |
| `hhBudgetEntries` (create/read) | Versioned budget revisions from approved budget moves | Budget Name (validated against a whitelist: `*-REV*`, `FCST*`; `*-ORIG` refused), G/L Account, Date, Amount, dimension codes, Description = revision number |
| `hhJournalLineCheck` (read) | One call answering "does this External Document No. exist anywhere?" across journal lines and G/L entries | Faster than two OData filters per line |

Permission set `HH-APP`: read on G/L Account, Dimension, Dimension Value, Bank Account, G/L Entry, G/L Budget Name and Entry, Bank Account Ledger Entry; insert, modify and delete on Gen. Journal Line restricted by a filter to the HHAPP template; insert on G/L Budget Entry; no posting codeunit until an auto-post rule is approved, then execute on the posting codeunit with the batch filter HHAPP/AUTOPOST. The extension is deployed to the sandbox from the repo's `bc/` folder and promoted only with the production package.

BC's own Text-to-Account Mapping stays empty on the app path: the app's rule register is the one classification engine, so two engines never disagree.

## Bank data: Plaid and file import

Plaid's free Trial plan covers all eight of the family's logins with two to spare, and every file format lands in the same staging path, so a feed outage never changes how a transaction is handled.

### Plaid

- **Plan.** Trial: a new US team, up to 10 Items, Transactions, Balance, Liabilities and Statements included. The team is created under Cade T. Jones CPA, P.C. and never applies for Production until a client release needs more than 10 Items; applying closes the Trial.
- **Link.** Each spouse links the institutions they own from the app (Vanessa: Beehive, Venmo; Cade: America First, Mountain America, Capital One, CareCredit if it connects, Frontier, PennyMac). Link runs in Plaid's own view; the app receives a public token and exchanges it on the server. Access tokens go to Key Vault; the database holds only the Item ID and status.
- **Sync.** `/transactions/sync` with a stored cursor per Item, run every 4 hours and on Plaid's `SYNC_UPDATES_AVAILABLE` webhook. Added, modified and removed transactions are applied in order; removed pending transactions are dropped, removed posted transactions raise an Exception.
- **Pending vs settled.** Pending transactions show in the app with a "pending" tag and count toward safe-to-spend, but only settled transactions get an idempotency key and can reach BC.
- **Balances.** `/accounts/balance/get` once a day and before computing safe-to-spend; the balance shown always carries its timestamp.
- **Liabilities.** For the Frontier loans and PennyMac, if they connect: `/liabilities/get` supplies rate, next due date and last payment for the debt register; the ledger balance still comes from BC.
- **Re-link.** `ITEM_LOGIN_REQUIRED` marks the connection `needs_relink`, shows a calm card to the owner of that login, and suspends alerts that depend on that account.

### Coverage confirmation (Phase 4, first week)

| Institution | Expected | How we confirm |
| --- | --- | --- |
| Beehive FCU, America First, Mountain America, Capital One, Venmo | Supported | `/institutions/search` in Sandbox, then one real Link per spouse |
| CareCredit (Synchrony) | Listed; recent user reports of failures after Synchrony's login change | Try Link once; fall back to statement PDF upload without changing anything else |
| Frontier CU | Unconfirmed (several "Frontier" credit unions) | Search by routing number; fall back to monthly statement |
| PennyMac | Unconfirmed | Search; fall back to the monthly statement, which also feeds the escrow split |

### File import

- Accepts CSV, OFX/QFX and statement PDFs, dropped into the Console or forwarded to the household's import address.
- Each institution gets a parser profile (column map, date format, sign convention) stored as data, mirroring BC's Data Exchange Definitions.
- Imported rows get the same states, duplicate checks and keys as Plaid rows; a row that matches an existing Plaid transaction by account, date, amount and merchant within 3 days is marked a Possible Duplicate for a person to resolve, never merged silently.
- PDF statements run through Document Intelligence's layout model, then the same parser profile.

SimpleFIN Bridge ($15 a year) stays in reserve for any credit union Plaid cannot reach; it plugs in as a second `feed_connections.provider`.

## Receipt pipeline and paycheck pipeline

Receipts and pay stubs follow the same shape: capture on the phone, read with an Azure Document Intelligence prebuilt model, map to the household's categories, match to a bank line, then post as one BC document.

### Receipts

1. **Capture.** The Expo camera takes the photo with edge detection and auto-shutter; the file is written to the device's encrypted store with a queue entry. Offline, the queue entry waits and the app shows "not synced yet."
2. **Upload.** The app sends the image with its SHA-256; the API refuses a hash it already holds for the household (same photo twice) and stores the blob in the household's container under its customer-managed key.
3. **Read.** `prebuilt-receipt` returns merchant, date, total, tax, tip, payment method and line items with confidence per field.
4. **Map lines.** Claude (Foundry, US Data Zone) receives the line descriptions and amounts, the household's category list with examples, and the merchant; it returns one category per line with a confidence. It never sees account numbers or the image.
5. **Split.** Tax is spread across lines in proportion to their amounts; rounding goes to the largest line; the split must equal the receipt total to the cent or the receipt goes to review. Lines under $25 that map to one category are not shown as questions; a Walmart or club receipt of $25 or more shows its split once for a one-tap confirmation.
6. **Match.** Candidates are bank lines on the same account within −3 to +5 days whose amount equals the total (or total within 2% for tips). One candidate above 0.9 confidence matches; two plausible candidates go to a person.
7. **Post.** The matched transaction's splits become the lines of one BC document in HHAPP/RECEIPTS (or AUTOPOST under a rule). The receipt keeps links to the transaction, the approval and the BC entry numbers.
8. **No receipt after 10 days.** Walmart, club and Amazon lines post to 603201, 603401 or 603801 and BC's monthly allocation clears them; the app shows "estimated split."

Amazon: order confirmation emails forwarded to the household's receipts address are parsed for items and prices and matched to the per-shipment charges; the monthly "Request your data" export is the catch-up for anything missed.

### Paychecks

Every net-pay deposit becomes a paycheck record whose components post as one document, so the ledger shows gross pay, bonus, each tax and each deduction, and the year ties to the W-2.

1. **Detect.** A deposit from a known employer (HFH or CTJ payroll descriptor) creates a `paychecks` row in state Needs Receipt with the employer's template applied provisionally.
2. **Stub.** Cade forwards or uploads the stub PDF (Paychex for Henry's Fork Homes, Gusto for CTJ); a photo of a printed stub works too. It runs through `prebuilt-payStub.us` (generally available in Document Intelligence v4.0, API version 2024-11-30, en-US); the model's schema lists the compensation, tax and deduction fields it returns. Each extracted line is mapped to a component kind; anything unmapped is shown for a one-tap choice and remembered in the employer template.
3. **Template fallback.** If no stub arrives within 3 days, the template (last stub's component ratios) proposes the breakdown with "estimated" shown; the next stub trues it up with a correction document.
4. **Post.** One BC document in HHAPP/FEEDS, or AUTOPOST once the paycheck rule is approved:

| Component | BC account (HFH / CTJ) | Dimensions |
| --- | --- | --- |
| Regular pay | 401101 / 401201 (credit) | FAMILY\_AREA CADE, TAX\_TREATMENT TAXABLE |
| Bonus | proposed 401102 / 401202 (credit) | same |
| Federal withholding | 701101 / 701102 | SPEND\_CLASS COMMITTED |
| Idaho withholding | 701201 / 701202 | COMMITTED, DED-SALT |
| Social Security | 701301 / 701302 | COMMITTED |
| Medicare | 701401 / 701402 | COMMITTED |
| Benefit premiums | the natural 605xxx account | COMMITTED |
| Other deductions | 701801 | REVIEW |
| Net pay | the receiving bank account card | — |

The bonus accounts 401102 and 401202 are approved (BC change 5) and are created in the sandbox in epic E2; until they exist, bonus posts to the gross wages account with a BONUS comment. Both employers' stubs arrive as PDFs (Paychex for Henry's Fork Homes, Gusto for CTJ), so the pipeline reads the PDF directly and never depends on a photo.

## Ask Homestead

Ask Homestead is a question box over read-only functions; the model can describe the numbers but cannot change anything, and every answer carries the date its data runs through.

| Function | Returns | Data-through |
| --- | --- | --- |
| `get_safe_to_spend()` | cash, set-aside, bills before payday, floor, result, next payday | bank balance timestamp |
| `get_budget_status(month)` | per category: budget, spent, left, pace status | last posted and last recorded transaction |
| `search_transactions(query, from, to, category)` | up to 50 rows with state and plain status words | same |
| `get_bills(until)` | due items with dates and whether they fall before payday | obligation calendar version |
| `get_goals()` | emergency fund, next debt, sinking funds, milestones | BC FUND\_GOAL balances at last poll |
| `get_paycheck(id)` | the component breakdown | posted document |

- The model (Claude on Foundry, Azure-hosted, US Data Zone) receives only the function results, the household's category names and the question. Account numbers, Plaid tokens, receipt images and other households never reach it; the household filter is applied in code before any function runs.
- No write functions exist. A request like "move $50 to groceries" returns a drafted budget move that opens the normal approval screen.
- Every numeric answer is rendered from the function results, not from the model's text: the model returns the sentence plus the function rows it used, and the app shows "Data through … · N items pending" from those rows.
- Questions and answers are kept 90 days for "what did I ask" and then deleted; they are never used to train anything.
- Vanessa's prototype answers are canned; the MVP replaces them with this design.

## Auto-post rules and the draft authority matrix

Hybrid posting, as Cade decided at Gate 1: a transaction that matches an approved auto-post rule goes to HHAPP/AUTOPOST and a job posts it; everything else waits for a person. Each rule is a written record with a test history, and auto-posting starts switched off until the first rules pass their sandbox test and Cade approves them in writing.

### Candidate rules for the first approval

| # | Rule | Match | Threshold | Why it is low-risk |
| --- | --- | --- | --- | --- |
| R1 | HFH paycheck | Deposit from the HFH payroll descriptor, pay stub read with every component mapped, components sum to net within $0.01 | Net within 15% of the last six | The stub is the evidence; the document ties to the W-2 |
| R2 | Own-account transfer | Equal and opposite lines on two household accounts within 2 days | Any amount; both sides present | Posts through 115101 and nets to zero |
| R3 | Card payment | Payment to a household card from a household account, both sides present | Any amount | Posts through 115201; never spending |
| R4 | Recurring bill, fixed | Merchant on the approved list (Verizon, Clear Management, insurance, subscriptions) | Amount within $5 or 5% of the last three | Known payee, stable amount, single category |
| R5 | Tithing | Weekly donation to the Church from a household account | Amount equals the standing amount | Fixed by policy; DED-CHAR |
| R6 | Small known merchant | Merchant with 10 or more approved classifications to one category in the last 6 months | Under $25 (the materiality line) and inside the merchant's amount band | Under materiality; drift guard applies |
| R7 | BC-native payments | PennyMac and Frontier payments matching BC's recurring-journal entries | Amount equals the scheduled payment | Reconciliation only; no new lines |

A rule never fires when any of these hold: the amount is outside the band, the merchant is on a watch list, the transaction is flagged business, a receipt split is pending, the account's feed is stale by more than 48 hours, or the household's auto-post switch is off. Fired rules are listed in the weekly pulse so both spouses see what posted without them.

### Draft authority matrix

| Action | Who | Step-up | Notes |
| --- | --- | --- | --- |
| Approve a classification or split | Either spouse | No | One tap |
| Mark an item as business | Either spouse | No | Shown to Cade in the CTJ list |
| Post approved drafts in BC | Cade | BC sign-in | Until auto-post rules are approved |
| Auto-post under R1–R7 | System | None | Only after written approval of each rule and the AUTOPOST permission |
| Approve or retire a rule | The spouse who did not propose it | Yes | Auto-post flag on a rule needs Cade's written approval |
| Budget move | The other spouse | Yes (Face ID) | I-09 threshold for unilateral moves between flexible categories: $\[TBD\] |
| Correction after posting | Cade | BC sign-in | Reverse and repost in BC with reason CORRECT |
| Opening-balance or policy change | Both, in writing | Yes | Per BC design §12 |
| Change thresholds, quiet hours, alert types | Both | Yes | Settings are versioned |
| Connect or remove a bank login | The login's owner | Yes | Never the other spouse |
| Export all data | Either spouse | Yes | Full human-readable export |

The matrix is stored as `household_settings` version 1 and shown read-only in Console function 11 until Cade approves it; the I-09 dollar threshold stays TBD until the Constitution decisions are made.

## Security model

Each spouse has their own identity, the server is the only thing that holds a bank token or a BC credential, and every secret lives in Key Vault under the firm's subscription.

### Identity and sign-in

| Who | How | Detail |
| --- | --- | --- |
| Vanessa, Cade | Entra External ID external tenant (owned by Cade T. Jones CPA, P.C.), one account each | Sign-up with email and password plus MFA, then a passkey registered on the custom domain through the system browser (External ID does not support passkeys inside an embedded web view or native-auth flow) |
| Passkeys | Stored where the family keeps them: LastPass on iOS acts as the passkey provider; iCloud Keychain works too | Cross-device sign-in by QR code if a phone is lost; LastPass Authenticator covers the TOTP step on sign-up |
| Day to day | Face ID unlock on the device (Expo local authentication) with a 7-day refresh token in the secure enclave store | Re-authentication with the passkey every 30 days or after a sign-out |
| Step-up | Approvals, rule changes, settings and export require a fresh Face ID (or passcode) inside the last 2 minutes | Recorded on the approval row |
| Console | Same tenant, browser sign-in with passkey; sessions expire after 12 hours | No separate admin login |
| Adviser role (later) | Separate account, read-only, invited by both spouses | For a CPA reviewer |

### Services and secrets

- **Business Central:** one Entra app registration per environment (sandbox, production) in the firm's workforce tenant, client-credentials flow with a certificate stored in Key Vault, permission set HH-APP. The phone never holds BC credentials.
- **Plaid:** client ID and secret in Key Vault; access tokens in Key Vault under `plaid-<household>-<item>`; the database stores only references.
- **Foundry, Document Intelligence, Service Bus, Postgres, Blob:** managed identities with RBAC; no connection strings in configuration.
- **Rotation:** certificates yearly, Plaid secret and Postgres password quarterly, all logged in the audit log without the secret itself.

### Data protection

- Postgres: TLS only, encryption at rest, row-level security keyed by `household_id`, 35-day point-in-time restore.
- Receipts and stubs: a private Blob container per household, customer-managed key per household in Key Vault, versioning and 30-day soft delete, no public access, SAS tokens valid 5 minutes for the phone's upload.
- Masking: the app and database store only the last four digits of any account number; Plaid's full numbers are never requested (no Auth product).
- Never stored: Social Security numbers, bank passwords, security answers, identity documents.
- Logs: Application Insights with a scrubber that removes amounts over $0, account masks, merchant strings, tokens and image URLs; errors keep the idempotency key only.
- Environments: dev uses synthetic data; the pilot uses real feeds against the BC sandbox; production is a separate resource group, tenant app registration and Key Vault.

### Audit and export

- `audit_log` is insert-only at the database role level. Approvals, postings, overrides, rule and budget changes, report issuance and access changes all write to it.
- Export: a signed-in spouse can request a complete export (CSV of every table plus the receipt images) delivered as a time-limited link; the request itself is audited.
- Retention: receipts and transactions kept 7 years (tax records); Ask Homestead conversations 90 days; logs 30 days; alerts 1 year.
- Incident basics: a stale feed, a dead-lettered BC write or a failed webhook renewal pages Cade's Console within 15 minutes; a suspected credential leak rotates the secret first and investigates second; both spouses are told what data was involved.

## Alerts and quiet hours

Alerts come from the cash forecast, not from a balance crossing a line, so a tight stretch produces one early alert instead of a daily one. Cash ran short in 8 of the last 12 months; the design target is two or fewer interrupts a month.

| Level | Fires when | Goes to | Delivery |
| --- | --- | --- | --- |
| Action needed | The 13-week forecast shows an account below $0, or a bill or minimum uncovered, within 3 days; a possible duplicate or out-of-pattern charge of $25 or more; a feed down 48 hours with a bill due; a BC write dead-lettered | Both spouses | Push; inside quiet hours only for the types both approved as critical |
| Watch | A category forecast to overrun by month-end; safe-to-spend below the floor; a receipt missing after 7 days; a Plaid login needing re-link | The relevant spouse | In-app badge and one daily digest card at 7 am; no push |
| Pulse | The weekly summary | Both | One push on council day, time to be set with the family |

Rules that keep alerts useful:

- One open alert per fingerprint (kind plus account or category); it repeats only when the facts change by more than $25 or the due date moves.
- An alert goes quiet while an agreed action is pending (for example, "hold the $400 card payment" sent to Cade) and reopens if the action is not taken by its date.
- Allowance categories never alert (I-10). Nothing compares the household with anyone else.
- Quiet hours default to 9 pm–7 am Mountain; the list of critical types that may break them is approved by both spouses and stored with the settings.
- Before the pilot, the last 12 months of transactions are replayed through these rules in the sandbox and the count, timing and wording of every alert is reviewed with both spouses.

Safe-to-spend uses the same forecast: cash in checking and savings, minus FUND\_GOAL set-asides from BC, minus bills and minimums due before the next Henry's Fork payday, minus giving due on income already received, minus the liquidity floor once set. CTJ draws count only when they arrive, until I-07 says otherwise.

## Monthly running cost

About $30–55 a month for the family at list prices, almost all of it the database, the Apple fee and model usage; the pilot month will replace these with real invoices.

| Item | Basis | Est. per month |
| --- | --- | --- |
| PostgreSQL Flexible Server B1ms, 32 GB, 7-day PITR | About $12 compute (East US list) plus storage and backup | $15–22 |
| Claude on Foundry | Receipt line mapping (\~150 receipts) and Ask Homestead (\~200 questions), Haiku-class model by default | $2–10 |
| Apple Developer Program | $99 a year, organization account | \~$8 |
| Container Apps (API, jobs) | Consumption plan; family-scale load mostly inside the free grant | $0–5 |
| Application Insights | Scrubbed logs, 30-day retention | $0–5 |
| Service Bus Standard | Base charge, light use | \~$10 |
| Key Vault, Blob Storage, Document Intelligence | Light use; receipts inside the 500 free pages | $1–3 |
| Plaid Trial, Entra External ID, Business Central | Free tier, free under 50,000 users, no new BC license | $0 |

Two levers if cost matters: Service Bus Basic ($0.05 per million operations) drops the $10 base charge at the cost of topics, which the outbox relay can live without; and stopping the dev database when idle (Flexible Server stop/start) keeps dev near $0. A paid Plaid plan is the one cost that is unknowable until a client release needs Production access.

## Backup, restore, disaster recovery and re-authorization

BC remains the system of record, so a total loss of the app's database costs at most the unposted work in flight, and every piece of it can be rebuilt from BC, Plaid and the receipt blobs.

| What | Protection | Restore |
| --- | --- | --- |
| Postgres | Automated backups, 35-day point-in-time restore, geo-redundant backup storage | Restore to a new server, repoint the API, replay the outbox |
| Receipt and stub blobs | Versioning, 30-day soft delete, geo-redundant storage, the household's key in Key Vault with soft delete and purge protection | Blob undelete or version restore; the key never leaves Key Vault |
| Key Vault | Soft delete (90 days) and purge protection | Recover deleted secrets or certificates in place |
| Configuration | Infrastructure as code in the repo; settings versioned in the database | Redeploy from `main`; settings come back with the database |
| BC drafts and postings | BC's own backups; the app's `bc_*` columns are a mirror | Re-read from BC by External Document No. |
| Plaid | Items persist at Plaid; tokens in Key Vault | Re-sync from cursor; a lost token means one re-link by the login's owner |

Procedures, each tested before the pilot and then twice a year:

1. **Database restore drill:** restore yesterday's point in time to a fresh server, run the nightly BC poll against it, confirm zero unexplained differences.
2. **Blob restore drill:** delete and undelete one receipt; confirm the hash and the transaction link survive.
3. **BC re-authorization:** rotate the app certificate, confirm the API writes to the sandbox, confirm the production registration is untouched.
4. **Plaid re-link:** force `ITEM_LOGIN_REQUIRED` in Sandbox, confirm the calm re-link card reaches only the login's owner and that alerts depending on that account pause.
5. **Webhook loss:** delete the BC subscription, post a batch in BC, confirm the nightly poll finds it and the renewal job recreates the subscription.
6. **Outage mode:** with the API down, capture two receipts on the phone, confirm they queue, show "not synced yet", and upload once without duplicates when the API returns.
7. **Full export:** run the household export and open every file; this doubles as the proof that nobody is trapped in the app.

Recovery targets for the family: data loss of at most 15 minutes (outbox replay), service back within 4 hours; a longer outage degrades to statement import and BC's own client, which keep working without the app.

## Test strategy

Every Gate 4 acceptance test maps to an automated test against the BC sandbox and Plaid Sandbox, run on every pull request, plus three resilience tests and the alert replay. Results are read back from BC, never inferred.

| # | Acceptance test (from the brief) | How it is proved |
| --- | --- | --- |
| A1 | A receipt from Vanessa's phone matches its bank transaction, posts as a draft with the right account and dimensions, the entry ID comes back, it shows Reconciled after bank rec, no duplicates after forced retries | Sandbox: upload a Broulim's receipt, inject the matching Plaid Sandbox transaction, approve, assert the HHAPP/RECEIPTS line has 603101 and the five dimensions; post in BC; assert `bc_entry_nos` populated by webhook and by poll; run bank rec in BC; assert Reconciled via `hhBankLedgerEntries`. Then resend the outbox message 3 times and kill the worker mid-request once; assert one document |
| A2 | A transfer, a card payment and a loan payment never show as spending | Inject all three; assert kinds `transfer`, `transfer`, `bc_native`; assert HH-SPEND and the app's budget totals exclude them; assert 115101 and 115201 net to zero |
| A3 | A Walmart receipt splits by line into the right categories | Five Walmart receipt images, each with known line items; assert splits, tax proration to the cent, and the one-tap confirmation card |
| A4 | A CTJ-paid personal bill lands in 404102 | Mark a Capital One payment as paid by CTJ; assert Cr 404102 and the natural debit; and the reverse case: a household-card charge marked business posts Dr 112101 |
| A5 | Offline capture syncs cleanly | Device test with the network cut: capture two receipts, restore the network, assert one upload each and the same hashes |
| A6 | A webhook outage is caught by the polling reconciliation | Delete the subscription, post a batch in BC, assert the nightly poll moves the lines to Posted and recreates the subscription |
| A7 | Safe-to-spend excludes restricted funds and covers bills due before the next paycheck | Fixtures with FUND\_GOAL balances and a bill calendar; property-based test over random bill dates and paydays |
| A8 | A budget change needs the other spouse's approval and writes a versioned revision | Vanessa proposes, Cade approves with step-up; assert `budget_revisions` row and the `hhBudgetEntries` write with revision number; assert an ORIG budget name is refused |
| A9 | Everything shown in the app ties to BC with the data-through date displayed | Snapshot test: every number on Home, Budget and Goals traces to a function result that carries a `data_through`; nightly poll differences are zero on the test household |

Resilience and quality tests beyond the gate list:

- **Forced-failure batch:** one invalid line in a three-line split must leave zero lines in BC.
- **Duplicate import:** import the same CSV twice and the overlapping OFX; assert Possible Duplicate rows and no second key.
- **Rule drift:** a $600 charge at a rule's merchant must be asked, not filed.
- **Alert replay:** the last 12 months of real transactions through the alert rules; report count by level and month for both spouses to review.
- **Security:** a signed-in member of household A cannot read a row of household B (RLS test); logs contain no masks, amounts or tokens (scrubber test); secrets scan in CI.
- **Device:** Expo end-to-end on an iPhone simulator for V1–V10, plus the three-tap receipt timing.

Tooling: Vitest for units, Testcontainers Postgres for integration, Playwright for the Console, Maestro for the phone app, GitHub Actions on every pull request, and a nightly job that runs A1–A9 against the sandbox and posts the result to the Console's health page.

## Implementation backlog (Phase 4 MVP)

Seven epics in build order; each story is small enough to finish and prove in a day or two, and the gate items are marked. Work starts after Gate 3 and after Vanessa's Gate 2 verdict shapes the Home screen.

| Epic | Stories, in order | Gate item |
| --- | --- | --- |
| E1 Foundation | Monorepo scaffold, CI, infra for dev (Postgres, Key Vault, Container Apps, Service Bus, Blob); schema and RLS; audit log; household and member seed; Entra External ID tenant, custom domain, passkey registration screen; Face ID unlock in Expo | Security tests |
| E2 BC adapter | Entra app registration and HH-APP permission set in the sandbox; `ledger-bc` package: accounts, dimensions, bank cards, journal lines with full dimension sets, `$batch` splits, post action, G/L entry read-back; HH App Connector extension (`hhJournalLineCheck`, `hhBankLedgerEntries`, `hhBudgetEntries`); webhook receiver, renewal job, nightly poll; HHAPP/AUTOPOST batch | A1, A6, A8 |
| E3 Bank data | Plaid Link in the app, token vaulting, sync job with cursor, balances, re-link handling; file import with parser profiles (Beehive, America First, Capital One, Synchrony PDF); duplicate detection; transfer and card-payment pairing; BC-native payment matching | A2, duplicate import |
| E4 Classification | Categories mapped to the chart; rule register with versions and drift guard; confidence tiers; Needs-your-answer queue API; business flag; outbox relay and BC worker; state machine with transition tests | A4, rule drift |
| E5 Receipts and paychecks | Camera and offline queue; upload with hash; Document Intelligence receipt and pay stub models; Claude line mapping on Foundry; split and tax proration; matching; employer templates; paycheck documents; Amazon email intake | A3, A5 |
| E6 Household Home | Home with safe-to-spend and forecast; Activity and item detail; This is wrong; Budget read from BC (sample label until approved); Move money and approvals with step-up; Goals from FUND\_GOAL; Bills calendar; Ask Homestead over the read-only functions; notifications and quiet hours | A7, A9 |
| E7 Console (MVP six) | Work queues; BC sync and posting status with Post batch; reconciliation status; mappings; authority matrix (read-only); connection health, logs and audit | A9 |

After the gate: alert replay and tuning, auto-post rules R1–R7 in the sandbox for Cade's written approval, the one-month parallel pilot (Phase 5), then the six later Console functions as the budget and debt chats deliver their outputs.

Definition of done for every story: tests green in CI, no secret in code, the Console shows the new state, and the records in `records/app/` are updated.

## Proposed Business Central changes

Four changes were approved at Gate 1; this spec adds two. None is made yet; each goes into the sandbox through the runbook with its own test step and into production only with the production package.

| # | Change | Status | Needed by |
| --- | --- | --- | --- |
| 1 | Entra app registration for the sandbox with permission set HH-APP (no posting until auto-post is approved; then posting scoped to HHAPP/AUTOPOST) | Approved at Gate 1 | E2 |
| 2 | HH App Connector AL extension: `hhBankLedgerEntries`, `hhBudgetEntries` (non-ORIG budgets only), plus `hhJournalLineCheck` added by this spec | Approved at Gate 1; the third page is new | E2 |
| 3 | Journal batch HHAPP/AUTOPOST; Text-to-Account Mapping unused on the app path | Approved at Gate 1 | E2 |
| 4 | Change Log on Gen. Journal Line for the HHAPP template | Approved at Gate 1 (optional) | E4 |
| 5 | **New:** bonus compensation accounts 401102 "Bonus Compensation - Henry's Fork Homes (Cade)" and 401202 "Bonus Compensation - Cade T. Jones CPA, P.C. (Cade)", Posting, Income, FAMILY\_AREA CADE, TAX\_TREATMENT TAXABLE, inside the 401000–401999 total; HH-IS and HH-GIVE row definitions widened to include them | Approved October 20, 2026 | E5 |
| 6 | **New:** a source code HHAUTO and reason code AUTOPOST for rule-posted entries, so auto-posted documents are distinguishable from Cade's in every report and in the Change Log | Approved October 20, 2026 | Auto-post go-live |

Change 5 keeps the W-2 tie-out intact: box 1 equals 401101 plus 401102 plus pre-tax deferrals. Change 6 costs nothing today and makes the first auto-post audit trivial.

## Decisions on the open questions

Cade answered all five on October 20, 2026; nothing in this spec is waiting on a question.

| # | Question | Decision | What it changes |
| --- | --- | --- | --- |
| 1 | Azure subscription | The firm has none today; a new pay-as-you-go subscription will be created under Cade T. Jones CPA, P.C.'s Microsoft tenant (the one that hosts Business Central) with a $100 monthly budget alert | Cade creates it (it needs the firm's payment method); dev resources deploy only after that |
| 2 | Custom sign-in domain | `cadejonescpa.com`; sign-in at `homestead.cadejonescpa.com` | One DNS record Cade controls; passkeys bind to this domain, so it is set before the first passkey is registered |
| 3 | Pay stubs | PDFs from Paychex (Henry's Fork Homes) and Gusto (Cade T. Jones CPA, P.C.) | The paycheck pipeline is PDF-first: forward or upload the PDF; photo capture is the backup |
| 4 | Auto-post rules R1–R7 | Approved as proposed: R2, R3 and R7 (transfers, card payments, BC-native recurring) go live first once the sandbox test passes; R1, R4, R5 and R6 after one clean month | The written approval is recorded with the rule versions; posting rights for HHAPP/AUTOPOST are added when the first three go live |
| 5 | BC changes 5 and 6 | Approved as proposed: bonus accounts 401102 and 401202; source code HHAUTO and reason code AUTOPOST | Added to the runbook with the other four; made in the sandbox in epic E2 |

## Sources

Pages opened on October 19–20, 2026, plus the project records (BC Setup Design, Account and Dimension Dictionaries, Test Results, Position Review, the approved Phase 1 spec).

- [Microsoft: Business Central webhooks and subscriptions (supported entities, 3-day expiry, retry codes)](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-subscriptions)
- [Microsoft: journal resource and its post action](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/resources/dynamics_journal)
- [Microsoft: Analytics API overview (read-only; generalLedgerBudget, generalLedgerBudgetEntry)](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-analytics/api-analytics-overview)
- [Microsoft: deprecated features in Business Central (finance reports API)](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/upgrade/deprecated-features-w1)
- [Microsoft: Document Intelligence pay stub model (prebuilt-payStub.us, v4.0 GA)](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/pay-stub)
- [Microsoft: passkeys in Entra External ID](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-sign-in-with-passkey)
- [Microsoft: Entra External ID pricing](https://azure.microsoft.com/en-us/pricing/details/microsoft-entra-external-id)
- [Microsoft: data privacy for Claude models in Foundry](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/claude-models/data-privacy)
- [Anthropic: Claude in Microsoft Foundry (hosting options, US Data Zone)](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry.md)
- [Plaid: pricing plans and the Trial plan](https://support.plaid.com/hc/en-us/articles/16110502116887-What-are-Plaid-s-prices-and-pricing-plans-and-how-do-they-differ)
- [Plaid: Synchrony Bank institution page](https://plaid.com/institutions/synchrony-bank/)
- [SimpleFIN Bridge pricing and limits](https://beta-bridge.simplefin.org/)
- [Bytebase: Azure PostgreSQL B1ms monthly prices](https://www.bytebase.com/dbcost/azure-flexible/instance/B1ms/)
- [Document Intelligence list rates (third-party summary)](https://ud.hk/en/blogs/insight/article/ai-document-processing-costs-2026-08-11)
- [Apple: App Store Review Guidelines, 5.1.1(ix)](https://developer.apple.com/app-store/review/guidelines/)
