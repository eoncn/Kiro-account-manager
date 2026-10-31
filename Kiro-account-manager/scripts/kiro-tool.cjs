#!/usr/bin/env node
'use strict'

// Kiro headless Server CLI. Node.js 22+, built-ins only; never prints credentials.
const fs = require('node:fs')
const readline = require('node:readline/promises')
const nodePath = require('node:path')

const ACCOUNT_COMMANDS = ['list', 'add', 'info', 'usage', 'refresh', 'enable', 'disable', 'delete', 'overage']

function usage() {
  console.log([
    'Kiro Server 账号管理 CLI（Node.js 22+）',
    '',
    '用法:',
    '  node kiro-tool.cjs help',
    '  node kiro-tool.cjs account help',
    '  node kiro-tool.cjs account help <命令>',
    '  node kiro-tool.cjs account <命令> --help',
    '',
    '常用命令:',
    '  account list                        查看账号列表',
    '  account add <账号.json>             导入或按 ID 更新账号',
    '  account info <账号>                 实时查看订阅、Credits 余额及超限状态',
    '  account usage <账号>                info 的别名',
    '  account refresh <账号>              强制刷新 Token',
    '  account enable|disable <账号>       启用或停用本地账号',
    '  account overage enable|disable <账号>  开启或关闭上游超限付费模式',
    '  account delete <账号>               删除本地账号凭证',
    '',
    '账号可以是从 1 开始的序号、账号 ID 或唯一邮箱。',
    '通用选项: --url <URL>  --env-file <路径>  --yes (-y)  --json (仅 info/usage)',
    '使用 account help 查看各命令说明；帮助命令无需 API Key 或 Server。',
    '详细文档: docs/KIRO-TOOL-CLI.md'
  ].join('\n'))
}

function accountUsage() {
  console.log([
    'Kiro Server / account 命令帮助',
    '',
    '  node kiro-tool.cjs account help [命令]',
    '  node kiro-tool.cjs account <命令> --help',
    '',
    '账号操作:',
    '  list                        查看序号、状态、邮箱、账号 ID',
    '  add <file.json>             导入单个账号（同 ID 则更新）',
    '  info <selector>             实时查询用量与账户信息',
    '  usage <selector>            info 的别名',
    '  refresh <selector>          强制刷新指定账号的 Token',
    '  enable <selector>           恢复本地账号启用状态',
    '  disable <selector>          停用账号（不删除凭证）',
    '  delete <selector>           删除本地账号（需要确认）',
    '  overage enable <selector>   开启超限付费（需要费用确认）',
    '  overage disable <selector>  关闭超限付费',
    '',
    'selector: 从 1 开始的序号、完整账号 ID 或唯一邮箱；序号以实时列表为准。',
    '示例:',
    '  node kiro-tool.cjs account list',
    '  node kiro-tool.cjs account info 2 --json',
    '  node kiro-tool.cjs account refresh 2',
    '  node kiro-tool.cjs account overage enable 2 --yes',
    '',
    '选项: --url <URL>  --env-file <路径>  --yes (-y)  --json (info/usage)',
    '更多帮助: node kiro-tool.cjs account help info',
    '详细文档: docs/KIRO-TOOL-CLI.md'
  ].join('\n'))
}

