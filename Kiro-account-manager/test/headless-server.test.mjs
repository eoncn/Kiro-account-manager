// Offline integration test: never contacts Kiro upstream or uses actual credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'

const entry = resolve(process.env.KIRO_SERVER_TEST_ENTRY || 'dist/server/index.cjs')
const TEST_KEY = 'test-local-key-not-a-real-secret'

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address()
  const port = addr.port
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}

async function start(port, dir, preload) {
  const logs = []
  const child = spawn(process.execPath, preload ? ['--require', preload, entry] : [entry], {
    cwd: dirname(entry),
    env: {
      ...process.env,
      NODE_PATH: '',
      DISPLAY: '',
      KIRO_SERVER_HOST: '127.0.0.1',
      KIRO_SERVER_PORT: String(port),
      KIRO_SERVER_API_KEY: TEST_KEY,
      KIRO_SERVER_DATA_DIR: dir,
      // The mocked refresh must never accidentally go through inherited proxies.
      ...(preload ? { HTTPS_PROXY: '', https_proxy: '', HTTP_PROXY: '', http_proxy: '' } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', data => logs.push(String(data)))
  child.stderr.on('data', data => logs.push(String(data)))
  const url = `http://127.0.0.1:${port}`
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null) throw new Error('Server exited at startup: ' + logs.join('').slice(-2500))
    try {
      const response = await fetch(url + '/health')
      if (response.ok) return { child, url, logs }
    } catch { /* not ready yet */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  child.kill('SIGTERM')
  throw new Error('Server did not become ready: ' + logs.join('').slice(-2500))
}

async function stop(child) {
  if (child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SIGTERM did not stop server')), 10000))
  ])
}

async function api(url, method, body, key = TEST_KEY) {
  return fetch(url + '/admin/accounts', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}

test('CLI help hierarchy requires no Server, API Key, or valid env file', () => {
  const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
  const env = {
    ...process.env,
    KIRO_SERVER_API_KEY: '',
    KIRO_TOOL_API_KEY: '',
    KIRO_SERVER_URL: 'http://127.0.0.1:1'
  }
  const cases = [
    [[], '账号管理 CLI'],
    [['-h'], 'account help'],
    [['--help'], 'account add account1.json'],
    [['help'], 'account help'],
    [['account'], 'account 命令帮助'],
    [['account', 'help'], 'account refresh'],
    [['account', '--help'], 'account refresh'],
    [['help', 'account'], 'account refresh'],
    [['account', 'help', 'info'], 'GetUsageLimits'],
    [['help', 'account', 'refresh'], 'account refresh'],
    [['account', 'help', 'list'], 'account list'],
    [['account', 'help', 'add'], 'account add'],
    [['account', 'help', 'usage'], 'account info'],
    [['account', 'help', 'overage'], '已停用'],
    [['account', 'info', '--help'], 'GetUsageLimits'],
    [['account', 'info', 'help'], 'GetUsageLimits'],
    [['account', 'refresh', '-h'], 'account refresh'],
    [['account', 'list', 'help'], 'account list'],
    [['account', 'delete', '--help'], 'account delete'],
    [['account', 'overage', 'help'], '已停用'],
    [['account', 'overage', 'enable', '--help'], '已停用'],
    [['account', 'overage', 'disable', '2', '--help'], '已停用'],
    [['account', 'help', '--config-file', '/definitely/missing/kiro.env'], 'account refresh']
  ]
  for (const [args, expected] of cases) {
    const result = spawnSync(process.execPath, [tool, ...args], {
      env, encoding: 'utf8', timeout: 5000
    })
    assert.equal(result.status, 0, args.join(' ') + '\n' + result.stderr)
    assert.match(result.stdout, new RegExp(expected), args.join(' '))
    assert.equal(result.stderr, '')
  }
  const unknownTopic = spawnSync(process.execPath,
    [tool, 'account', 'help', 'nonexistent'], { env, encoding: 'utf8', timeout: 5000 })
  assert.notEqual(unknownTopic.status, 0, 'unknown help topic must be an error')
  assert.match(unknownTopic.stderr, /未知命令/)
})

test('CLI help, -h and --help produce identical output at every level', () => {
  const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
  const env = {
    ...process.env,
    KIRO_SERVER_API_KEY: '',
    KIRO_TOOL_API_KEY: '',
    KIRO_SERVER_URL: 'http://127.0.0.1:1'
  }
  function run(args) {
    const result = spawnSync(process.execPath, [tool, ...args], {
      env, encoding: 'utf8', timeout: 5000
    })
    assert.equal(result.status, 0, args.join(' ') + '\n' + result.stderr)
    assert.equal(result.stderr, '', args.join(' '))
    return result.stdout
  }
  const topics = [
    [[], '账号管理 CLI'],
    [['account'], 'account 命令帮助'],
    [['account', 'list'], 'account list'],
    [['account', 'add'], 'account add'],
    [['account', 'info'], 'GetUsageLimits'],
    [['account', 'usage'], 'GetUsageLimits'],
    [['account', 'refresh'], 'account refresh'],
    [['account', 'enable'], 'account enable'],
    [['account', 'disable'], 'account disable'],
    [['account', 'delete'], 'account delete'],
    [['account', 'overage'], '已停用'],
    [['account', 'overage', 'enable'], '已停用'],
    [['account', 'overage', 'disable'], '已停用'],
    [['account', 'overage', 'on'], '已停用'],
    [['account', 'overage', 'off'], '已停用']
  ]
  for (const [topic, expected] of topics) {
    const outputs = ['help', '-h', '--help'].map(alias => run([...topic, alias]))
    assert.match(outputs[0], new RegExp(expected), topic.join(' '))
    assert.equal(outputs[0], outputs[1], 'help differs from -h: ' + topic.join(' '))
    assert.equal(outputs[1], outputs[2], '-h differs from --help: ' + topic.join(' '))
  }
  // Prefix/suffix help, a selector before help, and help in the overage action slot
  // must all resolve to the same context, without reading an account file or env.
  for (const [expected, equivalent] of [
    [['account', 'info', '--help'], ['account', 'help', 'info']],
    [['account', 'info', '--help'], ['help', 'account', 'info']],
    [['account', 'info', '--help'], ['account', 'info', '2', 'help']],
    [['account', 'info', '--help'], ['account', 'info', '2', '-h']],
    [['account', 'info', '--help'], ['account', 'info', '2', '--help']],
    [['account', 'add', '--help'], ['account', 'add', 'does-not-exist.json', '-h']],
    [['account', 'overage', '--help'], ['account', 'help', 'overage']],
    [['account', 'overage', 'enable', '--help'], ['account', 'overage', 'help', 'enable']],
    [['account', 'overage', 'enable', '--help'], ['account', 'help', 'overage', 'enable']],
    [['account', 'overage', 'enable', '--help'], ['account', 'overage', 'enable', '2', 'help']],
    [['account', 'overage', 'disable', '--help'], ['account', 'overage', 'disable', '2', '-h']],
    [['account', 'help'], ['account', '--help']],
    [['account', 'help'], ['help', 'account']]
  ]) {
    assert.equal(run(equivalent), run(expected), equivalent.join(' ') + ' should show same topic')
  }
  assert.equal(
    run(['account', 'help', '--config-file', '/nonexistent/kiro-cli-key.env']),
    run(['account', '--help']),
    'help must not read an explicitly absent env file'
  )
  const invalid = spawnSync(process.execPath,
    [tool, 'account', 'overage', 'invalid', '--help'],
    { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(invalid.status, 0)
  assert.match(invalid.stdout, /已停用/)
})

test('retired overage command cannot contact the server, with or without --yes', () => {
  const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
  const env = {
    ...process.env,
    KIRO_SERVER_API_KEY: '',
    KIRO_TOOL_API_KEY: '',
    KIRO_SERVER_URL: 'http://127.0.0.1:1'
  }
  for (const args of [
    ['account', 'overage', 'enable', '1'],
    ['account', 'overage', 'enable', '1', '--yes'],
    ['account', 'overage', 'on', '1', '--yes'],
    ['account', 'overage', 'disable', '1'],
    ['account', 'overage', 'off', '1']
  ]) {
    const result = spawnSync(process.execPath, [tool, ...args], {
      env, encoding: 'utf8', timeout: 5000
    })
    assert.notEqual(result.status, 0, 'mutating command must fail: ' + args.join(' '))
    assert.match(result.stderr, /已停用/)
    assert.doesNotMatch(result.stderr, /API_KEY|ECONNREFUSED|fetch failed/)
  }
  const rootHelp = spawnSync(process.execPath, [tool, '--help'], {
    env, encoding: 'utf8', timeout: 5000
  })
  assert.equal(rootHelp.status, 0)
  assert.doesNotMatch(rootHelp.stdout, /overage enable|overage disable/)
})

test('Node.js 22 --env-file flag is intercepted; --config-file help bypasses file loading', () => {
  const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
  const missing = '/nonexistent/kiro-configuration-test.env'
  const env = { ...process.env, KIRO_SERVER_API_KEY: '', KIRO_TOOL_API_KEY: '' }
  const cliHelp = spawnSync(process.execPath, [tool, 'account', 'help', '--config-file', missing], {
    encoding: 'utf8', timeout: 5000, env
  })
  assert.equal(cliHelp.status, 0, cliHelp.stderr)
  assert.match(cliHelp.stdout, /account 命令帮助/)
  assert.equal(cliHelp.stderr, '')
  // The Node runtime (not kiro-tool.cjs) handles --env-file before our code runs.
  // Prove the issue independently so the regression does not reintroduce it.
  const nodeProbe = spawnSync(process.execPath, [
    '-e', 'console.log("CHILD_RAN")', '--env-file', missing
  ], { encoding: 'utf8', timeout: 5000, env })
  assert.notEqual(nodeProbe.status, 0)
  assert.doesNotMatch(nodeProbe.stdout, /CHILD_RAN/)
  assert.match(nodeProbe.stderr, /not found/)
})

test('missing API key fails before binding', () => {
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, KIRO_SERVER_API_KEY: '' },
    encoding: 'utf8', timeout: 5000
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /KIRO_SERVER_API_KEY is required/)
})

test('headless server: auth, one-account import and restart persistence', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-server-test-'))
  const port = await freePort()
  let running
  try {
    running = await start(port, dir)
    assert.equal((await fetch(running.url + '/admin/accounts')).status, 401)
    assert.equal((await api(running.url, 'GET', undefined, 'wrong-key')).status, 401)
    assert.equal((await api(running.url, 'POST', [], TEST_KEY)).status, 400)
    assert.equal((await api(running.url, 'POST', { email: 'test@example.com' })).status, 400)
    assert.equal((await api(running.url, 'POST', {
      email: 'test@example.com', refreshToken: 'NOT_REAL'
    })).status, 400, 'OIDC refresh-only import requires clientId and clientSecret')

    // GitHub social accounts imported without an explicit authMethod must not be
    // misclassified as IdC and incorrectly require clientId/clientSecret.
    for (const [suffix, provider] of [['github-title', 'GitHub'], ['github-lower', 'github'], ['google-upper', 'GOOGLE']]) {
      const social = {
        id: 'offline-' + suffix,
        email: suffix + '@example.invalid',
        accessToken: 'FAKE_ACCESS_TOKEN',
        refreshToken: 'FAKE_REFRESH_TOKEN',
        provider
      }
      const inserted = await api(running.url, 'POST', social)
      assert.equal(inserted.status, 201, await inserted.text())
      const list = (await api(running.url, 'GET')).json()
      assert.equal((await list).accounts.find(a => a.id === social.id)?.authMethod, 'social')
      const deleted = await fetch(running.url + '/admin/accounts/' + social.id, {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + TEST_KEY }
      })
      assert.equal(deleted.status, 200)
    }

    const example = {
      id: 'offline-test-account',
      email: 'test@example.com',
      accessToken: 'NOT_A_REAL_TOKEN',
      authMethod: 'IdC',
      region: 'us-east-1'
    }
    const created = await api(running.url, 'POST', example)
    assert.equal(created.status, 201, await created.text())
    const repeated = await api(running.url, 'POST', example)
    assert.equal(repeated.status, 200, await repeated.text())
    const response = await api(running.url, 'GET')
    assert.equal(response.status, 200)
    const raw = await response.text()
    assert.ok(!raw.includes(example.accessToken), 'GET list must hide accessToken')
    const accounts = JSON.parse(raw)
    assert.equal(accounts.total, 1)

    const disk = await readFile(join(dir, 'accounts.json'), 'utf8')
    assert.ok(disk.includes(example.id), 'account must be persisted')
    assert.equal((await stat(join(dir, 'accounts.json'))).mode & 0o777, 0o600, 'credential file must be private')
    assert.equal((await stat(dir)).mode & 0o777, 0o700, 'account directory must be private')
    await stop(running.child)
    running = await start(port, dir)
    const afterRestart = await api(running.url, 'GET')
    assert.equal(afterRestart.status, 200)
    assert.equal((await afterRestart.json()).total, 1)

    // Admin management and the compiled CLI use the same ID-based endpoints.
    const extra = { ...example, id: 'offline-second-account', email: 'second@example.com' }
    assert.equal((await api(running.url, 'POST', extra)).status, 201)
    const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
    const runTool = (args, key = TEST_KEY) => spawnSync(process.execPath,
      [tool, 'account', ...args], {
        cwd: dirname(tool),
        env: { ...process.env, KIRO_SERVER_URL: running.url, KIRO_SERVER_API_KEY: key },
        encoding: 'utf8', timeout: 10000
      })
    // CLI JSON import: read one account file and send it through existing POST /admin/accounts.
    const importFile = join(dir, 'account-import.json')
    await (await import('node:fs/promises')).writeFile(importFile, JSON.stringify({
      id: 'offline-third-account', email: 'third@example.com',
      accessToken: 'FAKE_ACCESS_TOKEN', refreshToken: 'FAKE_REFRESH_TOKEN',
      provider: 'GitHub'
    }), { mode: 0o600 })
    const added = runTool(['add', importFile])
    assert.equal(added.status, 0, added.stderr)
    assert.match(added.stdout, /third@example.com/)
    const imported = await api(running.url, 'GET').then(r => r.json())
    assert.equal(imported.total, 3)
    assert.equal(imported.accounts.find(a => a.id === 'offline-third-account')?.authMethod, 'social')
    const repeatedAdd = runTool(['add', importFile])
    assert.equal(repeatedAdd.status, 0, repeatedAdd.stderr)
    assert.match(repeatedAdd.stdout, /已更新账号/)
    assert.equal((await api(running.url, 'GET').then(r => r.json())).total, 3)
    const invalidIdc = join(dir, 'missing-idc-credentials.json')
    await (await import('node:fs/promises')).writeFile(invalidIdc, JSON.stringify({
      email: 'missing-credentials@example.invalid', refreshToken: 'FAKE_REFRESH_TOKEN'
    }), { mode: 0o600 })
    const invalidIdcResult = runTool(['add', invalidIdc])
    assert.notEqual(invalidIdcResult.status, 0)
    assert.match(invalidIdcResult.stderr, /HTTP 400: OIDC refresh requires clientId and clientSecret/)
    const invalidImport = join(dir, 'invalid-account.json')
    await (await import('node:fs/promises')).writeFile(invalidImport, JSON.stringify([{ email: 'bad' }]))
    assert.notEqual(runTool(['add', invalidImport]).status, 0)
    await (await import('node:fs/promises')).writeFile(invalidImport, JSON.stringify({ email: 'bad', accessToken: '' }))
    assert.notEqual(runTool(['add', invalidImport]).status, 0, 'empty token is invalid')
    await (await import('node:fs/promises')).writeFile(invalidImport, JSON.stringify({ accounts: [imported] }))
    assert.notEqual(runTool(['add', invalidImport]).status, 0, 'batch exports are rejected')

    // Without ID, repeated imports of an existing email must not silently create another account.
    const withoutId = join(dir, 'without-id.json')
    await (await import('node:fs/promises')).writeFile(withoutId, JSON.stringify({
      email: 'third@example.com', accessToken: 'NO_REAL_TOKEN'
    }), { mode: 0o600 })
    assert.notEqual(runTool(['add', withoutId]).status, 0)
    assert.equal((await api(running.url, 'GET').then(r => r.json())).total, 3)
    const removedThird = runTool(['delete', '3', '--yes'])
    assert.equal(removedThird.status, 0, removedThird.stderr)

    const listed = runTool(['list'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /second@example.com/)
    const badDelete = runTool(['delete', '2'])
    assert.notEqual(badDelete.status, 0, 'noninteractive delete needs --yes')
    assert.equal((await api(running.url, 'GET').then(r => r.json())).total, 2)

    const unauthorized = await fetch(running.url + '/admin/accounts/' + extra.id + '/disable', { method: 'POST' })
    assert.equal(unauthorized.status, 401)

    const disabled = runTool(['disable', '2'])
    assert.equal(disabled.status, 0, disabled.stderr)
    const afterDisable = await api(running.url, 'GET').then(r => r.json())
    assert.equal(afterDisable.accounts[1].enabled, false)
    assert.equal(afterDisable.accounts[1].isAvailable, false)
    assert.equal(afterDisable.accounts[0].enabled, true)

    // A disabled account must remain disabled after Server restart.
    await stop(running.child)
    running = await start(port, dir)
    const restored = await api(running.url, 'GET').then(r => r.json())
    assert.equal(restored.accounts[1].enabled, false)
    assert.equal(restored.accounts[1].isAvailable, false)
    assert.equal((await readFile(join(dir, 'accounts.json'), 'utf8')).includes('"manuallyDisabled": true'), true)

    const enabled = runTool(['enable', '2'])
    assert.equal(enabled.status, 0, enabled.stderr)
    assert.equal((await api(running.url, 'GET').then(r => r.json())).accounts[1].enabled, true)
    const removed = runTool(['delete', '2', '--yes'])
    assert.equal(removed.status, 0, removed.stderr)
    const last = await api(running.url, 'GET').then(r => r.json())
    assert.equal(last.total, 1)
    assert.equal(last.accounts[0].id, example.id)
    assert.equal(JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8')).accounts.length, 1)

    const unknown = await fetch(running.url + '/admin/accounts/' + extra.id, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + TEST_KEY }
    })
    assert.equal(unknown.status, 404)
    await stop(running.child)
    running = await start(port, dir)
    assert.equal((await api(running.url, 'GET').then(r => r.json())).total, 1)
  } finally {
    if (running) await stop(running.child).catch(() => running.child.kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})

test('manual refresh: CLI env autodiscovery, rotated credentials, and disabled state', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-refresh-test-'))
  const port = await freePort()
  let running
  try {
    running = await start(port, dir, resolve('test/mock-token-refresh.cjs'))
    const refreshPath = '/admin/accounts/offline-manual-refresh/refresh'
    const headers = { Authorization: 'Bearer ' + TEST_KEY }
    assert.equal((await fetch(running.url + refreshPath, { method: 'POST' })).status, 401)
    assert.equal((await fetch(running.url + refreshPath, { method: 'POST', headers })).status, 404)

    // Refresh-token-less accounts cannot be refreshed and must not be mutated.
    assert.equal((await api(running.url, 'POST', {
      id: 'no-refresh-credentials', accessToken: 'OFFLINE_NO_REFRESH'
    })).status, 201)
    assert.equal((await fetch(running.url + '/admin/accounts/no-refresh-credentials/refresh', {
      method: 'POST', headers
    })).status, 422)

    assert.equal((await api(running.url, 'POST', {
      id: 'offline-manual-refresh',
      email: 'refresh@example.invalid',
      accessToken: 'OFFLINE_EXPIRED_ACCESS_TOKEN',
      refreshToken: 'OFFLINE_OLD_REFRESH_TOKEN',
      clientId: 'OFFLINE_CLIENT',
      clientSecret: 'OFFLINE_CLIENT_SECRET',
      authMethod: 'IdC',
      region: 'us-east-1',
      expiresAt: Date.now() + 86_400_000
    })).status, 201)

    // No API key in the CLI environment; discover the third candidate in cwd.
    const envFile = join(dir, 'kiro-server.env')
    await (await import('node:fs/promises')).writeFile(envFile,
      'KIRO_SERVER_API_KEY=' + TEST_KEY + '\nKIRO_SERVER_URL=' + running.url + '\n',
      { mode: 0o600 })
    const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
    const toolEnv = { ...process.env }
    delete toolEnv.KIRO_SERVER_API_KEY
    delete toolEnv.KIRO_TOOL_API_KEY
    delete toolEnv.KIRO_SERVER_URL
    const runTool = args => spawnSync(process.execPath, [tool, 'account', ...args], {
      cwd: dir, env: toolEnv, encoding: 'utf8', timeout: 15000
    })
    const refreshed = runTool(['refresh', '2'])
    assert.equal(refreshed.status, 0, refreshed.stderr)
    assert.match(refreshed.stdout, /已刷新账号 2/)
    assert.doesNotMatch(refreshed.stdout, /OFFLINE_REFRESHED_ACCESS_TOKEN|OFFLINE_ROTATED_REFRESH_TOKEN/)
    const disk = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'))
    const saved = disk.accounts.find(a => a.id === 'offline-manual-refresh')
    assert.equal(saved.accessToken, 'OFFLINE_REFRESHED_ACCESS_TOKEN')
    assert.equal(saved.refreshToken, 'OFFLINE_ROTATED_REFRESH_TOKEN')
    assert.ok(saved.expiresAt > Date.now())

    // Explicit --env-file still works, and refreshing must never re-enable a disabled account.
    assert.equal((await fetch(running.url + '/admin/accounts/offline-manual-refresh/disable', {
      method: 'POST', headers
    })).status, 200)
    const again = runTool(['refresh', 'refresh@example.invalid', '--env-file', envFile])
    assert.equal(again.status, 0, again.stderr)
    const listed = await api(running.url, 'GET').then(r => r.json())
    const account = listed.accounts.find(a => a.id === 'offline-manual-refresh')
    assert.equal(account.enabled, false)
    assert.equal(account.isAvailable, false)
    assert.ok(!JSON.stringify(listed).includes('OFFLINE_REFRESHED_ACCESS_TOKEN'))
  } finally {
    if (running) await stop(running.child).catch(() => running.child.kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})

test('quota API failure still returns local account info and safe diagnostics', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-usage-failure-'))
  const port = await freePort()
  let running
  try {
    running = await start(port, dir, resolve('test/mock-usage-failure.cjs'))
    const example = {
      id: 'local-usage-failure', email: 'failure@example.invalid',
      accessToken: 'OFFLINE_ACCESS_TOKEN_MUST_NEVER_LEAK',
      region: 'us-east-1', authMethod: 'social', provider: 'GitHub',
      expiresAt: Date.now() + 1800000
    }
    assert.equal((await api(running.url, 'POST', example)).status, 201)
    const headers = { Authorization: 'Bearer ' + TEST_KEY }
    const response = await fetch(running.url + '/admin/accounts/local-usage-failure/info', { headers })
    assert.equal(response.status, 200, 'local account info is available even when quota fails')
    const data = await response.json()
    assert.equal(data.id, example.id)
    assert.equal(data.email, example.email)
    assert.equal(data.enabled, true)
    assert.equal(data.expiresAt, example.expiresAt)
    assert.equal(data.usageQuery.status, 'unavailable')
    assert.equal(data.usageQuery.code, 'HTTP_403')
    assert.equal(data.usageQuery.upstreamStatus, 403)
    assert.deepEqual(data.usageQuery.attemptedRegions, ['us-east-1', 'eu-central-1'])
    assert.equal(data.credits, undefined, 'do not invent missing quota')
    assert.equal(data.overage.status, 'UNKNOWN', 'do not invent remote overage state')
    assert.doesNotMatch(JSON.stringify(data), /OFFLINE_ACCESS_TOKEN|EXAMPLE_UPSTREAM_BODY/)
    const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
    const runTool = args => spawnSync(process.execPath, [tool, 'account', ...args], {
      cwd: dirname(tool), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, KIRO_SERVER_URL: running.url, KIRO_SERVER_API_KEY: TEST_KEY }
    })
    const info = runTool(['info', '1'])
    assert.equal(info.status, 2, 'partial info must not count as successful quota retrieval')
    assert.match(info.stdout, /HTTP_403/)
    assert.match(info.stdout, /账号序号: 1/)
    assert.match(info.stdout, /额度: 未知/)
    const usage = runTool(['usage', '1', '--json'])
    assert.equal(usage.status, 2)
    assert.equal(JSON.parse(usage.stdout).usageQuery.code, 'HTTP_403')
  } finally {
    if (running) await stop(running.child).catch(() => running.child.kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})

test('account info and retired overage commands: values, authorization and no paid mutation', { timeout: 45000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-usage-test-'))
  const port = await freePort()
  let running
  try {
    running = await start(port, dir, resolve('test/mock-token-refresh.cjs'))
    const example = {
      id: 'usage-account', email: 'usage@example.invalid', accessToken: 'OFFLINE_VALID_TOKEN',
      refreshToken: 'OFFLINE_REFRESH_TOKEN', authMethod: 'social',
      provider: 'GitHub', expiresAt: Date.now() + 1800000
    }
    assert.equal((await api(running.url, 'POST', example)).status, 201)
    const infoUrl = running.url + '/admin/accounts/usage-account/info'
    const overageUrl = running.url + '/admin/accounts/usage-account/overage'
    const headers = { Authorization: 'Bearer ' + TEST_KEY, 'Content-Type': 'application/json' }
    assert.equal((await fetch(infoUrl)).status, 401)
    assert.equal((await fetch(overageUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{"enabled":false}'
    })).status, 401)
    const retiredEnable = await fetch(overageUrl, {
      method: 'POST', headers,
      body: '{"enabled":true,"acknowledgeCharges":true}'
    })
    assert.equal(retiredEnable.status, 410, 'legacy overage route must not modify billing')
    assert.match(JSON.stringify(await retiredEnable.json()), /Add-on Credits/)
    assert.equal((await fetch(overageUrl, {
      method: 'POST', headers, body: '{"enabled":false}'
    })).status, 410, 'legacy disable route is retired as well')
    const unknown = await fetch(running.url + '/admin/accounts/no-such-account/info', { headers })
    assert.equal(unknown.status, 404)
    const info = await fetch(infoUrl, { headers })
    assert.equal(info.status, 200)
    const detail = await info.json()
    assert.equal(detail.id, example.id)
    assert.equal(detail.subscription.title, 'Kiro Pro')
    assert.equal(detail.credits.used, 24.25)
    assert.equal(detail.credits.limit, 115, 'inactive bonus must not count')
    assert.equal(detail.credits.remaining, 90.75)
    assert.equal(detail.overage.status, 'DISABLED')
    assert.equal(detail.billingMode, 'INDIVIDUAL_ADDON')
    assert.ok(!JSON.stringify(detail).includes('OFFLINE_VALID_TOKEN'))

    const tool = resolve(process.env.KIRO_TOOL_TEST_ENTRY || 'kiro-tool.cjs')
    const runTool = args => spawnSync(process.execPath, [tool, 'account', ...args], {
      cwd: dirname(tool), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, KIRO_SERVER_URL: running.url, KIRO_SERVER_API_KEY: TEST_KEY }
    })
    const listed = runTool(['info', '1'])
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /剩余: 90.75/)
    assert.match(listed.stdout, /Add-on Credits/)
    const json = runTool(['info', 'usage@example.invalid', '--json'])
    assert.equal(json.status, 0, json.stderr)
    assert.equal(JSON.parse(json.stdout).credits.remaining, 90.75)
    const legacyEnable = runTool(['overage', 'enable', '1', '--yes'])
    assert.notEqual(legacyEnable.status, 0)
    assert.match(legacyEnable.stderr, /已停用/)
    const legacyDisable = runTool(['overage', 'disable', '1'])
    assert.notEqual(legacyDisable.status, 0)
    assert.match(legacyDisable.stderr, /已停用/)
    assert.equal((await fetch(infoUrl, { headers }).then(r => r.json())).overage.status, 'DISABLED',
      'retired commands must not call setUserPreference')
    const saved = JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'))
    assert.equal(saved.accounts.length, 1)
    assert.equal(saved.accounts[0].accessToken, example.accessToken, 'query/toggle should not mutate credentials')

    // Region selection should honor a valid non-default account.region.
    const regional = {
      id: 'regional-usage-account', email: 'regional@example.invalid',
      region: 'ap-southeast-1', authMethod: 'social', provider: 'GitHub',
      accessToken: 'OFFLINE_VALID_REGIONAL_TOKEN', expiresAt: Date.now() + 1800000
    }
    assert.equal((await api(running.url, 'POST', regional)).status, 201)
    const regionalInfo = await fetch(running.url + '/admin/accounts/regional-usage-account/info', { headers })
    assert.equal(regionalInfo.status, 200)
    const regionalDetail = await regionalInfo.json()
    assert.equal(regionalDetail.usageQuery.status, 'ok')
    assert.equal(regionalDetail.subscription.title, 'Regional plan')
    assert.equal(regionalDetail.credits.used, 3.5)
    assert.equal(regionalDetail.credits.remaining, 46.5)
  } finally {
    if (running) await stop(running.child).catch(() => running.child.kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})
