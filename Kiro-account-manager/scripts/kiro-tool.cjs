#!/usr/bin/env node
'use strict'

// Kiro headless Server CLI. Node.js 22+, built-ins only; never prints credentials.
const fs = require('node:fs')
const readline = require('node:readline/promises')

function usage() {
  console.log([
    'Kiro Server 账号管理 (序号从 1 开始)',
    '',
    '  node kiro-tool.cjs account list',
    '  node kiro-tool.cjs account disable 2',
    '  node kiro-tool.cjs account enable 2',
    '  node kiro-tool.cjs account delete 2',
    '  node kiro-tool.cjs account delete 2 --yes    # 无交互确认',
    '',
    '选项: --url http://127.0.0.1:5580  --env-file /path/server.env  --yes',
    '环境变量: KIRO_SERVER_API_KEY, KIRO_SERVER_URL, KIRO_SERVER_HOST, KIRO_SERVER_PORT',
    '如果未设置 API Key，自动尝试读取 /etc/kiro-account-manager/server.env。',
    '删除会永久移除 Server 存储的账号凭证；不会删除 Kiro 官方账号。'
  ].join('\n'))
}

function parseArgs(argv) {
  const positional = []
  const opts = { yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--url' || arg === '--env-file') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(arg + ' 缺少参数')
      opts[arg === '--url' ? 'url' : 'envFile'] = argv[++i]
    } else if (arg.startsWith('--')) throw Error('未知选项: ' + arg)
    else positional.push(arg)
  }
  return { positional, opts }
}

function readEnvFile(path, strict) {
  if (!fs.existsSync(path)) {
    if (strict) throw Error('配置文件不存在: ' + path)
    return {}
  }
  const out = {}
  for (let line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    line = line.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const pos = line.indexOf('=')
    if (pos < 1) continue
    const key = line.slice(0, pos).trim()
    let value = line.slice(pos + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) out[key] = value
  }
  return out
}

function configuration(opts) {
  const fromFile = readEnvFile(opts.envFile || '/etc/kiro-account-manager/server.env', !!opts.envFile)
  const key = process.env.KIRO_SERVER_API_KEY || process.env.KIRO_TOOL_API_KEY || fromFile.KIRO_SERVER_API_KEY
  if (!key) throw Error('缺少 KIRO_SERVER_API_KEY；请设置环境变量或通过 --env-file 指定 Server 配置')
  const hostRaw = process.env.KIRO_SERVER_HOST || fromFile.KIRO_SERVER_HOST || '127.0.0.1'
  const host = hostRaw === '0.0.0.0' || hostRaw === '::' ? '127.0.0.1' : hostRaw
  const port = process.env.KIRO_SERVER_PORT || fromFile.KIRO_SERVER_PORT || '5580'
  const base = opts.url || process.env.KIRO_SERVER_URL || fromFile.KIRO_SERVER_URL ||
    ('http://' + (host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host) + ':' + port)
  const url = new URL(base)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Error('Server URL 必须是 http 或 https')
  if (url.username || url.password || url.search || url.hash) throw Error('Server URL 不能携带凭证或查询参数')
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('远程管理必须使用 HTTPS，或通过 SSH 端口转发至本地')
  }
  return { key, base: url.href.replace(/\/$/, '') }
}

async function api(config, method, path) {
  const response = await fetch(config.base + path, {
    method,
    headers: { Authorization: 'Bearer ' + config.key, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  })
  const raw = await response.text()
  let data
  try { data = JSON.parse(raw) } catch { data = {} }
  if (!response.ok) {
    const serverMessage = typeof data.error === 'string' ? data.error
      : (typeof data.message === 'string' ? data.message : '')
    throw Error('HTTP ' + response.status + (serverMessage ? ': ' + serverMessage : ''))
  }
  return data
}

function resolveAccount(accounts, selector) {
  if (!selector) throw Error('缺少账号序号（从 1 开始）或账号 ID')
  if (/^\d+$/.test(selector)) {
    const index = Number(selector)
    if (!Number.isSafeInteger(index) || index < 1 || index > accounts.length) {
      throw Error('账号序号超出范围，请先运行 account list')
    }
    return { account: accounts[index - 1], index }
  }
  const matches = accounts.filter(a =>
    a.id === selector || (a.email && a.email.toLowerCase() === selector.toLowerCase()))
  if (matches.length !== 1) throw Error(matches.length ? '邮箱对应多个账号，请使用账号 ID' : '账号不存在')
  return { account: matches[0], index: accounts.indexOf(matches[0]) + 1 }
}

function printAccounts(accounts) {
  if (!accounts.length) { console.log('暂无已导入的账号'); return }
  console.log('序号\t状态\t邮箱\t\t账号 ID')
  accounts.forEach((account, i) => {
    const status = account.enabled === false ? '已停用' :
      (account.suspended ? '上游封禁' : (account.isAvailable ? '可用' : '暂不可用'))
    console.log(String(i + 1) + '\t' + status + '\t' + (account.email || '-') + '\t' + account.id)
  })
  console.log('账号数: ' + accounts.length)
}

async function confirmDelete(account, index, yes) {
  if (yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw Error('非交互环境删除账号必须显式指定 --yes')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('确认永久删除账号 ' + index + ' (' + (account.email || account.id) + ')? 输入 yes: ')
    if (answer.trim() !== 'yes') throw Error('已取消删除')
  } finally {
    rl.close()
  }
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2))
  if (opts.help || positional.length === 0) { usage(); return }
  const [resource, command, selector, ...extra] = positional
  if (resource !== 'account' || !['list', 'delete', 'enable', 'disable'].includes(command)) {
    throw Error('命令格式错误，使用 --help 查看帮助')
  }
  if (extra.length || (command === 'list' && selector) || (command !== 'list' && !selector)) {
    throw Error('参数数量不正确，使用 --help 查看帮助')
  }
  const config = configuration(opts)
  const result = await api(config, 'GET', '/admin/accounts')
  if (!Array.isArray(result.accounts)) throw Error('Server 未返回有效账号列表')
  if (command === 'list') { printAccounts(result.accounts); return }

  const { account, index } = resolveAccount(result.accounts, selector)
  if (command === 'delete') await confirmDelete(account, index, opts.yes)
  const method = command === 'delete' ? 'DELETE' : 'POST'
  const path = '/admin/accounts/' + encodeURIComponent(account.id) +
    (command === 'delete' ? '' : '/' + command)
  const done = await api(config, method, path)
  if (!done.success || done.id !== account.id) throw Error('Server 未确认修改，建议重新查询账号列表')
  const actionLabel = { delete: '已删除', disable: '已停用', enable: '已启用' }
  console.log(actionLabel[command] + '账号 ' + index + ': ' + (account.email || account.id))
  if (command === 'delete') console.log('账号凭证已从 Server 数据文件移除（不影响已有备份文件）。')
}

main().catch(error => {
  console.error('错误: ' + (error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
