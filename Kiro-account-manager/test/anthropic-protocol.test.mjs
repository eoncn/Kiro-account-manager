// 离线协议回归测试：不调用 Kiro，也不需要真实账号。
import test from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function loadProtocol() {
  const file = resolve('src/main/proxy/anthropicProtocol.ts')
  const source = await readFile(file, 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' })
  const dir = await mkdtemp(join(tmpdir(), 'kiro-anthropic-protocol-'))
  const out = join(dir, 'anthropicProtocol.mjs')
  await writeFile(out, code)
  try {
    return await import(pathToFileURL(out).href)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('Anthropic usage: preserve real zero cache reads and writes', async () => {
  const { toAnthropicUsage } = await loadProtocol()
  assert.deepEqual(toAnthropicUsage({
    inputTokens: 1000, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0
  }), {
    input_tokens: 1000, output_tokens: 20,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0
  })
  assert.deepEqual(toAnthropicUsage({
    inputTokens: 1000, outputTokens: 20
  }), {
    input_tokens: 1000, output_tokens: 20,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0
  })
})

test('Anthropic usage: subtract real cache tokens exactly once', async () => {
  const { toAnthropicUsage } = await loadProtocol()
  assert.deepEqual(toAnthropicUsage({
    inputTokens: 1200, outputTokens: 30, cacheReadTokens: 800, cacheWriteTokens: 100
  }), {
    input_tokens: 300, output_tokens: 30,
    cache_creation_input_tokens: 100, cache_read_input_tokens: 800
  })
})

test('Claude Code fallback uses first user text regardless of cache marker movement', async () => {
  const { fallbackClaudeSessionHint } = await loadProtocol()
  const first = [{ role: 'user', content: [{ type: 'text', text: 'Fix this bug', cache_control: { type: 'ephemeral' } }] }]
  const second = [
    { role: 'user', content: [{ type: 'text', text: 'Fix this bug' }] },
    { role: 'assistant', content: 'Done' },
    { role: 'user', content: 'Continue' }
  ]
  assert.equal(fallbackClaudeSessionHint(first), fallbackClaudeSessionHint(second))
  assert.notEqual(fallbackClaudeSessionHint(first),
    fallbackClaudeSessionHint([{ role: 'user', content: 'Different task' }]))
})

test('No simulated Anthropic cache or per-request timestamp in active proxy paths', async () => {
  const proxy = await readFile(resolve('src/main/proxy/proxyServer.ts'), 'utf8')
  const translator = await readFile(resolve('src/main/proxy/translator.ts'), 'utf8')
  assert.ok(!proxy.includes('promptCacheTracker'))
  assert.ok(!proxy.includes('simulatedCacheUsage'))
  assert.ok(!translator.includes('new Date().toISOString()'))
  assert.ok(proxy.includes('fallbackClaudeSessionHint(request.messages)'))
  assert.ok(proxy.includes('x-claude-code-session-id'))
})
