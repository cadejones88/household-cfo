# Homestead infrastructure (Bicep)

One Azure environment per resource group — `rg-homestead-dev`, `rg-homestead-pilot`, `rg-homestead-prod` — in West US 3, from the Phase 3 spec ("Stack and hosting", "Security model", "Monthly running cost", "Backup, restore, disaster recovery"). `main.bicep` composes the modules at subscription scope; a `.bicepparam` file per environment carries the differences. GitHub Actions deploys dev on every push to `main` with OIDC federation (`.github/workflows/deploy-dev.yml`, guarded by the repository variable `DEPLOY_ENABLED=true`); pilot and prod use the same templates from the command line below after the gate sign-offs (a tag-triggered workflow is a later addition).

Before anything deploys, Cade does the one-time steps in `docs/runbook-azure-setup.md` (subscription, Entra External ID tenant, app registrations, custom domain, Plaid, Apple). This file is about what the templates create and how to run them.

## What gets created

| Module | Resources | Notes |
| --- | --- | --- |
| `monitoring` | Log Analytics `log-homestead-<env>`, Application Insights `appi-homestead-<env>` | 30-day retention, 1 GB/day cap, Entra-only ingestion |
| `identities` | User-assigned identities `id-homestead-<env>-api`, `-jobs` | Created before the apps so RBAC and Postgres users exist first |
| `key-vault` | `kv-homestead-<env>-<suffix>` | RBAC, soft delete 90 days, purge protection; RSA key `storage-cmk` with yearly rotation. **No secret values are created by the template.** |
| `storage` | `sthomestead<env><suffix>` with private containers `receipts`, `imports` | Versioning, 30-day soft delete (blobs and containers), customer-managed key from Key Vault through the account's own identity, shared-key access off, infrastructure encryption. Per-household keys are created at runtime by the API. |
| `postgres` | `psql-homestead-<env>`, database `homestead` | Flexible Server 16, B1ms, 32 GB, PITR 7 days (35 prod), geo-redundant backup in prod, **Entra-only authentication** (no password exists; Cade is the only administrator; the two identities are ordinary roles in `homestead_app`, created once by SQL, see "Postgres roles"), TLS required, "allow Azure services" firewall rule |
| `service-bus` | `sb-homestead-<env>-<suffix>`, topic `homestead-outbox`, subscriptions `bc-worker`, `ocr`, `matching`, `alerts` | Standard tier, local auth off, duplicate detection on `MessageId` (10 min), max delivery 10 then dead-letter, each subscription filters `target = '<name>'` |
| `container-registry` | `crhomestead<env><suffix>` (Basic) | Pull by managed identity; admin user off. Not in the spec's cost table: about $5/month |
| `document-intelligence` | `di-homestead-<env>` | F0 (dev) / S0; keys disabled; West US 2 (not offered in West US 3) |
| `container-apps-env` | `cae-homestead-<env>` | Consumption workload profile; logs to Log Analytics through a diagnostic setting (no shared key in the template) |
| `container-apps` | `homestead-<env>-api`; scheduled jobs `-plaid-sync`, `-nightly-poll`, `-webhook-renewal`, `-alerts-hourly`, `-autopost-post`, `-outbox-relay`, `-receipt-fallback`, `-pay-fallback`, `-rule-proposals`, `-ocr-sweep`, `-matching-sweep`; event jobs `-bc-worker`, `-ocr`, `-matching`, `-alerts` (Service Bus scaler by identity) | 0–2 replicas, scale to zero, external HTTPS, same image, no secrets in configuration; CORS answered by the API for the Console's origin only |
| `static-web-app` | `stapp-homestead-<env>-console` (Free, West US 2) | Content pushed by the workflow with a token it fetches at deploy time |
| `rbac` | Role assignments for the two identities on the vault, storage, Service Bus, registry, App Insights, Document Intelligence | Listed at the top of `modules/rbac.bicep` |
| `budget` | `homestead-monthly`, $100, subscription scope | Deployed from dev only (`deployBudget`); emails at 80 % actual, 100 % actual, 100 % forecast |

Every resource carries the tags `homestead-env`, `project`, `owner`, `managed-by`.

### Job schedules (UTC; Container Apps cron has no time zone)

Each job resource runs one job name from `services/jobs/src/index.ts` (`node services/jobs/dist/index.js <job>`).

