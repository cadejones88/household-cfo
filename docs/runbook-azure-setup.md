# Runbook: Azure, Entra, Plaid and Apple setup for Homestead

The one-time, hands-on steps only Cade can do, in order. Each step says what it produces and where the result goes. Three rules throughout:

1. **No secret ever goes into chat, a GitHub variable, a `.bicepparam`, or the repo.** Secrets go from your own shell straight into Key Vault; the code reads them by name.
2. Ids (tenant ids, client ids, company ids, subscription ids) are configuration, not secrets. They go into GitHub repository *variables* and the `HOMESTEAD_*` environment variables the parameter files read.
3. Nothing in this runbook touches Business Central production or a live bank login. dev and pilot run against `CADE_Sandbox_vs25`; the pilot's Plaid logins are read-only.

Reference: `docs/phase3-architecture-spec.md` ("Stack and hosting", "Security model", "Decisions on the open questions"), `infra/README.md`, `services/api/.env.example`.

---

## 1. Azure subscription (decision 1)

The firm has no Azure subscription today. Create one under **Cade T. Jones CPA, P.C.'s Microsoft tenant** (the tenant that hosts Business Central), pay-as-you-go, with the firm's payment method.

1. Sign in to https://portal.azure.com with your firm account (the one that administers Business Central).
2. Subscriptions → Add → **Pay-As-You-Go**. Name it `Homestead`. Note the **subscription id** (a GUID).
3. Cost Management → Budgets: the Bicep deploys a `$100/month` budget automatically from dev (`deployBudget = true`), emailing `HOMESTEAD_BUDGET_EMAIL`. If you prefer to see it in place before the first deploy, create it by hand with the same name `homestead-monthly`; the template will take it over.
4. Register the resource providers the templates use (once per subscription; the portal does this on first use, the CLI does not):

   ```sh
   az login
   az account set --subscription <subscription id>
   for p in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL Microsoft.ServiceBus Microsoft.KeyVault \
            Microsoft.Storage Microsoft.OperationalInsights Microsoft.Insights Microsoft.Web Microsoft.CognitiveServices \
            Microsoft.ManagedIdentity Microsoft.Consumption; do az provider register --namespace $p; done
   ```

**Produces:** subscription id → GitHub variable `AZURE_SUBSCRIPTION_ID`. Tenant id (`az account show --query tenantId`) → `AZURE_TENANT_ID`.

**Install locally:** Azure CLI 2.70+, Bicep CLI (`az bicep install`), Docker Desktop (only if you want to build the image on your machine; the workflow builds it otherwise), Node 22 and pnpm 10 for migrations.

## 2. GitHub OIDC federated credential (no stored cloud secret)

The deploy workflow signs in to Azure with a short-lived token from GitHub; nothing is stored.

1. Entra admin center (firm tenant) → App registrations → New: `homestead-github-deploy`, single tenant, no redirect URI.
2. Certificates & secrets → **Federated credentials** → Add → GitHub Actions deploying Azure resources:
   - Organization `cadejones88`, repository `household-cfo`
   - Entity **Branch** `main` → subject `repo:cadejones88/household-cfo:ref:refs/heads/main`
   - Add a second one, entity **Environment** `dev` → subject `repo:cadejones88/household-cfo:environment:dev` (the workflow runs in the `dev` environment)
   - Audience `api://AzureADTokenExchange`
3. Role assignments on the subscription (Subscriptions → Homestead → Access control):
   - **Contributor** — creates every resource
   - **Role Based Access Control Administrator** — the templates assign roles to the managed identities; constrain it to the roles in `infra/modules/rbac.bicep` if you like (Key Vault Secrets User/Officer, Key Vault Crypto User/Officer, Storage Blob Data Contributor, Azure Service Bus Data Sender/Owner, AcrPull, Monitoring Metrics Publisher, Cognitive Services User)
4. GitHub → repository → Settings → Environments → create `dev` (no protection rules needed yet).

