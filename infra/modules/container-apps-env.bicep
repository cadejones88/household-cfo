// Container Apps environment on the consumption plan, logs to Log Analytics through a diagnostic setting (no
// workspace shared key in the template). The API and the jobs share this environment.

param env string
param location string
param tags object

param logAnalyticsWorkspaceId string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-homestead-${env}'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: { destination: 'azure-monitor' }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    zoneRedundant: false
    peerAuthentication: { mtls: { enabled: false } }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: environment
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      { category: 'ContainerAppConsoleLogs', enabled: true }
      { category: 'ContainerAppSystemLogs', enabled: true }
      { category: 'AppEnvSpringAppConsoleLogs', enabled: false }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output environmentId string = environment.id
output environmentName string = environment.name
output defaultDomain string = environment.properties.defaultDomain
