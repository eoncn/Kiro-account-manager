// Offline quota failure fixture. Must never contact real Kiro.
'use strict'
const { MockAgent, setGlobalDispatcher } = require('undici')
const agent = new MockAgent()
agent.disableNetConnect()
for (const region of ['us-east-1', 'eu-central-1']) {
  agent.get('https://q.' + region + '.amazonaws.com')
    .intercept({ path: /^\/getUsageLimits\?/, method: 'GET' })
    .reply(403, { message: 'EXAMPLE_UPSTREAM_BODY_NEVER_EXPOSE' })
    .persist()
}
setGlobalDispatcher(agent)
