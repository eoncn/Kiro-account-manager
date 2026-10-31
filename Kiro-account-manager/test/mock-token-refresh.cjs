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
