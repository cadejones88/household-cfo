// Azure Static Web Apps (Free) for the Console. Content is pushed by the deploy workflow with a deployment
// token it fetches at deploy time with its federated identity (`az staticwebapp secrets list`), so no token is
// stored in GitHub. Static Web Apps is not offered in West US 3; West US 2 is the nearest region, and the
// content is served from the global edge anyway.

param env string
param tags object

@description('Static Web Apps region (westus2, centralus, eastus2, westeurope, eastasia)')
@allowed(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'])
param location string = 'westus2'

resource site 'Microsoft.Web/staticSites@2023-12-01' = {
  name: 'stapp-homestead-${env}-console'
  location: location
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true // apps/console/staticwebapp.config.json (SPA fallback, security headers)
    enterpriseGradeCdnStatus: 'Disabled'
  }
}

output siteId string = site.id
output siteName string = site.name
output defaultHostname string = site.properties.defaultHostname
output consoleUrl string = 'https://${site.properties.defaultHostname}'
