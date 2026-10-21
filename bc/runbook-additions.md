# Runbook additions: Business Central changes 1–6 (epic E2)

These steps extend the BC setup runbook in the project records (`records/bc-setup/Runbook.md`) with the six changes from the Phase 3 spec's "Proposed Business Central changes" table. Each change has a test step; nothing is done in production. Every step is done in the sandbox `CADE_Sandbox_vs25` by Cade with the firm account, except where a step says "Azure portal" (the firm's Microsoft tenant, the one that hosts Business Central).

Names that other parts of the system depend on are fixed here and in code; change one only with the other:

| Name | Used by |
| --- | --- |
| Journal template `HHAPP`; batches `FEEDS`, `RECEIPTS`, `AUTOPOST` | adapter `journalTemplate`, `resolveJournal()`; `HH AutoPost Defaults` |
| Permission set `HH-APP` | Entra application card |
| Source code `HHAUTO`, reason code `AUTOPOST` | `HH AutoPost Defaults`; the Change Log review |
| Accounts `401102`, `401202` | `@homestead/shared` chart, paycheck pipeline (`PENDING_SANDBOX_ACCOUNTS`) |
| Budget names `*-ORIG` (never written), `*-REV*`, `FCST*` | `hhBudgetEntries`, `assertWritableBudgetName()` |

Record each completed step in the project's BC Review Log with the date and the test result.

---

## Change 1 — Entra app registration for the sandbox, permission set HH-APP

Approved at Gate 1. One registration per environment; this one is for the sandbox and is named so it cannot be mistaken for production. Microsoft's walkthrough: [Using Service-to-Service (S2S) Authentication](https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication); certificate credentials: [Microsoft identity platform application authentication certificate credentials](https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials).

### 1.1 The certificate (Azure portal, Key Vault first)

The private key is born in Key Vault and never leaves it as a file. The services read the PEM by *name* at start-up; nothing in the repo or a laptop holds it.

For **Gate 4** the test runs use a separate certificate made on Cade's Mac and kept only as the GitHub secret `BC_SANDBOX_CERT_PEM` (`docs/gate4-checklist.md`, step 4). The steps below are for the **deployed** app, after the Azure setup exists.

1. Key Vault `kv-homestead-dev` (created by the infra) → **Certificates → Generate/Import**.
2. Method **Generate**; name **`bc-sandbox-client-cert`** (the name `BC_CERT_SECRET_REF` points at); type **Self-signed**; subject `CN=homestead-bc-sandbox`; validity **12 months**; content type **PEM**; key type RSA 2048; auto-renew notification at 30 days before expiry.
3. After creation, open the certificate → the current version → **Download in CER format**. This is the public half only; it is what the app registration needs.
4. Nothing to configure: the templates already set `BC_CERT_SECRET_REF=bc-sandbox-client-cert`, and Key Vault serves a PEM certificate's key and certificate as a secret of the same name. The spec's rotation rule is yearly; renewing in Key Vault and uploading the new `.cer` to the registration (step 1.2.5) is the whole rotation.

### 1.2 The app registration (Azure portal → Microsoft Entra ID)

