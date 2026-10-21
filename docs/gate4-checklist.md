# Gate 4 checklist: what Cade does, in order

Gate 4 is the nine acceptance tests passing against the real BC sandbox. Everything below happens in `CADE_Sandbox_vs25` and the firm's Microsoft tenant. Nothing touches production, a bank, or money. About 45 minutes in all.

## 1. Install the HH App Connector in the sandbox (5 minutes)

1. Download `HH-App-Connector.zip` from https://github.com/cadejones88/household-cfo/releases/tag/hh-app-connector-v1.0.0.0 and unzip it.
2. In the sandbox: search **Extension Management** → **Manage** → **Upload Extension**.
3. Choose `HH-App-Connector.app`, Deploy to **Current version**, accept, **Deploy**.
4. **Deployment Status** shows *Completed* within a couple of minutes. Extension Management then lists "HH App Connector" by Cade T. Jones CPA, P.C., version 1.0.0.0.

## 2. The BC master data (changes 3–6, about 20 minutes, or Claude does it)

Claude can do this step in the built-in browser while you watch; sign in to the sandbox there and say "go". To do it yourself, follow `bc/runbook-additions.md` in this order:

1. **Change 6:** Source Code `HHAUTO`; Reason Code `AUTOPOST`.
2. **Change 3:** No. Series `HH-AUTO` (starting `HHA00001`); journal batch `HHAPP` / `AUTOPOST` with that series and reason code `AUTOPOST`.
3. **Change 5:** G/L accounts `401102` and `401202` (bonus compensation, with FAMILY_AREA CADE and TAX_TREATMENT TAXABLE), and widen the wage rows in HH-IS and HH-GIVE.
4. **Change 4:** Change Log on table 81 Gen. Journal Line, then switch the Change Log on.

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
3. **User Permission Sets**: Permission Set **HH-APP**, Company **Cade & Vanessa Jones Family**. Nothing else.
4. **Grant Consent** → sign in → Accept.

## 6. Tell Claude "done"

Claude starts the sandbox run in GitHub Actions, reads the results, and fixes anything that differs from Microsoft's documented behavior. Two parts of the run need your own BC sign-in: posting the HHAPP/FEEDS and HHAPP/RECEIPTS test batches, and one bank reconciliation. They are done together in a short guided session (about 20 minutes). Gate 4 passes when A1–A9 are green.

## Not needed for Gate 4, but worth starting now (waiting periods)

- **Apple Developer Program** for the firm (TestFlight on your and Vanessa's iPhones): needs the firm's D-U-N-S number, which can take 1–2 weeks if the firm doesn't have one. https://developer.apple.com/programs/enroll/ → organization. Issue #11.
- **Plaid** team under the firm (https://dashboard.plaid.com), Transactions product only; start the production-access review for the pilot's live read-only logins. Issue #7.
- **Azure subscription** (pay-as-you-go, firm tenant), Entra External ID tenant, and the decision on Front Door for `homestead.cadejonescpa.com`. Needed for the Phase 5 pilot, not for Gate 4. `docs/runbook-azure-setup.md`, issues #2 and #3.
