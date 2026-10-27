# 无桌面 Server 运行与部署

> **新推荐：单文件部署。** 若希望 GitHub Actions 打包后把一个 JS 复制到 CentOS 7、无需 node_modules，请使用 [HEADLESS-STANDALONE.md](HEADLESS-STANDALONE.md) 中的独立手动打包 Action。本文其余步骤描述的是原有 `build:server`（仍依赖 node_modules）模式。

本文针对仓库 `dev` 分支中的 **Node.js 无头入口**，不需要 Electron、桌面环境、Xvfb 或浏览器。

> 前提：CentOS 7 上已有**能够正常运行的特殊 Node.js 22**。不升级系统 glibc，也不替换现有 Node.js。Node 22 二进制的具体路径必须在目标机器上确认；本仓库不猜测其路径。

## 1. 编译（项目内目录）

```bash
cd Kiro-account-manager
node -v
npm ci
npm run typecheck:node
npm run typecheck:web
npm run build:server
npm run test:server
npm run build
```

Server 的入口为 `dist/server/index.cjs`。编译时使用现有 Vite 构建链依赖的 esbuild，**不新增独立的 npm 包**。最终服务运行时需要原项目的 npm 生产依赖（`node_modules`），不需要 Electron 应用或 DISPLAY。

如果 CentOS 7 环境中仅能运行 Node.js 22，不能运行 Electron 相关的 npm 构建/安装脚本，可在可构建的机器上完成构建；在目标机（保持 Node 22）采用 `npm ci --omit=dev --ignore-scripts` 安装 JS 运行时依赖。该命令仅在已确认实际生产依赖无需 native postinstall 的前提下使用；如出现模块兼容问题，先记录失败并诊断，不要替换系统 glibc 或强行用 `--force`。

## 2. 环境变量

`KIRO_SERVER_API_KEY` **必填**，缺失会拒绝启动。其他变量均可选：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KIRO_SERVER_API_KEY` | 无 | Bearer / X-Api-Key 鉴权 |
| `KIRO_SERVER_HOST` | `127.0.0.1` | 默认只允许本机访问 |
| `KIRO_SERVER_PORT` | `5580` | TCP 端口（1–65535） |
| `KIRO_SERVER_DATA_DIR` | `~/.local/share/kiro-account-manager-server` | `accounts.json` 与日志目录 |
| `HTTPS_PROXY` / `HTTP_PROXY` | 未设置 | 需要时复用项目已有上游代理 |

例如（演示 Key，禁止直接用于生产）：

```bash
export KIRO_SERVER_API_KEY='REPLACE_WITH_LONG_RANDOM_SECRET'
export KIRO_SERVER_HOST=127.0.0.1
export KIRO_SERVER_PORT=5580
export KIRO_SERVER_DATA_DIR="$HOME/.local/share/kiro-account-manager-server"
npm run serve
```

服务以 Node.js 运行，不需 `DISPLAY`。要允许远端调用时，优先以 SSH 隧道或受控 HTTPS 反向代理转发本地的 `127.0.0.1:5580`，避免明文 HTTP 与 Key 暴露公网。

## 3. 单账号导入

JSON 文件每次**只能含一个账号对象**，不支持数组；不需要批量导入功能。可用字段沿用 `ProxyAccount`，例如：

```json
{
  "id": "my-account",
  "email": "me@example.com",
  "accessToken": "REDACTED_ACCESS_TOKEN",
  "refreshToken": "REDACTED_REFRESH_TOKEN",
  "clientId": "REDACTED_CLIENT_ID",
  "clientSecret": "REDACTED_CLIENT_SECRET",
  "authMethod": "IdC",
  "region": "us-east-1",
  "expiresAt": 1790000000000
}
```

Google/GitHub 社交登录可使用 `authMethod: "social"` 或已有桌面单账号导入格式中的 `idp: "Google" / "Github"`，不要求 OIDC 的 `clientId/clientSecret`。对于 IdC 账号，提供 `refreshToken` 时必须同时提供 `clientId/clientSecret`。**与桌面单账号导入一致，可以只提供 `refreshToken`（及该登录方式所需字段），由服务导入时先刷新得到 `accessToken`；刷新失败则拒绝保存。** 如果同时提供了 `accessToken` 和 `refreshToken` 但未提供到期时间，服务会在首次请求时尝试刷新。只输入 `accessToken` 可以导入，但 **无法自动续期**。

```bash
chmod 600 ./one-account.json
curl -i -X POST http://127.0.0.1:5580/admin/accounts \
  -H "Authorization: Bearer $KIRO_SERVER_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @./one-account.json

curl -fsS -H "Authorization: Bearer $KIRO_SERVER_API_KEY" \
  http://127.0.0.1:5580/admin/accounts
```

成功时返回脱敏的 `{ "success": true, "id": "...", "updated": false }`，相同 id 再次导入则更新现有账号（`updated: true`）。**导入成功表示已保存，不代表上游 Kiro 账号有效。** 凭证、refresh token 等不会从 GET 列表读出。

服务将账号存储到 `KIRO_SERVER_DATA_DIR/accounts.json`，目录权限为 0700，文件权限为 0600；以原子文件替换落盘，Token 刷新后更新同一文件。不要把账号 JSON 或环境 Key 提交进 Git。

## 4. 调用接口

```bash
curl -fsS http://127.0.0.1:5580/health
curl -fsS -H "Authorization: Bearer $KIRO_SERVER_API_KEY" \
  http://127.0.0.1:5580/v1/models
