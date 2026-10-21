// The $100 monthly budget alert on the subscription (decision 1, Oct 20, 2026). Subscription scope, so it
// covers every environment at once. Emails at 80% actual and 100% forecast; nothing is turned off
// automatically (a budget cannot stop resources; it only tells).

targetScope = 'subscription'

@description('Monthly amount in USD')
param amount int = 100

@description('First day of the month the budget starts (YYYY-MM-01); Azure requires the first of a month')
param startDate string

@description('Addresses that receive the alerts')
param contactEmails array

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'homestead-monthly'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: {
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: contactEmails, contactRoles: ['Owner'] }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: contactEmails, contactRoles: ['Owner'] }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: contactEmails, contactRoles: ['Owner'] }
    }
  }
}

output budgetId string = budget.id
