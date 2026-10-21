// Log Analytics workspace + Application Insights (workspace-based), 30-day retention (spec: Stack and hosting,
// Monitoring row). The API and jobs scrub amounts, masks, merchants, tokens and image bytes before anything
// reaches here (services/api/src/lib/logScrub.ts); retention is short because the audit trail lives in Postgres.

@description('Environment: dev | pilot | prod')
param env string
param location string
param tags object

@description('Log retention in days (spec: 30)')
@minValue(30)
@maxValue(730)
param retentionDays int = 30

@description('Daily ingestion cap in GB; keeps a runaway log loop inside the budget. -1 disables the cap.')
param dailyQuotaGb int = 1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-homestead-${env}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: retentionDays
    workspaceCapping: { dailyQuotaGb: dailyQuotaGb }
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-homestead-${env}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    Flow_Type: 'Bluefield'
    Request_Source: 'rest'
    WorkspaceResourceId: workspace.id
    RetentionInDays: retentionDays
    IngestionMode: 'LogAnalytics'
    // Entra-only ingestion: the API and jobs publish telemetry with their managed identity (Monitoring Metrics
    // Publisher, see rbac.bicep); the instrumentation key alone cannot write.
    DisableLocalAuth: true
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output appInsightsId string = appInsights.id
@description('Not a secret (Microsoft documents it as public configuration), but ingestion still needs the identity role above.')
output appInsightsConnectionString string = appInsights.properties.ConnectionString
