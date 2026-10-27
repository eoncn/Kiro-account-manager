// Offline account-pool regression test. No Kiro calls, credentials or Electron.
import test from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadPool() {
  const input = await readFile(resolve('src/main/proxy/accountPool.ts'), 'utf8')
  const { code } = await transform(input, { loader: 'ts', format: 'esm', target: 'node22' })
  const dir = await mkdtemp(join(tmpdir(), 'kiro-pool-test-'))
  const file = join(dir, 'pool.mjs')
  await writeFile(file, code)
  try { return await import(pathToFileURL(file).href) }
  finally { await rm(dir, { recursive: true, force: true }) }
}

test('manually disabled single account is never chosen', async () => {
  const { AccountPool } = await loadPool()
  const pool = new AccountPool()
  pool.addAccount({ id: 'disabled', accessToken: 'fake', manuallyDisabled: true })
  assert.equal(pool.availableCount, 0)
  assert.equal(pool.getNextAccount(), null)
  assert.equal(pool.getNextAvailableAccount(new Set()), null)
})

test('disabled account cannot be used by retry/cooldown fallback', async () => {
  const { AccountPool, ErrorType } = await loadPool()
  const pool = new AccountPool({ probabilisticRetryChance: 0 })
  pool.addAccount({ id: 'disabled', accessToken: 'fake', manuallyDisabled: true })
  pool.addAccount({ id: 'working', accessToken: 'fake' })
  assert.equal(pool.getNextAccount()?.id, 'working')
  pool.recordError('working', ErrorType.RECOVERABLE, 403)
  assert.equal(pool.getNextAccount()?.id, 'working')
  assert.equal(pool.getNextAvailableAccount(new Set())?.id, 'working')
  pool.removeAccount('working')
  assert.equal(pool.getNextAccount(), null)
})

test('reset must not enable manually disabled accounts', async () => {
  const { AccountPool } = await loadPool()
  const pool = new AccountPool()
  pool.addAccount({ id: 'disabled', accessToken: 'fake', manuallyDisabled: true })
  pool.reset()
  assert.equal(pool.availableCount, 0)
  assert.equal(pool.getNextAccount(), null)
})
