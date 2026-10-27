// Shared OIDC/social token refresh for Electron and the standalone Node.js server.
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { safeCreateProxyAgent } from './systemProxy'

export interface TokenRefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

function networkAgent(proxyUrl?: string) {
  const globalProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  return safeCreateProxyAgent(proxyUrl || globalProxy)
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, proxyUrl?: string): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const dispatcher = networkAgent(proxyUrl)
  try {
    const response = await undiciFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(dispatcher ? { dispatcher } : {})
    } as UndiciRequestInit)
    // Never propagate upstream body: it may contain account-sensitive information.
    if (!response.ok) return { ok: false, status: response.status, data: {} }
    const parsed: unknown = await response.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: response.status, data: {} }
    }
    return { ok: true, status: response.status, data: parsed as Record<string, unknown> }
  } finally {
    if (dispatcher) {
      try { await dispatcher.close() } catch { /* ignore agent close failures */ }
    }
  }
}

export async function refreshOidcToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region = 'us-east-1',
  proxyUrl?: string
): Promise<TokenRefreshResult> {
  if (!refreshToken || !clientId || !clientSecret) {
    return { success: false, error: 'Missing OIDC refresh credentials' }
  }
  try {
    const response = await postJson(`https://oidc.${region}.amazonaws.com/token`, {
      clientId, clientSecret, refreshToken, grantType: 'refresh_token'
    }, {}, proxyUrl)
    const token = response.data.accessToken
    if (!response.ok || typeof token !== 'string' || !token) {
      return { success: false, error: `OIDC token refresh failed (HTTP ${response.status})` }
    }
    return {
      success: true,
      accessToken: token,
      refreshToken: typeof response.data.refreshToken === 'string' ? response.data.refreshToken : refreshToken,
      expiresIn: typeof response.data.expiresIn === 'number' ? response.data.expiresIn : 3600
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'OIDC token refresh failed' }
  }
}

export async function refreshSocialToken(
  refreshToken: string,
  proxyUrl?: string,
  machineId?: string
): Promise<TokenRefreshResult> {
  if (!refreshToken) return { success: false, error: 'Missing social refresh token' }
  const suffix = machineId ? `KiroIDE-0.6.18-${machineId}` : 'KiroIDE-0.6.18'
  const userAgent = `aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
  try {
    const response = await postJson(
      'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken',
      { refreshToken }, { 'User-Agent': userAgent }, proxyUrl
    )
    const token = response.data.accessToken
    if (!response.ok || typeof token !== 'string' || !token) {
      return { success: false, error: `Social token refresh failed (HTTP ${response.status})` }
    }
    return {
      success: true,
      accessToken: token,
      refreshToken: typeof response.data.refreshToken === 'string' ? response.data.refreshToken : refreshToken,
      expiresIn: typeof response.data.expiresIn === 'number' ? response.data.expiresIn : 3600
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Social token refresh failed' }
  }
}

export async function refreshTokenByMethod(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  region = 'us-east-1',
  authMethod?: string,
  proxyUrl?: string,
  machineId?: string
): Promise<TokenRefreshResult> {
  return authMethod === 'social'
    ? refreshSocialToken(refreshToken, proxyUrl, machineId)
    : refreshOidcToken(refreshToken, clientId, clientSecret, region, proxyUrl)
}
