# @homestead/ledger-adapter-bc

The ledger adapter interface and its Business Central implementation (epic E2). Everything the app ever says to BC goes through this package: chart, dimensions and bank cards; draft journal lines with the full dimension set written as one `$batch` change set; the post action; G/L entry read-back; bank ledger entries; budget revisions; webhook subscriptions. Money is integer cents at the boundary and two-decimal numbers on the wire; dates are `YYYY-MM-DD`.

## What is in it

| File | What it does |
| --- | --- |
| `src/types.ts` | `LedgerAdapter` — the ledger-agnostic contract (no BC name in it) and its DTOs |
| `src/bcAdapter.ts` | `BusinessCentralAdapter`: API v2.0, the HH App Connector routes, the Analytics API (read-only), subscriptions, `webhookSupportedResources`. Client-side guards: `validateLines` (one External Document No., sums to zero, description cut to 100, comment to 250), `assertWritableBudgetName` (`*-REV*` or `FCST*`, never `*-ORIG`, 10 characters) |
| `src/auth.ts` | `CertificateCredential`: OAuth 2.0 client credentials against Entra ID with a certificate — a JWT client assertion signed RS256 (PS256 by config) with `x5t` and `x5t#S256` headers, scope `https://api.businesscentral.dynamics.com/.default`, token cached until five minutes before expiry, concurrent refreshes coalesced. The PEM comes in by value and is never logged |
| `src/http.ts` | `BcHttp`: bearer, JSON, `@odata.nextLink` paging, one 401 retry with a fresh token, `$batch` (multipart/mixed change set by default, BC's JSON batch by config, `Isolation: snapshot` on both), error classification |
| `src/odata.ts` | OData literals and the `$batch` builders/parsers (OData 4 §11.7 multipart, BC's JSON form) |
| `src/retry.ts` | `nextRetryDelayMs(attempt)`: 1, 2, 4, 8, 16 minutes, then hourly for a day (29 attempts, ~24.5 h), pure; `retryDelayFor` honors a longer `Retry-After` |
| `src/errors.ts` | `BcRetryableError` (408, 429, 5xx, network), `BcNonRetryableError` (everything else, with the BC error code and a scrubbed message), `LedgerAdapterError` (refused before any call) |
| `src/scrub.ts` | `redactString`: tokens, JWTs, amounts, account masks, PEM blocks and correlation IDs out of any message the adapter produces |
| `src/mapping.ts` | `mapTransactionToJournalLines`: app transaction → balanced BC document (bank line as `Bank Account`, transfers through 115101, card payments through 115201, CTJ-paid bills to 404102, household-card business charges to 112101, paychecks by component); `paycheckLinesToSplits` |
| `src/mock/MockBcServer.ts` | The in-process fake of every endpoint above (see "What is faked"); exported for other packages and the acceptance suite |
| `test/` | 62 Vitest tests (see "What the tests prove") |

The AL side of the three connector pages is in `bc/hh-app-connector/`; the by-hand BC changes are in `bc/runbook-additions.md`.

## How to use it

```ts
import { BusinessCentralAdapter, BcHttp, CertificateCredential } from "@homestead/ledger-adapter-bc";
import { externalDocumentNo, idempotencyKey } from "@homestead/shared";

const tokenProvider = new CertificateCredential({ tenantId, clientId, pem /* read from Key Vault by name */ });
const adapter = new BusinessCentralAdapter({
  http: { baseUrl: `https://api.businesscentral.dynamics.com/v2.0/${tenantId}/${environment}`, tokenProvider },
  companyId,
  journalTemplate: "HHAPP",
  connectorInstalled: true, // false until bc/hh-app-connector is published to the environment
});

