// Homestead — one environment (dev | pilot | prod) in its own resource group rg-homestead-<env>, West US 3.
// Deployed at subscription scope by GitHub Actions with OIDC (.github/workflows/deploy-dev.yml) or by Cade:
//
//   az deployment sub create --location westus3 --template-file infra/main.bicep \
//     --parameters infra/main.dev.bicepparam
//
// Two-pass deploys: with `apiImage` empty the container app and jobs are skipped (everything else, including
// the registry, is created or updated); the workflow then builds and pushes the image and deploys again with
// `apiImage` set. Incremental mode never deletes what a pass leaves out.
//
// Nothing here is specific to one household: per-family values live in the database and in Key Vault.

targetScope = 'subscription'

@allowed(['dev', 'pilot', 'prod'])
param env string

@description('Region for everything except Static Web Apps and Document Intelligence (spec: West US 3)')
param location string = 'westus3'

@description('Entra object id of Cade (Postgres administrator for migrations and support)')
param adminObjectId string
@description('Cade\'s UPN in the firm\'s tenant')
param adminPrincipalName string

@description('Full image reference for the API and jobs; empty skips the container app and jobs (first pass)')
param apiImage string = ''

@description('Business Central environment name for this deployment (dev and pilot: the sandbox)')
param bcEnvironment string = 'CADE_Sandbox_vs25'
@description('Business Central tenant id (the firm\'s workforce tenant); not a secret')
param bcTenantId string = ''
@description('BC company id (GUID) in that environment; not a secret')
param bcCompanyId string = ''
@description('Client id of the BC app registration for this environment; not a secret')
param bcClientId string = ''
@description('Key Vault secret name holding the BC certificate (PEM) for this environment')
param bcCertSecretName string = 'bc-sandbox-client-cert'

@description('Plaid environment. Plaid retired "development" in 2024: the pilot uses production under the free Trial (limited production) plan with live read-only logins')
@allowed(['sandbox', 'production'])
param plaidEnv string = 'sandbox'
@description('Plaid client id; not a secret')
param plaidClientId string = ''
@description('Key Vault secret name holding the Plaid secret for this environment')
param plaidSecretName string = 'plaid-sandbox-secret'

@description('Entra External ID: tenant id, the sign-in host, and the API app registration client id (audience)')
param entraTenantId string = ''
@description('Where the family signs in: homesteadfamily.ciamlogin.com through the pilot (decided 10/21/2026); the custom URL domain later')
param entraSignInHost string = 'homesteadfamily.ciamlogin.com'
@description('True while a Conditional Access policy in the sign-in tenant requires MFA for every token to the API (External ID issues no amr claim to prove it per token).')
param entraMfaByPolicy bool = true
param entraApiAudience string = ''

@description('Foundry endpoint and model deployment name for Ask Homestead and receipt line mapping; created by hand')
param foundryEndpoint string = ''
param foundryModel string = ''
@description('Key Vault secret name holding the Foundry key. The API as built reads a key by name (services/api/src/deps.ts); without the secret it keeps its offline fake')
param foundryKeySecretName string = 'foundry-api-key'

@description('Browser origins allowed to call the API besides the Console\'s Static Web App (for example a custom console hostname, or http://localhost:5174 in dev)')
param consoleExtraOrigins array = []

@description('Region for the Postgres server; defaults to the deployment region. The pilot uses westus2 because Azure would not create a new Burstable server in westus3 for this subscription (SkuNotAvailable, 10/23/2026).')
param postgresLocation string = location

@description('Postgres backup retention: 7 (dev, pilot) or 35 (prod)')
param postgresBackupRetentionDays int = 7
@allowed(['Enabled', 'Disabled'])
param postgresGeoRedundantBackup string = 'Disabled'

@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS'])
param storageSku string = 'Standard_LRS'

@allowed(['F0', 'S0'])
param documentIntelligenceSku string = 'F0'
param documentIntelligenceLocation string = 'westus2'
param staticWebAppLocation string = 'westus2'

@description('Honour the household auto-post switch in the autopost-post job (false until the first rules are approved)')
param autoPostJobEnabled bool = false

@description('Deploy the subscription-level $100 budget from this environment (true in dev only, so three deployments do not fight over it)')
param deployBudget bool = false
param budgetStartDate string = '2026-11-01'
param budgetContactEmails array = []

var tags = {
  'homestead-env': env
  project: 'homestead'
  owner: 'Cade T. Jones CPA, P.C.'
  'managed-by': 'bicep'
}

// Globally unique names (storage, vault, registry, service bus) get a short suffix derived from the subscription.
var suffix = take(uniqueString(subscription().subscriptionId, 'homestead', env), 6)

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-homestead-${env}'
  location: location
  tags: tags
}

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring'
  params: { env: env, location: location, tags: tags }
}

