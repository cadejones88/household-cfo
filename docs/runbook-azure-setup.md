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

**Install locally:** Azure CLI 2.70+, Bicep CLI (`az bicep install`), Docker Desktop (only if you want to build the image on your machine; the workflow builds it otherwise), Node 22 and pnpm 10 for migrations, and `psql` (PostgreSQL 16 client) for the one-time role step in step 9.

## 2. GitHub OIDC federated credential (no stored cloud secret)

The deploy workflow signs in to Azure with a short-lived token from GitHub; nothing is stored.

1. Entra admin center (firm tenant) → App registrations → New: `homestead-github-deploy`, single tenant, no redirect URI.
2. Certificates & secrets → **Federated credentials** → Add → scenario **Other issuer** (not the GitHub Actions template, which builds the old name-based subject):
   - Issuer `https://token.actions.githubusercontent.com`
   - Subject identifier `repo:cadejones88@212395518/household-cfo@1426547300:environment:dev` (the workflow runs in the `dev` environment; a second credential ending `:environment:pilot` comes with the pilot deploy)
   - Audience `api://AzureADTokenExchange`

   The repository was created after July 15, 2026, so GitHub sends **immutable subjects** that carry the owner and repository ids (`212395518`, `1426547300`), not the name-based `repo:cadejones88/household-cfo:…`. A credential with the old form fails with AADSTS700213, which is what the first deploy hit on 10/21/2026 ([Microsoft: immutable subjects](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)).
3. Role assignments on the subscription (Subscriptions → Homestead → Access control):
   - **Contributor** — creates every resource
   - **Role Based Access Control Administrator** — the templates assign roles to the managed identities; constrain it to the roles in `infra/modules/rbac.bicep` if you like (Key Vault Secrets User/Officer, Key Vault Crypto User/Officer, Storage Blob Data Contributor, Azure Service Bus Data Sender/Owner, AcrPull, Monitoring Metrics Publisher, Cognitive Services User)
4. GitHub → repository → Settings → Environments → create `dev` (no protection rules needed yet).

**Produces:** the app registration's client id → GitHub variable `AZURE_CLIENT_ID`. No secret.

## 3. Entra External ID tenant (decision 2; `homesteadfamily`, created 10/21/2026)

A separate *external* tenant for the family's sign-in, owned by the firm. Free under 50,000 monthly users.

1. Entra admin center → Overview → Manage tenants → Create → **External** → name `Homestead family`, domain `homesteadfamily` (gives `homesteadfamily.onmicrosoft.com` and the sign-in host `homesteadfamily.ciamlogin.com`), country United States, under the Homestead subscription.
2. Switch to the new tenant. External Identities → User flows → New: `HomesteadSignIn`, identity provider **Email with password**, attributes: display name only. Do not collect anything else. Then the flow → Applications → add `homestead-phone` and `homestead-console`.
3. **MFA.** Authentication methods → Policies → **Email OTP** → Enable, All users. Conditional Access → New policy `Homestead MFA`: Users **All users**; Target resources → Select resources → **`homestead-api`**; Grant → **Require multifactor authentication**; On. Conditional Access cannot target a public client such as `homestead-phone`, only the resource it asks for; both apps ask for the API at every sign-in (the phone refuses to build without the API scope), so the policy covers both, and the admin's own portal sign-in is untouched. External ID's second factors are an email code, a text message (paid add-on) or a passkey; there is **no authenticator app** option in an external tenant.
4. **Passkeys: after the pilot** (decided 10/21/2026). External ID passkeys need the custom URL domain (step 4), and Microsoft provides no registration screen in an external tenant: the app needs its own, built on Microsoft Graph's FIDO2 methods (backlog item). Through the pilot each spouse signs in with email and password plus the email code, and the phone locks with Face ID.
5. No users to create by hand: you and Vanessa sign up through the flow the first time you open the app or the Console, and the API admits only the two member rows linked to your object ids (step 9b).

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

The API validates tokens against `ENTRA_ISSUER` = `https://<external tenant id>.ciamlogin.com/<external tenant id>/v2.0`, which is what External ID writes into every token whichever host the user signed in on, and reads the signing keys from `ENTRA_JWKS_URI` = `https://<sign-in host>/<external tenant id>/discovery/v2.0/keys`. Both come from the tenant's discovery document (checked 10/21/2026) and `infra/main.bicep` derives them from the tenant id and `entraSignInHost`. Re-check the issuer when the custom domain is added.

