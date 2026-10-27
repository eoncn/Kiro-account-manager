// Offline integration test: never contacts Kiro upstream or uses actual credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'

const entry = resolve('dist/server/index.cjs')
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

async function start(port, dir) {
  const logs = []
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      DISPLAY: '',
      KIRO_SERVER_HOST: '127.0.0.1',
      KIRO_SERVER_PORT: String(port),
      KIRO_SERVER_API_KEY: TEST_KEY,
      KIRO_SERVER_DATA_DIR: dir
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
  } finally {
    if (running) await stop(running.child).catch(() => running.child.kill('SIGKILL'))
    await rm(dir, { recursive: true, force: true })
  }
})
