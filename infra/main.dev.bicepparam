// dev: synthetic data only, BC sandbox, Plaid Sandbox (spec: Environments). Values that are ids (never secrets)
// are filled by the deploy workflow from repository variables, or by Cade on the command line:
//   --parameters adminObjectId=<guid> adminPrincipalName=<upn> ...
using './main.bicep'

param env = 'dev'
param location = 'westus3'

// Who administers Postgres (migrations, support). Provided at deploy time.
param adminObjectId = readEnvironmentVariable('HOMESTEAD_ADMIN_OBJECT_ID', '00000000-0000-0000-0000-000000000000')
param adminPrincipalName = readEnvironmentVariable('HOMESTEAD_ADMIN_UPN', 'cade@example.invalid')

// Image: empty on the first pass; the workflow sets it on the second.
param apiImage = readEnvironmentVariable('HOMESTEAD_API_IMAGE', '')

// Business Central sandbox (ids only; the certificate is in Key Vault under bcCertSecretName)
param bcEnvironment = 'CADE_Sandbox_vs25'
param bcTenantId = readEnvironmentVariable('HOMESTEAD_BC_TENANT_ID', '')
param bcCompanyId = readEnvironmentVariable('HOMESTEAD_BC_COMPANY_ID', '')
param bcClientId = readEnvironmentVariable('HOMESTEAD_BC_CLIENT_ID', '')
param bcCertSecretName = 'bc-sandbox-client-cert'

// Plaid Sandbox (fake institutions)
param plaidEnv = 'sandbox'
param plaidClientId = readEnvironmentVariable('HOMESTEAD_PLAID_CLIENT_ID', '')
param plaidSecretName = 'plaid-sandbox-secret'

// Entra External ID (same tenant for every environment; separate app registrations are a later hardening step)
param entraTenantId = readEnvironmentVariable('HOMESTEAD_ENTRA_TENANT_ID', '')
param entraTenantDomain = 'homestead.cadejonescpa.com'
param entraApiAudience = readEnvironmentVariable('HOMESTEAD_ENTRA_API_AUDIENCE', '')

param foundryEndpoint = readEnvironmentVariable('HOMESTEAD_FOUNDRY_ENDPOINT', '')
param foundryModel = readEnvironmentVariable('HOMESTEAD_FOUNDRY_MODEL', '')

param postgresBackupRetentionDays = 7
param postgresGeoRedundantBackup = 'Disabled'
param storageSku = 'Standard_LRS'
param documentIntelligenceSku = 'F0'
param autoPostJobEnabled = false

// The one subscription-wide budget is deployed from dev.
param deployBudget = true
param budgetStartDate = '2026-11-01'
param budgetContactEmails = [readEnvironmentVariable('HOMESTEAD_BUDGET_EMAIL', 'cade@example.invalid')]
