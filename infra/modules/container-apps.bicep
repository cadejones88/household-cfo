// The API container app and the Container Apps Jobs, one image for all of them (spec: Stack, API and Jobs rows).
//
// API: external HTTPS ingress, scale to zero, 0–2 replicas, user-assigned identity, no secrets in configuration
// (everything secret is read from Key Vault by name at runtime; everything else is plain configuration).
//
// Jobs (same image, entry point `node jobs/dist/index.js <job>`; see services/api/Dockerfile):
//   schedule-triggered     plaid-sync, nightly-poll, webhook-renewal, alerts-digest, autopost-post, outbox-relay
//   event-triggered        bc-worker, ocr, matching, alerts — one per outbox subscription, scaled by its message
//                          count through KEDA's azure-servicebus scaler with the jobs identity (no connection string)
//
// Cron is UTC only. America/Boise is MST (UTC−7) from early November to mid-March and MDT (UTC−6) otherwise;
// a fixed UTC hour drifts one hour across the change. The times below are chosen so the DST drift stays on the
// safe side of each window:
//   nightly poll   09:00 UTC = 02:00 MST / 03:00 MDT  (the spec says 02:00 Mountain; never earlier than 02:00)
//   alerts digest  14:00 UTC = 07:00 MST / 08:00 MDT  (never inside the 9 pm–7 am quiet hours)

param env string
param location string
param tags object

param environmentId string
param registryLoginServer string

@description('Full image reference, e.g. crhomesteaddev.azurecr.io/homestead-api:abc1234')
param image string

param apiIdentityId string
param jobsIdentityId string

@description('Plain configuration for the API and jobs: { name, value }[]')
param commonEnv array

param serviceBusNamespaceName string
param serviceBusTopicName string

@description('Whether the household-level auto-post switch is honoured by the autopost-post job (the rule-level and settings-level switches still apply)')
param autoPostJobEnabled bool = false

var apiEnv = concat(commonEnv, [{ name: 'SERVICE_ROLE', value: 'api' }])
var jobsEnv = concat(commonEnv, [{ name: 'SERVICE_ROLE', value: 'jobs' }])

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: 'homestead-${env}-api'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${apiIdentityId}': {} } }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
        // The phone app and the Console call the API directly; webhooks from Plaid and BC arrive here too.
        corsPolicy: { allowedOrigins: ['https://*.azurestaticapps.net', 'https://console.homestead.cadejonescpa.com'], allowedMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['*'], maxAge: 600 }
      }
      registries: [{ server: registryLoginServer, identity: apiIdentityId }]
      secrets: [] // none: secrets are read from Key Vault by name at runtime
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          command: ['node', 'api/dist/server.js']
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: apiEnv
          probes: [
            { type: 'Liveness', httpGet: { path: '/health', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 5, periodSeconds: 30, failureThreshold: 3 }
            { type: 'Startup', httpGet: { path: '/health', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 2, periodSeconds: 5, failureThreshold: 20 }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '50' } } }]
      }
    }
  }
}

// ---- Scheduled jobs ------------------------------------------------------------------------------------------

var scheduledJobs = [
  { name: 'plaid-sync', cron: '0 */4 * * *', timeout: 900, note: 'Plaid /transactions/sync by cursor, balances, re-link detection; also triggered by SYNC_UPDATES_AVAILABLE through the API' }
  { name: 'nightly-poll', cron: '0 9 * * *', timeout: 1800, note: 'BC completeness check: count and sum by batch and date for 45 days; moves lines Posted/Reconciled; raises Exceptions' }
  { name: 'webhook-renewal', cron: '30 6 * * *', timeout: 300, note: 'Renews the BC subscriptions (three-day expiry) and recreates missing ones' }
  { name: 'alerts-digest', cron: '0 14 * * *', timeout: 300, note: 'Watch-level digest at 7 am Mountain; Action-level alerts go out event-driven' }
  { name: 'autopost-post', cron: '15 * * * *', timeout: 600, note: 'Posts HHAPP/AUTOPOST when the household switch and an approved rule allow; otherwise exits' }
  { name: 'outbox-relay', cron: '*/5 * * * *', timeout: 240, note: 'Publishes due outbox rows to the Service Bus topic (the API also relays inline after each commit; this catches what it missed)' }
]

