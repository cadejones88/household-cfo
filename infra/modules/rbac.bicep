// Who may do what, by managed identity (spec: Services and secrets, "managed identities with RBAC; no
// connection strings"). Every assignment is scoped to one resource. Nothing here is a person; Cade's and the
// GitHub deployer's rights are granted once by hand (docs/runbook-azure-setup.md) so they are visible in the
// portal rather than buried in a template.
//
//   API identity    Key Vault Secrets User (read the Plaid secret, the BC certificate, Plaid tokens),
//                   Key Vault Secrets Officer (write plaid-<household>-<item> after Link),
//                   Key Vault Crypto Officer (create and use per-household blob keys),
//                   Storage Blob Data Contributor, Service Bus Data Sender (outbox relay),
//                   Cognitive Services User (Document Intelligence, direct receipt reads),
//                   Monitoring Metrics Publisher, AcrPull
//   Jobs identity   Key Vault Secrets User, Key Vault Crypto User, Storage Blob Data Contributor,
//                   Service Bus Data Owner (receive, complete, dead-letter; KEDA reads message counts),
//                   Cognitive Services User, Monitoring Metrics Publisher, AcrPull

param keyVaultName string
param storageAccountName string
param serviceBusNamespaceName string
param registryName string
param appInsightsName string
param documentIntelligenceName string

param apiPrincipalId string
param jobsPrincipalId string

var roles = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  keyVaultCryptoUser: '12338af0-0e69-4776-bea7-57ae8d297424'
  keyVaultCryptoOfficer: '14b46e9e-c2b7-41b4-b07b-48a6ebf60603'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  serviceBusDataSender: '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39'
  serviceBusDataOwner: '090c5cfd-751d-490a-894a-3ce6f1109419'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  monitoringMetricsPublisher: '3913510d-42f4-4e42-8a64-420c390055eb'
  cognitiveServicesUser: 'a97b65f3-24c7-4388-baec-2e87135dc908'
}

func roleId(id string) string => subscriptionResourceId('Microsoft.Authorization/roleDefinitions', id)

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: keyVaultName }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccountName }
resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' existing = { name: serviceBusNamespaceName }
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: registryName }
resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = { name: appInsightsName }
resource documentIntelligence 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = { name: documentIntelligenceName }

// ---- API ----

resource apiKvSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, apiPrincipalId, roles.keyVaultSecretsUser)
  scope: keyVault
  properties: { roleDefinitionId: roleId(roles.keyVaultSecretsUser), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiKvSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, apiPrincipalId, roles.keyVaultSecretsOfficer)
  scope: keyVault
  properties: { roleDefinitionId: roleId(roles.keyVaultSecretsOfficer), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiKvCrypto 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, apiPrincipalId, roles.keyVaultCryptoOfficer)
  scope: keyVault
  properties: { roleDefinitionId: roleId(roles.keyVaultCryptoOfficer), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, apiPrincipalId, roles.storageBlobDataContributor)
  scope: storage
  properties: { roleDefinitionId: roleId(roles.storageBlobDataContributor), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiSbSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, apiPrincipalId, roles.serviceBusDataSender)
  scope: serviceBus
  properties: { roleDefinitionId: roleId(roles.serviceBusDataSender), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiAcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, apiPrincipalId, roles.acrPull)
  scope: registry
  properties: { roleDefinitionId: roleId(roles.acrPull), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiMetrics 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, apiPrincipalId, roles.monitoringMetricsPublisher)
  scope: appInsights
  properties: { roleDefinitionId: roleId(roles.monitoringMetricsPublisher), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}
resource apiDi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, apiPrincipalId, roles.cognitiveServicesUser)
  scope: documentIntelligence
  properties: { roleDefinitionId: roleId(roles.cognitiveServicesUser), principalId: apiPrincipalId, principalType: 'ServicePrincipal' }
}

// ---- Jobs ----

resource jobsKvSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, jobsPrincipalId, roles.keyVaultSecretsUser)
  scope: keyVault
  properties: { roleDefinitionId: roleId(roles.keyVaultSecretsUser), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
resource jobsKvCrypto 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, jobsPrincipalId, roles.keyVaultCryptoUser)
  scope: keyVault
  properties: { roleDefinitionId: roleId(roles.keyVaultCryptoUser), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
resource jobsBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, jobsPrincipalId, roles.storageBlobDataContributor)
  scope: storage
  properties: { roleDefinitionId: roleId(roles.storageBlobDataContributor), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
resource jobsSbOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, jobsPrincipalId, roles.serviceBusDataOwner)
  scope: serviceBus
  properties: { roleDefinitionId: roleId(roles.serviceBusDataOwner), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
resource jobsAcr 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, jobsPrincipalId, roles.acrPull)
  scope: registry
  properties: { roleDefinitionId: roleId(roles.acrPull), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
resource jobsMetrics 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, jobsPrincipalId, roles.monitoringMetricsPublisher)
  scope: appInsights
  properties: { roleDefinitionId: roleId(roles.monitoringMetricsPublisher), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
resource jobsDi 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, jobsPrincipalId, roles.cognitiveServicesUser)
  scope: documentIntelligence
  properties: { roleDefinitionId: roleId(roles.cognitiveServicesUser), principalId: jobsPrincipalId, principalType: 'ServicePrincipal' }
}
