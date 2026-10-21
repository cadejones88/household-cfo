// prod: the production BC company, after written approval by both spouses (Gate 5). Separate resource group,
// separate BC app registration and certificate, 35-day point-in-time restore with geo-redundant backups
// (spec: Data protection, DR). Deployed by tag.
using './main.bicep'

param env = 'prod'
param location = 'westus3'

param adminObjectId = readEnvironmentVariable('HOMESTEAD_ADMIN_OBJECT_ID', '00000000-0000-0000-0000-000000000000')
param adminPrincipalName = readEnvironmentVariable('HOMESTEAD_ADMIN_UPN', 'cade@example.invalid')
param apiImage = readEnvironmentVariable('HOMESTEAD_API_IMAGE', '')

// The production environment name and company id are set only when Gate 5 is signed.
param bcEnvironment = readEnvironmentVariable('HOMESTEAD_BC_ENVIRONMENT', 'Production')
param bcTenantId = readEnvironmentVariable('HOMESTEAD_BC_TENANT_ID', '')
param bcCompanyId = readEnvironmentVariable('HOMESTEAD_BC_COMPANY_ID', '')
param bcClientId = readEnvironmentVariable('HOMESTEAD_BC_CLIENT_ID', '')
param bcCertSecretName = 'bc-prod-client-cert'

param plaidEnv = 'production'
param plaidClientId = readEnvironmentVariable('HOMESTEAD_PLAID_CLIENT_ID', '')
param plaidSecretName = 'plaid-production-secret'

param entraTenantId = readEnvironmentVariable('HOMESTEAD_ENTRA_TENANT_ID', '')
param entraTenantDomain = 'homestead.cadejonescpa.com'
param entraApiAudience = readEnvironmentVariable('HOMESTEAD_ENTRA_API_AUDIENCE', '')

param foundryEndpoint = readEnvironmentVariable('HOMESTEAD_FOUNDRY_ENDPOINT', '')
param foundryModel = readEnvironmentVariable('HOMESTEAD_FOUNDRY_MODEL', '')

param postgresBackupRetentionDays = 35
param postgresGeoRedundantBackup = 'Enabled'
param storageSku = 'Standard_GRS'
param documentIntelligenceSku = 'S0'
// Stays false until R2, R3 and R7 pass their sandbox test and Cade approves them in writing (decision 4).
param autoPostJobEnabled = false

param deployBudget = false