**Produces:** the app registration's client id → GitHub variable `AZURE_CLIENT_ID`. No secret.

## 3. Entra External ID tenant (decision 2; "homesteadfamily" to confirm)

A separate *external* tenant for the family's sign-in, owned by the firm. Free under 50,000 monthly users.

1. Entra admin center → Overview → Manage tenants → Create → **External** → name `Homestead family`, domain `homesteadfamily` (gives `homesteadfamily.onmicrosoft.com` and the sign-in host `homesteadfamily.ciamlogin.com`), country United States, under the Homestead subscription.
2. Switch to the new tenant. External Identities → User flows → New: `HomesteadSignIn`, identity provider Email with password, **MFA required** (email one-time passcode is fine for sign-up; Authenticator TOTP for day to day), attributes: display name only. Do not collect anything else.
3. Authentication methods → enable **Passkey (FIDO2)** for the whole tenant. Passkeys are registered through the system browser on the sign-in domain, which is why the domain (step 4) is decided *before* the first passkey.
4. Create the two users (Users → New → Create external user) with your and Vanessa's email addresses, or let them sign up through the flow on first use.

**Produces:** External tenant id → GitHub variable `HOMESTEAD_ENTRA_TENANT_ID`.

### 3a. App registrations in the external tenant

Three registrations. Register the API first; the other two reference its scope.

