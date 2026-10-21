# Homestead infrastructure (Bicep)

One Azure environment per resource group — `rg-homestead-dev`, `rg-homestead-pilot`, `rg-homestead-prod` — in West US 3, from the Phase 3 spec ("Stack and hosting", "Security model", "Monthly running cost", "Backup, restore, disaster recovery"). `main.bicep` composes the modules at subscription scope; a `.bicepparam` file per environment carries the differences. GitHub Actions deploys dev on every push to `main` with OIDC federation (`.github/workflows/deploy-dev.yml`); pilot and prod deploy by tag after the gate sign-offs.

Before anything deploys, Cade does the one-time steps in `docs/runbook-azure-setup.md` (subscription, Entra External ID tenant, app registrations, custom domain, Plaid, Apple). This file is about what the templates create and how to run them.

## What gets created

| Module | Resources | Notes |
| --- | --- | --- |
| `monitoring` | Log Analytics `log-homestead-<env>`, Application Insights `appi-homestead-<env>` | 30-day retention, 1 GB/day cap, Entra-only ingestion |
| `identities` | User-assigned identities `id-homestead-<env>-api`, `-jobs` | Created before the apps so RBAC and Postgres users exist first |
| `key-vault` | `kv-homestead-<env>-<suffix>` | RBAC, soft delete 90 days, purge protection; RSA key `storage-cmk` with yearly rotation. **No secret values are created by the template.** |
| `storage` | `sthomestead<env><suffix>` with private containers `receipts`, `imports` | Versioning, 30-day soft delete (blobs and containers), customer-managed key from Key Vault through the account's own identity, shared-key access off, infrastructure encryption. Per-household keys are created at runtime by the API. |
| `postgres` | `psql-homestead-<env>`, database `homestead` | Flexible Server 16, B1ms, 32 GB, PITR 7 days (35 prod), geo-redundant backup in prod, **Entra-only authentication** (Cade + the two identities as administrators; no password exists), TLS required, "allow Azure services" firewall rule |
| `service-bus` | `sb-homestead-<env>-<suffix>`, topic `homestead-outbox`, subscriptions `bc-worker`, `ocr`, `matching`, `alerts` | Standard tier, local auth off, duplicate detection on `MessageId` (10 min), max delivery 10 then dead-letter, each subscription filters `target = '<name>'` |
| `container-registry` | `crhomestead<env><suffix>` (Basic) | Pull by managed identity; admin user off. Not in the spec's cost table: about $5/month |
| `document-intelligence` | `di-homestead-<env>` | F0 (dev) / S0; keys disabled; West US 2 (not offered in West US 3) |
| `container-apps-env` | `cae-homestead-<env>` | Consumption workload profile; logs to Log Analytics through a diagnostic setting (no shared key in the template) |
| `container-apps` | `homestead-<env>-api`; jobs `homestead-<env>-plaid-sync`, `-nightly-poll`, `-webhook-renewal`, `-alerts-digest`, `-autopost-post`, `-outbox-relay` (schedule) and `-bc-worker`, `-ocr`, `-matching`, `-alerts` (event, Service Bus scaler by identity) | 0–2 replicas, scale to zero, external HTTPS, same image, no secrets in configuration |
| `static-web-app` | `stapp-homestead-<env>-console` (Free, West US 2) | Content pushed by the workflow with a token it fetches at deploy time |
| `rbac` | Role assignments for the two identities on the vault, storage, Service Bus, registry, App Insights, Document Intelligence | Listed at the top of `modules/rbac.bicep` |
| `budget` | `homestead-monthly`, $100, subscription scope | Deployed from dev only (`deployBudget`); emails at 80 % actual, 100 % actual, 100 % forecast |

Every resource carries the tags `homestead-env`, `project`, `owner`, `managed-by`.

### Job schedules (UTC; Container Apps cron has no time zone)