| Resource | Job | Cron | Mountain time | Why |
| --- | --- | --- | --- | --- |
| plaid-sync | plaid-sync | `0 */4 * * *` | every 4 h | Plus on-demand from the Plaid webhook |
| nightly-poll | nightly-poll | `0 9 * * *` | 02:00 MST / 03:00 MDT | Spec says 02:00 Mountain; the DST drift lands later, never earlier |
| webhook-renewal | webhook-renewal | `30 6 * * *` | 23:30 / 00:30 | Well inside the three-day subscription expiry |
| alerts-hourly | alerts | `0 * * * *` | hourly | The job decides in America/Boise time (DST-aware, ±30 min) when the 07:00 digest and the weekly pulse are due and holds pushes in quiet hours. No single UTC hour is 07:00 Boise in both MST and MDT; hourly is. |
| autopost-post | autopost-post | `15 * * * *` | hourly | Exits at once unless the household switch and an approved rule allow |
| outbox-relay | outbox-relay | `*/5 * * * *` | every 5 min | Relays and works the outbox in process (BC writes, post requests, read-backs) |
| receipt-fallback | receipt-fallback | `0 8 * * *` | 01:00 / 02:00 | Estimated split after 10 days without a receipt |
| pay-fallback | paycheck-template-fallback | `10 8 * * *` | 01:10 / 02:10 | Template estimate after 3 days without a stub |
| rule-proposals | rule-proposals | `20 8 * * *` | 01:20 / 02:20 | Proposals only; a spouse approves |
| ocr-sweep | ocr | `*/30 * * * *` | every 30 min | Until Service Bus feeds the event job (see below) |
| matching-sweep | matching | `5,35 * * * *` | every 30 min | Until Service Bus feeds the event job (see below) |

The two sweeps exist because this build of the API relays the outbox in process (`QueuePort` is in-memory, "Service Bus later"), so nothing reaches the topic and the event-triggered jobs never start. When the API publishes to Service Bus, each event job must also *complete* its subscription's messages; until it does, a published message keeps KEDA starting that job every 30 seconds (about $20 a month, which the budget alert would catch).

### Configuration handed to the API and jobs

Plain settings only (`commonEnv` in `main.bicep`, plus per-role values in `modules/container-apps.bicep`): Postgres host and database (`PG_AUTH=entra`, `PGUSER` = the identity's role name), `AZURE_CLIENT_ID` (which user-assigned identity to ask for tokens), Key Vault URL, blob endpoint, Service Bus namespace and topic, Document Intelligence endpoint, Foundry endpoint and model, Entra and BC ids, `CORS_ORIGINS` (the Console's Static Web App URL, plus `consoleExtraOrigins`), `PLAID_WEBHOOK_URL` and the jobs' `WEBHOOK_BASE_URL` (both derived from the environment's default domain, so they are right on the first deploy), and the **names** of the Key Vault secrets to read (`BC_CERT_SECRET_REF`, `PLAID_SECRET_REF`, `FOUNDRY_KEY_REF`). Names match `services/api/.env.example`.

### What the API build does not do yet (blocks a working cloud deploy, not the templates)

The templates follow the spec (identity everywhere, no connection strings). Four things on the code side have to land before dev runs end to end; they are listed for the API and jobs builders:

1. **Postgres by identity.** `services/api/src/db/index.ts` only reads `DATABASE_URL`. It needs a `PG_AUTH=entra` path: `pg.Pool({ host: PGHOST, database: PGDATABASE, user: PGUSER, ssl: true, password: async () => <token for https://ossrdbms-aad.database.windows.net/.default> })`.
2. **User-assigned identity tokens.** `managedIdentityTokenProvider` (services/api/src/services/ports.ts) calls the Container Apps identity endpoint without `client_id`; with only user-assigned identities that request fails. Append `&client_id=${AZURE_CLIENT_ID}` (set here per role).
3. **Jobs and row-level security.** `listHouseholdIds` selects `households` with no `app.household_id` set; under `FORCE ROW LEVEL SECURITY` a non-superuser (every Azure role, administrators included) sees no rows, so every job would run for zero households. It needs a `security definer` function like `members_lookup_fn` (0002) that returns household ids.
4. **Service Bus.** `QueuePort` is in-memory; see the sweeps above.

## Deploy

```sh
az login                                  # the firm's tenant, the Homestead subscription
az account set --subscription <id>

# dev, first time or any time (two passes: infrastructure, then the app with an image)
export HOMESTEAD_ADMIN_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)
export HOMESTEAD_ADMIN_UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)
export HOMESTEAD_BUDGET_EMAIL=cade@cadejonescpa.com
export HOMESTEAD_BC_TENANT_ID=... HOMESTEAD_BC_COMPANY_ID=... HOMESTEAD_BC_CLIENT_ID=...   # ids, not secrets
az deployment sub create --location westus3 --template-file infra/main.bicep --parameters infra/main.dev.bicepparam

# build and push the image (needs Docker), then pass 2
az acr login --name $(az deployment sub show -n <deployment name> --query properties.outputs.registryName.value -o tsv)
docker build -f services/api/Dockerfile -t <registry>.azurecr.io/homestead-api:<tag> .
docker push <registry>.azurecr.io/homestead-api:<tag>
HOMESTEAD_API_IMAGE=<registry>.azurecr.io/homestead-api:<tag> \
  az deployment sub create --location westus3 --template-file infra/main.bicep --parameters infra/main.dev.bicepparam

# what-if before pilot or prod
az deployment sub what-if --location westus3 --template-file infra/main.bicep --parameters infra/main.pilot.bicepparam
```

