# Kiro Server CLI 命令手册（kiro-tool.cjs）

本手册适用于仓库 `dev` 分支中的 **无头（Headless）Server 账号管理命令行工具** `kiro-tool.cjs`。CLI 使用 Node.js 22+ 内置模块，不需要 Electron、图形桌面或额外安装 npm 依赖。账号管理需要一个正在运行、版本匹配的 Kiro Server，只有 **help / --help** 不需要 Server 或 API Key。

> 此工具是本地/自管 Kiro Server 的账号管理客户端。它不会修改官方登录密码，也不能绕过官方额度、收费或风控。**自 2026 年 7 月 1 日起个人付费计划的旧版超限计费已由 Add-on Credits 取代；原 `account overage` 写入命令已从 CLI 移除，Server 对旧 `POST /admin/accounts/:id/overage` 返回 HTTP 410，不再调用 Kiro 的计费偏好设置接口。** 企业超限请由管理员在 AWS Kiro 控制台管理。参考 [Kiro 官方公告](https://kiro.dev/changelog/general/add-on-credits/) 和 [官方 FAQ](https://kiro.dev/faq/)。

## 1. 快速开始

将从 GitHub Actions **Headless Server Standalone Package** 下载的 `kiro-tool.cjs` 和对应版本的 `kiro-server.cjs` 部署在服务器上；服务进程需先按部署文档启动。

```bash
node --version                             # 需要 Node.js 22+
node kiro-tool.cjs --help                  # 无需配置、无需联网
node kiro-tool.cjs account help            # 所有账号管理命令
node kiro-tool.cjs account list            # 查询当前账号及其序号
node kiro-tool.cjs account info 2          # 查询第 2 个账号额度
node kiro-tool.cjs account refresh 2       # 强制刷新第 2 个账号 Token
```

当配置存放于 `/etc/kiro-server.env` 时，CLI 默认自动发现，**无需每次传入** `--config-file /etc/kiro-server.env`。安装和 Server 启动过程详见 [Headless 单文件部署](HEADLESS-STANDALONE.md) 和 [Server 部署说明](HEADLESS-SERVER-DEPLOY.md)。

## 2. 帮助系统（完全离线）

**现在统一规则：`help`、`-h`、`--help` 在任意命令层级完全等价。** 推荐日常使用 `--help`（传统 CLI 风格）；以前习惯的 `account help` 和直接输入 `help` 仍然保留。**所有帮助都无需配置 Key、不读账号文件、不访问 Server，也不会真正执行命令。**

### 三种写法对照

| 查看哪个层级 | `help` | `-h` | `--help` |
| --- | --- | --- | --- |
| 全局 | `node kiro-tool.cjs help` | `node kiro-tool.cjs -h` | `node kiro-tool.cjs --help` |
| 账号总览 | `node kiro-tool.cjs account help` | `node kiro-tool.cjs account -h` | `node kiro-tool.cjs account --help` |
| 指定命令 | `node kiro-tool.cjs account info help` | `node kiro-tool.cjs account info -h` | `node kiro-tool.cjs account info --help` |

以上规则也适用于 `list`、`add`、`usage`、`refresh`、`enable`、`disable` 和 `delete`。同一层级三种写法会输出完全一致的帮助。已废弃的 `account overage ... help/-h/--help` 仅显示移除通知。

### help 的其它兼容位置

```bash
# help 可写在命令前：传统的「查看某个命令帮助」写法
node kiro-tool.cjs account help info
node kiro-tool.cjs help account info

# 也可写在必需参数之后，参数无需真实存在
node kiro-tool.cjs account info 2 help
node kiro-tool.cjs account info 2 -h
node kiro-tool.cjs account info 2 --help
node kiro-tool.cjs account add missing.json --help

# 不写任何命令也可以显示全局帮助
node kiro-tool.cjs
node kiro-tool.cjs account
```

在以上场景中，帮助由具体程度最高的已识别命令层级决定。已移除的旧 `account overage enable/disable` 不再出现在主帮助；直接调用会退出并提示官方 Add-on Credits / Enterprise 管理入口，不会发送费用相关请求。未知命令/帮助主题仍返回非零退出码。

**注意**：`help` 是保留命令字；如果 JSON 文件恰好叫 `help`，使用 `./help` 或其它路径作为文件参数，避免被当作帮助请求。

## 3. 命令与参数速查

统一格式：

```text
node kiro-tool.cjs account <命令> [必需参数] [选项]
```

| 命令 | 功能 | 使用示例 |
| --- | --- | --- |
| `list` | 账号列表、序号、邮箱、状态及 ID | `account list` |
| `add <文件>` | 导入一个账号；同 ID 时更新 | `account add 3.json` |
| `info <账号>` | 实时查看订阅、Credits 余量及计费方式 | `account info 2` |
| `usage <账号>` | `info` 的别名 | `account usage 2` |
| `refresh <账号>` | 强制刷新 Token 并保存轮换凭证 | `account refresh 2` |
| `enable <账号>` | 启用本地账号 | `account enable 2` |
| `disable <账号>` | 停用本地账号，不删除凭证 | `account disable 2` |
| `delete <账号>` | 删除本地账号凭证，需要确认 | `account delete 2 --yes` |

原 `account overage enable/disable/on/off` **已停用**；请勿将旧脚本中的 `--yes` 视为已购买附加额度。个人订阅购买 [Add-on Credits](https://app.kiro.dev/account/usage)，企业超限由 AWS Kiro 管理员在官方控制台设置。

### 账号定位规则

所有 `<账号>` 参数均支持三种形式：

- **序号**：`1`、`2`、`3`，从 1 开始。CLI 每次先请求实时账号列表，再将序号换成账号 ID。删除、导入后序号可能变化，操作前建议先 `account list`。
- **账号 ID**：`account list` 返回的完整稳定 ID，适用于脚本、定时任务。
- **唯一邮箱**：不区分邮箱大小写；若同邮箱有多个账号，会拒绝操作并提示使用 ID。

纯数字字符串会被解析为**序号**，不是 ID。如果账号 ID 恰好全是数字，建议改用唯一邮箱或调整 ID。

## 4. 通用选项、环境变量与配置查找

| 选项 | 含义 | 适用范围 |
| --- | --- | --- |
| `help`, `-h`, `--help` | 打印当前层级帮助并退出；三种形式等价 | 所有层级（`help` 可作子命令或后缀） |
| `--url <URL>` | 显式指定 Server 管理 API 地址 | 需要连接 Server 的命令 |
| `--config-file <路径>` | 只从指定文件读取配置；文件不存在则报错 | 需要连接 Server 的命令 |
| `--env-file <路径>` | 兼容旧命令；Node.js 22 会先于 CLI 加载此文件，因此文件不存在时连 Help 都无法执行 | 兼容保留，建议改用 `--config-file` |
| `--json` | 打印完整脱敏 JSON（不含 Token） | 仅 `info` / `usage` |
| `-y`, `--yes` | 显式确认删除 | `delete` |

CLI 支持的环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `KIRO_SERVER_API_KEY` | Server 管理密钥，必需（可从配置文件读取） |
| `KIRO_TOOL_API_KEY` | 管理密钥的 CLI 专用别名 |
| `KIRO_SERVER_URL` | 完整 API 基础 URL，例如 `http://127.0.0.1:5580` |
| `KIRO_SERVER_HOST` | Server 主机；默认 `127.0.0.1` |
| `KIRO_SERVER_PORT` | Server 端口；默认 `5580` |

**Node.js 22 兼容性说明**：`--env-file` 同时也是 Node 运行时的原生参数，即使放在 `node kiro-tool.cjs` 后面，也可能在 CLI 执行前被 Node 读取。不存在的 `--env-file` 会导致 Node 以退出码 9 直接结束，无法进入 `help`。请优先使用 `--config-file` 显式指定配置文件路径；旧 `--env-file` 仍能在文件有效时兼容使用。以下离线帮助示例不会读取指定的 `--config-file`：

```bash
node kiro-tool.cjs account help --config-file /nonexistent/example.env
```

### 配置自动发现顺序

不使用 `--config-file` 时，CLI 按以下顺序寻找**第一个包含** `KIRO_SERVER_API_KEY` 或 `KIRO_TOOL_API_KEY` 的文件：

1. 当前执行目录：`.env` → `server.env` → `kiro-server.env`
2. **脚本实际所在目录**：`.env` → `server.env` → `kiro-server.env`
3. `/etc/kiro-server.env`
4. `/etc/kiro-account-manager/server.env`

如果文件存在但不包含 Key，会继续向后查找；无法读取文件则报错，不静默忽略访问权限错误。找到 Key 后，同一文件的 URL、Host 和 Port 也可用于连接。进程环境变量优先于文件值；`--url` 优先于 `KIRO_SERVER_URL`。

例如，将 Server 的密钥及网络配置写在权限受限的配置文件中：

```ini
KIRO_SERVER_API_KEY=REPLACE_WITH_YOUR_SECRET
KIRO_SERVER_HOST=127.0.0.1
KIRO_SERVER_PORT=5580
```

```bash
chmod 600 /etc/kiro-server.env
node kiro-tool.cjs account list
# 临时指定另一个配置文件
node kiro-tool.cjs account list --config-file /path/to/another.env
# 本地 SSH 端口转发场景
node kiro-tool.cjs account list --url http://127.0.0.1:5580
```

只有本机 `localhost` / `127.0.0.1` / `::1` 允许明文 HTTP；访问远端管理端点必须使用 HTTPS，或先通过 SSH 隧道映射为本地地址。不要把 API Key 写入命令行参数、终端历史或 Git 仓库。

## 5. `account list`：列出账号

```bash
node kiro-tool.cjs account list
```

结果包含**序号、账号状态、邮箱、账号 ID**和账号数。状态主要分为“可用”“暂不可用”“已停用”“上游封禁”；该列表不主动访问 Kiro 查询 Credits 用量。若需要额度，使用 `account info`。

## 6. `account add`：导入或更新账号

```bash
node kiro-tool.cjs account add 3.json
node kiro-tool.cjs account add /root/kiro/accounts/account3.json
```

每次只读取一个**扁平 JSON 对象**；文件必须非空且不超过 1 MiB，不接受账号数组或 `credentials` 嵌套对象。需要至少提供非空 `accessToken` 或 `refreshToken`。

IdC 登录示例（全为占位符，请替换为自己合法获取的凭证）：

```json
{
  "id": "my-kiro-account",
  "email": "user@example.com",
  "accessToken": "REPLACE_WITH_ACCESS_TOKEN",
  "refreshToken": "REPLACE_WITH_REFRESH_TOKEN",
  "clientId": "REPLACE_WITH_CLIENT_ID",
  "clientSecret": "REPLACE_WITH_CLIENT_SECRET",
  "authMethod": "IdC",
  "region": "us-east-1"
}
```

社交登录可使用 `authMethod: "social"` 或 `provider: "Google"` / `"GitHub"`。如果只提交 Refresh Token，Server 会先尝试刷新，成功后再导入；IdC 的 Refresh Token 还需要 `clientId`、`clientSecret`。

- **有 ID**：相同 ID 更新对应账号，而非新建；保存原账号信息前请确认 ID 准确。
- **无 ID**：Server 分配新 ID；CLI 会尝试防止无 ID 的同邮箱重复添加。导入成功会打印 ID，建议保存用于后续更新。
- **安全**：`chmod 600 3.json`；账号文件和 `accounts.json` 不要提交到 Git。

导入成功仅表示 Server 接受并保存了账号，**不保证账号已获上游实际模型访问权限**。

## 7. `account info` / `usage`：实时查询额度

```bash
node kiro-tool.cjs account info 2
node kiro-tool.cjs account usage user@example.com
node kiro-tool.cjs account info 2 --json
```

Server 使用账号的 Access Token 调用 Kiro 官方 `GetUsageLimits`。会显示以下信息（如果上游返回）：

- 账号序号、邮箱、ID、本地启停/上游封禁状态。
- 订阅计划、订阅状态和当前计费类型（`billingMode`）；企业账号可只读显示超限状态。
- Credits 总额度、已用额度、剩余额度。
- 基础额度、有效试用额度、有效奖励额度（展示各项已用与上限）。
- 下次额度重置时间、Token 到期时间、查询时间；企业账号可能附带只读超限费率/上限。

计算时使用精确用量字段（若存在），剩余为 `max(0, limit - used)`；不会将**缺失的必需额度**错误地显示成 0。上游成功返回但未提供额度时显示“未知”。**如果实时请求失败，仍返回本地已保存的账号 ID、邮箱、状态与 Token 到期时间**；订阅、超限状态和额度显示未知，且命令返回退出码 `2`，避免脚本将部分数据视为成功读取余额。信息查询本身不会开通超限付费。

`--json` 适用于通过 `jq` 自动取值，字段包括 `id`、`email`、`enabled`、`suspended`、`billingMode`、`subscription`、`overage`（上游只读字段）、`credits`、`nextResetDate`、`expiresAt`、`checkedAt`。例如：

```bash
node kiro-tool.cjs account info 2 --json | jq '.credits.remaining'
node kiro-tool.cjs account info 2 --json | jq -r '.billingMode'
# 上游不可用时，仍输出 JSON；检查 status 是否为 ok
node kiro-tool.cjs account info 2 --json | jq '.usageQuery'
```

当上游不提供某字段时，该字段可能缺省；脚本须处理 `null` / 缺失，而不是当成零。

### 实时额度查询失败时的诊断信息

`info` 和 `usage` 共用同一个上游 GetUsageLimits 请求。新版本会在 JSON 中返回 `usageQuery`：

```json
{
  "id": "example-account-id",
  "email": "example@example.invalid",
  "enabled": true,
  "overage": { "status": "UNKNOWN" },
  "usageQuery": {
    "status": "unavailable",
    "code": "HTTP_403",
    "upstreamStatus": 403,
    "attemptedRegions": ["us-east-1", "eu-central-1"]
  }
}
```

以上仅为结构示例。实际失败可能是 `HTTP_401`、`HTTP_403`、`TIMEOUT`、`NETWORK_ERROR`、`INVALID_RESPONSE`、`TOKEN_REFRESH_FAILED` 或 `UNKNOWN_FAILURE`；**不能仅根据 502 或超限设置成功判断额度查询成功**。成功时 `usageQuery.status = "ok"`，额度字段以 Kiro 响应为准。失败时 `credits` 缺失、`overage.status = "UNKNOWN"`，不会伪造为零余额或假定已经开启超限。查询失败的原始响应体不会回传给 CLI。

最新 Server 会优先访问账号已配置的真实 AWS 区域，使用与手动可行的简单 Bearer GET 一致的请求头；遇到 HTTP 403 或网络错误时尝试备用区域，并通过 `attemptedRegions` 报告尝试结果。若 `HTTP_403` 持续出现，请检查对应账号的区域、Token 权限、代理设置和 Server 端访问情况。

## 8. `account refresh`：手动刷新指定账号 Token

```bash
node kiro-tool.cjs account refresh 2
node kiro-tool.cjs account refresh user@example.com
```

即使 Token 尚未到期也会尝试刷新（通过账号原有登录方式及 Refresh Token）。刷新成功后，Server 会保存更新的 Access Token、可能轮换的 Refresh Token 和新过期时间。**不会打印任何 Token 内容**。

刷新失败时返回非零退出码，不代表账号官方订阅一定失效；若 Refresh Token 已过期或被撤销，需要重新登录取得新凭证再导入。刷新不会自动解除管理员手动停用、上游封禁或额度限制。

## 9. `account enable` / `disable`：本地账号启停

```bash
node kiro-tool.cjs account disable 2
node kiro-tool.cjs account enable 2
```

`disable` 使本地账号不参与正常账号池分配，但**保留凭证**，状态持久化到 Server 数据文件。再次 `enable` 只取消本地手动停用，不能解除上游封禁、额度耗尽或已失效的 Token。

**注意**：`account enable` 仅启用本地账号，不会购买 Add-on Credits，也不会解除上游额度限制。

## 10. 超额使用：个人 Add-on Credits / 企业 Overages（只读）

**个人付费账号（社交登录 / AWS Builder ID）**：自 2026 年 7 月 1 日起，旧的超限后自动计费已被预付费附加额度取代。需要继续使用时，在 [Kiro 官方门户](https://app.kiro.dev/account/usage) 购买 Add-on Credits。CLI 不进行购买或启用旧超限设置。

**Enterprise（IAM Identity Center / 外部身份提供商）**：超限仍存在，但需由管理员在 AWS Kiro 控制台的 Settings → Overages 配置。CLI 仅可显示上游返回的只读状态，**不代替 AWS 管理控制台进行账单配置**。

```bash
# 查看个人账号当前 Credits 和计费类型
node kiro-tool.cjs account info 2
node kiro-tool.cjs account info 2 --json

# 旧命令不会发送上游写入请求，只显示停用提示并失败退出
node kiro-tool.cjs account overage enable 2
node kiro-tool.cjs account overage disable 2
```

Headless Server 对旧接口 `POST /admin/accounts/:id/overage` 返回 **HTTP 410 Gone**（经过管理员 API Key 鉴权），无论客户端发送 `enabled: true` 还是 `false`，**均不调用上游计费变更接口**。旧 `kiro-tool.cjs` 搭配新版 Server 也无法再提交计费偏好更改。

## 11. `account delete`：删除本地账号

```bash
# 交互模式要求输入 yes
node kiro-tool.cjs account delete 2

# 非交互模式必须显式确认
node kiro-tool.cjs account delete 2 --yes
```

永久删除 **Server 保存的本地账号凭证**；不会删除 Kiro 官方账号，也不会自动擦除此前保存的 JSON 备份。删除后序号可能重新排列，建议重新运行 `account list`。

## 12. 返回值、故障排查与安全

**退出码**：成功为 `0`；`info` / `usage` 能读取本地账号但实时额度失败时返回 `2`，同时仍输出可阅读的本地资料（`--json` 仍输出 JSON）。参数错误、缺少密钥、HTTP 错误、文件错误或取消操作返回其它非零码。请在脚本中检查退出码，不要仅凭标准输出判断成功：

```bash
if node kiro-tool.cjs account refresh 2; then
  echo '刷新接口已确认成功'
else
  echo '刷新失败，请检查 Token 或 Server 日志' >&2
fi
```

| 常见现象 | 原因与处理建议 |
| --- | --- |
| `缺少 KIRO_SERVER_API_KEY` | 配置路径未找到或无有效 Key；检查自动查找目录、权限及 `--config-file` |
| `HTTP 401` | Server 管理密钥错误；检查 Server 和 CLI 使用的同一套 Key |
| `HTTP 404` | 旧 Server 不支持新接口，或目标账号已删除；更新 Server/CLI 并重新 `list` |
| `HTTP 422`（refresh） | 账号缺 Refresh Token；需重新取得正确凭证 |
| `usageQuery.status = unavailable`（info/usage，退出码 2） | 上游用量获取失败，但本地账号信息可读；查看 `usageQuery.code` / `attemptedRegions`，排查地区、Token、代理、权限 |
| `HTTP 410`（旧 overage API） | 该接口已永久停用；个人账号需在官方门户购买 Add-on Credits，企业账号由管理员在 AWS 控制台设置 | 
| `HTTP 502`（refresh） | Token 刷新失败；检查 Server 日志、代理、区域、账号权限 |
| `账号序号超出范围` | 序号已变化；先运行 `account list` |
| `非交互环境 ... --yes` | 删除账号需要显式确认；确认后添加 `--yes` |
| `额度: 未知` | Kiro 未提供完整 Credits 用量；不等同于余额为 0 |
| `ECONNREFUSED` / `fetch failed` | Server 未运行、端口/URL 配置错误、网络或代理不可达 |

HTTP 管理接口使用相同 API Key 鉴权；`info` 和其它命令不会回传 Access Token、Refresh Token 或客户端密钥。请保护配置文件、账号 JSON、Server 日志及命令输出；远程使用必须加 TLS 或 SSH 隧道。

## 13. 构建、测试与部署注意事项

在仓库的 `Kiro-account-manager` 子目录中：

```bash
npm ci
npm run build:tool          # scripts/kiro-tool.cjs -> kiro-tool.cjs
npm run build:server        # 构建依赖 node_modules 的 Server
npm run test:server         # 含命令帮助、账号管理和脱敏 API 的离线测试
```

单文件部署请使用 [Headless Server Standalone Package](../../.github/workflows/headless-standalone-package.yml) 的手动工作流，从 `dev` 分支构建后下载构件并部署。工作流不会由普通 push 触发。添加管理接口时需**同时更新** `kiro-tool.cjs` 与 `kiro-server.cjs`；旧 Server 不认识新的管理接口。

帮助命令可直接在没有 Key 的机器上检查：

```bash
env -u KIRO_SERVER_API_KEY -u KIRO_TOOL_API_KEY node kiro-tool.cjs account help
env -u KIRO_SERVER_API_KEY -u KIRO_TOOL_API_KEY node kiro-tool.cjs account info --help
```

> 本文给出工具当前代码所支持的用法和本地测试方法。真实 Credits、付费状态及上游刷新结果必须由已授权账号和实际 Kiro API 验证，不能由离线模拟测试证明。
