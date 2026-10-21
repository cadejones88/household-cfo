// Blob storage for receipt and statement images: private containers `receipts` and `imports`, versioning,
// 30-day soft delete for blobs and containers, customer-managed key from Key Vault (spec: Data protection, DR).
//
// Key hierarchy: this account-level key (storage-cmk in Key Vault) encrypts the account; on top of it the API
// envelope-encrypts each household's images with a per-household key it creates at runtime in the same vault
// (`hh-<household id>`), so one household's key can be rotated or destroyed without touching another's. The
// per-household keys are not created here.
//
// Shared-key access is off: the phone uploads with a 5-minute user-delegation SAS the API mints with its
// identity, and the API and jobs use their identities (Storage Blob Data Contributor, see rbac.bicep).

param env string
param location string
param tags object
param suffix string

@description('Resource id of the Key Vault holding the customer-managed key')
param keyVaultId string
param keyVaultUri string
param cmkKeyName string

@description('Geo-redundant storage for pilot and prod (spec DR: geo-redundant), locally redundant for dev')
@allowed(['Standard_LRS', 'Standard_ZRS', 'Standard_GRS', 'Standard_RAGRS'])
param skuName string = 'Standard_LRS'

@description('Soft-delete retention for blobs and containers, in days (spec: 30)')
param softDeleteDays int = 30

var keyVaultName = last(split(keyVaultId, '/'))

// Key Vault Crypto Service Encryption User: lets the storage account's identity wrap/unwrap with the CMK.
var cryptoServiceEncryptionUserRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'e147488a-f6f5-4113-8e2d-b22465e65bf6')

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// The storage account needs an identity with vault access *before* it is created with encryption settings,
// so the identity is user-assigned and the role assignment is a dependency of the account.
resource storageIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-homestead-${env}-storage'
  location: location
  tags: tags
}

resource cmkAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, storageIdentity.id, cryptoServiceEncryptionUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: cryptoServiceEncryptionUserRoleId
    principalId: storageIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'sthomestead${env}${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: skuName }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${storageIdentity.id}': {} }
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' }
    encryption: {
      keySource: 'Microsoft.Keyvault'
      identity: { userAssignedIdentity: storageIdentity.id }
      keyvaultproperties: {
        keyname: cmkKeyName
        keyvaulturi: keyVaultUri
        // no keyversion: the account follows the vault's rotation policy automatically
      }
      services: {
        blob: { enabled: true, keyType: 'Account' }
        file: { enabled: true, keyType: 'Account' }
      }
      requireInfrastructureEncryption: true
    }
  }
  dependsOn: [cmkAccess]
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: softDeleteDays }
    containerDeleteRetentionPolicy: { enabled: true, days: softDeleteDays }
    changeFeed: { enabled: true, retentionInDays: softDeleteDays }
    cors: {
      corsRules: [
        {
          // The phone app's direct-to-blob upload with a user-delegation SAS (PUT) from the Expo app; the Console
          // reads images through the API, not from the account.
          allowedOrigins: ['*']
          allowedMethods: ['PUT', 'OPTIONS']
          allowedHeaders: ['x-ms-blob-type', 'x-ms-blob-content-type', 'content-type', 'x-ms-version']
          exposedHeaders: ['ETag']
          maxAgeInSeconds: 300
        }
      ]
    }
  }
}

resource receipts 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'receipts'
  properties: { publicAccess: 'None' }
}

resource imports 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'imports'
  properties: { publicAccess: 'None' }
}

output accountId string = account.id
output accountName string = account.name
output blobEndpoint string = account.properties.primaryEndpoints.blob
output storageIdentityPrincipalId string = storageIdentity.properties.principalId