| Job | Cron | Mountain time | Why this hour |
| --- | --- | --- | --- |
| plaid-sync | `0 */4 * * *` | every 4 h | Plus on-demand from the Plaid webhook |
| nightly-poll | `0 9 * * *` | 02:00 MST / 03:00 MDT | Spec says 02:00 Mountain; the DST drift lands later, never earlier |
| webhook-renewal | `30 6 * * *` | 23:30 / 00:30 | Well inside the three-day subscription expiry |
| alerts-digest | `0 14 * * *` | 07:00 MST / 08:00 MDT | Never inside the 9 pm–7 am quiet hours |
| autopost-post | `15 * * * *` | hourly | Exits at once unless the household switch and an approved rule allow |
| outbox-relay | `*/5 * * * *` | every 5 min | Safety net behind the API's inline relay |

### Configuration handed to the API and jobs

Plain settings only (see `commonEnv` in `main.bicep`): Postgres host and database (`PG_AUTH=entra`, user = the identity name), Key Vault URL, blob endpoint, Service Bus namespace and topic, Document Intelligence endpoint, Foundry endpoint, Entra and BC ids, and the **names** of the Key Vault secrets to read (`BC_CERT_SECRET_REF`, `PLAID_SECRET_REF`). Names match `services/api/.env.example`.

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

1. Put the secrets in Key Vault **by name** (runbook step 7): `bc-sandbox-client-cert`, `plaid-sandbox-secret` (dev) — never through the repo or a chat.
2. Run the migrations as a Postgres administrator (runbook step 9).
3. Set `PLAID_WEBHOOK_URL` at Plaid and the BC subscription notification URL to `https://<api fqdn>/v1/webhooks/plaid` and `/v1/webhooks/bc` (the API does the BC part itself in the webhook-renewal job).
4. Add the Console's URL to the Console app registration's redirect URIs.

## Validation

`bicep build infra/main.bicep` and `bicep build-params infra/main.<env>.bicepparam` compile cleanly (Bicep CLI 0.48.1, no warnings; every property is checked against the resource API schemas). What this environment could not do: `az deployment sub what-if` (no Azure access here) and a Docker build of the image (no daemon). Both run in the workflow.

## Cost

List prices, family scale (spec: $30–55/month): Postgres B1ms about $15–22, Service Bus Standard about $10, App Insights and Container Apps mostly inside the free grants, Key Vault, storage and Document Intelligence F0 about $1–3. Two additions over the spec table: the container registry (Basic, about $5) and, if Document Intelligence S0 is chosen for the pilot, pay-per-page beyond the free tier. Levers: Service Bus Basic drops the $10 base at the cost of topics; stopping the dev Postgres server when idle (`az postgres flexible-server stop`) keeps dev near $0. The subscription budget alert catches a surprise before it compounds.

## Things to know

- **Two-pass deploys.** With `apiImage` empty the container app and jobs are left out (the first run has no image yet; later runs leave the live revision alone). Incremental mode never deletes what a pass omits.
- **Entra-only Postgres.** There is no password. The API and jobs sign in as their identities (token for `https://ossrdbms-aad.database.windows.net/.default`); Cade signs in with `az account get-access-token --resource-type oss-rdbms` as the password. Each identity's Postgres role is created by the `administrators` resource; the schema's RLS role setup (`0001_schema.sql`) still applies.
- **Public endpoints with identity, not private endpoints.** Container Apps on the consumption plan has dynamic outbound IPs, so Postgres, Key Vault, storage and Service Bus accept Azure traffic over TLS and rely on RBAC. Private endpoints need a VNet-integrated environment; that is a prod-hardening item, not an MVP one.
- **Static Web Apps region.** West US 2, because the Free tier is not offered in West US 3; the content is served from the edge regardless.
- **Custom domains** (`homestead.cadejonescpa.com` for sign-in, a console hostname later) are DNS steps in the runbook, not resources here. The Entra External ID custom URL domain requires Azure Front Door; see the runbook for the cost.
- **Secrets never pass through this folder.** The templates only reserve names; if you find yourself typing a secret value into a `.bicepparam`, stop — it goes into Key Vault from your own shell.
