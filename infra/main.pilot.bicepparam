// pilot: real feeds (Plaid Trial, live read-only logins), BC sandbox ledger, one-month parallel run (Phase 5).
// Deployed by tag after the gate sign-off; same parameters as dev except the data-protection settings.
using './main.bicep'

param env = 'pilot'
param location = 'westus3'

param adminObjectId = readEnvironmentVariable('HOMESTEAD_ADMIN_OBJECT_ID', '00000000-0000-0000-0000-000000000000')
param adminPrincipalName = readEnvironmentVariable('HOMESTEAD_ADMIN_UPN', 'cade@example.invalid')
param apiImage = readEnvironmentVariable('HOMESTEAD_API_IMAGE', '')

param bcEnvironment = 'CADE_Sandbox_vs25'
param bcTenantId = readEnvironmentVariable('HOMESTEAD_BC_TENANT_ID', '')
param bcCompanyId = readEnvironmentVariable('HOMESTEAD_BC_COMPANY_ID', '')
param bcClientId = readEnvironmentVariable('HOMESTEAD_BC_CLIENT_ID', '')
param bcCertSecretName = 'bc-sandbox-client-cert'

// Plaid Trial (limited production): live institutions, read-only, inside the free item limit. Plaid has no
// separate "development" environment any more; the production secret is used with the Trial plan.
param plaidEnv = 'production'
param plaidClientId = readEnvironmentVariable('HOMESTEAD_PLAID_CLIENT_ID', '')
param plaidSecretName = 'plaid-production-secret'

param entraTenantId = readEnvironmentVariable('HOMESTEAD_ENTRA_TENANT_ID', '')
param entraSignInHost = 'homesteadfamily.ciamlogin.com' // custom domain skipped for the pilot (10/21/2026)
param entraApiAudience = readEnvironmentVariable('HOMESTEAD_ENTRA_API_AUDIENCE', '')

param foundryEndpoint = readEnvironmentVariable('HOMESTEAD_FOUNDRY_ENDPOINT', '')
param foundryModel = readEnvironmentVariable('HOMESTEAD_FOUNDRY_MODEL', '')

// Real receipts and real transactions: geo-redundant blobs, 7-day PITR, paid Document Intelligence tier.
param postgresBackupRetentionDays = 7
param postgresGeoRedundantBackup = 'Disabled'
param storageSku = 'Standard_GRS'
param documentIntelligenceSku = 'S0'
param autoPostJobEnabled = false

param deployBudget = false
