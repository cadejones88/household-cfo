// The API container app and the Container Apps Jobs, one image for all of them (spec: Stack, API and Jobs rows).
//
// API: external HTTPS ingress, scale to zero, 0–2 replicas, user-assigned identity, no secrets in configuration
// (everything secret is read from Key Vault by name at runtime; everything else is plain configuration).
//
// Jobs (same image, entry point `node services/jobs/dist/index.js <job>`; see services/api/Dockerfile). The job
// names are services/jobs/src/index.ts JOB_NAMES; a resource name may differ from its job (32-character limit):
//   schedule-triggered   plaid-sync, nightly-poll, webhook-renewal, alerts-hourly (job alerts), autopost-post,
//                        outbox-relay, receipt-fallback, pay-fallback (job paycheck-template-fallback),
//                        rule-proposals, ocr-sweep (job ocr), matching-sweep (job matching)
//   event-triggered      bc-worker, ocr, matching, alerts: one per outbox subscription, scaled by its message count
//                        through KEDA's azure-servicebus scaler with the jobs identity (no connection string)
//
// The two sweeps exist because this build of the API relays the outbox in process (services/api QueuePort is
// in-memory; "Service Bus later"), so nothing reaches the topic yet and the event-triggered jobs never start. The
// outbox-relay schedule already works the BC side every five minutes; the sweeps do the same for OCR and matching.
// Once the API publishes to Service Bus *and* each job completes its subscription's messages, slow the sweeps
// down. Until the jobs complete messages, a published message would keep KEDA starting its job every 30 seconds
// (two at a time): about $20 a month, which the budget alert would catch.
//
// Cron is UTC only. America/Boise is MST (UTC−7) from early November to mid-March and MDT (UTC−6) otherwise;
// a fixed UTC hour drifts one hour across the change:
//   nightly poll   09:00 UTC = 02:00 MST / 03:00 MDT  (the spec says 02:00 Mountain; the drift lands later, never
//                                                      earlier, so the BC day is always closed)
//   alerts         hourly. The 07:00 Boise digest window, quiet hours and the weekly pulse are decided inside the
//                  job in America/Boise time (services/api/src/services/alerts.ts, ±30 minutes), so an hourly run
//                  hits 07:00 local in both MST and MDT, which no single UTC hour can. Action-level alerts go out
//                  within the hour until the event-triggered `alerts` job is fed.
//   daily jobs     08:00–08:30 UTC = 01:00–01:30 MST / 02:00–02:30 MDT, before the nightly poll.

param env string
param location string
param tags object

param environmentId string
@description('The Container Apps environment default domain; the API FQDN is <app name>.<default domain>')
param environmentDefaultDomain string
param registryLoginServer string

@description('Full image reference, e.g. crhomesteaddev.azurecr.io/homestead-api:abc1234')
param image string

param apiIdentityId string
param apiIdentityName string
param apiClientId string
param jobsIdentityId string
param jobsIdentityName string
param jobsClientId string

@description('Plain configuration for the API and jobs: { name, value }[]')
param commonEnv array

@description('Browser origins allowed to call the API (the Console). The phone app and webhooks are not browsers.')
param corsOrigins array

param serviceBusNamespaceName string
param serviceBusTopicName string

@description('Whether the household-level auto-post switch is honoured by the autopost-post job (the rule-level and settings-level switches still apply)')
param autoPostJobEnabled bool = false

var apiName = 'homestead-${env}-api'
var apiFqdn = '${apiName}.${environmentDefaultDomain}'

// Per-role settings. AZURE_CLIENT_ID picks the user-assigned identity for managed-identity tokens (Key Vault,
// storage, Postgres, Document Intelligence); PGUSER is the identity's Postgres role (infra/README.md, "Postgres roles").
var apiEnv = concat(commonEnv, [
  { name: 'SERVICE_ROLE', value: 'api' }
  { name: 'AZURE_CLIENT_ID', value: apiClientId }
  { name: 'PGUSER', value: apiIdentityName }
  { name: 'CORS_ORIGINS', value: join(corsOrigins, ',') }
  { name: 'PLAID_WEBHOOK_URL', value: 'https://${apiFqdn}/v1/webhooks/plaid' }
])
var jobsEnv = concat(commonEnv, [
  { name: 'SERVICE_ROLE', value: 'jobs' }
  { name: 'AZURE_CLIENT_ID', value: jobsClientId }
  { name: 'PGUSER', value: jobsIdentityName }
  // webhook-renewal registers BC subscriptions with this base (…/v1/webhooks/bc).
  { name: 'WEBHOOK_BASE_URL', value: 'https://${apiFqdn}' }
])

