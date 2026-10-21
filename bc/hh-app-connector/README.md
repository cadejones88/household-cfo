# HH App Connector (Business Central AL extension)

The per-tenant extension the Homestead app needs beyond API v2.0 (Phase 3 spec, "HH App Connector", approved at Gate 1; BC change 2). Publisher "Cade T. Jones CPA, P.C.", object ID range 72100–72149 (moved from 50100–50149 on 10/21/2026: the sandbox's Risky Cards Connector already uses 50100), routes under `api/cadejonescpa/homestead/v1.0`.

| Object | ID | What it is for |
| --- | --- | --- |
| page `HH Bank Ledger Entries` (`hhBankLedgerEntries`, read) | 72100 | Reconciliation state of Bank Account Ledger Entry: Entry No., Bank Account No., Posting Date, Amount, Document No., External Document No., Open, Statement No., Statement Line No., Closed at Date, Reversed. API v2.0 has no bank ledger entity. Moves a transaction to Reconciled and matches BC-native payments |
| page `HH Budget Entries` (`hhBudgetEntries`, insert + read) | 72101 | Versioned budget revisions from approved budget moves (A8). OnInsert refuses any `*-ORIG` budget and accepts `*-REV*` or `FCST*` only; builds the Dimension Set ID from the six code fields |
| page `HH Journal Line Check` (`hhJournalLineChecks`, read) | 72102 | "Does this External Document No. exist anywhere?" across Gen. Journal Line and G/L Entry in one call, with where (template/batch or entry no.) and which (document no., posting date, account, amount). The adapter's pre-write check and read-back |
| table `HH Doc Check Row` (temporary) | 72100 | Buffer behind page 72102 |
| enum `HH Doc Source` | 72100 | `Journal` or `Ledger` |
| codeunit `HH Budget Name Check` | 72100 | The whitelist, callable from a test |
| codeunit `HH AutoPost Defaults` | 72101 | BC change 6: stamps Source Code HHAUTO and Reason Code AUTOPOST on every line inserted into HHAPP/AUTOPOST |
| permissionset `HH-APP` | 72100 | The one set assigned to the Entra application. No posting codeunit until auto-post is approved |

The TypeScript side of each page is in `packages/ledger-adapter-bc/src/bcAdapter.ts`; the in-process fake of these routes is `packages/ledger-adapter-bc/src/mock/MockBcServer.ts` (section "HH App Connector"). Keep field names in the three places in step.

## Installing in the sandbox (no tools needed)

GitHub Actions compiles this folder against Microsoft's BC 27 symbols on every change and publishes the result as the release `hh-app-connector-v<version>` (asset `HH-App-Connector.zip`; GitHub does not accept `.app` attachments). Download, unzip, then in BC: **Extension Management → Manage → Upload Extension** → `HH-App-Connector.app` → Deploy to **Current version** → **Deploy**, and watch **Deployment Status**. The first compile (10/21/2026, AL compiler 18.1) found and fixed two OnPrem-only tables in `HH-APP`; it now builds with no errors.

## Publishing to the sandbox from VS Code (alternative)

Nothing here is compiled or published from the build environment; this is the by-hand path. The whole thing takes about fifteen minutes the first time.

1. Install [Visual Studio Code](https://code.visualstudio.com/) and the **AL Language** extension (`ms-dynamics-smb.al`) from the Marketplace.
2. Open the folder `bc/hh-app-connector` in VS Code (File → Open Folder). Do not open the repo root; the AL extension wants `app.json` at the workspace root.
3. In `.vscode/launch.json`, set `tenant` to the firm's Microsoft tenant ID (or its primary domain) and confirm `environmentName` is `CADE_Sandbox_vs25`. These are not secrets. Never add credentials to this file.
4. Run **AL: Download symbols** (Ctrl+Shift+P). Sign in with the firm account when the browser opens. The base application and system symbols land in `.alpackages/` (git-ignored).
5. If the download reports a platform or application mismatch, open `app.json` and lower `application` and `runtime` to what the sandbox runs (see "Version assumption" below), then download again.
6. Run **AL: Package** (Ctrl+Shift+B) once to see the compiler output in the Problems panel. Fix anything it flags; every spot that could not be verified from here is marked `// VERIFY:` in the source, so start there.
7. Run **AL: Publish** (Ctrl+F5). The extension installs in the sandbox and BC opens in the browser. The first publish of a new per-tenant extension on a sandbox takes a minute.
8. In BC, open **Extension Management** and confirm "HH App Connector" by "Cade T. Jones CPA, P.C." is installed, version 1.0.0.0.
9. Smoke test with the firm account's own token before touching the app registration (Postman, Insomnia or curl all work):
   - `GET https://api.businesscentral.dynamics.com/v2.0/{tenant}/CADE_Sandbox_vs25/api/cadejonescpa/homestead/v1.0/companies` → the household company
   - `GET .../companies({id})/hhJournalLineChecks?$filter=externalDocumentNo eq 'HHAPP-MAN-20261020-00000000'` → `{"value":[]}` (an empty answer, not an error)
   - `GET .../companies({id})/hhBankLedgerEntries?$top=1` → one entry if any bank entries exist
   - `POST .../companies({id})/hhBudgetEntries` with `{"budgetName":"2026-ORIG","glAccountNo":"603101","date":"2026-11-01","amount":1}` → 400 with "original budget"
10. Continue with `bc/runbook-additions.md` (change 1 assigns `HH-APP` to the Entra application; changes 3–6 are the master data this extension expects).

Re-publishing after a source change: bump `version` in `app.json` (1.0.0.1, …) and Ctrl+F5 again; `schemaUpdateMode` is `ForceSync` in `launch.json`, which is fine for a sandbox and must never be used against production.

Production: the extension is not published to production by hand. It goes in the production package after Gate 5 with the same `app.json` version that passed the sandbox tests (spec: "deployed to the sandbox from the repo's `bc/` folder and promoted only with the production package"). Production publishing is through **Extension Management → Upload Extension** with the `.app` file built by **AL: Package**.

## Version assumption

`app.json` targets Business Central 2025 release wave 2 (version 27, `application` 27.0.0.0, `runtime` 16.0). Cade confirmed on 10/21/2026 that the sandbox is on 2025 wave 2 or newer, so the extension installs as built; a newer sandbox runs it unchanged.

## What is not here

- No test app. The codeunit `HH Budget Name Check` is separate so a test codeunit (needs the Test Toolkit, a separate app) can assert the whitelist; the TypeScript suite proves the same rule against the mock.
- No posting right. `codeunit "Gen. Jnl.-Post Batch" = X` is added to `HH-APP` only when auto-post rules R2, R3 and R7 pass their sandbox test and Cade approves them in writing.
- No table extension on G/L Entry. A key on External Document No. is noted in `HHJournalLineCheck.Page.al` as the fix if the pre-write check is ever slow; at household volume it is not needed.
- Text-to-Account Mapping is not touched (spec: it stays empty on the app path).
