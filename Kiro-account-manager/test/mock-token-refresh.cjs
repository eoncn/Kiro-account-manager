// Test-only preload: intercept OIDC refresh without contacting a real Kiro endpoint.
'use strict'
const { MockAgent, setGlobalDispatcher } = require('undici')
const agent = new MockAgent()
agent.disableNetConnect()
agent.get('https://oidc.us-east-1.amazonaws.com')
  .intercept({ path: '/token', method: 'POST' })
  .reply(200, {
    accessToken: 'OFFLINE_REFRESHED_ACCESS_TOKEN',
    refreshToken: 'OFFLINE_ROTATED_REFRESH_TOKEN',
    expiresIn: 3600
  })
  .persist()
setGlobalDispatcher(agent)

// A non-default AWS region must be queried directly rather than silently mapped to us-east-1.
agent.get('https://q.ap-southeast-1.amazonaws.com')
  .intercept({ path: /^\/getUsageLimits\?/, method: 'GET' })
  .reply(200, {
    usageBreakdownList: [{
      resourceType: 'CREDIT', currentUsageWithPrecision: 3.5,
      usageLimitWithPrecision: 50, unit: 'credits'
    }],
    subscriptionInfo: { subscriptionTitle: 'Regional plan' },
    overageConfiguration: { overageStatus: 'DISABLED' }
  })
  .persist()

agent.get('https://q.us-east-1.amazonaws.com')
  .intercept({ path: /^\/getUsageLimits\?/, method: 'GET' })
  .reply(200, () => ({
    usageBreakdownList: [{
      resourceType: 'CREDIT', currentUsageWithPrecision: 21.25,
      usageLimitWithPrecision: 100, unit: 'credits',
      freeTrialInfo: {
        freeTrialStatus: 'ACTIVE', currentUsageWithPrecision: 2,
        usageLimitWithPrecision: 10
      },
      bonuses: [{
        displayName: 'Demo bonus', status: 'ACTIVE',
        currentUsageWithPrecision: 1, usageLimitWithPrecision: 5
      }, {
        displayName: 'Expired bonus', status: 'EXPIRED',
        currentUsageWithPrecision: 0, usageLimitWithPrecision: 1000
      }],
      overageRate: 0.04, overageCap: 100
    }],
    subscriptionInfo: { subscriptionTitle: 'Kiro Pro', status: 'ACTIVE', overageCapability: 'ENABLED' },
    overageConfiguration: { overageStatus: 'DISABLED' },
    nextDateReset: 1893456000
  }))
  .persist()