resource api 'Microsoft.App/containerApps@2025-01-01' = {
  name: apiName
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
        // CORS is answered by the API itself (@fastify/cors with CORS_ORIGINS), not by the ingress, so a response
        // never carries two Access-Control-Allow-Origin headers.
      }
      registries: [{ server: registryLoginServer, identity: apiIdentityId }]
      secrets: [] // none: secrets are read from Key Vault by name at runtime
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          command: ['node', 'services/api/dist/server.js']
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
  { name: 'plaid-sync', job: 'plaid-sync', cron: '0 */4 * * *', timeout: 900, note: 'Plaid /transactions/sync by cursor, balances, liabilities, re-link detection; also triggered by SYNC_UPDATES_AVAILABLE through the API' }
  { name: 'nightly-poll', job: 'nightly-poll', cron: '0 9 * * *', timeout: 1800, note: 'BC completeness check: count and sum by batch and date for 45 days; moves lines Posted/Reconciled; raises Exceptions' }
  { name: 'webhook-renewal', job: 'webhook-renewal', cron: '30 6 * * *', timeout: 300, note: 'Renews the BC subscriptions (three-day expiry) and recreates missing ones' }
  { name: 'alerts-hourly', job: 'alerts', cron: '0 * * * *', timeout: 300, note: 'Forecast alerts, the 7 am Boise digest, the weekly pulse, quiet hours (decided in local time inside the job), retention purges' }
  { name: 'autopost-post', job: 'autopost-post', cron: '15 * * * *', timeout: 600, note: 'Posts HHAPP/AUTOPOST when the household switch and an approved rule allow; otherwise exits' }
  { name: 'outbox-relay', job: 'outbox-relay', cron: '*/5 * * * *', timeout: 240, note: 'Relays due outbox rows and works them in process (BC writes, post requests, read-backs) with the pre-write check' }
  { name: 'receipt-fallback', job: 'receipt-fallback', cron: '0 8 * * *', timeout: 300, note: 'Walmart, club and Amazon lines 10 days without a receipt get the estimated split' }
  { name: 'pay-fallback', job: 'paycheck-template-fallback', cron: '10 8 * * *', timeout: 300, note: 'Paychecks 3 days without a stub get the employer-template estimate' }
  { name: 'rule-proposals', job: 'rule-proposals', cron: '20 8 * * *', timeout: 300, note: 'Proposes merchant rules from approved history (proposals only; a spouse approves)' }
  { name: 'ocr-sweep', job: 'ocr', cron: '*/30 * * * *', timeout: 600, note: 'Reads queued receipts and stubs until the event-triggered ocr job is fed by Service Bus' }
  { name: 'matching-sweep', job: 'matching', cron: '5,35 * * * *', timeout: 300, note: 'Duplicates, transfer and card pairs, receipts, the rule engine, until the event-triggered matching job is fed' }
]

resource scheduled 'Microsoft.App/jobs@2025-01-01' = [
  for j in scheduledJobs: {
    name: 'homestead-${env}-${j.name}' // job names are limited to 32 characters
    location: location
    tags: union(tags, { 'homestead-job': j.job, note: j.note })
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
            command: ['node', 'services/jobs/dist/index.js']
            args: [j.job]
            resources: { cpu: json('0.25'), memory: '0.5Gi' }
            env: concat(jobsEnv, [
              { name: 'JOB_NAME', value: j.job }
              { name: 'AUTOPOST_JOB_ENABLED', value: j.job == 'autopost-post' ? string(autoPostJobEnabled) : 'n/a' }
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
            command: ['node', 'services/jobs/dist/index.js']
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
