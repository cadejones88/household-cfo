# Gate 4 checklist: what Cade does, in order

Gate 4 is the nine acceptance tests passing against the real BC sandbox. Everything below happens in `CADE_Sandbox_vs25` and the firm's Microsoft tenant. Nothing touches production, a bank, or money. About 45 minutes in all.

**Progress (October 21, 2026): all steps done; A1–A9 pass against the sandbox** (guided CI run 39667150760, with the A6 receiver). Connector 1.0.0.3 is installed, and the application card carries HH-APP plus the two sets the sandbox runs proved necessary (step 5). Claude did the guided session (step 6) in the built-in browser, and Cade approved each posting. Gate 4 now waits on Cade's approval.

## 1. Install the HH App Connector in the sandbox (5 minutes) — done

1. Download `HH-App-Connector.zip` (version 1.0.0.3 or later) from https://github.com/cadejones88/household-cfo/releases/latest/download/HH-App-Connector.zip and unzip it. Version 1.0.0.0 cannot install in this sandbox: its object numbers collided with the Risky Cards Connector.
2. In the sandbox: search **Extension Management** → **Manage** → **Upload Extension**.
3. Choose `HH-App-Connector.app`, Deploy to **Current version**, accept, **Deploy**.
4. **Deployment Status** shows *Completed* within a couple of minutes. Extension Management then lists "HH App Connector" by Cade T. Jones CPA, P.C., at the version you uploaded.

## 2. The BC master data (changes 3–6) — done by Claude

Entered in the sandbox October 21, 2026, following `bc/runbook-additions.md`:

1. **Change 6:** Source Code `HHAUTO`; Reason Code `AUTOPOST`.
2. **Change 3:** No. Series `GJ-AUTO` (`AUTO-000001`..`AUTO-999999`); journal batch `HHAPP` / `AUTOPOST` with that series and reason code `AUTOPOST`.
3. **Change 5:** G/L accounts `401102` and `401202` (bonus compensation, with FAMILY_AREA CADE and TAX_TREATMENT TAXABLE). The wage rows in HH-IS and HH-GIVE already total by range, so they needed no edit.
4. **Change 4:** Change Log on table 81 Gen. Journal Line (13 fields on insert and modify, all fields on delete); the Change Log was already on. Change Log entries kept 2 years.

## 3. Register the app in the firm's tenant (10 minutes)

https://entra.microsoft.com, signed in as the firm's admin:

1. **Applications → App registrations → New registration.** Name `Homestead BC Sandbox`; *Accounts in this organizational directory only*; no redirect URI → **Register**.
2. On the Overview page, keep two values handy (they are ids, not secrets): **Application (client) ID** and **Directory (tenant) ID**.
3. **API permissions → Add a permission → Dynamics 365 Business Central → Application permissions → `API.ReadWrite.All` → Add permissions**, then **Grant admin consent for Cade T. Jones CPA, P.C.** → Yes.
4. Do **not** create a client secret.

## 4. Make the test certificate on your Mac (5 minutes)

In Terminal:

```sh
cd ~/Desktop
openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes -subj "/CN=homestead-bc-ci" \
  -keyout homestead-bc-ci.key -out homestead-bc-ci.crt
```

1. Back in the app registration: **Certificates & secrets → Certificates → Upload certificate** → `homestead-bc-ci.crt` (the public half) → Add.
2. Copy the key and certificate together to the clipboard:

   ```sh
   cat homestead-bc-ci.key homestead-bc-ci.crt | pbcopy
   ```

3. GitHub → `cadejones88/household-cfo` → **Settings → Secrets and variables → Actions → New repository secret**:
   - `BC_SANDBOX_CERT_PEM` → paste (Cmd+V)
   - `BC_SANDBOX_CLIENT_ID` → the Application (client) ID from step 3
   - `BC_SANDBOX_TENANT_ID` → the Directory (tenant) ID from step 3
4. Clean up so the private key exists only in GitHub:

   ```sh
   rm ~/Desktop/homestead-bc-ci.key && pbcopy < /dev/null
   ```

   Keep `homestead-bc-ci.crt` or delete it; it is public.

Never paste the key into chat. The company id is not needed: the test run finds it from the name "Cade & Vanessa Jones Family".

## 5. Let the app into BC (5 minutes)

In the sandbox:

1. Search **Microsoft Entra Applications** → **New**.
2. **Client ID** = the Application (client) ID; **Description** `Homestead BC Sandbox`; **State** Enabled.
3. **User Permission Sets**: Permission Set **HH-APP**, Company **Cade & Vanessa Jones Family**. The first runs showed BC also needs two read-only sets that an extension cannot carry. Both were added with Cade's approval and both are for the household company only:
   - **SUSTAINABILITY READ** (Microsoft's): BC reads Sustainability Setup on every journal line.
   - **HH-APP-SYS** (user-defined): Read Indirect on two tables. Web Service (2000000076) is read when a budget entry is inserted. API Webhook Subscription (2000000095) is read on every insert the app makes while a webhook subscription exists.

   Nothing else (`bc/runbook-additions.md`, change 1.3).
4. Do **not** use **Grant Consent**. The admin consent from step 3 already covers it, and BC's button needs a redirect URI that this registration deliberately doesn't have (it fails with AADSTS900561, "The endpoint only accepts POST requests").

## 6. The guided session in BC (about 20 minutes)

These are the steps that need a person's BC sign-in, because the app cannot post. They are all sandbox test data. The test run checks each one in BC. If a step is done, its test goes on. If not, the test is skipped and the run's summary repeats the instruction. The documents are the same every run, so the steps can be done at any time between runs. Do step 5 after step 1.

To open an HHAPP batch: search **General Journal Templates**, select **HHAPP**, choose **Batches**, select the batch, then **Edit Journal**. To open GENERAL/TEST: search **General Journals** and choose batch **TEST** in Batch Name.

1. **Post HHAPP/RECEIPTS.** It should hold six test receipts:
   - Broulim's $48.27 on 10/19 (2 lines).
   - Five Walmart receipts: 10/04 $34.96, 10/08 $81.03, 10/12 $33.05, 10/15 $58.47 and 10/19 $17.67 (19 lines).

   **Post** → Yes. If the batch holds anything else, stop and tell Claude.
2. **Post HHAPP/FEEDS.** It should hold six documents (12 lines):
   - Two transfers between your own accounts, each side its own document: Beehive checking to savings $500.00 (10/21 and 10/22), and America First to Capital One $363.00 (10/23 and 10/24).
   - The Capital One payment of $363.00 by CTJ and the Microsoft 365 business charge of $129.99, both 10/25.

   **Post** → Yes.
3. **PennyMac payment (A2).** In GENERAL/TEST, enter one line, then **Post**:
   - Posting Date 11/01/2026
   - Account Type Bank Account, Account No. AFCU-CHK
   - Description "PennyMac payment (acceptance A2)"
   - Amount −5,670.39
   - Bal. Account Type G/L Account, Bal. Account No. 271101

   In this sandbox test the whole payment goes to principal. Real payments use the RECURRING/MORTGAGE batch with the interest and escrow split.
4. **Emergency-fund earmark (A7).** In GENERAL/TEST, enter two lines, then **Post**. Both lines use Posting Date 10/21/2026, Account Type Bank Account, Account No. BEEHIVE-SAV and Description "Set aside EMERG-1M (acceptance A7)":
   - Amount 750.00, FUND_GOAL Code EMERG-1M
   - Amount −750.00, FUND_GOAL Code OPERATING

   The savings balance does not change. $750 of it is now marked as emergency fund.
5. **Reconcile Broulim's (A1).**
   1. Search **Bank Account Reconciliations** → **New**. Bank Account No. BEEHIVE-CHK, Statement Date 10/31/2026.
   2. Add one statement line: Transaction Date 10/19/2026, Description BROULIMS, Statement Amount −48.27.
   3. Select that line and the −48.27 Broulim's ledger entry, then **Match Manually**.
   4. Set Statement Ending Balance to Balance Last Statement − 48.27.
   5. **Post**.

Then tell Claude "done". The next run should pass A1, A2 and A7. Claude can do these steps in the built-in browser instead, if you approve the list.

A guided run is also possible. Start CI with **Run workflow** and wait_minutes = 30. The run then waits at each step, checking BC every 20 seconds, instead of skipping.

**A6** needs a guided run with **a6_receiver** ticked as well. CI then opens a temporary public webhook receiver for that run only: a Cloudflare quick tunnel to the test run, answering BC's webhook route and nothing else. About two minutes into the test step, HHAPP/FEEDS gets one new line: WinCo Foods, $33.10, 10/27/2026. Post it while the run waits. The run deletes its own subscriptions when it ends.

## 7. Gate 4

Gate 4 passes when A1–A9 are green in the sandbox run.

## Not needed for Gate 4, but worth starting now (waiting periods)

- **Apple Developer Program** for the firm (TestFlight on your and Vanessa's iPhones): needs the firm's D-U-N-S number, which can take 1–2 weeks if the firm doesn't have one. https://developer.apple.com/programs/enroll/ → organization. Issue #11.
- **Plaid** team under the firm (https://dashboard.plaid.com), Transactions product only; start the production-access review for the pilot's live read-only logins. Issue #7.
- **Azure subscription** (pay-as-you-go, firm tenant), Entra External ID tenant, and the decision on Front Door for `homestead.cadejonescpa.com`. Needed for the Phase 5 pilot, not for Gate 4. `docs/runbook-azure-setup.md`, issues #2 and #3.
