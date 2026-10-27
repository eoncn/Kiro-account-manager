// Minimal cross-runtime adapter: headless Server must not import Electron or K-Proxy.
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { KProxyService } from '../kproxy'

let serviceResolver: (() => KProxyService | null) | undefined
let dataDirectory = resolve(process.cwd(), 'data')

export function setKProxyServiceResolver(resolver: (() => KProxyService | null) | undefined): void {
  serviceResolver = resolver
}

export function getKProxyService(): KProxyService | null {
  return serviceResolver?.() ?? null
}

export function generateDeviceId(): string {
  return randomBytes(32).toString('hex')
}

export function setProxyDataDirectory(directory: string): void {
  dataDirectory = resolve(directory)
}

export function getProxyDataDirectory(): string {
  return dataDirectory
}
