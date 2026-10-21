// Service Bus Standard: one topic `homestead-outbox` fed only from the outbox table by the relay, with one
// subscription per consumer and dead-lettering on (spec: Stack, Queue row; Idempotency and retries).
//
// Routing: the relay stamps each message with the application property `target` (bc-worker | ocr | matching |
// alerts) and each subscription keeps only its own messages (SQL rule below). Delivery is at-least-once; the
// consumers are idempotent by the transaction's key, so a redelivery cannot create a second BC line. After
// 10 failed deliveries a message dead-letters and the Console's Health page shows it with a retry.
//
// Local auth is off: the API (sender) and jobs (receiver) use their identities (rbac.bicep).

param env string
param location string
param tags object
param suffix string

param topicName string = 'homestead-outbox'

@description('Consumer subscriptions on the outbox topic')
param subscriptions array = ['bc-worker', 'ocr', 'matching', 'alerts']

resource namespace 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: 'sb-homestead-${env}-${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    minimumTlsVersion: '1.2'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    zoneRedundant: false
  }
}

resource topic 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' = {
  parent: namespace
  name: topicName
  properties: {
    enablePartitioning: false
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M' // the relay sets MessageId = outbox row id; a re-publish inside 10 minutes is dropped
    defaultMessageTimeToLive: 'P7D'
    supportOrdering: true
    maxSizeInMegabytes: 1024
  }
}

resource subs 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2024-01-01' = [
  for s in subscriptions: {
    parent: topic
    name: s
    properties: {
      lockDuration: 'PT1M'
      maxDeliveryCount: 10
      deadLetteringOnMessageExpiration: true
      deadLetteringOnFilterEvaluationExceptions: true
      defaultMessageTimeToLive: 'P7D'
      requiresSession: false
    }
  }
]

// Replace the default "1=1" rule with "only my messages".
resource subRules 'Microsoft.ServiceBus/namespaces/topics/subscriptions/rules@2024-01-01' = [
  for (s, i) in subscriptions: {
    parent: subs[i]
    name: '$Default'
    properties: {
      filterType: 'SqlFilter'
      sqlFilter: { sqlExpression: 'target = \'${s}\'' }
    }
  }
]

output namespaceId string = namespace.id
output namespaceName string = namespace.name
output fullyQualifiedNamespace string = '${namespace.name}.servicebus.windows.net'
output topicName string = topic.name
output subscriptionNames array = subscriptions