const doc = mapTransactionToJournalLines(tx);                       // pure, balanced, dimension sets built
const res = await adapter.createJournalLines({ journalCode: "FEEDS", lines: doc.lines });
// res.outcome: "written" | "already_in_journal" | "already_posted" — the last two mean the pre-write check found it
await adapter.postBatch("AUTOPOST");                                // only once the posting right exists (runbook 6b)
const entries = await adapter.readGlEntriesByExternalDocNo(doc.externalDocumentNo); // entry numbers, dims, amounts
```

The worker loop around it (services/jobs) is: catch `BcRetryableError` → sleep `retryDelayFor(err, attempt)` → call again (the adapter reruns the pre-write check itself, so a timeout after a successful write cannot double post); catch `BcNonRetryableError` → dead-letter and raise an Exception with `err.code`; `retryDelayFor` returning `undefined` → give up.

Run: `pnpm --filter @homestead/ledger-adapter-bc test` (or `build`, `typecheck`). No environment variables, no network.

### Wiring to `services/api`'s `LedgerPort`

`services/api/src/services/ledgerPort.ts` codes against a port with the same method names and slightly different shapes; the coordinator writes the shim. The mapping is one-to-one:

| `LedgerPort` | This package |
| --- | --- |
| `findByExternalDocumentNo(doc)` → `{ journalLineIds, batch, glEntryNos, lineCount, sumCents }` | `findByExternalDocumentNo(doc)` (no batch: every HHAPP batch) → `journalLines[].id`, `journalLines[0].journalCode`, `ledgerEntries[].entryNumber`; count and sum from the two arrays |
| `createJournalLines({ batch, externalDocumentNo, lines })` | `createJournalLines({ journalCode: batch, lines })` with `accountNo→accountNumber`, `externalDocumentNo→externalDocumentNumber`, `dimensions→dimensionSetLines`; map `already_in_journal`/`already_posted` to the port's result |
| `readGlEntriesByExternalDocNo({ externalDocumentNo })` | `readGlEntriesByExternalDocNo(doc)` |
| `readGlEntriesByExternalDocNo({ externalDocumentNoStartsWith, postingDateFrom, postingDateTo })` (nightly poll) | `listAppDocuments(filter)` — drafts and posted entries with batch, source and reason codes |
| `readBankLedgerEntries({ bankAccountCode, … })` | `readBankLedgerEntries({ bankAccountNumber, … })` |
| `writeBudgetEntries(entries[] with budgetName)` | group by `budgetName`, one `writeBudgetEntries(name, entries)` per group (one change set per revision) |
| `readBudget(name)` | `readBudget(name).lines` |
| `createWebhookSubscription / renewWebhookSubscription / deleteWebhookSubscription` | `subscriptions.create / renew(id, clientState) / delete` |
| `LedgerError(status, retryable, code)` | `BcRetryableError` / `BcNonRetryableError` (`status`, `code`) |

Balance reads for goals (`accountNoPrefix`, `dimension` in the port's `GlEntryQuery`) are not in this package yet: `generalLedgerEntries?$filter=accountNumber ge … and accountNumber le …` with `$expand=dimensionSetLines` would serve them; add when E6 needs it.

## What the tests prove

| Brief item | Test |
| --- | --- |
| Token request shape | `auth.test.ts`: form fields, scope, assertion type; RS256 JWT with `x5t` and `x5t#S256`, aud/iss/sub/jti/nbf/iat/exp verified with the public key; cache until 5 minutes before expiry; `invalidate()`; coalesced refreshes; AADSTS text surfaced, PEM and assertion never |
| A 3-line split lands whole or not at all (forced-failure batch) | `adapter.test.ts` "forced-failure batch": a bad dimension value on line 2, then a bad bank account on line 3 → zero lines in BC; same with the JSON batch format |
| Pre-write check: resend ×3, timeout after write | "resending the same transaction three times leaves one document"; "a timeout after a successful write is retryable, and the retry finds the lines"; "after posting, a resend reports already_posted"; a resend aimed at another batch is still caught |
| Post, then read-back: entry numbers and the five dimensions | "posts the batch (204), then reads back entry numbers, document no, posting date and the five dimensions" |
| Retry schedule | `retry.test.ts`: 1/2/4/8/16 min, 24 hourly, `undefined` after 29, `Retry-After` honored, 408/429/5xx vs the rest |
| ORIG budget refused | client guard; the connector page refuses it even when the guard is bypassed; a bad dimension rolls a revision back (A8) |
| Subscription handshake and renewal | create with `validationToken` echo and `clientState`; PATCH renew re-handshakes and resets the 3-day expiry; expiry drops the subscription; 5xx keeps it, 4xx deletes it |
| Descriptions truncated to 100 | mapping and adapter both; the mock refuses 101 |
| Mapping (A2, A4) | `mapping.test.ts`: transfers 115101 net to zero, card payments 115201, CTJ-paid bill Cr 404102 with the natural debit, household-card business charge Dr 112101, lash DED-BUS, paycheck by component, lines sum to zero |
| Nightly poll range read | `listAppDocuments` by window, prefix and batch; HHAUTO/AUTOPOST on rule-posted entries |

