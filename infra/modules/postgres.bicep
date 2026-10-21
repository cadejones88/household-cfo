// Azure Database for PostgreSQL Flexible Server 16, Burstable B1ms, 32 GB, 7-day point-in-time restore
// (35 in prod), geo-redundant backup in prod (spec: Stack, Data protection, DR).
//
// Authentication is Entra-only: no password exists to leak. The API and jobs connect as their managed identities
// (token for scope https://ossrdbms-aad.database.windows.net/.default), and Cade is an Entra administrator for
// migrations and support. Row-level security inside the database keys everything by household.
//
// Network: public endpoint with "allow Azure services" so Container Apps on the consumption plan (dynamic
// outbound IPs) can reach it; TLS is required by the server. Private endpoints are a prod-hardening step
// (they need a VNet-integrated environment, which the consumption plan supports at extra cost).

param env string
param location string
param tags object

@description('Entra object id of the first administrator (Cade), used for migrations and support')
param adminObjectId string
@description('UPN of that administrator, e.g. cade@cadejonescpa.com')
param adminPrincipalName string

@description('Managed identities that connect as database users: { name, principalId }')
param identityUsers array = []

@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@allowed(['Enabled', 'Disabled'])
param geoRedundantBackup string = 'Disabled'

param databaseName string = 'homestead'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: 'psql-homestead-${env}'
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '16'
    createMode: 'Default'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled', tier: 'P4' }
    backup: { backupRetentionDays: backupRetentionDays, geoRedundantBackup: geoRedundantBackup }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    maintenanceWindow: { customWindow: 'Enabled', dayOfWeek: 0, startHour: 9, startMinute: 0 } // Sunday 02:00–03:00 Mountain (09:00 UTC)
  }
}

// Burstable servers accept the standard parameters; RLS is enforced by the schema (0001_schema.sql), not here.
resource requireTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: server
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// Entra administrators. The service creates these one at a time, so each depends on the previous.
resource cadeAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: server
  name: adminObjectId
  properties: {
    principalType: 'User'
    principalName: adminPrincipalName
    tenantId: subscription().tenantId
  }
  dependsOn: [database]
}

@batchSize(1)
resource identityAdmins 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = [
  for u in identityUsers: {
    parent: server
    name: u.principalId
    properties: {
      principalType: 'ServicePrincipal'
      principalName: u.name
      tenantId: subscription().tenantId
    }
    dependsOn: [cadeAdmin]
  }
]

output serverId string = server.id
output serverName string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