```

沿用原服务接口：`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages` 及 `POST /v1/messages/count_tokens`。能否实际访问上游模型取决于 Kiro 账号、权限、网络及服务规则，不能以 `/health` 代替真实调用验收。

管理接口 `GET /admin/accounts` 与 `POST /admin/accounts` 使用同一个 API Key；不要公开未加 TLS 的管理端点。

## 5. systemd（CentOS 7）

仓库提供模板 `deploy/kiro-account-manager.service`。模板中的 `ExecStart=/REPLACE_WITH_YOUR_WORKING_NODE22_PATH` 必须替换为 `node -p 'process.execPath'` 得到的**绝对路径**。

```bash
# 使用普通专用账号 kiro，部署目录及服务账号由系统管理员事先准备。
sudo mkdir -p /etc/kiro-account-manager
sudo chmod 700 /etc/kiro-account-manager
sudo install -m 600 /dev/null /etc/kiro-account-manager/server.env
# 用编辑器写入 KIRO_SERVER_API_KEY 与 KIRO_SERVER_DATA_DIR，避免密钥进入 shell 历史
sudo vi /etc/kiro-account-manager/server.env
sudo chmod 600 /etc/kiro-account-manager/server.env

# 按实际工作目录、Node 22 绝对路径和 User 调整 service 后：
sudo cp deploy/kiro-account-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kiro-account-manager
sudo systemctl status kiro-account-manager
sudo journalctl -u kiro-account-manager -n 100 --no-pager
```

首次部署还需确保 `kiro` 普通服务用户存在（可使用 `useradd -r -s /sbin/nologin kiro`，已存在则勿重复创建），并准备数据目录，例如：`sudo install -d -m 700 -o kiro -g kiro /var/lib/kiro-account-manager`。确保 `kiro` 对数据目录和日志子目录有写权限，并能够执行已确认的特殊 Node.js 22 二进制。配置更新后运行 `sudo systemctl restart kiro-account-manager`；关闭时运行 `sudo systemctl stop kiro-account-manager`。服务将响应 SIGTERM/SIGINT，停止 HTTP 服务并等待排队的账号持久化完成。

注意：**本文件提供安装步骤，不代表已在你的 CentOS 7 服务器实际执行部署。**

## 6. 验收与排错

- `npm run typecheck:node`、`npm run typecheck:web`、`npm run build:server`、`npm run build` 必须退出码 0；运行 `npm run test:server` 验证空账号条件下的鉴权、导入与重启持久化。
- 在无 `DISPLAY` 环境启动，确保未加载 Electron，检查 `/health`、`/admin/accounts`。
- 使用有权限的真实账号独立验证模型列表、聊天/Responses/Claude 流式、Token 刷新及重启后可用。无真实凭证时不宣称该项通过。
- 禁止使用生产 Key 作为 shell 命令参数明文长期保存到历史记录；正式部署用权限受限的 EnvironmentFile。
- 原 Electron 桌面程序的 `npm run build` 必须保持通过。如两种构建互相影响，先修复再发布。

## 账号启停与删除（无需重启 Server）

以上管理 API 均要求与 `/admin/accounts` 相同的 API Key，且仅 headless Server 提供持久化管理能力：

| Method | URL | 功能 |
| --- | --- | --- |
| GET | `/admin/accounts` | 列表（包含 `enabled`、`isAvailable`、`suspended`） |
| DELETE | `/admin/accounts/:id` | 删除账号及 Server 保存的凭证 |
| POST | `/admin/accounts/:id/disable` | 管理员手动停用（不删除凭证） |
| POST | `/admin/accounts/:id/enable` | 解除管理员手动停用 |

手动停用标记 `manuallyDisabled` 独立于上游封禁标记 `suspendedAt`，重启后仍生效。启用不解除上游风控、额度耗尽或凭证过期。操作先写入 `accounts.json`，成功后更新内存账号池；已经开始的上游请求不会被强制中断。

### CLI（Node.js 22+，序号从 1 开始）

项目根目录 `Kiro-account-manager` 执行：

```bash
npm run build:tool
node kiro-tool.cjs account list
node kiro-tool.cjs account disable 2
node kiro-tool.cjs account enable 2
node kiro-tool.cjs account delete 2
# 非交互环境明确指定：
node kiro-tool.cjs account delete 2 --yes
```

CLI 支持序号、完整账号 ID 或唯一邮箱；序号会先根据实时账号列表解析为稳定的 ID。删除在交互终端需要输入 `yes`，无交互终端必须加 `--yes`。仅删除 Server 本地保存的凭证，不会删除官方 Kiro 账号，也不会抹除已经生成的备份文件。

认证优先读取 `KIRO_SERVER_API_KEY` 环境变量；未设置时尝试 `/etc/kiro-account-manager/server.env`。可用 `--env-file /path/server.env` 指定配置路径，或通过 `--url http://127.0.0.1:5580` 连接本地 Server。远程使用请先配置 SSH 端口转发或 HTTPS，CLI 禁止通过远程明文 HTTP 发送管理密钥。
