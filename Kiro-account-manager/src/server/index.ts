// Standalone Node.js 22 entry point. No Electron, browser, GUI, or Xvfb.
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProxyServer } from '../main/proxy/proxyServer'
import { proxyLogger, proxyLogStore } from '../main/proxy/logger'
import { setProxyDataDirectory } from '../main/proxy/runtimeBridge'
import { setProfileArnPersistCallback } from '../main/proxy/kiroApi'
import { refreshTokenByMethod } from '../main/proxy/tokenRefresh'
import { AccountStorage } from './accountStorage'
import type { ProxyConfig } from '../main/proxy/types'

function readPort(value: string | undefined): number {
  if (!value) return 5580
  if (!/^\d+$/.test(value)) throw new Error('KIRO_SERVER_PORT must be an integer between 1 and 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('KIRO_SERVER_PORT must be an integer between 1 and 65535')
  }
  return port
}

async function main(): Promise<void> {
  const apiKey = process.env.KIRO_SERVER_API_KEY?.trim()
  if (!apiKey) throw new Error('KIRO_SERVER_API_KEY is required')
  const host = process.env.KIRO_SERVER_HOST?.trim() || '127.0.0.1'
  const port = readPort(process.env.KIRO_SERVER_PORT)
  const dataDirectory = resolve(process.env.KIRO_SERVER_DATA_DIR || join(homedir(), '.local', 'share', 'kiro-account-manager-server'))

  const storage = new AccountStorage(dataDirectory)
  await storage.load()
  setProxyDataDirectory(dataDirectory)
  proxyLogStore.initialize(dataDirectory)
  proxyLogger.configure({ enabled: true, logDir: join(dataDirectory, 'logs', 'proxy'), logToConsole: true })

  const config: ProxyConfig = {
    enabled: true,
    host,
    port,
    apiKey,
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    maxRetries: 3,
    retryDelayMs: 1000,
    tokenRefreshBeforeExpiry: 300,
    clientDrivenToolExecution: true,
    autoStart: false
  }

  // Keep the shared ProxyServer and wire its desktop callbacks to a durable Node store.
  const server = new ProxyServer(config, {
    onAccountImport: account => storage.upsert(account),
    onTokenRefresh: async account => {
      if (!account.refreshToken) return { success: false, error: 'No refreshToken provided' }
      const result = await refreshTokenByMethod(
        account.refreshToken,
        account.clientId || '',
        account.clientSecret || '',
        account.region || 'us-east-1',
        account.authMethod,
        account.proxyUrl,
        account.machineId
      )
      return {
        ...result,
        expiresAt: result.success ? Date.now() + (result.expiresIn || 3600) * 1000 : undefined
      }
    },
    onAccountUpdate: account => {
      void storage.patch(account.id, account).catch(error => {
        console.error('[Server] Could not persist updated account:', error instanceof Error ? error.message : 'Unknown error')
      })
    },
    onAccountSuspended: info => {
      void storage.patch(info.accountId, {
        suspendedAt: Date.now(), suspendReason: info.reason, suspendMessage: info.message
      }).catch(error => {
        console.error('[Server] Could not persist suspension:', error instanceof Error ? error.message : 'Unknown error')
      })
    },
    onError: error => console.error('[Server] Proxy error:', error.message)
  })
  for (const account of storage.list()) server.getAccountPool().addAccount(account)
  setProfileArnPersistCallback((id, profileArn) => {
    server.getAccountPool().updateAccount(id, { profileArn })
    void storage.patch(id, { profileArn }).catch(error => {
      console.error('[Server] Could not persist profileArn:', error instanceof Error ? error.message : 'Unknown error')
    })
  })

  let stopping = false
  async function shutdown(reason: string, failed = false): Promise<void> {
    if (stopping) return
    stopping = true
    console.log(`[Server] Stopping (${reason})`)
    const watchdog = setTimeout(() => process.exit(1), 12000)
    watchdog.unref()
    try {
      await server.stop(5000)
      await storage.flush()
      setProfileArnPersistCallback(undefined)
      proxyLogger.close()
      clearTimeout(watchdog)
      process.exitCode = failed ? 1 : 0
    } catch (error) {
      console.error('[Server] Shutdown failed:', error)
      process.exitCode = 1
    }
  }

  process.once('SIGTERM', () => { void shutdown('SIGTERM') })
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('uncaughtException', error => {
    console.error('[Server] Uncaught exception:', error)
    void shutdown('uncaughtException', true)
  })
  process.once('unhandledRejection', reason => {
    console.error('[Server] Unhandled rejection:', reason)
    void shutdown('unhandledRejection', true)
  })

  await server.start()
  console.log(`[Server] Listening on http://${host}:${port} with ${storage.list().length} stored account(s)`)
}

void main().catch(error => {
  // No key, token or account data is intentionally interpolated into startup errors.
  console.error('[Server] Startup failed:', error instanceof Error ? error.message : 'Unknown error')
  process.exitCode = 1
})