## 4. Custom sign-in domain `homestead.cadejonescpa.com` (decision 2)

**Decided 10/21/2026: Option B.** The pilot signs in on `homesteadfamily.ciamlogin.com`; the custom domain and passkeys come together before production.

External ID custom URL domains are served through **Azure Front Door**: Microsoft requires a Front Door profile in front of the tenant's sign-in endpoint. Front Door Standard carries a base charge of roughly **$35 a month** plus a small amount of traffic, which is about the size of the whole rest of the bill (spec: $30–55 a month). That is a decision, not a step:

- **Option A (spec as approved):** custom domain now. Passkeys bind to `homestead.cadejonescpa.com` from day one. Cost about +$35/month.
- **Option B:** use `homesteadfamily.ciamlogin.com` through the pilot; add the custom domain before production. Passkeys registered during the pilot are bound to the ciamlogin domain and would be re-registered once (a two-minute step per person) when the domain changes.

If Option A:

1. External tenant → Custom domain names → Add `homestead.cadejonescpa.com` → verify with the TXT record Microsoft shows (DNS at your registrar for `cadejonescpa.com`).
2. Create a Front Door Standard profile (Homestead subscription, `rg-homestead-prod` or a shared `rg-homestead-shared`), origin = `homesteadfamily.ciamlogin.com`, add the custom domain to the endpoint, let Front Door issue the managed certificate.
3. DNS: `CNAME homestead.cadejonescpa.com → <endpoint>.z01.azurefd.net` plus the `_dnsauth` TXT Front Door asks for.
4. External tenant → Company branding / Custom URL domain → Enable for the domain. Update `HOMESTEAD_ENTRA_AUTHORITY` and `HOMESTEAD_ENTRA_KNOWN_AUTHORITY`.

Either way, nothing in the repo changes except two variables.

## 5. Business Central app registration and certificates (BC change 1; one registration per environment)

In the **firm's workforce tenant** (where BC lives), not the external tenant. The step-by-step for Gate 4 is `docs/gate4-checklist.md`; this section is the reference.

1. App registrations → New: `Homestead BC Sandbox`, single tenant, no redirect URI. API permissions → Dynamics 365 Business Central → **Application** permissions → `API.ReadWrite.All` → Grant admin consent. No client secret, ever.
2. Two certificates on that one registration, each living in exactly one place:
   - **Test runs (Gate 4, CI):** made on your Mac with `openssl`, public half uploaded to the registration, the PEM (key + certificate) stored only as the GitHub repository secret `BC_SANDBOX_CERT_PEM`, the local key deleted. Exact commands in `docs/gate4-checklist.md`, step 4.
   - **The deployed app (dev and pilot):** generated *inside* Key Vault after step 8 so the private key never exists as a file: Key Vault → Certificates → Generate, name **`bc-sandbox-client-cert`** (the name `BC_CERT_SECRET_REF` points at), self-signed, subject `CN=homestead-bc-sandbox`, 12 months, content type **PEM**. Download the CER and upload it to the same registration. Key Vault exposes the PEM as a secret of the same name, which is what the API reads.
3. Business Central (sandbox `CADE_Sandbox_vs25`) → **Microsoft Entra Applications** → New → Client ID = the registration's client id, description `Homestead BC Sandbox`, State **Enabled**; User Permission Sets → **HH-APP** only, company `Cade & Vanessa Jones Family` (not `D365 READ` or any Microsoft set: HH-APP carries exactly the reads the app needs). Skip the card's **Grant Consent**: the admin consent in step 1 covers it, and without a redirect URI the button fails with AADSTS900561. No posting permission until the auto-post rules are approved (decision 4).

