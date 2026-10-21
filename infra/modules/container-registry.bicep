// Azure Container Registry (Basic) for the one API/jobs image. Not in the spec's cost table: about $5 a month
// at list price, the price of pulling by managed identity instead of keeping a registry credential in the
// Container Apps configuration. Admin user off; CI pushes with its federated identity (AcrPush), the apps pull
// with theirs (AcrPull). See rbac.bicep.

param env string
param location string
param tags object
param suffix string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'crhomestead${env}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
    // Retention policies for untagged manifests are a Premium feature; the deploy workflow prunes old tags
    // instead (`az acr repository delete`), see infra/README.md.
  }
}

output registryId string = registry.id
output registryName string = registry.name
output loginServer string = registry.properties.loginServer