module identities 'modules/identities.bicep' = {
  scope: rg
  name: 'identities'
  params: { env: env, location: location, tags: tags }
}

module keyVault 'modules/key-vault.bicep' = {
  scope: rg
  name: 'key-vault'
  params: { env: env, location: location, tags: tags, suffix: suffix }
}

module storage 'modules/storage.bicep' = {
  scope: rg
  name: 'storage'
  params: {
    env: env
    location: location
    tags: tags
    suffix: suffix
    keyVaultId: keyVault.outputs.vaultId
    keyVaultUri: keyVault.outputs.vaultUri
    cmkKeyName: keyVault.outputs.storageCmkKeyName
    skuName: storageSku
  }
}

module postgres 'modules/postgres.bicep' = {
  scope: rg
  name: 'postgres'
  params: {
    env: env
    location: postgresLocation
    tags: tags
    adminObjectId: adminObjectId
    adminPrincipalName: adminPrincipalName
    backupRetentionDays: postgresBackupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
  }
}

module serviceBus 'modules/service-bus.bicep' = {
  scope: rg
  name: 'service-bus'
  params: { env: env, location: location, tags: tags, suffix: suffix }
}

module registry 'modules/container-registry.bicep' = {
  scope: rg
  name: 'container-registry'
  params: { env: env, location: location, tags: tags, suffix: suffix }
}

module documentIntelligence 'modules/document-intelligence.bicep' = {
  scope: rg
  name: 'document-intelligence'
  params: { env: env, tags: tags, location: documentIntelligenceLocation, skuName: documentIntelligenceSku }
}

module containerAppsEnv 'modules/container-apps-env.bicep' = {
  scope: rg
  name: 'container-apps-env'
  params: { env: env, location: location, tags: tags, logAnalyticsWorkspaceId: monitoring.outputs.workspaceId }
}

module rbac 'modules/rbac.bicep' = {
  scope: rg
  name: 'rbac'
  params: {
    keyVaultName: keyVault.outputs.vaultName
    storageAccountName: storage.outputs.accountName
    serviceBusNamespaceName: serviceBus.outputs.namespaceName
    registryName: registry.outputs.registryName
    appInsightsName: 'appi-homestead-${env}'
    documentIntelligenceName: 'di-homestead-${env}'
    apiPrincipalId: identities.outputs.apiPrincipalId
    jobsPrincipalId: identities.outputs.jobsPrincipalId
  }
  dependsOn: [monitoring, documentIntelligence]
}

// Plain configuration shared by the API and the jobs. Names match services/api/.env.example; the values that are
// secrets (BC certificate, Plaid secret, Plaid tokens) are referenced by Key Vault *name* and read at runtime.
var commonEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'HOMESTEAD_ENV', value: env }
  { name: 'PORT', value: '8080' }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'TZ', value: 'UTC' }
  // Postgres: Entra authentication with the container's identity; no DATABASE_URL in the cloud.
  { name: 'PGHOST', value: postgres.outputs.fqdn }
  { name: 'PGDATABASE', value: postgres.outputs.databaseName }
  { name: 'PGPORT', value: '5432' }
  { name: 'PGSSLMODE', value: 'require' }
  { name: 'PG_AUTH', value: 'entra' } // PGUSER and AZURE_CLIENT_ID are set per role in container-apps.bicep
  // Entra External ID
  { name: 'ENTRA_TENANT_ID', value: entraTenantId }
  { name: 'ENTRA_SIGN_IN_HOST', value: entraSignInHost }
  { name: 'ENTRA_API_AUDIENCE', value: entraApiAudience }
  // External ID tokens name the tenant-id host as issuer whichever host signed the user in (the tenant's discovery
  // document, checked 10/21/2026). Re-check it when the custom URL domain is added. The keys come from the sign-in host.
  { name: 'ENTRA_ISSUER', value: empty(entraTenantId) ? '' : 'https://${entraTenantId}.ciamlogin.com/${entraTenantId}/v2.0' }
  { name: 'ENTRA_JWKS_URI', value: empty(entraTenantId) ? '' : 'https://${entraSignInHost}/${entraTenantId}/discovery/v2.0/keys' }
  // External ID tokens carry no `amr`; Conditional Access ("Homestead MFA" on homestead-api) requires the emailed code
  // for every token to the API, so step-up trusts the policy (services/api/src/lib/auth.ts hasFreshStepUp).
  { name: 'ENTRA_MFA_BY_POLICY', value: entraMfaByPolicy ? 'true' : 'false' }
  // Business Central (certificate by Key Vault name)
  { name: 'BC_TENANT_ID', value: bcTenantId }
  { name: 'BC_ENVIRONMENT', value: bcEnvironment }
  { name: 'BC_COMPANY_ID', value: bcCompanyId }
  { name: 'BC_CLIENT_ID', value: bcClientId }
  { name: 'BC_CERT_SECRET_REF', value: bcCertSecretName }
  { name: 'BC_API_BASE_URL', value: 'https://api.businesscentral.dynamics.com/v2.0' }
  // Plaid (secret by Key Vault name)
  { name: 'PLAID_ENV', value: plaidEnv }
  { name: 'PLAID_CLIENT_ID', value: plaidClientId }
  { name: 'PLAID_SECRET_REF', value: plaidSecretName }
  // Azure services, all reached by identity
  { name: 'KEY_VAULT_URL', value: keyVault.outputs.vaultUri }
  { name: 'STORAGE_ACCOUNT_URL', value: storage.outputs.blobEndpoint }
  { name: 'SERVICE_BUS_NAMESPACE', value: serviceBus.outputs.fullyQualifiedNamespace }
  { name: 'SERVICE_BUS_TOPIC', value: serviceBus.outputs.topicName }
  { name: 'DOCUMENT_INTELLIGENCE_ENDPOINT', value: documentIntelligence.outputs.endpoint }
  { name: 'FOUNDRY_ENDPOINT', value: foundryEndpoint }
  { name: 'FOUNDRY_MODEL', value: foundryModel }
  { name: 'FOUNDRY_KEY_REF', value: empty(foundryEndpoint) ? '' : foundryKeySecretName }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: monitoring.outputs.appInsightsConnectionString }
]