| Registration | Type | Settings | Produces |
| --- | --- | --- | --- |
| `homestead-api` | Web API | Expose an API → Application ID URI `api://<client id>`; add scope **`Household.ReadWrite`** (admin and user consent; the family are the only users). Token version 2. | client id → `HOMESTEAD_ENTRA_API_AUDIENCE` (the API's `ENTRA_API_AUDIENCE`); scope string `api://<client id>/Household.ReadWrite` → `HOMESTEAD_ENTRA_API_SCOPE` |
| `homestead-phone` | Mobile/desktop (public client) | Redirect URI **`homestead://auth`**; Authentication → "Allow public client flows" **Yes**; API permissions → `homestead-api / Household.ReadWrite`, grant admin consent | client id → the phone app's `EXPO_PUBLIC_ENTRA_CLIENT_ID` (apps/mobile) |
| `homestead-console` | Single-page application | Redirect URIs `http://localhost:5174` and, after the first deploy, `https://<static web app hostname>`; API permissions as above, grant admin consent | client id → `HOMESTEAD_CONSOLE_CLIENT_ID` |

Then, still in the external tenant: User flows → `HomesteadSignIn` → Applications → add all three.

Authority strings for the clients (variables, not secrets):

- `HOMESTEAD_ENTRA_AUTHORITY` = `https://homesteadfamily.ciamlogin.com/<external tenant id>/` (or `https://homestead.cadejonescpa.com/<external tenant id>/` once step 4 is done)
- `HOMESTEAD_ENTRA_KNOWN_AUTHORITY` = `homesteadfamily.ciamlogin.com` (or `homestead.cadejonescpa.com`)

The API validates tokens against `ENTRA_ISSUER` = `https://<domain>/<external tenant id>/v2.0`, which `infra/main.bicep` derives from the same two values.

## 4. Custom sign-in domain `homestead.cadejonescpa.com` (decision 2)

External ID custom URL domains are served through **Azure Front Door**: Microsoft requires a Front Door profile in front of the tenant's sign-in endpoint. Front Door Standard carries a base charge of roughly **$35 a month** plus a small amount of traffic, which is about the size of the whole rest of the bill (spec: $30–55 a month). That is a decision, not a step:

- **Option A (spec as approved):** custom domain now. Passkeys bind to `homestead.cadejonescpa.com` from day one. Cost about +$35/month.
- **Option B:** use `homesteadfamily.ciamlogin.com` through the pilot; add the custom domain before production. Passkeys registered during the pilot are bound to the ciamlogin domain and would be re-registered once (a two-minute step per person) when the domain changes.

If Option A:

1. External tenant → Custom domain names → Add `homestead.cadejonescpa.com` → verify with the TXT record Microsoft shows (DNS at your registrar for `cadejonescpa.com`).
2. Create a Front Door Standard profile (Homestead subscription, `rg-homestead-prod` or a shared `rg-homestead-shared`), origin = `homesteadfamily.ciamlogin.com`, add the custom domain to the endpoint, let Front Door issue the managed certificate.
3. DNS: `CNAME homestead.cadejonescpa.com → <endpoint>.z01.azurefd.net` plus the `_dnsauth` TXT Front Door asks for.
4. External tenant → Company branding / Custom URL domain → Enable for the domain. Update `HOMESTEAD_ENTRA_AUTHORITY` and `HOMESTEAD_ENTRA_KNOWN_AUTHORITY`.

Either way, nothing in the repo changes except two variables.

## 5. Business Central app registration and certificate (BC change 1; one per environment)

In the **firm's workforce tenant** (where BC lives), not the external tenant.

1. App registrations → New: `homestead-bc-sandbox`, single tenant, no redirect URI. API permissions → Dynamics 365 Business Central → **Application** permissions → `API.ReadWrite.All` (and `Automation.ReadWrite.All` only if the HH App Connector install is automated; it is not) → Grant admin consent.
2. Make a certificate on your machine (valid one year; rotation is yearly per the spec):

   ```sh
   openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
     -subj "/CN=homestead-bc-sandbox" -keyout bc-sandbox.key -out bc-sandbox.crt
   cat bc-sandbox.key bc-sandbox.crt > bc-sandbox.pem
   ```

3. App registration → Certificates & secrets → Certificates → upload `bc-sandbox.crt` (the public half).
4. Business Central (sandbox `CADE_Sandbox_vs25`) → search **Microsoft Entra Applications** → New → Client ID = the registration's client id, description `Homestead`, State **Enabled**; User Permission Sets → add **HH-APP** (created by the BC setup runbook in `records/bc-setup/`) and `D365 READ`. No posting permission until the auto-post rules are approved (decision 4).
5. After `infra` has deployed Key Vault (step 8), put the PEM in it **from your shell** and delete the local files:

   ```sh
   az keyvault secret set --vault-name <kv name from the deployment outputs> --name bc-sandbox-client-cert --file bc-sandbox.pem
   shred -u bc-sandbox.key bc-sandbox.pem   # keep bc-sandbox.crt if you like; it is public
   ```

**Produces (variables):** `HOMESTEAD_BC_TENANT_ID` (firm tenant id), `HOMESTEAD_BC_CLIENT_ID`, `HOMESTEAD_BC_COMPANY_ID` (`GET https://api.businesscentral.dynamics.com/v2.0/<tenant>/CADE_Sandbox_vs25/api/v2.0/companies`, or Companies page in BC), `HOMESTEAD_BC_COMPANY_NAME` (the display name, for the Console's deep links). **Secret (Key Vault only):** `bc-sandbox-client-cert`. For production later: `homestead-bc-prod`, `bc-prod-client-cert`, the production environment name — only after Gate 5.

## 6. Plaid

1. https://dashboard.plaid.com → create the team under the firm (Cade T. Jones CPA, P.C.), product **Transactions** only (no Auth, no Identity, no transfers: the app never needs account numbers or moves money).
2. Keys → copy the **client id** (a variable) and the **Sandbox secret** (a secret). Plaid retired its separate "development" environment; the pilot's live read-only logins use the **production** secret under the free Trial / limited production plan, which needs the short application review in the dashboard — start it now so it is ready for Phase 5.
3. Webhooks are set per Item by the API when it creates the link token (`PLAID_WEBHOOK_URL` = `https://<api fqdn>/v1/webhooks/plaid`); nothing to configure in the dashboard beyond allowing the domain under Team settings → Allowed redirect URIs (`homestead://auth` for the phone's Link flow).
4. After step 8:

   ```sh
   read -rs -p 'Plaid sandbox secret: ' s; echo
   az keyvault secret set --vault-name <kv name> --name plaid-sandbox-secret --file <(printf '%s' "$s"); unset s
   # pilot, later: --name plaid-production-secret
   ```

   (`--file` with process substitution keeps the value out of your shell history and the process list.)

**Produces (variable):** `HOMESTEAD_PLAID_CLIENT_ID`. **Secrets (Key Vault only):** `plaid-sandbox-secret`, later `plaid-production-secret`. Plaid access tokens are written by the API itself as `plaid-<household id>-<item id>` and never seen by a person.

## 7. Where every secret lives

| `services/api/.env.example` name | What it is | Where the value lives | Who puts it there |
| --- | --- | --- | --- |
| `BC_CERT_SECRET_REF` | **name** of the Key Vault secret holding the BC certificate PEM | Key Vault `bc-sandbox-client-cert` / `bc-prod-client-cert` | Cade, step 5 |
| `PLAID_SECRET_REF` | **name** of the Key Vault secret holding the Plaid secret | Key Vault `plaid-sandbox-secret` / `plaid-production-secret` | Cade, step 6 |
| (runtime) | Plaid access tokens | Key Vault `plaid-<household>-<item>` | the API, after Link |
| (runtime) | per-household blob encryption keys | Key Vault keys `hh-<household id>` | the API, on household creation |
| (template) | storage account customer-managed key | Key Vault key `storage-cmk` | Bicep |
| `DATABASE_URL` | local development only | your laptop's `.env` (gitignored) | you |
| `PGHOST`, `PGDATABASE`, `PG_AUTH=entra` | cloud database access | Container Apps environment variables (not secrets; the identity is the credential) | Bicep |
| `KEY_VAULT_URL`, `STORAGE_ACCOUNT_URL`, `SERVICE_BUS_NAMESPACE`, `DOCUMENT_INTELLIGENCE_ENDPOINT`, `FOUNDRY_ENDPOINT`, `FOUNDRY_MODEL`, `APPLICATIONINSIGHTS_CONNECTION_STRING` | endpoints reached by managed identity | Container Apps environment variables | Bicep |
| `ENTRA_*`, `BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_COMPANY_ID`, `PLAID_CLIENT_ID` | ids | GitHub variables → Bicep → environment variables | Cade, steps 3, 5, 6 |
| Static Web App deployment token | pushes the Console | fetched by the workflow at deploy time with OIDC; never stored | the workflow |
| Expo / Apple signing | TestFlight builds | EAS (Expo) credentials store, per `apps/mobile/README.md` | Cade, step 10 |

Nothing in the table is pasted into chat, the repo, or a GitHub secret. GitHub needs **no secrets at all** for dev.

## 8. First deploy

1. GitHub → Settings → Variables (repository): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `HOMESTEAD_ADMIN_OBJECT_ID` (`az ad signed-in-user show --query id -o tsv`), `HOMESTEAD_ADMIN_UPN`, `HOMESTEAD_BUDGET_EMAIL`, `HOMESTEAD_BC_TENANT_ID`, `HOMESTEAD_BC_CLIENT_ID`, `HOMESTEAD_BC_COMPANY_ID`, `HOMESTEAD_BC_COMPANY_NAME`, `HOMESTEAD_PLAID_CLIENT_ID`, `HOMESTEAD_ENTRA_TENANT_ID`, `HOMESTEAD_ENTRA_API_AUDIENCE`, `HOMESTEAD_ENTRA_API_SCOPE`, `HOMESTEAD_ENTRA_AUTHORITY`, `HOMESTEAD_ENTRA_KNOWN_AUTHORITY`, `HOMESTEAD_CONSOLE_CLIENT_ID`, and (empty until step 11) `HOMESTEAD_FOUNDRY_ENDPOINT`, `HOMESTEAD_FOUNDRY_MODEL`.
2. Set `DEPLOY_ENABLED` = `true`. Push to `main` (or Actions → Deploy dev → Run workflow). The run creates `rg-homestead-dev`, builds and pushes the image, deploys the API and jobs, builds and publishes the Console, and prints both URLs in its summary. Expect 15–25 minutes the first time (Postgres is the slow one).
3. Load the two secrets into the new vault (steps 5.5 and 6.4). The API reads them on its next start: Container Apps → `homestead-dev-api` → Revisions → Restart.
4. Add `https://<console hostname>` to the `homestead-console` registration's redirect URIs (step 3a).

## 9. Database migrations

The deployer has no database rights on purpose. Migrations run as you (a Postgres Entra administrator) until a migration job is added:

```sh
az postgres flexible-server firewall-rule create -g rg-homestead-dev -n psql-homestead-dev \
  --rule-name cade-laptop --start-ip-address $(curl -s https://api.ipify.org) --end-ip-address $(curl -s https://api.ipify.org)
export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
DATABASE_URL="postgres://$(az ad signed-in-user show --query userPrincipalName -o tsv)@psql-homestead-dev.postgres.database.azure.com:5432/homestead" \
PGSSLMODE=require pnpm --filter @homestead/api db:migrate
unset PGPASSWORD
```

The token lasts an hour; nothing is saved. Remove the firewall rule afterwards if you prefer (`az postgres flexible-server firewall-rule delete`). The two managed identities already exist as Postgres roles (created by the template); the schema's role grants (`services/api/db/migrations/0001_schema.sql`) apply to them.

## 10. Apple Developer Program (organization)

For TestFlight (phase 5) and the App Store later. Organization enrollment, not individual, so the app belongs to the firm.

1. The firm needs a **D-U-N-S number** (free from Dun & Bradstreet; 1–2 weeks if it does not exist yet) and a legal-entity web domain and email.
2. https://developer.apple.com/programs/enroll/ → Enroll as an organization → Cade as the Account Holder → $99/year.
3. After approval: App Store Connect → New app, bundle id `com.cadejonescpa.homestead` (the phone builder confirms the exact id in `apps/mobile`). Expo's EAS handles signing certificates and provisioning profiles; they live in EAS, not the repo.

## 11. Claude on Microsoft Foundry and Document Intelligence

- **Document Intelligence** is created by the templates (`di-homestead-<env>`, keys disabled, identity access). Nothing to do.
- **Foundry:** create an AI Foundry resource and project in a US region that hosts Claude (Foundry portal → Create project → Homestead subscription, `rg-homestead-dev`), deploy a Haiku-class Claude model with a **US Data Zone Standard** deployment, grant the API identity `id-homestead-dev-api` the **Azure AI User** role on the project, and put the project endpoint and deployment name in `HOMESTEAD_FOUNDRY_ENDPOINT` and `HOMESTEAD_FOUNDRY_MODEL` (variables). No key is used.

## 12. Checks before calling dev "up"

- `curl https://<api fqdn>/health` answers `{ "ok": true }`.
- The Console signs in with your external-tenant account and shows "BC CADE_Sandbox_vs25" in the sidebar; Health → Connections shows the BC poll within the hour after the first `nightly-poll` run (trigger it by hand: `az containerapp job start -g rg-homestead-dev -n homestead-dev-nightly-poll`).
- Key Vault → Secrets lists `bc-sandbox-client-cert` and `plaid-sandbox-secret`, nothing else typed by a person.
- Cost Management shows the `homestead-monthly` budget.
- `node scripts/secrets-scan.mjs` in the repo is clean (CI runs it too).

## Open items for Cade

1. External tenant name `homesteadfamily` (spec: "name to confirm").
2. Custom sign-in domain now (Front Door, about +$35/month) or after the pilot (step 4).
3. The container registry adds about $5/month over the spec's cost table (`infra/README.md`); alternative is a GitHub-hosted image with a stored pull credential, which the spec's "no stored cloud secrets" rule argues against.
4. Document Intelligence tier for the pilot: F0 (500 free pages, may throttle) or S0 (pay per page).
