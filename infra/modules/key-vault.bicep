// Key Vault: RBAC authorization, soft delete (90 days) and purge protection (spec: Security model, DR table).
// Holds, by name: the BC app certificate, the Plaid client secret, Plaid access tokens (plaid-<household>-<item>,
// written at runtime by the API), and the storage account's customer-managed key. Per-household blob keys are
// created at runtime by the API under the same vault (Key Vault Crypto Officer, see rbac.bicep).
//
// No secret value is created here. Cade loads the certificate and the Plaid secret from his own machine
// (docs/runbook-azure-setup.md); the template only reserves the names in its outputs.

param env string
param location string
param tags object

@description('Globally unique suffix for the vault name')
param suffix string

@description('Name of the RSA key the storage account uses as its customer-managed key')
param storageCmkKeyName string = 'storage-cmk'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: 'kv-homestead-${env}-${suffix}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true // required for customer-managed keys; cannot be turned off once on
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    publicNetworkAccess: 'Enabled' // Container Apps on the consumption plan reach it over the public endpoint with TLS and RBAC
    networkAcls: { bypass: 'AzureServices', defaultAction: 'Allow' }
  }
}

// The storage account's infrastructure key. Rotates yearly; versions are kept by the vault.
resource storageCmk 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
  parent: vault
  name: storageCmkKeyName
  tags: tags
  properties: {
    kty: 'RSA'
    keySize: 2048
    keyOps: ['wrapKey', 'unwrapKey']
    rotationPolicy: {
      lifetimeActions: [
        { trigger: { timeBeforeExpiry: 'P30D' }, action: { type: 'Rotate' } }
        { trigger: { timeBeforeExpiry: 'P14D' }, action: { type: 'Notify' } }
      ]
      attributes: { expiryTime: 'P1Y' }
    }
  }
}

output vaultId string = vault.id
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output storageCmkKeyName string = storageCmk.name
output storageCmkKeyUriWithoutVersion string = storageCmk.properties.keyUri