## What is faked, and why

Business Central is unreachable from the build environment (brief), so `MockBcServer` mirrors the documented shapes, in process (`server.fetch`) or on a loopback port (`server.listen()`):

- `companies`, `accounts`, `dimensions` (+`dimensionValues`), `bankAccounts` seeded from `@homestead/shared` `CHART`, the five dimensions' values and `BANK_CARD_LIST`;
- `journals` (listing the GENERAL template unless filtered by `templateDisplayName`, as page 30048 does), `journalLines` with the `dimensionSetLines` deep insert and field-length checks, Document No. from the batch's No. Series shared by consecutive lines with the same External Document No.;
- `$batch` with atomic change sets (multipart and JSON) under `Isolation: snapshot`;
- `Microsoft.NAV.post` (balanced documents → `generalLedgerEntries` with entry numbers, bank lines → bank ledger entries, 204, "nothing to post");
- `generalLedgerEntries` with `$expand=dimensionSetLines` and **no** `externalDocumentNumber` (a filter on it is a 400, as on the real page 30018);
- `subscriptions` (handshake on POST and PATCH, 3-day expiry, notifications with `clientState`, retry on 408/429/5xx, deletion otherwise), `webhookSupportedResources`;
- the HH App Connector pages (`hhJournalLineChecks`, `hhBankLedgerEntries`, `hhBudgetEntries` with the ORIG refusal) and the read-only Analytics budget endpoints;
- one-shot failures: `failNext` (refuse before doing the work) and `cutConnectionAfterNext` (do the work, then drop the connection — the timeout-after-write case).

Not mirrored, so the sandbox acceptance run (A1, A6, A8 and the forced-failure batch) is what proves them: posting-date and period checks, posting groups, No. Series gaps, ETags, throttling, the full OData grammar.

## Assumptions about the BC API to verify on the sandbox

Each is marked `VERIFY` in the source with the doc it rests on.

1. **`$batch` format.** Microsoft's page shows only the JSON batch body with `Isolation: snapshot` and states that an inner failure reverts every change ([Using OData $batch](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/webservices/use-odata-batch)). The adapter sends the OData 4 multipart/mixed change set by default (as the brief asks) and the JSON form with `batchFormat: "json"`; both carry the header. Inner URLs are absolute. The first sandbox test should run the forced-failure batch in both formats and keep whichever BC rolls back.
2. **`generalLedgerEntries` has no `externalDocumentNumber`** ([resource page](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/resources/dynamics_generalledgerentry) — confirmed). So the "two OData filters" fallback can only check the ledger side by a known Document No.; with the connector installed `hhJournalLineChecks` answers both sides, which is why `connectorInstalled` exists.
3. **`journalLines` deep insert of `dimensionSetLines`** on POST (page 30049 has the part). If the sandbox ignores the nested collection, the fallback is one POST per line to `journalLines({id})/dimensionSetLines` inside the same change set.
4. **Analytics API entity set names** `generalLedgerBudgets` / `generalLedgerBudgetEntries` and their camelCase fields: the overview lists `generalLedgerBudget` and `generalLedgerBudgetEntry` and shows plural URLs for other entities ([overview](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-analytics/api-analytics-overview)); the resource pages were not reachable. Check `$metadata` once.
5. **Subscription renewal body.** PATCH `subscriptions({id})` with `If-Match: *` and `{ clientState }`; the doc confirms PATCH + handshake but not the body ([webhooks](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/api-reference/v2.0/dynamics-subscriptions)). `webhookSupportedResources?$filter=resource eq 'v2.0*'` is the doc's own example.
6. **Client assertion algorithm.** RS256 with `x5t` (what MSAL sends) is the default; Microsoft's page now recommends PS256 and the `x5t#S256` header, which is also sent. `assertionAlgorithm: "PS256"` is the switch if Entra answers AADSTS700027 ([certificate credentials](https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials)).
7. **`startswith(externalDocumentNo,'HHAPP-')`** on the connector page becomes the AL filter `HHAPP-*` that the page passes through to the source tables (`HHJournalLineCheck.Page.al`).