module containerApps 'modules/container-apps.bicep' = if (!empty(apiImage)) {
  scope: rg
  name: 'container-apps'
  params: {
    env: env
    location: location
    tags: tags
    environmentId: containerAppsEnv.outputs.environmentId
    environmentDefaultDomain: containerAppsEnv.outputs.defaultDomain
    registryLoginServer: registry.outputs.loginServer
    image: apiImage
    apiIdentityId: identities.outputs.apiIdentityId
    apiIdentityName: identities.outputs.apiIdentityName
    apiClientId: identities.outputs.apiClientId
    jobsIdentityId: identities.outputs.jobsIdentityId
    jobsIdentityName: identities.outputs.jobsIdentityName
    jobsClientId: identities.outputs.jobsClientId
    commonEnv: commonEnv
    corsOrigins: concat([staticWebApp.outputs.consoleUrl], consoleExtraOrigins)
    serviceBusNamespaceName: serviceBus.outputs.namespaceName
    serviceBusTopicName: serviceBus.outputs.topicName
    autoPostJobEnabled: autoPostJobEnabled
  }
  dependsOn: [rbac]
}

module staticWebApp 'modules/static-web-app.bicep' = {
  scope: rg
  name: 'static-web-app'
  params: { env: env, tags: tags, location: staticWebAppLocation }
}

module budget 'modules/budget.bicep' = if (deployBudget) {
  name: 'budget'
  params: { amount: 100, startDate: budgetStartDate, contactEmails: budgetContactEmails }
}

// PLAID_WEBHOOK_URL and the BC webhook notification URL point here; the phone app and Console use apiUrl.
output resourceGroupName string = rg.name
output registryLoginServer string = registry.outputs.loginServer
output registryName string = registry.outputs.registryName
output keyVaultName string = keyVault.outputs.vaultName
output keyVaultUri string = keyVault.outputs.vaultUri
output storageAccountName string = storage.outputs.accountName
output postgresFqdn string = postgres.outputs.fqdn
output serviceBusNamespace string = serviceBus.outputs.fullyQualifiedNamespace
output containerAppsEnvironment string = containerAppsEnv.outputs.environmentName
output apiName string = containerApps.?outputs.apiName ?? 'homestead-${env}-api'
output apiUrl string = containerApps.?outputs.apiUrl ?? ''
output jobNames array = containerApps.?outputs.jobNames ?? []
output staticWebAppName string = staticWebApp.outputs.siteName
output consoleUrl string = staticWebApp.outputs.consoleUrl
output documentIntelligenceEndpoint string = documentIntelligence.outputs.endpoint
output apiIdentityClientId string = identities.outputs.apiClientId
output jobsIdentityClientId string = identities.outputs.jobsClientId
// For the one-time Postgres role step (infra/README.md, "Postgres roles"): role name and Entra object id.
output apiIdentityName string = identities.outputs.apiIdentityName
output apiIdentityPrincipalId string = identities.outputs.apiPrincipalId
output jobsIdentityName string = identities.outputs.jobsIdentityName
output jobsIdentityPrincipalId string = identities.outputs.jobsPrincipalId
output postgresServerName string = postgres.outputs.serverName
