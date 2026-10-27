// Minimal durable account store for the headless server. No Electron/renderer dependencies.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProxyAccount } from '../main/proxy/types'

interface StoredAccounts {
  version: 1
  accounts: ProxyAccount[]
}

export class AccountStorage {
  private readonly file: string
  private readonly directory: string
  private accounts = new Map<string, ProxyAccount>()
  private pending: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.directory = directory
    this.file = join(directory, 'accounts.json')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    await fs.chmod(this.directory, 0o700)
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid accounts.json object')
    const data = parsed as Partial<StoredAccounts>
    if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error('Invalid accounts.json format')
    const next = new Map<string, ProxyAccount>()
    for (const item of data.accounts) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.accessToken !== 'string' || !item.accessToken) {
        throw new Error('Invalid account in accounts.json')
      }
      if (next.has(item.id)) throw new Error('Duplicate account ID in accounts.json')
      next.set(item.id, item)
    }
    this.accounts = next
    await fs.chmod(this.file, 0o600)
  }

  list(): ProxyAccount[] {
    return Array.from(this.accounts.values()).map(a => ({ ...a }))
  }

  // Serial writes prevent refresh/import from racing; rollback on failed persistence.
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.pending.then(operation)
    this.pending = task.catch(() => { /* keep queue usable */ })
    return task
  }

  private async persist(): Promise<void> {
    const temp = join(this.directory, `.accounts.${process.pid}.${randomUUID()}.tmp`)
    const content = JSON.stringify({ version: 1, accounts: [...this.accounts.values()] } satisfies StoredAccounts, null, 2) + '\n'
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      // The newly created temp file is already 0600; rename is the commit point.
      await fs.rename(temp, this.file)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }

  upsert(account: ProxyAccount): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.accounts.get(account.id)
      this.accounts.set(account.id, {
        ...previous, ...account,
        suspendedAt: undefined, suspendReason: undefined, suspendMessage: undefined,
        isAvailable: true
      })
      try {
        await this.persist()
      } catch (error) {
        if (previous) this.accounts.set(account.id, previous)
        else this.accounts.delete(account.id)
        throw error
      }
    })
  }

  /** Persist-first delete, rollback on disk failure. */
  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.accounts.get(id)
      if (!previous) throw new Error('Account not found')
      this.accounts.delete(id)
      try {
        await this.persist()
      } catch (error) {
        this.accounts.set(id, previous)
        throw error
      }
    })
  }

  /** Serialized admin state mutation; unlike patch, missing IDs are errors. */
  setManagementState(id: string, updates: Partial<ProxyAccount>): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.accounts.get(id)
      if (!previous) throw new Error('Account not found')
      this.accounts.set(id, { ...previous, ...updates })
      try {
        await this.persist()
      } catch (error) {
        this.accounts.set(id, previous)
        throw error
      }
    })
  }

  patch(id: string, updates: Partial<ProxyAccount>): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.accounts.get(id)
      if (!previous) return
      this.accounts.set(id, { ...previous, ...updates })
      try {
        await this.persist()
      } catch (error) {
        this.accounts.set(id, previous)
        throw error
      }
    })
  }

  async flush(): Promise<void> {
    await this.pending
  }
}