resource scheduled 'Microsoft.App/jobs@2025-01-01' = [
  for j in scheduledJobs: {
    name: 'homestead-${env}-${j.name}' // job names are limited to 32 characters
    location: location
    tags: union(tags, { 'homestead-job': j.name, note: j.note })
    identity: { type: 'UserAssigned', userAssignedIdentities: { '${jobsIdentityId}': {} } }
    properties: {
      environmentId: environmentId
      workloadProfileName: 'Consumption'
      configuration: {
        triggerType: 'Schedule'
        scheduleTriggerConfig: { cronExpression: j.cron, parallelism: 1, replicaCompletionCount: 1 }
        replicaTimeout: j.timeout
        replicaRetryLimit: 1
        registries: [{ server: registryLoginServer, identity: jobsIdentityId }]
      }
      template: {
        containers: [
          {
            name: j.name
            image: image
            command: ['node', 'jobs/dist/index.js']
            args: [j.name]
            resources: { cpu: json('0.25'), memory: '0.5Gi' }
            env: concat(jobsEnv, [
              { name: 'JOB_NAME', value: j.name }
              { name: 'AUTOPOST_JOB_ENABLED', value: j.name == 'autopost-post' ? string(autoPostJobEnabled) : 'n/a' }
            ])
          }
        ]
      }
    }
  }
]

// ---- Event-driven jobs (one per outbox subscription) ---------------------------------------------------------

var eventJobs = [
  { name: 'bc-worker', subscription: 'bc-worker', timeout: 900, note: 'Writes journal lines to BC after the pre-write check by External Document No.; never a second line' }
  { name: 'ocr', subscription: 'ocr', timeout: 600, note: 'Document Intelligence on receipts and pay stubs, then Claude line mapping' }
  { name: 'matching', subscription: 'matching', timeout: 300, note: 'Receipt-to-bank matching, transfer and card-payment pairing, rule engine' }
  { name: 'alerts', subscription: 'alerts', timeout: 300, note: 'Action-level pushes (forecast, duplicates, stale feed with a bill due, dead letters)' }
]

resource eventDriven 'Microsoft.App/jobs@2025-01-01' = [
  for j in eventJobs: {
    name: 'homestead-${env}-${j.name}' // job names are limited to 32 characters
    location: location
    tags: union(tags, { 'homestead-job': j.name, note: j.note })
    identity: { type: 'UserAssigned', userAssignedIdentities: { '${jobsIdentityId}': {} } }
    properties: {
      environmentId: environmentId
      workloadProfileName: 'Consumption'
      configuration: {
        triggerType: 'Event'
        eventTriggerConfig: {
          parallelism: 1
          replicaCompletionCount: 1
          scale: {
            minExecutions: 0
            maxExecutions: 2
            pollingInterval: 30
            rules: [
              {
                name: 'outbox-${j.subscription}'
                type: 'azure-servicebus'
                // KEDA azure-servicebus scaler with workload identity: `namespace` is the namespace name; KEDA
                // appends .servicebus.windows.net. https://keda.sh/docs/scalers/azure-service-bus/
                metadata: {
                  namespace: serviceBusNamespaceName
                  topicName: serviceBusTopicName
                  subscriptionName: j.subscription
                  messageCount: '5'
                }
                identity: jobsIdentityId
              }
            ]
          }
        }
        replicaTimeout: j.timeout
        replicaRetryLimit: 1
        registries: [{ server: registryLoginServer, identity: jobsIdentityId }]
      }
      template: {
        containers: [
          {
            name: j.name
            image: image
            command: ['node', 'jobs/dist/index.js']
            args: [j.name]
            resources: { cpu: json('0.25'), memory: '0.5Gi' }
            env: concat(jobsEnv, [
              { name: 'JOB_NAME', value: j.name }
              { name: 'OUTBOX_SUBSCRIPTION', value: j.subscription }
            ])
          }
        ]
      }
    }
  }
]

output apiName string = api.name
output apiFqdn string = api.properties.configuration.ingress.fqdn
output apiUrl string = 'https://${api.properties.configuration.ingress.fqdn}'
output jobNames array = concat(map(scheduledJobs, j => 'homestead-${env}-${j.name}'), map(eventJobs, j => 'homestead-${env}-${j.name}'))
