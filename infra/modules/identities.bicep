// User-assigned identities for the API and the jobs. User-assigned (not system-assigned) so the role
// assignments and the Postgres Entra users exist before the first container starts, and so the identities
// survive a container app being recreated.

param env string
param location string
param tags object

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-homestead-${env}-api'
  location: location
  tags: tags
}

resource jobsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-homestead-${env}-jobs'
  location: location
  tags: tags
}

output apiIdentityId string = apiIdentity.id
output apiIdentityName string = apiIdentity.name
output apiPrincipalId string = apiIdentity.properties.principalId
output apiClientId string = apiIdentity.properties.clientId
output jobsIdentityId string = jobsIdentity.id
output jobsIdentityName string = jobsIdentity.name
output jobsPrincipalId string = jobsIdentity.properties.principalId
output jobsClientId string = jobsIdentity.properties.clientId
