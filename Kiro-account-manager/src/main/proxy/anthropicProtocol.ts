// Anthropic Messages 协议与 Claude Code 会话标识辅助函数。
// 不估算、不模拟缓存：所有 cache tokens 只来自 Kiro 上游 tokenUsage。
import { createHash } from 'node:crypto'
import type { ClaudeMessage } from './types'

export interface KiroTokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export function toAnthropicUsage(usage: KiroTokenCounts): {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
} {
  const cacheRead = usage.cacheReadTokens ?? 0
  const cacheWrite = usage.cacheWriteTokens ?? 0
  // Kiro inputTokens 包含缓存读写，Anthropic input_tokens 则不包含。
  return {
    input_tokens: Math.max(0, usage.inputTokens - cacheRead - cacheWrite),
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead
  }
}

// cache_control 是移动的缓存标记，不应影响初始用户消息的会话指纹。
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'cache_control')
      .map(([key, val]) => [key, stripCacheControl(val)])
  )
}

/**
 * 旧版 Claude Code 缺少 x-claude-code-session-id 时的最佳努力回退。
 * 首条真实用户消息在多轮请求中保持不变；不再依赖代理注入的 system history。
 * 如果不同会话的首条消息完全相同，仍可能碰撞，应优先使用官方会话头。
 */
export function fallbackClaudeSessionHint(messages: readonly ClaudeMessage[]): string | undefined {
  const firstUser = messages.find(message => message.role === 'user')
  if (!firstUser) return undefined
  const serialized = JSON.stringify(stripCacheControl(firstUser.content))
  if (!serialized || serialized === '""' || serialized === '[]') return undefined
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 40)
  return `claude-first-user:${digest}`
}