The `.bicepparam` files read ids from `HOMESTEAD_*` environment variables (with placeholder defaults) so the same file serves the workflow and a laptop. Pilot and prod use the same template with 35-day PITR, geo-redundant backups, GRS blobs and the paid Document Intelligence tier in prod.

### After the first deploy

1. Put the secrets in Key Vault **by name** (runbook step 7): `bc-sandbox-client-cert`, `plaid-sandbox-secret` (dev), and `foundry-api-key` once Foundry exists — never through the repo or a chat.
2. Run the migrations as the Postgres administrator, then create the two identity roles (runbook step 9, and "Postgres roles" below).
3. Nothing to set for webhooks: the API passes `PLAID_WEBHOOK_URL` (`https://<api fqdn>/v1/webhooks/plaid`) to Plaid on each link token, and the webhook-renewal job registers `https://<api fqdn>/v1/webhooks/bc` with BC.
4. Add the Console's URL to the Console app registration's redirect URIs.

### Postgres roles

Once per environment, after the migrations (which create `homestead_app`). Connect as the administrator (runbook step 9 shows how) to the **`postgres`** database and create one role per identity from the deployment outputs `apiIdentityName`/`apiIdentityPrincipalId` and `jobsIdentityName`/`jobsIdentityPrincipalId`:

```sql
-- database: postgres
select * from pgaadauth_create_principal_with_oid('id-homestead-dev-api',  '<apiIdentityPrincipalId>',  'service', false, false);
select * from pgaadauth_create_principal_with_oid('id-homestead-dev-jobs', '<jobsIdentityPrincipalId>', 'service', false, false);
-- database: homestead
grant homestead_app to "id-homestead-dev-api", "id-homestead-dev-jobs";
```

The roles get nothing but `homestead_app`: row-level security applies, the audit log and settings history are insert-only, and neither identity owns a table or can create roles.

## Validation

`bicep build infra/main.bicep`, `bicep lint infra/main.bicep` and `bicep build-params infra/main.<env>.bicepparam` for all three environments compile cleanly (Bicep CLI 0.48.1, no warnings; every property is checked against the resource API schemas; the longest job name, `homestead-pilot-receipt-fallback`, is exactly the 32-character limit). What this environment could not do: `az deployment sub what-if` (no Azure access here) and `docker build` (no daemon). The image layout was checked by running the Dockerfile's `pnpm deploy` steps into `services/api` and `services/jobs` folders: the API answers `/health` from `node services/api/dist/server.js`, and the jobs entry point runs from `node services/jobs/dist/index.js` (from the earlier flat `/app/jobs` layout it exited 0 without running anything). Both build steps run in the workflow.

## Cost

List prices, family scale (spec: $30–55/month): Postgres B1ms about $15–22, Service Bus Standard about $10, App Insights and Container Apps mostly inside the free grants (the schedules above start about 440 short job executions a day, roughly 65,000 vCPU-seconds a month against the 180,000 free), Key Vault, storage and Document Intelligence F0 about $1–3. Two additions over the spec table: the container registry (Basic, about $5) and, if Document Intelligence S0 is chosen for the pilot, pay-per-page beyond the free tier. Levers: Service Bus Basic drops the $10 base at the cost of topics; stopping the dev Postgres server when idle (`az postgres flexible-server stop`) keeps dev near $0. The subscription budget alert catches a surprise before it compounds.

## Things to know

- **Two-pass deploys.** With `apiImage` empty the container app and jobs are left out (the first run has no image yet; later runs leave the live revision alone). Incremental mode never deletes what a pass omits.
- **Entra-only Postgres.** There is no password. The API and jobs sign in as their identities (token for `https://ossrdbms-aad.database.windows.net/.default`); Cade signs in with `az account get-access-token --resource-type oss-rdbms` as the password. Cade is the only administrator; the identity roles are created by SQL ("Postgres roles") and are members of `homestead_app` only.
- **Public endpoints with identity, not private endpoints.** Container Apps on the consumption plan has dynamic outbound IPs, so Postgres, Key Vault, storage and Service Bus accept Azure traffic over TLS and rely on RBAC. Private endpoints need a VNet-integrated environment; that is a prod-hardening item, not an MVP one.
- **Static Web Apps region.** West US 2, because the Free tier is not offered in West US 3; the content is served from the edge regardless.
- **Custom domains** (`homestead.cadejonescpa.com` for sign-in, a console hostname later) are DNS steps in the runbook, not resources here. The Entra External ID custom URL domain requires Azure Front Door; see the runbook for the cost.
- **Secrets never pass through this folder.** The templates only reserve names; if you find yourself typing a secret value into a `.bicepparam`, stop — it goes into Key Vault from your own shell.
