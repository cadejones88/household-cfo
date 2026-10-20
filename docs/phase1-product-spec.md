# Homestead — Phase 1 Product Spec and Decisions

Snapshot of the live Claude Doc as of Oct 19, 2026 (https://claude.ai/code/artifact/26655575-3c74-4c8c-849e-44fbe866d4ea). Status: **approved at Gate 1 by Cade on Oct 19, 2026, with the amendments below.** The live doc wins if they differ.

## Gate 1 outcome

Approved by Cade on October 19, 2026, with these amendments. Where they differ from the sections below, the amendments win.

| Topic | Decision |
| --- | --- |
| Name | The system is **Homestead** (Cade declined "Homestead" on 10/19). Vanessa's app is Homestead; Cade's desktop view is Homestead Console; the assistant in the app is "Ask Homestead." The Czar stays the agent's name in the project records |
| Auto-posting | Hybrid: some transactions may post to BC automatically. Phase 3 drafts the first rule set and thresholds; each rule is tested and approved in writing before it is switched on |
| Paychecks | Every paycheck is broken into its components in BC: regular pay, bonus, Social Security, Medicare, federal and Idaho withholding, benefits and other deductions, net to the bank. Phase 3 designs pay-stub capture and an employer template |
| Business vs personal | Everything through the household accounts is personal unless Cade says otherwise. No prompt by default; "Mark as business" on the item; Venmo inflows suggested as lash income |
| Ownership | Cade T. Jones CPA, P.C. owns the Azure subscription, Entra external tenant, Plaid team and Apple developer account |
| Repo | github.com/cadejones88/household-cfo (private) |
| Vanessa's phone | iPhone. The family keeps passkeys in LastPass and LastPass Authenticator; Face ID unlocks the app day to day |
| Everything else | All seven recommendations and the four proposed BC changes are approved |

## Summary

Build one phone app for both of you with Expo (React Native), a web CFO Console for Cade, and an Azure backend that is the only thing that ever talks to Business Central. Plaid supplies read-only bank data. Nothing in the design moves money, and nothing posts to BC without a human approval or an approved auto-post rule.

| Decision | Recommendation | Est. monthly cost |
| --- | --- | --- |
| App platform | Expo for iPhone and Android; CFO Console as a web app on the same API | ~$8 (Apple developer fee, annualized) |
| Backend and hosting | Azure: container API and scheduled jobs, PostgreSQL, Blob Storage, Key Vault, Entra | ~$16–32 |
| Bank aggregation | Plaid on its free Trial plan (10 logins; you need 8), plus CSV/OFX import | $0 to start |
| Receipts | Azure Document Intelligence reads the receipt; Claude maps lines to your categories | ~$0–5 |
| Ask Homestead | Claude through Microsoft Foundry, limited to read-only questions over BC-backed data | ~$2–10 |
| Business vs personal | Personal by default; "Mark as business" is the exception path | — |
| Alerts | Forecast-based, one alert per problem, quiet hours 9 pm–7 am | — |
| Multi-family | Household ID on every record and setting; the ledger sits behind an adapter | — |

All in, about $26–52 a month for the family, before any paid Plaid plan.

## What I read

I read every document named in the brief, and the app is designed to the BC setup exactly as tested on 10/19. Nothing in BC or the project was changed.

- **Project instructions:** Phase 3 integration, Phase 4 app and receipt workflow, H security, I data quality.
- **records/bc-setup/:** Setup Design (all 13 areas), README, Account Dictionary (270 accounts, 177 posting), Dimension Dictionary (5 dimensions, 45 values), Test Results (T01–T12 pass).
- **records/position-review-2026-09-30/:** the review, its README and the Account Inventory (23 accounts, open and closed).
- **phase1/ Constitution framework:** I-09, I-10, I-14 and I-22 are still proposals, so the app treats their thresholds as settings, not code.

Facts the design is built on:

- The app writes only to the HHAPP journal template (RECEIPTS, FEEDS) with source code HHAPP, using the External Document No. key `HHAPP-<source>-<yyyymmdd>-<hash8>`.
- Test finding 1 holds: API lines carry only the two global dimensions unless told otherwise, so the app sends the full dimension set on every line.
- Cards, Venmo and CareCredit are bank account cards; loans and the mortgage are G/L liabilities split by recurring journals. Walmart, clubs and Amazon post to the three unallocated accounts unless a receipt splits them.
- Vanessa has no BC license. The app reaches BC only through a server-side Entra app.

Three things found that change the plan:

1. The finance reports API (which holds `generalBudgetEntries`) is marked obsolete in 2026 release wave 2 and removed in 2027 release wave 1. The app reads budgets from the Analytics API instead; writing budget revisions needs a small AL extension (section "Proposed BC changes").
2. The BC design planned webhooks on `journalLines`. Microsoft's webhook list includes journals and G/L entries but not journal lines, so the app subscribes to G/L entries and polls draft lines. Any webhook reply other than success, 408, 429 or 5xx deletes the subscription, so the receiver is built to answer exactly that way.
3. The acceptance test says a CTJ-paid bill lands in "the CTJ clearing account," but BC design §4 posts those to 404102 (business-paid distributions) on purpose. Resolved at Gate 1: CTJ-paid personal items post Cr 404102; the rare business charge on a household card, when Cade marks it, posts Dr 112101.

## Who it's for and the design rules

The phone app is built for Vanessa; the accounting depth lives in BC and in Cade's Homestead Console. Both sign in separately, see the same household, and have the same approval rights.

| | Vanessa (Homestead) | Cade (Homestead Console) |
| --- | --- | --- |
| Device | Phone first; works in a browser | Desktop browser first |
| Wants | Fast, calm, plain words, few questions | Control, traceability, drill-down to BC |
| Sees | Safe-to-spend, bills, budget status, goals, activity | Queues, sync status, reconciliations, rules, mappings, logs |
| Vocabulary | Recorded · In the books · Matched to the bank | Imported … Posted · Reconciled, with BC entry numbers |

Rules every screen follows:

- **Three taps or fewer** for routine tasks; receipt capture is measured from the home screen.
- **One answer first, details on tap.** Every number opens to its parts and its data-through date.
- **Calm status:** On track, Watch, Action needed. Dollars and dates, never a wall of red.
- **Ask only what needs a person.** At most three questions show at once; each says why it's asked.
- **No guilt mechanics:** no streaks, scores, badges or comparisons with other households.
- **Equal by design:** neither spouse is labeled admin; approvals go to "the other spouse," never to a fixed person.
- **Accessibility:** Dynamic Type, screen-reader labels, 44-point tap targets, contrast that passes WCAG AA.
- **BC wins:** if the app and BC disagree, the app shows BC's value and flags the difference.

## User journeys

Vanessa's ten journeys are the Phase 2 prototype script; Cade's eight define the first Homestead Console release. Either spouse can do every Household Home journey.

### Vanessa (Homestead)

| # | Journey | What she does | What happens behind it |
| --- | --- | --- | --- |
| V1 | Snap a receipt | Home → **Snap receipt** → shutter (or auto-capture) → **Done** on the pre-filled card. Three taps. | Image encrypted on the phone, uploaded, hashed for duplicates, read, matched to its bank transaction once that posts. Offline: "Saved on your phone — not synced yet." |
| V2 | What can we spend? | Opens the app. Sees "$412 safe to spend until Fri, Oct 24." Taps for the parts. | Spendable cash minus bills due before payday, set-aside funds and the floor. Each part shows its data-through date. |
| V3 | Answer a question | From a notification or the queue: "Walmart $142.37 — split from your receipt. Look right?" **Yes** or **Change**. "Venmo +$85 from Kayla — lash appointment?" **Yes** or **Something else**. | Her answer approves the classification and the BC draft line is created right away (or posts, under an approved auto-post rule). |
| V4 | This is wrong | Activity → the item → **This is wrong** → picks from five suggestions or searches. Optional "Do this every time for Maverik?" | Before posting: fixed at once. After posting: a correction request to the CFO queue, shown as "Fix pending." "Every time" becomes a rule proposal, not a rule. |
| V5 | Check goals | Goals tab: emergency fund bar and next debt payoff. | Targets show only once approved in the budget chat; until then "Target not set yet." |
| V6 | Ask Homestead | "How much have we spent eating out this month?" | Plain answer with "Data through Oct 18 · 2 items pending." |
| V7 | Propose a budget change | Budget → category → **Move money** → amount and source. Sees the effect, sends. | Goes to Cade for one-tap approval (I-09). On approval a versioned revision is written to BC and both are told. |
| V8 | Approve Cade's change | Notification → sees the effect → **Approve** with Face ID, or **Not now**. | Same flow in reverse; the step-up check proves it was her. |
| V9 | Lash income and supplies | A Venmo payment shows "Lash appointment?" **Yes**. Supply purchases get **Mark as business → Lash**. | Posts to 402101 and the 731xxx lash accounts, tagged VANESSA and DED-BUS. |
| V10 | First run | Opens an invite link, creates her sign-in, adds Face ID, links the logins she owns (Beehive, Venmo). | Plaid handles the bank sign-in; the app never sees or stores her bank password. |

### Cade (Homestead Console)

| # | Journey | What he does | What happens behind it |
| --- | --- | --- | --- |
| C1 | Work the queue | Clears exceptions, low-confidence items, unmatched receipts and possible duplicates; bulk-approves by keyboard. | Each approval writes an audit record and, where ready, a BC draft line. |
| C2 | Drafts to posted | Reviews HHAPP/FEEDS and HHAPP/RECEIPTS in BC and posts them (in BC, or with **Post batch** in the Console). Approved auto-post rules post HHAPP/AUTOPOST without him. | The poll or webhook finds G/L entries by External Document No.; the app stores entry numbers and shows Posted. |
| C3 | Reconcile | Runs the bank reconciliation in BC as today. | The app reads bank ledger entry status and marks lines Reconciled; differences go to the queue. |
| C4 | Manage rules | Approves proposed rules: merchant, account, amount band, who, effective date, and whether the rule may auto-post. | Rules apply only after approval; drift flags show when a rule meets an unusual amount. |
| C5 | CTJ items | Reviews the month's items marked business and CTJ-paid personal items with receipts; exports them. | Supports the year-end CTJ settlement (§4 of the BC design). |
| C6 | Sync health | Checks webhook subscriptions, last poll, mismatches, failed jobs, Plaid logins that need re-linking. | Nothing is retried in a way that can duplicate a line. |
| C7 | Budget | Reads the approved budget from BC, the revision log, and Vanessa's requests. | Until an approved budget exists, every budget screen says "Sample budget (BUD26-ORIG test data)." |
| C8 | Close support | Checks clearing accounts 115101/115201 at zero, suspense at zero, unallocated accounts cleared, receipts matched. | Read-outs link to the BC report rows they come from. |

## Screen list

The MVP is 14 phone screens and 6 of the 12 CFO Console functions; the other 6 follow once the budget and debt chats have approved outputs to show.

### Homestead (phone, also in a browser)

| Screen | What it shows or does | Release |
| --- | --- | --- |
| H1 Home | Safe-to-spend until next payday with its status, bills before payday, one plain forecast sentence, questions waiting, goals peek, "as of" stamp | MVP |
| H2 Camera | Edge-detected capture, auto-shutter, flash; works offline | MVP |
| H3 Receipt card | Merchant, amount, date pre-filled; **Done** | MVP |
| H4 Needs your answer | Up to three cards, one tap each, each with "why we're asking" | MVP |
| H5 Activity | Search and simple filters (who, account, category); receipt and status icons in plain words | MVP |
| H6 Item detail | Receipt image, split lines, paycheck breakdown, status, **This is wrong**, **Mark as business** | MVP |
| H7 Category picker | Five suggestions plus search, in household words ("Groceries," not 603101) | MVP |
| H8 Budget | Groups in plain names with dollars left and On track / Watch / Action needed | MVP |
| H9 Move money | Propose a budget change and see its effect before sending | MVP |
| H10 Approvals | Requests from the other spouse, with effect and Face ID approve | MVP |
| H11 Goals | Emergency fund and next debt payoff, progress and next milestone | MVP |
| H12 Ask Homestead | Question box, answers with data-through date and status | MVP |
| H13 Bills | Calendar of bills and minimums until the next two paydays | MVP |
| H14 Settings | Face ID, notifications and quiet hours, linked logins (status only), export my data, sign out | MVP |
| H15 Kids' view | Goals and progress only, no balances (I-22, pending approval) | Later |

An "Uploading 3 receipts" bar sits above every screen while anything is waiting to sync.

### Homestead Console (desktop browser)

| Function (Phase 4 list) | Screen | Release |
| --- | --- | --- |
| 1 Work queues | Transactions, receipts, rule proposals, exceptions, possible duplicates | MVP |
| 2 BC sync and posting | Every line's state, BC document and entry numbers, last sync, retry log | MVP |
| 3 Reconciliation status | Per account: last statement, reconciled through, open differences | MVP |
| 4 Account and dimension mappings | Household category → G/L account + five dimensions; versioned | MVP |
| 11 Authority matrix | Thresholds, who approves what, and which rules may auto-post | MVP |
| 12 Connection health and audit | Plaid logins, webhooks, poll results, failed jobs, append-only audit history | MVP |
| 5 Budget builder and scenarios | Reads BC budgets; scenarios once the budget chat delivers v1 | Later |
| 6 13-week and month-end forecast | Cash forecast by week, assumptions shown | Later |
| 7 Debt payoff model | Waterfall and schedules from the debt chat's approved plan | Later |
| 8 Net worth and ASC 274 workbench | Links to the PFS workpapers (they stay outside BC per design §11) | Later |
| 9 Close checklist | Month-end and quarter-end checklists with sign-off | Later |
| 10 Reports and lineage | Any number → report line → BC entry → bank line → receipt | Later |

## How a transaction flows

Every bank line, receipt and imported file row follows one path into BC, keyed so that a retry can never create a second line.

Main path: Imported (feed, receipt or file) → Needs an answer (rule or one tap) → **Approved** (by a person or rule) → Sent to BC (retried safely) → BC draft line (line ID returned) → Posted (Cade posts in BC, or an approved auto-post rule posts) → Reconciled (bank rec in BC). Side paths: Imported → Possible duplicate (held for a person); Posted → Reversed (fixed by a new entry); BC draft line → Exception (BC wins; flagged).

Approval is the gate: until a person or an approved rule says yes, nothing is written to BC.

- **Only settled bank lines go to BC.** Pending card charges show in the app but stay out of BC, because their IDs change when they settle.
- **One key per source.** The Plaid transaction ID, an OFX FITID, the receipt's ID, or a hash of account, date, amount and description for CSV rows. BC's External Document No. carries `HHAPP-<source>-<yyyymmdd>-<hash8>`, and the app checks BC for the key before any write.
- **Splits are all or nothing.** A receipt's split lines go to BC in one batch request; Phase 3 confirms in the sandbox that a failed batch leaves no partial lines.
- **Drafts at once, posting by approval or rule.** Approval writes the draft line immediately through an outbox and queue. Lines that match an approved auto-post rule go to HHAPP/AUTOPOST and a job posts them; everything else waits for Cade.
- **Matching.** Receipts match bank lines on amount, a date window, merchant similarity and account. Two plausible matches are never merged automatically.
- **Confidence.** High confidence auto-categorizes only under an approved rule and inside its amount band, so a $600 charge at a usual grocery merchant is asked, not filed. Medium asks for one tap; low goes to review.
- **BC wins.** A nightly poll compares the app with BC by batch, date, count, sum and key. A draft edited or deleted in BC shows that change in the app; a BC entry with an unknown HHAPP key becomes an exception.
- **Paychecks.** A net-pay deposit is matched to its pay stub (photo or PDF) or to the employer's template, and posts as one document: gross pay and bonus as income, Social Security, Medicare, federal and Idaho withholding and benefits as their own lines, net to the bank.
- **Plain status words for Vanessa:** Needs a quick answer · Recorded · In the books · Matched to the bank · Being checked.

### Safe to spend

Safe to spend until the next paycheck = cash in checking and savings, minus money set aside (emergency and sinking funds, from FUND_GOAL balances in BC), minus bills and minimums due before payday, minus giving due on income already received, minus the liquidity floor once it is set.

- "Next paycheck" is the next Henry's Fork payday; CTJ draws count only once they arrive, until I-07 says otherwise.
- A negative result reads "Short $180 before Fri, Oct 24 — Action needed," with one suggested step, never a bare red number.

## Decisions and recommendations (all approved at Gate 1)

### D1 · App platform: Expo (React Native)

One Expo codebase for iPhone and Android, which also runs in a browser, plus a separate React web app for Homestead Console. Both share a TypeScript package for categories, states and money math.

| Need | Expo app | Progressive web app |
| --- | --- | --- |
| Receipt camera | Native capture with edge detection and auto-shutter | Browser camera; no native document scanner |
| Offline capture | On-device database and file queue; uploads retry in the background | Browser storage; Safari has no background sync, so uploads wait until she reopens the app |
| Notifications | Native and actionable (answer from the lock screen) | iPhone only after "Add to Home Screen"; fewer actions |
| Face ID and passkeys | Face ID unlock; native passkeys need a development build, not Expo Go | Passkeys through Safari |
| Distribution | TestFlight for the family; App Store later | A link |
| Cost | Apple $99 a year; Google Play $25 once, only if needed | None |

For a public release, Apple's guideline 5.1.1(ix) expects financial-services apps to come from an organization account; the accounts are under Cade T. Jones CPA, P.C.

### D2 · Backend and hosting: Azure

Azure, because BC, Entra, Claude (Foundry) and Document Intelligence then share one identity model, one network boundary and one bill.

| Part | Choice | Why |
| --- | --- | --- |
| API | TypeScript service on Azure Container Apps (consumption) | Same language as the app; scales to zero |
| Job runner | Container Apps jobs on schedules | Plaid sync, daily webhook renewal, nightly BC poll, alerts, OCR, auto-post |
| Queue | Azure Service Bus with a dead-letter queue, fed by an outbox table | A crash never loses or doubles a BC write |
| Staging database | Azure Database for PostgreSQL Flexible Server, Burstable B1ms | About $12 a month compute (East US list); row-level security by household |
| Receipt storage | Private Blob container, customer-managed key in Key Vault, versioning and soft delete | Encrypted evidence that can't be silently replaced |
| Secrets | Key Vault and managed identities; certificate credential for the BC app | No secrets in code, phones, logs or prompts |
| Sign-in | Entra External ID (an external tenant, not the firm's workforce tenant) | Free for the first 50,000 monthly users. Passkeys work through the system browser after an email-and-password sign-up with MFA, and need a custom domain plus a registration screen we build. LastPass can hold the passkey on iOS; Face ID unlocks the app day to day |
| Monitoring | Application Insights with a scrubbing filter | Errors without account numbers, tokens or images |

Supabase would be faster to start and cheaper, but puts sign-in and data with a second vendor outside Azure. If the prototype shows External ID's browser-based passkey step is clumsy for Vanessa, Clerk, which has a native Expo passkey package, is the fallback at the cost of another vendor.

### D3 · Bank aggregation: Plaid Trial, with file import as the fallback

Plaid's Trial plan gives new US teams real production data free for up to 10 logins (Items) and includes Transactions, Balance, Liabilities and Statements. The family needs 8. The Trial is closed to teams that have applied for Production, so don't apply until a client release needs more than 10 logins.

| Institution | Login owner | Plaid coverage | Fallback |
| --- | --- | --- | --- |
| Beehive FCU | Vanessa (primary) | Listed as supported | CSV/OFX download |
| America First CU | Cade | Listed as supported | CSV/OFX download |
| Mountain America CU | Cade | Listed as supported | CSV/OFX (both accounts dormant) |
| Capital One | Cade (Vanessa authorized user) | Listed as supported | CSV download |
| CareCredit (Synchrony) | To confirm | Listed; another app's users report failures since Synchrony's login change | Statement PDF upload |
| Venmo | Vanessa | Listed as supported | CSV export |
| Frontier CU (two auto loans) | Cade | Not confirmed; several credit unions share the name | Monthly statement, one payment per loan |
| PennyMac | Joint | Not confirmed | Monthly statement, one payment |

"Listed" means public coverage trackers or Plaid's own institution page. Phase 3 confirms each with Plaid's institution search, which needs no real login.

- **BC's own bank feeds** (the Envestnet Yodlee extension, third-party AL connectors) import straight into BC. Not used: a second path into BC skips receipts, rules and approvals and invites double entries.
- **SimpleFIN Bridge** ($15 a year, up to 25 institutions, one refresh a day) is a spare for a credit union Plaid misses, not a base for a client product.
- **MX and Finicity** reach more credit unions but sell through company-sized contracts.
- **File import:** CSV, OFX/QFX and statement PDFs enter the same staging table, states and duplicate checks as Plaid data.
- **Pending transactions** show in the app but never go to BC.

### D4 · Receipts and Ask Homestead

Azure Document Intelligence's receipt model reads merchant, date, total, tax and line items; Claude maps each line to household categories. Document Intelligence lists $10 per 1,000 pages with 500 free pages a month.

- **Split rules:** tax is spread across lines in proportion; the lines must equal the bank amount to the cent or the split goes to review.
- **Walmart:** 316 transactions last year. Receipts are requested only on Walmart and club trips of $25 or more; smaller ones take the default split.
- **Amazon:** no paper receipt and one charge per shipment. Order emails are forwarded to a private household receipts address; Amazon's "Request your data" order history is the monthly catch-up.
- **No receipt after 10 days:** the line posts to 603201, 603401 or 603801 and the monthly 60/25/15 allocation clears it. The app labels it "estimated split."

Ask Homestead runs on Claude through Microsoft Foundry's Azure-hosted option. In a US Data Zone deployment, prompts and answers stay within Azure and inference stays in the United States; only usage metadata and content flagged by safety systems go to Anthropic, which acts as an independent processor.

- Read-only functions only: balances, budget status, transactions, safe-to-spend, goals, bills. Each returns its data-through date and status.
- No write tools. "Move $50 to groceries" becomes a draft that goes through the normal approval (V7).
- It never receives account numbers, receipt images or Plaid tokens. The household filter is enforced in code, not in the prompt.
- Numbers come only from function results, and every answer card opens to the rows behind it.

### D5 · Business vs personal (amended at Gate 1)

Everything through the household accounts is personal by default. No prompt is shown. Either spouse can **Mark as business** on an item (CTJ or Lash); Venmo inflows are suggested as lash income with one tap.

| Case | Posting | Tags |
| --- | --- | --- |
| Personal (default) | Natural expense account, through the paying card | Account defaults |
| Marked CTJ business, on a household card | Dr 112101 Due from (to) CTJ, Cr the card, so household spending never includes it | DED-BUS |
| Marked Lash business | 731101–731301, through the paying account | VANESSA, DED-BUS |
| Paid by CTJ for the household | Dr the natural account or liability, Cr 404102 | Per BC design §4 |

CTJ-paid items appear in household data only on their far side: a Capital One or Frontier payment with no matching household outflow is suggested as "Paid by CTJ." CTJ-paid tithing and life premiums leave no household trace, so they come in as a monthly list in the Console.

### D6 · Alerts that stay useful

Alerts are driven by the cash forecast, not by balances crossing a line. Cash ran short in 8 of the last 12 months; a balance trigger would fire through each episode, while a forecast fires once, days earlier.

| Level | Trigger | Delivery |
| --- | --- | --- |
| Action needed | An account is forecast below $0, or a bill or minimum can't be covered, within 3 days; a possible duplicate or fraud of $25 or more; a feed down 48 hours with a bill due | Push to both. During quiet hours only for alert types both approve as critical |
| Watch | A category forecast to overrun; safe-to-spend below the floor; a receipt missing after 7 days | In-app badge and one daily digest card, no push |
| Pulse | Weekly summary (section D of the instructions) | One push on council day |

- One alert per problem, repeated only when the facts change; silent while an agreed action is pending.
- No alerts on allowance categories (I-10).
- Default quiet hours 9 pm–7 am Mountain.
- Phase 3 replays the last 12 months through these rules; the target is two or fewer interrupts a month.

### D7 · Multi-family readiness

- A household ID on every record, enforced by PostgreSQL row-level security.
- Each household's BC connection stored as data: tenant, environment, company ID, journal batches, category-to-account-and-dimension map. No account numbers in code.
- The ledger behind an adapter with five operations: create draft lines, read posted entries, read budgets, write a budget revision, read reconciliation status. BC is the first adapter.
- Roles: household member (equal approval rights) and adviser (a CPA reviewer, matching P-UD-09). No "owner" role inside a household.
- Per-household receipt container and key, Plaid logins, rules and feature flags. Rules never learn across families.

| Option for a client release | For | Against |
| --- | --- | --- |
| A. A BC company per family in the firm's tenant, built from the HH-SETUP RapidStart package | Same chart, reports and ASC 274 workflow; the firm runs the books; families need no BC license | The firm hosts client data (engagement terms, security, export on exit); setup and support per company |
| B. An app-native simple ledger for self-serve families | Cheapest to run | A second ledger engine to build and test; no BC reporting |
| C. A for CFO clients now, B later if demand appears | Fits two markets | Most work |

Design for A now; decide on B after the family pilot. A client release also needs a paid Plaid plan with Production review and a written security review.

## Proposed BC changes (approved at Gate 1; to be made in the sandbox in Phase 3)

| # | Change | Why the standard setup isn't enough | Needed by |
| --- | --- | --- | --- |
| 1 | Register the app's Entra identity in the sandbox with a custom permission set HH-APP: read accounts, dimensions, bank accounts, G/L entries and budgets; create and edit lines only in the HHAPP template; **no posting rights** until an auto-post rule is approved, then posting scoped to HHAPP/AUTOPOST | Least privilege | Phase 3 |
| 2 | A small per-tenant AL extension, "HH App Connector," with two API pages: (a) read Bank Account Ledger Entries with open/closed and statement number; (b) write G/L Budget Entries, limited to revision and forecast budget names, never an ORIG budget | API v2.0 has no bank ledger entry endpoint; the Analytics API is read-only and the finance reports API is being removed | Phase 3 |
| 3 | An empty journal batch HHAPP/AUTOPOST for approved auto-post rules; BC's Text-to-Account Mapping is not used on the app path | Posting via the API posts a whole batch; one rule engine | Phase 3 |
| 4 | Optional: Change Log on Gen. Journal Line for the HHAPP template | Lets the app see when a draft is edited in BC | Phase 4 |

Phase 3 may propose one more: a bonus compensation account per employer (e.g., 401102) so paycheck components post to their own lines.

## Running cost estimate

About $26–52 a month for the family, most of it the database and the Apple fee. List-price estimates; Phase 3 replaces them with an Azure calculator quote.

| Item | Basis | Est. per month |
| --- | --- | --- |
| PostgreSQL Flexible Server, B1ms | About $12 compute (East US list) plus storage | $15–20 |
| Claude via Foundry | Ask Homestead and receipt line categorizing, billed by use | $2–10 |
| Apple Developer Program | $99 a year | ~$8 |
| Container Apps (API and jobs) | Family-scale load on the consumption plan | $0–5 |
| Application Insights | Small, scrubbed log volume | $0–5 |
| Key Vault and Service Bus | Light use | $1–2 |
| Document Intelligence | Inside the 500 free pages a month | $0–1 |
| Blob Storage | About 100 receipts a month | under $1 |
| Plaid | Trial plan, 8 of 10 logins | $0 |
| Entra External ID | Two users | $0 |
| Business Central | No new license; the app connects service-to-service | $0 |

## Phases and gates

1 Spec (approved 10/19/2026) → 2 Prototype — gate: Vanessa uses it unaided and likes it → 3 Architecture — gate: Cade approves → 4 MVP build on the BC sandbox and Plaid test data — gate: all nine acceptance tests pass → 5 Live pilot, read-only feeds, one-month parallel run — gate: both approve production in writing.

## Sources

Pages opened on October 19, 2026, plus the project records named above.

- [Plaid: pricing plans and the Trial plan](https://support.plaid.com/hc/en-us/articles/16110502116887-What-are-Plaid-s-prices-and-pricing-plans-and-how-do-they-differ)
- [Plaid: Synchrony Bank institution page](https://plaid.com/institutions/synchrony-bank/)
- [Open Banking Tracker: Beehive FCU on Plaid](https://openbankingtracker.com/plaid/beehive-federal-credit-union) and [CareCredit on Plaid](https://openbankingtracker.com/plaid/carecredit)
- [Simplifi community: CareCredit connection failures after Synchrony's portal change](https://community.simplifimoney.com/discussion/15759/carecredit-account-no-longer-available-to-connect-after-login-portal-migration-fdp-103)
- [SimpleFIN Bridge pricing and limits](https://beta-bridge.simplefin.org/)
- [Microsoft: deprecated features in Business Central (finance reports API)](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/upgrade/deprecated-features-w1)
- [Microsoft: Analytics API overview](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-analytics/api-analytics-overview)
- [Microsoft: Business Central webhooks and subscriptions](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-subscriptions)
- [Microsoft: journal resource and its post action](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/resources/dynamics_journal)
- [Microsoft: passkeys in Entra External ID](https://learn.microsoft.com/en-us/entra/external-id/customers/how-to-sign-in-with-passkey)
- [Microsoft: Entra External ID pricing](https://azure.microsoft.com/en-us/pricing/details/microsoft-entra-external-id)
- [Microsoft: data privacy for Claude models in Foundry](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/claude-models/data-privacy)
- [Anthropic: Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry.md)
- [Document Intelligence list rates (third-party summary)](https://ud.hk/en/blogs/insight/article/ai-document-processing-costs-2026-08-11); Microsoft's own [pricing page](https://azure.microsoft.com/en-us/pricing/details/document-intelligence/) shows the free tier but not the rate
- [Bytebase: Azure PostgreSQL B1ms monthly prices](https://www.bytebase.com/dbcost/azure-flexible/instance/B1ms/)
- [Apple: App Store Review Guidelines, 5.1.1(ix)](https://developer.apple.com/app-store/review/guidelines/)