1. **App registrations → New registration**. Name `Homestead BC Sandbox`; supported account types **Accounts in this organizational directory only**; no redirect URI. Register.
2. Copy **Application (client) ID** and **Directory (tenant) ID** into the dev configuration as `BC_CLIENT_ID` and `BC_TENANT_ID`. They are identifiers, not secrets, but they are still not committed; `.env.example` lists the names only.
3. **API permissions → Add a permission → Dynamics 365 Business Central → Application permissions → `API.ReadWrite.All`** → Add. Then **Grant admin consent for Cade T. Jones CPA, P.C.** (Cade is the tenant's global admin). `Automation.ReadWrite.All` is *not* added: the services never publish extensions or manage companies. No delegated permission is added: nothing signs in as a person.
4. **Certificates & secrets → Certificates → Upload certificate** → the `.cer` from step 1.1.3, description `bc-sandbox-cert 2026`. Do not create a client secret; the spec's security model is certificate-only.
5. On yearly rotation: upload the new `.cer` first, then renew in Key Vault, then delete the old certificate from the registration once the jobs have restarted with the new PEM.
6. **Overview → Managed application in local directory** → open the enterprise application → **Properties**: set *Assignment required* **Yes** and *Visible to users* **No**, so the registration cannot be used for interactive sign-in.

### 1.3 The application in Business Central (sandbox)

1. Search **Microsoft Entra Applications** (the page is named "Azure Active Directory Applications" on older builds) → **New**.
2. **Client ID** = the Application (client) ID from 1.2.2; **Description** `Homestead BC Sandbox`; **State** `Enabled`. BC creates a user of type Application behind the card; leave its contact fields blank.
3. **User Permission Sets** subpage: add `HH-APP` (it appears once the HH App Connector is published, change 2; if publishing comes later, come back to this step). Company: the household company only. Add nothing else — in particular not `D365 BUS FULL ACCESS`, `SUPER` or `D365 READ`. If a smoke test in 1.4 fails with a permission error on a system table, add that table to the `HH-APP` source (`bc/hh-app-connector/src/HHApp.PermissionSet.al`) and republish; the comment at the end of that file explains why.
4. **Grant Consent** action on the card → sign in as the admin → accept. This is what lets the S2S token be exchanged for a BC session.
5. Optional, server-side scoping: on the application's user card, **Permission Sets → Security Filters** for `Gen. Journal Line`: `Journal Template Name=CONST(HHAPP)`. The adapter only ever addresses HHAPP batches; this makes BC enforce it as well. Note the user card also lists the permission set with a blank company, which means all companies; set the household company explicitly.

### 1.4 Test

The sandbox acceptance run in GitHub Actions does these (it signs in with `BC_SANDBOX_*`); later the deployed jobs repeat them with the Key Vault certificate:

1. Token: `CertificateCredential.getToken()` returns an access token for scope `https://api.businesscentral.dynamics.com/.default`. An `AADSTS700027` answer means the assertion signature is refused: switch `assertionAlgorithm` to `PS256` (see `packages/ledger-adapter-bc/src/auth.ts`). `AADSTS7000215`/`700016` mean the client ID or tenant is wrong.
2. `GET api/v2.0/companies` lists the household company (a 401 here with a good token means step 1.3.4 was skipped; a 403 means the permission set is missing).
3. `listAccounts()`, `listDimensions()`, `listBankAccounts()` return the chart (incl. 401102/401202 after change 5), the five dimensions with values, and the fourteen bank cards.
4. `createJournalLines()` of the three-line Walmart split into `HHAPP/FEEDS`: three draft lines, one Document No., the five dimensions visible on each line's **Dimensions** in BC. Then the forced-failure batch (one bad dimension value in line 2): zero lines in the batch afterwards.
5. `subscriptions.create()` for `generalLedgerEntries` against the dev receiver succeeds (handshake visible in the receiver log).
6. A `POST journals({id})/Microsoft.NAV.post` with HH-APP must **fail** with a permission error until change 6b (posting right) is approved. Record that it failed.

---

## Change 2 — Publish the HH App Connector

Approved at Gate 1; `hhJournalLineChecks` added by the Phase 3 spec. GitHub Actions compiles the extension against Microsoft's BC 27 symbols on every change (`.github/workflows/al-compile.yml`) and publishes it as the release `hh-app-connector-v<version>`: download `HH-App-Connector.zip`, unzip, and in the sandbox **Extension Management → Manage → Upload Extension** → choose `HH-App-Connector.app` → Deploy to **Current version** → Deploy; **Deployment Status** shows Completed in a minute or two. (Publishing from VS Code, `bc/hh-app-connector/README.md`, also works.) After publishing, go back to step 1.3.3 and assign `HH-APP`.

### Test

1. The four smoke calls in the README's step 9 (companies, hhJournalLineChecks empty answer, hhBankLedgerEntries, the `2026-ORIG` refusal) pass with the firm account's token.
2. The same four calls pass with the application's token (change 1). This is the proof that `HH-APP` carries enough rights for the connector pages.
3. `findByExternalDocumentNo()` for the draft document from test 1.4.4 answers `answeredBy: "connector"` with three `journalLines` and no `ledgerEntries`.
4. A8: with a budget `2026-REV1` created in BC (**G/L Budgets → New**, name `2026-REV1`, Budget Dimension 1–3 = FAMILY_AREA, TAX_TREATMENT, PROJECT), `writeBudgetEntries("2026-REV1", …)` lands two entries visible in the budget matrix with their dimensions; `writeBudgetEntries("2026-ORIG", …)` is refused by the adapter before any call, and a direct `POST hhBudgetEntries` with `budgetName: "2026-ORIG"` is refused by BC with "original budget".

---

## Change 3 — Journal batch HHAPP/AUTOPOST

Approved at Gate 1. The HHAPP template with FEEDS and RECEIPTS exists from the BC setup; this adds the batch rule-posted lines go to. Text-to-Account Mapping stays empty (nothing to do; just do not add rows for the app's bank accounts).

1. **General Journal Templates** → `HHAPP` → **Batches**.
2. New batch: **Name** `AUTOPOST`; **Description** `Homestead rule-posted (auto)`; **No. Series**: a new series `GJ-AUTO` (**No. Series → New**: code `GJ-AUTO`, description `Homestead rule-posted (HHAPP/AUTOPOST)`, one line `AUTO-000001`..`AUTO-999999`, Default Nos on, Manual Nos on, the same as the setup's other `GJ-` series) so auto-posted document numbers are recognisable at a glance; **Bal. Account No.** blank (every document carries its own bank line); **Reason Code** `AUTOPOST` (after change 6, come back if it does not exist yet); **Copy Tax Setup to Jnl. Lines** as FEEDS has it (no tax setup in this company, so it has no effect); **Allow Payment Export** off.
3. Confirm the batches' No. Series. In the sandbox FEEDS and RECEIPTS share `GJ-RCPT` and AUTOPOST has `GJ-AUTO`. Sharing is harmless: the app keys documents on External Document No. (`HHAPP-<SRC>-…`), never on Document No.

Done in the sandbox October 21, 2026 (series `GJ-AUTO` rather than the earlier draft's `HH-AUTO`/`HHA00001`, to match the house `GJ-` naming; nothing in code refers to the series).

### Test

1. `resolveJournal("AUTOPOST")` returns the batch (the adapter filters journals by `templateDisplayName eq 'HHAPP'`; without that filter BC lists the GENERAL template's batches, which is why the test exists).
2. `createJournalLines({ journalCode: "AUTOPOST", … })` lands a document numbered from `GJ-AUTO` (`AUTO-000001`, …).
3. Posting that batch by hand in BC (Cade, until the posting right exists): the G/L entries show Reason Code `AUTOPOST` and, after change 6, Source Code `HHAUTO`.

---

## Change 4 — Change Log on Gen. Journal Line

Approved at Gate 1 (optional). The audit trail for drafts the app wrote and a person then edited or deleted in BC (state machine: "BC draft created → Exception: draft edited or deleted in BC"). The Change Log cannot filter by template value, so it logs table 81 as a whole; the HHAPP rows are picked out on review by Journal Template Name.

1. **Change Log Setup** → **Setup** (Tables) → find table **81 Gen. Journal Line**.
2. **Log Insertion** `Some Fields`, **Log Modification** `Some Fields`, **Log Deletion** `All Fields`. For the two "Some Fields" entries pick: Journal Template Name, Journal Batch Name, Line No., Posting Date, Document No., External Document No., Account Type, Account No., Amount, Description, Dimension Set ID, Source Code, Reason Code. (All Fields on insert would log every API write twice over; the chosen fields are what the nightly poll compares.)
3. Back on **Change Log Setup**, switch **Change Log Activated** on. BC asks to sign out and in again. (In the sandbox it was already on from the October 19 setup, so no sign-out was needed.)
4. Retention: **Retention Policy** for Change Log Entry, 2 years (the spec keeps transactions 7 years in the app; the Change Log is a BC-side cross-check, not the record). BC refuses **Apply to all records** on this table because it carries mandatory filters, so: **Retention Periods → New** `2 YEARS` (Custom, `-2Y`); on the Change Log Entry policy set the editable line **Protected: No** to `2 YEARS` (Microsoft's two locked lines, Protected: Yes at 1 year and Monitor Sensitive Fields at 28 days, stay as they are); switch the policy **Enabled** on.

Done in the sandbox October 21, 2026: table 81 logs the 13 fields above on insert and modify (both columns, nothing else ticked) and all fields on delete; retention as in step 4, 0 expired records.

### Test

1. Write a FEEDS document with `createJournalLines()`, then in BC change its Description and delete one line. **Change Log Entries** filtered to table 81 shows the API insert under the application user and the edit and delete under Cade's user.
2. The nightly poll (E4/E7) raises an Exception for that document with the keys on both sides.

---

## Change 5 — Bonus compensation accounts 401102 and 401202

Approved October 20, 2026. Keeps the W-2 tie-out: box 1 = 401101 + 401102 + pre-tax deferrals (and the same for CTJ).

1. **Chart of Accounts → New**, twice:

   | No. | Name | Settings |
   | --- | --- | --- |
   | `401102` | `Bonus Compensation - Henry's Fork Homes (Cade)` | Income/Balance **Income Statement**; Account Category **Income**; Account Subcategory as 401101; Account Type **Posting**; Direct Posting **on**; Gen. Posting Type blank; Blocked off |
   | `401202` | `Bonus Compensation - Cade T. Jones CPA, P.C. (Cade)` | same |

2. On each new account, **Dimensions → Dimensions-Single**: `FAMILY_AREA` = `CADE`, `TAX_TREATMENT` = `TAXABLE`, with the same Value Posting setting 401101 uses (Code Mandatory if that is what 401101 has). No default SPEND_CLASS or FUND_GOAL (income accounts carry none).
3. Confirm the totaling account for wages (`401000`–`401999` range) picks them up: open the Chart of Accounts with **Indentation** and check the total line's **Totaling** is a range, not a list; if it is a list, add the two numbers.
4. **Financial Reports** (Account Schedules) → row definitions `HH-IS` and `HH-GIVE`: find the rows that total gross wages (`401101|401201` or similar) and widen the **Totaling** to `401101..401102|401201..401202` (or to the ranges the rows already use). Save; the column definitions are unchanged.
5. Run the HH-IS report for the current year: it still foots (no amounts yet on the new accounts, so the totals are unchanged).

Done in the sandbox October 21, 2026. Both accounts match 401101/401201 (Income Statement, Income, blank subcategory, Both, Posting, Direct Posting on) with FAMILY_AREA CADE and TAX_TREATMENT TAXABLE, Value Posting blank as on 401101. Steps 3 and 4 needed no edits: total 401999 is `401000..401999`, HH-IS row I10 is `401000..401999` and HH-GIVE row I10 is `401000..402999|404101|404102`, all ranges that already include the new accounts.

### Test

1. `listAccounts()` returns 401102 and 401202 as Posting, direct posting, not blocked. Remove them from `PENDING_SANDBOX_ACCOUNTS` in `packages/shared/src/chart.ts` once this passes (the paycheck pipeline then stops falling back to 401101 with a BONUS comment).
2. A paycheck with a bonus component maps `-50000` cents to 401102 (`mapping.test.ts`, "maps a paycheck by component") and posts in the sandbox with FAMILY_AREA CADE and TAX_TREATMENT TAXABLE visible on the G/L entry.
3. HH-IS shows the bonus on the wages rows after that post.

---

## Change 6 — Source code HHAUTO and reason code AUTOPOST

Approved October 20, 2026. Costs nothing today; makes the first auto-post audit trivial.

1. **Source Codes → New**: code `HHAUTO`, description `Homestead auto-post (rule-posted)`.
2. **Reason Codes → New**: code `AUTOPOST`, description `Posted by an approved Homestead rule`.
3. **General Journal Templates → HHAPP → Batches → AUTOPOST**: Reason Code `AUTOPOST` (change 3, step 2).
4. Source Code on the lines: the HH App Connector's `HH AutoPost Defaults` codeunit stamps `HHAUTO` (and `AUTOPOST`) on every line inserted into HHAPP/AUTOPOST, because the API's journalLines resource has no source-code field and the template's source code (`GENJNL`) would otherwise apply. Nothing to set by hand.

Done in the sandbox October 21, 2026.

### Test

1. Insert a line into HHAPP/AUTOPOST through the API; open the batch in BC and show the **Source Code** and **Reason Code** columns: `HHAUTO` and `AUTOPOST`.
2. Post the batch by hand (Cade). The G/L entries carry Source Code `HHAUTO` and Reason Code `AUTOPOST`; the Change Log shows the insert under the application user.
3. **If the posted entries show `GENJNL` instead of `HHAUTO`**, the posting batch codeunit overwrote the line's source code from the template. Fallback (a decision for Cade, recorded in the Review Log): a second template `HHAUTO` with Source Code `HHAUTO` holding the `AUTOPOST` batch, and the adapter configured with `journalTemplate: "HHAUTO"` for that batch (one config value in the jobs service, no code change).

---

## 6b — Posting right for HHAPP/AUTOPOST (not yet; recorded here so it is not forgotten)

Only after auto-post rules R2, R3 and R7 pass their sandbox test and Cade approves them in writing (spec: Decisions, question 4):

1. In `bc/hh-app-connector/src/HHApp.PermissionSet.al` add `codeunit "Gen. Jnl.-Post Batch" = X` (and `tabledata "G/L Entry" = RI`, `tabledata "Bank Account Ledger Entry" = RI`, `tabledata "G/L Register" = RI`, `tabledata "Bank Account" = RM`, `tabledata "G/L Account" = RM`, `tabledata "No. Series Line" = RM`, plus whatever the first posting attempt reports), bump the version, republish (change 2).
2. On the application's user card, security filter for `Gen. Journal Batch`: `Journal Template Name=CONST(HHAPP),Name=CONST(AUTOPOST)` so the post action cannot reach FEEDS or RECEIPTS.
3. Set `ledger_connections.auto_post_enabled` only after test 3 below.

Test: `postBatch("AUTOPOST")` returns 204 and the read-back by External Document No. returns the entry numbers (`adapter.test.ts`, "post and read-back"); `postBatch("FEEDS")` with the application's token is refused.
