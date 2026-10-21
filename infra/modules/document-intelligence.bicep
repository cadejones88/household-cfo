// Azure AI Document Intelligence (prebuilt-receipt, prebuilt-payStub.us). F0 gives 500 free pages a month for
// dev; S0 for the pilot and prod (spec: Stack, Documents row). Keys are disabled: the jobs identity calls it
// (Cognitive Services User, rbac.bicep). Data stays in the United States; the service is not in West US 3, so
// the region is a parameter.

param env string
param tags object

@description('A US region that hosts Document Intelligence')
param location string = 'westus2'

@allowed(['F0', 'S0'])
param skuName string = 'F0'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: 'di-homestead-${env}'
  location: location
  tags: tags
  kind: 'FormRecognizer'
  sku: { name: skuName }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: 'di-homestead-${env}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
    networkAcls: { defaultAction: 'Allow' }
  }
}

output accountId string = account.id
output endpoint string = account.properties.endpoint