function commandUsage(command) {
  const sections = {
    list: [
      '查看 Server 保存的账号列表，显示序号、状态、邮箱与账号 ID。',
      '用法: node kiro-tool.cjs account list [--url URL] [--env-file 路径]',
      '序号从 1 开始，账号增删后可能变化；操作前建议先运行 list。'
    ],
    add: [
      '从 JSON 文件导入一个账号；相同账号 ID 再导入则更新现有账号。',
      '用法: node kiro-tool.cjs account add <account.json> [--env-file 路径]',
      '仅支持单个顶层 JSON 对象（不是数组或 credentials 嵌套备份）。',
      '需要非空 accessToken 或 refreshToken；IdC 刷新还需 clientId/clientSecret。',
      '若未提供 ID，CLI 会阻止同邮箱重复新增；请为更新操作提供已有 ID。',
      '示例: node kiro-tool.cjs account add 3.json'
    ],
    info: [
      '从 Kiro GetUsageLimits 实时查询订阅、已用/剩余 Credits、重置时间和超限状态。',
      '用法: node kiro-tool.cjs account info <selector> [--json]',
      '--json 输出结构化 JSON，供 shell 脚本解析（仅 info/usage 支持）。',
      '上游缺失的额度显示为未知；实时查询可能需要先自动刷新即将到期的 Token。',
      '示例: node kiro-tool.cjs account info 2 --json'
    ],
    refresh: [
      '即使当前 Token 未到期，也立即刷新指定账号；成功后更新 Server 存储的凭证。',
      '用法: node kiro-tool.cjs account refresh <selector>',
      '必须有可用 refreshToken；IdC 还需 clientId/clientSecret。',
      '刷新不解除管理员停用、上游封禁或额度限制。',
      '示例: node kiro-tool.cjs account refresh 2'
    ],
    enable: [
      '启用本地 Server 账号；不会解除上游封禁、额度限制或 Token 过期。',
      '用法: node kiro-tool.cjs account enable <selector>',
      '示例: node kiro-tool.cjs account enable 2'
    ],
    disable: [
      '停用本地 Server 账号，不删除已保存的凭证；可使用 enable 恢复。',
      '用法: node kiro-tool.cjs account disable <selector>',
      '示例: node kiro-tool.cjs account disable 2'
    ],
    delete: [
      '永久删除 Server 存储的账号凭证；不会删除 Kiro 官方账号或已有备份。',
      '用法: node kiro-tool.cjs account delete <selector> [--yes]',
      '交互终端需要输入 yes；非交互环境必须显式指定 --yes。',
      '示例: node kiro-tool.cjs account delete 2 --yes'
    ],
    overage: [
      '设置 Kiro 官方超限付费偏好；这不同于本地账号 enable/disable。',
      '用法: node kiro-tool.cjs account overage enable <selector> [--yes]',
      '      node kiro-tool.cjs account overage disable <selector>',
      '开启可能产生额外费用：交互终端需输入 yes，非交互环境需 --yes。',
      '关闭无需确认。操作后可运行 account info 查询官方返回的状态。',
      '别名: on = enable，off = disable。',
      '示例: node kiro-tool.cjs account overage enable 2 --yes'
    ]
  }
  if (command === 'usage') command = 'info'
  if (!Object.hasOwn(sections, command)) {
    throw Error('未知命令: ' + command + '；使用 account help 查看可用命令')
  }
  console.log(['Kiro Server / account ' + command, '', ...sections[command],
    '', 'selector: 账号序号（从 1 开始）、完整 ID 或唯一邮箱。',
    '通用选项: --url <URL>、--env-file <路径>；详见 docs/KIRO-TOOL-CLI.md'
  ].join('\n'))
}

// Help requests run before configuration(), file reads or any network call.
function showHelp(positional, opts) {
  if (positional.length === 0) { usage(); return true }
  const [resource, command, detail, fourth] = positional
  if (resource === 'help') {
    if (command === undefined && positional.length === 1) { usage(); return true }
    if (command !== 'account' || positional.length > 3) {
      throw Error('用法: help [account [命令]]')
    }
    if (detail === undefined) accountUsage()
    else commandUsage(detail)
    return true
  }
  if (resource === 'account') {
    if (command === undefined) { accountUsage(); return true }
    if (command === 'help') {
      if (positional.length > 3) throw Error('用法: account help [命令]')
      if (detail === undefined) accountUsage()
      else commandUsage(detail)
      return true
    }
    if (ACCOUNT_COMMANDS.includes(command)) {
      if (opts.help || detail === 'help' || (command === 'overage' && fourth === 'help')) {
        commandUsage(command)
        return true
      }
    } else if (opts.help) {
      accountUsage()
      return true
    }
  } else if (opts.help) {
    usage()
    return true
  }
  return false
}