**Produces (variables):** `HOMESTEAD_BC_TENANT_ID` (firm tenant id), `HOMESTEAD_BC_CLIENT_ID`, `HOMESTEAD_BC_COMPANY_ID` (printed by the first sandbox acceptance run, which finds it from the company's name), `HOMESTEAD_BC_COMPANY_NAME`. **Secrets:** `BC_SANDBOX_CERT_PEM` (GitHub, test runs only) and `bc-sandbox-client-cert` (Key Vault, the deployed app). For production later: a separate `Homestead BC Production` registration and `bc-prod-client-cert`, only after Gate 5.

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
| `BC_CERT_SECRET_REF` | **name** of the Key Vault secret holding the BC certificate PEM | Key Vault `bc-sandbox-client-cert` / `bc-prod-client-cert` (generated in Key Vault) | Cade, step 5 |
| `BC_SANDBOX_CERT_PEM` | the test-run certificate (sandbox only, no posting rights) | GitHub repository secret | Cade, `docs/gate4-checklist.md` |
| `PLAID_SECRET_REF` | **name** of the Key Vault secret holding the Plaid secret | Key Vault `plaid-sandbox-secret` / `plaid-production-secret` | Cade, step 6 |
| (runtime) | Plaid access tokens | Key Vault `plaid-<household>-<item>` | the API, after Link |
| (runtime) | per-household blob encryption keys | Key Vault keys `hh-<household id>` | the API, on household creation |
| (template) | storage account customer-managed key | Key Vault key `storage-cmk` | Bicep |
| `DATABASE_URL` | local development only | your laptop's `.env` (gitignored) | you |
| `PGHOST`, `PGDATABASE`, `PGUSER`, `PG_AUTH=entra`, `AZURE_CLIENT_ID` | cloud database access and which identity asks for tokens | Container Apps environment variables (not secrets; the identity is the credential) | Bicep |
| `FOUNDRY_KEY_REF` | **name** of the Key Vault secret holding the Foundry key | Key Vault `foundry-api-key` | Cade, step 11 |
| `KEY_VAULT_URL`, `STORAGE_ACCOUNT_URL`, `SERVICE_BUS_NAMESPACE`, `DOCUMENT_INTELLIGENCE_ENDPOINT`, `FOUNDRY_ENDPOINT`, `FOUNDRY_MODEL`, `APPLICATIONINSIGHTS_CONNECTION_STRING` | endpoints reached by managed identity | Container Apps environment variables | Bicep |
| `ENTRA_*`, `BC_TENANT_ID`, `BC_CLIENT_ID`, `BC_COMPANY_ID`, `PLAID_CLIENT_ID` | ids | GitHub variables → Bicep → environment variables | Cade, steps 3, 5, 6 |
| Static Web App deployment token | pushes the Console | fetched by the workflow at deploy time with OIDC; never stored | the workflow |
| Expo / Apple signing | TestFlight builds | EAS (Expo) credentials store, per `apps/mobile/README.md` | Cade, step 10 |

Nothing in the table is pasted into chat or the repo. The deploy needs no GitHub secrets; the only GitHub secrets are the three sandbox test-run values (`BC_SANDBOX_TENANT_ID`, `BC_SANDBOX_CLIENT_ID`, `BC_SANDBOX_CERT_PEM`).

## 8. First deploy

1. GitHub → Settings → Variables (repository): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `HOMESTEAD_ADMIN_OBJECT_ID` (`az ad signed-in-user show --query id -o tsv`), `HOMESTEAD_ADMIN_UPN`, `HOMESTEAD_BUDGET_EMAIL`, `HOMESTEAD_BC_TENANT_ID`, `HOMESTEAD_BC_CLIENT_ID`, `HOMESTEAD_BC_COMPANY_ID`, `HOMESTEAD_BC_COMPANY_NAME`, `HOMESTEAD_PLAID_CLIENT_ID`, `HOMESTEAD_ENTRA_TENANT_ID`, `HOMESTEAD_ENTRA_API_AUDIENCE`, `HOMESTEAD_ENTRA_API_SCOPE`, `HOMESTEAD_ENTRA_AUTHORITY`, `HOMESTEAD_ENTRA_KNOWN_AUTHORITY`, `HOMESTEAD_CONSOLE_CLIENT_ID`, and (empty until step 11) `HOMESTEAD_FOUNDRY_ENDPOINT`, `HOMESTEAD_FOUNDRY_MODEL`.
2. Set `DEPLOY_ENABLED` = `true`. Push to `main` (or Actions → Deploy dev → Run workflow). The run creates `rg-homestead-dev`, builds and pushes the image, deploys the API and jobs, builds and publishes the Console, and prints both URLs in its summary. Expect 15–25 minutes the first time (Postgres is the slow one).
3. Give yourself data rights on the new vault (once per environment; by hand so it shows in the portal, per `infra/modules/rbac.bicep`): `rg-homestead-dev` → the `kv-homestead-dev-…` vault → **Access control (IAM) → Add role assignment** → **Key Vault Certificates Officer**, then again for **Key Vault Secrets Officer**, member = your own account. Owner on the subscription manages the vault but cannot read or write what is inside it. Then generate `bc-sandbox-client-cert` in the vault (step 5.2) and load the Plaid secret (step 6.4). The API reads them on its next start: Container Apps → `homestead-dev-api` → Revisions → Restart.
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

The token lasts an hour; nothing is saved.

Then, once per environment, give the API and jobs identities their database roles. They are deliberately not administrators: they get the schema's `homestead_app` role and nothing else (row-level security, insert-only audit log). The names and object ids are in the deployment outputs (`apiIdentityName`, `apiIdentityPrincipalId`, `jobsIdentityName`, `jobsIdentityPrincipalId`):

```sh
export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)
ME=$(az ad signed-in-user show --query userPrincipalName -o tsv)
H=psql-homestead-dev.postgres.database.azure.com
psql "host=$H dbname=postgres user=$ME sslmode=require" \
  -c "select * from pgaadauth_create_principal_with_oid('id-homestead-dev-api',  '<apiIdentityPrincipalId>',  'service', false, false);" \
  -c "select * from pgaadauth_create_principal_with_oid('id-homestead-dev-jobs', '<jobsIdentityPrincipalId>', 'service', false, false);"
psql "host=$H dbname=homestead user=$ME sslmode=require" -c 'grant homestead_app to "id-homestead-dev-api", "id-homestead-dev-jobs";'
unset PGPASSWORD
```

### 9b. Create the household and link your sign-ins

Every table forces row-level security, and in Azure the administrator is not a superuser, so plain SQL as the administrator sees no rows (an `update members …` would quietly change nothing). Two scripts handle it: the household's id is derived from its name and set before the first read.

1. Create the household once (with the same `PGPASSWORD` token as above; the BC ids fill the Console's ledger panel):

   ```sh
   BC_TENANT_ID=<firm tenant id> BC_COMPANY_ID=<BC company id> \
   DATABASE_URL="postgres://cade%40cadejonescpa.com@psql-homestead-dev.postgres.database.azure.com:5432/homestead" \
     npx pnpm@10.28.0 --filter @homestead/shared build && \
   BC_TENANT_ID=<firm tenant id> BC_COMPANY_ID=<BC company id> \
   DATABASE_URL="postgres://cade%40cadejonescpa.com@psql-homestead-dev.postgres.database.azure.com:5432/homestead" \
     npx pnpm@10.28.0 --filter @homestead/api db:seed
   ```

   dev gets the seed's synthetic starting data (accounts by mask, categories, sample budget marked as a sample).
2. You and Vanessa each sign up once through the Console or the phone (step 3.5). Read each Object ID in the family tenant (Entra ID → Users → your name → Object ID; ids are not secrets), then:

   ```sh
   DATABASE_URL="postgres://cade%40cadejonescpa.com@psql-homestead-dev.postgres.database.azure.com:5432/homestead" \
     npx pnpm@10.28.0 --filter @homestead/api db:link-member -- --member Cade --object-id <Cade's object id>
   ```

   and again with `--member Vanessa`. Each link is written to the audit log.

Until a member is linked, that person gets "not signed in" from every screen, which is the intended behavior for anyone else who signs up through the flow.

Remove the firewall rule afterwards if you prefer (`az postgres flexible-server firewall-rule delete`).

The API signs in to Postgres with its managed identity (no password; `PGHOST`, `PGUSER`, `PGDATABASE` set by the templates), and the jobs list households through a security-definer function owned by a non-superuser role (migrations 0006–0007).

## 10. Apple Developer Program (organization)

For TestFlight (phase 5) and the App Store later. Organization enrollment, not individual, so the app belongs to the firm.

1. The firm needs a **D-U-N-S number** (free from Dun & Bradstreet; 1–2 weeks if it does not exist yet) and a legal-entity web domain and email.
2. https://developer.apple.com/programs/enroll/ → Enroll as an organization → Cade as the Account Holder → $99/year.
3. After approval: App Store Connect → New app, bundle id `com.cadejonescpa.homestead` (the phone builder confirms the exact id in `apps/mobile`). Expo's EAS handles signing certificates and provisioning profiles; they live in EAS, not the repo.

## 11. Claude on Microsoft Foundry and Document Intelligence

- **Document Intelligence** is created by the templates (`di-homestead-<env>`, keys disabled, identity access). Nothing to do.
- **Foundry:** create an AI Foundry resource and project in a US region that hosts Claude (Foundry portal → Create project → Homestead subscription, `rg-homestead-dev`), deploy a Haiku-class Claude model with a **US Data Zone Standard** deployment, grant the API identity `id-homestead-dev-api` the **Azure AI User** role on the project, and put the project endpoint and deployment name in `HOMESTEAD_FOUNDRY_ENDPOINT` and `HOMESTEAD_FOUNDRY_MODEL` (variables).
- The API as built still authenticates to Foundry with a key read **by name** (`FOUNDRY_KEY_REF` = `foundry-api-key`); identity access is the target and is listed as an API gap. Until then, from your shell (never chat or the repo):

  ```sh
  read -rs -p 'Foundry key: ' k; echo
  az keyvault secret set --vault-name <kv name> --name foundry-api-key --file <(printf '%s' "$k"); unset k
  ```

  Without the secret the API keeps its offline fake for Ask Homestead and receipt line mapping.

## 12. Checks before calling dev "up"

- `curl https://<api fqdn>/health` answers `{ "ok": true }`.
- The Console signs in with your external-tenant account and shows "BC CADE_Sandbox_vs25" in the sidebar; Health → Connections shows the BC poll within the hour after the first `nightly-poll` run (trigger it by hand: `az containerapp job start -g rg-homestead-dev -n homestead-dev-nightly-poll`).
- Key Vault → Secrets lists `bc-sandbox-client-cert` and `plaid-sandbox-secret` (and `foundry-api-key` once Foundry exists), nothing else typed by a person.
- Cost Management shows the `homestead-monthly` budget.
- `node scripts/secrets-scan.mjs` in the repo is clean (CI runs it too).

## 13. Pilot environment (Phase 5)

The pilot is its own environment (`rg-homestead-pilot`): real read-only feeds through Plaid's Trial plan, the same BC sandbox ledger, geo-redundant file storage, no synthetic data. It is built by the same steps as dev (`.github/workflows/deploy.yml`) but only from a tag, never from a push to `main`.

1. Firm tenant → `homestead-github-deploy` → Federated credentials → add a second **Other issuer** credential: subject `repo:cadejones88@212395518/household-cfo@1426547300:environment:pilot`, name `github-pilot-immutable`, audience `api://AzureADTokenExchange`.
2. GitHub → Settings → Environments → **New environment** `pilot`.
3. GitHub variable `PILOT_DEPLOY_ENABLED` = `true`.
4. Tag and push: `git tag pilot-20261101-1 && git push origin pilot-20261101-1` (or Actions → Deploy pilot → Run workflow, choosing the tag). The run prints the pilot's API and Console URLs.
5. Repeat steps 8.3–8.4 and 9 for the pilot: generate `bc-sandbox-client-cert` in the **pilot** vault and upload its CER to the same BC registration; load `plaid-production-secret` (not the sandbox one) once Plaid approves production access; run the migrations and grant the two identities their role on `psql-homestead-pilot`; add the pilot Console URL to `homestead-console`'s redirect URIs; link your and Vanessa's sign-ins (9b).
6. The phone app's pilot build points at the pilot API (`EXPO_PUBLIC_API_URL`), not dev.

## Open items for Cade

1. ~~External tenant name~~: `homesteadfamily` (10/21/2026).
2. ~~Custom sign-in domain~~: after the pilot (10/21/2026, step 4).
3. The container registry adds about $5/month over the spec's cost table (`infra/README.md`); alternative is a GitHub-hosted image with a stored pull credential, which the spec's "no stored cloud secrets" rule argues against.
4. Document Intelligence tier for the pilot: F0 (500 free pages, may throttle) or S0 (pay per page).