function parseArgs(argv) {
  const positional = []
  const opts = { yes: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes' || arg === '-y') opts.yes = true
    else if (arg === '--json') opts.json = true
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

function discoverEnv(opts) {
  if (opts.envFile) return readEnvFile(opts.envFile, true)
  const candidates = [
    ...[process.cwd(), __dirname].flatMap(dir => [
      nodePath.join(dir, '.env'),
      nodePath.join(dir, 'server.env'),
      nodePath.join(dir, 'kiro-server.env')
    ]),
    '/etc/kiro-server.env',
    '/etc/kiro-account-manager/server.env'
  ]
  const seen = new Set()
  for (const candidate of candidates) {
    const resolved = nodePath.resolve(candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!fs.existsSync(resolved)) continue
    const variables = readEnvFile(resolved, true)
    if (variables.KIRO_SERVER_API_KEY || variables.KIRO_TOOL_API_KEY) return variables
  }
  return {}
}

function configuration(opts) {
  const fromFile = discoverEnv(opts)
  const key = process.env.KIRO_SERVER_API_KEY || process.env.KIRO_TOOL_API_KEY ||
    fromFile.KIRO_SERVER_API_KEY || fromFile.KIRO_TOOL_API_KEY
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

async function api(config, method, path, payload) {
  const response = await fetch(config.base + path, {
    method,
    headers: { Authorization: 'Bearer ' + config.key, Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(path.endsWith('/info') ? 45000 : (method === 'GET' ? 15000 : 60000))
  })
  const raw = await response.text()
  let data
  try { data = JSON.parse(raw) } catch { data = {} }
  if (!response.ok) {
    // The Server uses { error: { message, type, code } } for failed requests.
    // Show the error message, not only HTTP 400, without echoing submitted tokens.
    const serverMessage = typeof data.error === 'string' ? data.error
      : (data.error && typeof data.error.message === 'string' ? data.error.message
        : (typeof data.message === 'string' ? data.message : ''))
    throw Error('HTTP ' + response.status + (serverMessage ? ': ' + serverMessage : ''))
  }
  return data
}

function readAccountFile(filename) {
  let raw
  try {
    const stat = fs.statSync(filename)
    if (!stat.isFile()) throw Error('路径不是普通文件')
    if (stat.size < 1 || stat.size > 1024 * 1024) throw Error('文件必须非空且不超过 1 MiB')
    raw = fs.readFileSync(filename, 'utf8')
  } catch (error) {
    throw Error('无法读取账号文件: ' + (error.code || error.message))
  }
  let account
  try {
    account = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    throw Error('账号文件不是有效 JSON')
  }
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw Error('账号文件必须包含单个账号 JSON 对象（不支持数组）')
  }
  if (Array.isArray(account.accounts) || (account.credentials && typeof account.credentials === 'object')) {
    throw Error('需要单账号扁平 JSON，accessToken / refreshToken 应位于顶层')
  }
  const nonEmpty = field => typeof account[field] === 'string' && account[field].trim() !== ''
  if (!nonEmpty('accessToken') && !nonEmpty('refreshToken')) {
    throw Error('账号缺少有效的 accessToken 或 refreshToken')
  }
  if (account.id !== undefined && (!nonEmpty('id') || account.id.length > 200)) {
    throw Error('账号 id 必须是非空字符串，长度不超过 200')
  }
  return account
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

async function confirmPaidOverage(account, index, yes) {
  if (yes) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw Error('启用超限计费可能产生费用；非交互环境必须显式指定 --yes')
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('启用账号 ' + index + ' (' + (account.email || account.id) +
      ') 的超限付费模式可能产生费用。确认请输入 yes: ')
    if (answer.trim() !== 'yes') throw Error('已取消开启超限模式')
  } finally {
    rl.close()
  }
}

function formatCredits(number) {
  return typeof number === 'number' && Number.isFinite(number)
    ? String(Math.round(number * 1000) / 1000) : '未知'
}

function printAccountInfo(info, index) {
  const status = info.enabled === false ? '已停用' : (info.suspended ? '上游封禁' : '已启用')
  const sub = info.subscription || {}
  const usage = info.credits
  console.log('账号序号: ' + index)
  console.log('邮箱: ' + (info.email || '-'))
  console.log('账号 ID: ' + info.id)
  console.log('账号状态: ' + status)
  console.log('订阅: ' + (sub.title || sub.name || '未知') + (sub.status ? ' (' + sub.status + ')' : ''))
  console.log('超限模式: ' + ({ ENABLED: '已开启（可能产生费用）', DISABLED: '已关闭', UNKNOWN: '未知' }[info.overage?.status] || '未知'))
  console.log('超限资格: ' + (sub.overageCapability || '未知'))
  if (usage) {
    const unit = usage.unit ? ' ' + usage.unit : ''
    console.log('总额度: ' + formatCredits(usage.limit) + unit)
    console.log('已使用: ' + formatCredits(usage.used) + unit)
    console.log('剩余: ' + formatCredits(usage.remaining) + unit)
    console.log('基础额度: ' + formatCredits(usage.base?.used) + ' / ' + formatCredits(usage.base?.limit))
    if (usage.trial) console.log('试用额度: ' + formatCredits(usage.trial.used) + ' / ' + formatCredits(usage.trial.limit))
    for (const bonus of usage.bonuses || []) {
      console.log('奖励 [' + (bonus.name || '-') + ']: ' + formatCredits(bonus.used) + ' / ' + formatCredits(bonus.limit))
    }
  } else {
    console.log('额度: 未知（Kiro 未提供 CREDIT 用量信息）')
  }
  if (typeof info.overage?.rate === 'number') console.log('超限费率: ' + formatCredits(info.overage.rate))
  if (typeof info.overage?.cap === 'number') console.log('超限上限: ' + formatCredits(info.overage.cap))
  console.log('额度重置时间: ' + (info.nextResetDate || '未知'))
  console.log('Token 过期时间: ' + (Number.isSafeInteger(info.expiresAt) ? new Date(info.expiresAt).toISOString() : '未知'))
  console.log('查询时间: ' + (info.checkedAt || '未知'))
}

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2))
  if (showHelp(positional, opts)) return
  const [resource, command, selector, ...extra] = positional
  if (resource !== 'account' || !['list', 'add', 'delete', 'enable', 'disable', 'refresh', 'info', 'usage', 'overage'].includes(command)) {
    throw Error('命令格式错误，使用 --help 查看帮助')
  }
  let target = selector
  let overageEnabled
  if (command === 'overage') {
    if (!['enable', 'disable', 'on', 'off'].includes(selector) || extra.length !== 1) {
      throw Error('正确用法: account overage enable|disable 序号')
    }
    overageEnabled = selector === 'enable' || selector === 'on'
    target = extra[0]
  } else if (extra.length || (command === 'list' && selector) || (command !== 'list' && !selector)) {
    throw Error('参数数量不正确，使用 --help 查看帮助')
  }
  if (opts.json && !['info', 'usage'].includes(command)) throw Error('--json 仅支持 account info')
  const config = configuration(opts)
  if (command === 'add') {
    const account = readAccountFile(selector)
    // 未带 ID 的重复导入会让 Server 创建新 ID；在本地先检查邮箱避免误新增。
    if (!account.id && typeof account.email === 'string' && account.email.trim()) {
      const existing = await api(config, 'GET', '/admin/accounts')
      if (Array.isArray(existing.accounts) && existing.accounts.some(a =>
        typeof a.email === 'string' && a.email.toLowerCase() === account.email.trim().toLowerCase()
      )) {
        throw Error('该邮箱已在账号列表中；如需更新，请在 JSON 中填写 account list 显示的 id')
      }
    }
    const result = await api(config, 'POST', '/admin/accounts', account)
    if (!result.success || typeof result.id !== 'string') throw Error('Server 未确认导入成功')
    console.log((result.updated ? '已更新账号: ' : '已添加账号: ') + (account.email || result.id))
    console.log('账号 ID: ' + result.id)
    if (!account.id) console.log('提示：建议将该 ID 保存到 JSON，便于下次更新同一账号。')
    return
  }
  const result = await api(config, 'GET', '/admin/accounts')
  if (!Array.isArray(result.accounts)) throw Error('Server 未返回有效账号列表')
  if (command === 'list') { printAccounts(result.accounts); return }

  const { account, index } = resolveAccount(result.accounts, target)
  if (command === 'info' || command === 'usage') {
    const detail = await api(config, 'GET', '/admin/accounts/' + encodeURIComponent(account.id) + '/info')
    if (!detail || detail.id !== account.id) throw Error('Server 未返回有效账号信息')
    if (opts.json) console.log(JSON.stringify(detail, null, 2))
    else printAccountInfo(detail, index)
    return
  }
  if (command === 'overage') {
    if (overageEnabled) await confirmPaidOverage(account, index, opts.yes)
    const done = await api(config, 'POST', '/admin/accounts/' + encodeURIComponent(account.id) + '/overage', {
      enabled: overageEnabled, ...(overageEnabled ? { acknowledgeCharges: true } : {})
    })
    const expected = overageEnabled ? 'ENABLED' : 'DISABLED'
    if (!done.success || done.id !== account.id || done.status !== expected) {
      throw Error('Server 未确认超限模式变更')
    }
    console.log('账号 ' + index + ' (' + (account.email || account.id) +
      ') 超限模式操作成功: ' + (overageEnabled ? '开启（可能产生额外费用）' : '关闭'))
    return
  }
  if (command === 'refresh') {
    const done = await api(config, 'POST', '/admin/accounts/' + encodeURIComponent(account.id) + '/refresh')
    if (!done.success || done.id !== account.id || done.action !== 'refresh') {
      throw Error('Server 未确认刷新成功，建议重新查询账号列表')
    }
    console.log('已刷新账号 ' + index + ': ' + (account.email || account.id))
    if (Number.isSafeInteger(done.expiresAt)) {
      console.log('Token 到期时间: ' + new Date(done.expiresAt).toISOString())
    }
    return
  }
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
