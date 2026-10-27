# 无桌面环境 Server 模式改造计划（CentOS 7 / Node.js 22）

> 状态：**P1–P5 已提交到 dev；P6 Ubuntu / Node.js 22 编译与离线验收通过；CentOS 7 实机及真实账号验收待完成**
>
> 创建日期：2026-10-27
>
> 目标分支：`dev`（从 `main` 的 `8f11db50f64cc4faf3f9c0dff8eca543c01cdc15` 创建）
>
> 文档位置：`Kiro-account-manager/docs/HEADLESS-SERVER-PLAN.md`
>
> 实施原则：**最小改动、复用现有能力、主桌面程序不回归、每阶段有可验证结果；不提前声明编译或运行通过。**

## 1. 目标与已确认环境

目标是在**没有桌面环境**的 CentOS 7 上，以用户已安装且**目前正常运行的特殊构建 Node.js 22**，启动独立 Kiro API 服务，不依赖 Electron、Xvfb、浏览器、桌面会话或系统托盘。实际提供已有的 OpenAI、Claude 等兼容接口；允许通过 JSON **一次导入一个账号**，持久化账号和更新后的凭证，通过 systemd 常驻运行。

已确认：

- CentOS 7 上现有特殊 Node.js 22 可正常运行。**不安排重装 Node.js、升级 glibc 或更换操作系统**；实施时记录 `node -v`、`npm -v`、`node -p "process.execPath"` 作为环境基线。
- 保留原有 Windows/macOS/Linux Electron 桌面运行方式；只新增 Server 模式。
- 本阶段仅编写计划；后续改代码以 `dev` 为目标，不直接改 `main`。
- “能编译过”是最终验收条件，不是当前已完成事实；还要实际运行并通过接口测试。

### 1.1 范围内（必须完成）

1. 新增独立 `server` 启动入口：无需创建 Electron `BrowserWindow`，直接构造和启动现有 `ProxyServer`。
2. 将 Token 刷新、日志、K-Proxy 的不必要 Electron **运行时依赖**解耦；保留桌面模式现有功能。
3. JSON **单账号**导入与持久化；在现有 `GET /admin/accounts` 之外增加最小 `POST /admin/accounts`。
4. 环境变量配置、API Key 鉴权、SIGINT/SIGTERM 优雅退出、systemd 常驻运行。
5. 输出可独立执行的 Node.js 22 编译产物，并通过 TypeScript 类型检查、构建和无桌面运行测试。

### 1.2 范围外（明确不做）

- **不做批量账号导入**、账号注册、网页登录、二维码登录、浏览器自动化。
- 不开发 Web 管理后台、CLI 账号管理大全、新的数据库、消息队列、Docker 配置或额外 API 功能。
- 不改机器码、SSO 登录页面、K-Proxy MITM、桌面 UI 功能逻辑。
- 不为单纯部署问题新增依赖，除非现有构建工具无法生成可运行 Server 产物且有实际失败证据。
- 不修改既有 API 协议或扩大模型支持范围；不承诺服务端上游账号必然可用。
- 不修改 `main`、不自动创建 PR、不启用新的 push-triggered Actions。

## 2. 当前代码基线与依赖检查

检查版本：`main` 提交 `8f11db50f64cc4faf3f9c0dff8eca543c01cdc15`，项目内 `package.json` 标注版本 `1.7.6`。

| 模块 | 当前职责 | Server 模式处理 |
| --- | --- | --- |
| `src/main/proxy/proxyServer.ts` | 原生 Node HTTP/HTTPS 监听、路由、鉴权、代理请求 | 直接复用；只做必要的解耦和单账号 POST |
| `src/main/proxy/accountPool.ts` | 账号池、轮询、失败切换、状态 | 直接复用 |
| `src/main/proxy/kiroApi.ts` | 上游 API、模型、流式调用 | 复用；剥离对 K-Proxy 的强制运行时导入 |
| `src/main/proxy/translator.ts` | OpenAI/Claude 转换 | 直接复用 |
| `src/main/proxy/logger.ts` | 日志、默认路径 | 改成路径可注入，不能在 Server 模式导入 Electron `app` |
| `src/main/kproxy/index.ts` | MITM/K-Proxy，模块顶层依赖 Electron | 通过可选适配层/懒加载，使无头模式不加载该模块 |
| `src/main/index.ts` | Electron 生命周期、Token 刷新、proxy 初始化、electron-store | 提取跨端刷新逻辑；桌面入口继续使用它 |
| `src/renderer/src/store/accounts.ts` | 桌面账号导入、渲染端状态 | 保留原状；Server 单账号导入不得依赖 React/renderer |
| `src/main/proxy/types.ts` | `ProxyAccount`、`ProxyConfig` | 共享类型，不复制第二套定义 |

重要现状：

- 桌面 `ProxyServer` 自启动依赖 `createWindow()` 的 `ready-to-show` 流程；直接运行 `main/index.ts` 不能视为无头模式。
- `ProxyServer` 的 Token 刷新由 `onTokenRefresh` 回调实现，而回调当前调用 `main/index.ts` 的 `refreshTokenByMethod`。
- `onAccountUpdate` 和 `profileArn` 回写目前依赖 renderer/IPC 持久化；无头模式必须直接落盘。
- `logger.ts` 顶层 `import { app } from 'electron'`；`kiroApi.ts`、`proxyServer.ts` 顶层导入 `../kproxy`，后者也顶层依赖 `electron`。这条依赖链必须检查并切断。
- `ProxyServer` 自签证书默认生成路径目前读取 `app.getPath('userData')`；无头模式应使用显式证书路径，或仅在需要时使用 Node 路径实现，不必先开发自动证书管理。
- 已有 `GET /admin/accounts` 输出脱敏状态列表；目前没有 `POST /admin/accounts`。
- 已有 `/health`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`，以及管理统计接口；维持现有路由行为。

## 3. 目标架构和约束

```text
CentOS 7（用户已有特殊 Node.js 22）
  └─ systemd / node dist/server/index.js
       ├─ src/server/index.ts           # 无头入口，读取 env、信号处理
       ├─ src/server/accountStorage.ts  # 单账号读写；按需要收敛文件数
       ├─ 共享 Token 刷新函数             # OIDC / social
       └─ 原有 ProxyServer              # 同一业务代理实现
            ├─ AccountPool
            ├─ kiroApi / translator
            └─ HTTP API / admin
```

约束：

1. 不能在无头入口的**实际运行时依赖图**中加载 `electron` 或 `src/renderer`；`import type` 仅用于编译类型时允许。
2. 使用原有 `ProxyAccount` 结构；优先移动公共函数或注入适配器，不复制整套 Proxy/Token 代码。
3. K-Proxy 是**可选桌面能力**；Server 模式禁用 K-Proxy，不应因模块 import 引发 Electron 初始化。已有账号绑定 `proxyUrl`、全局 `HTTP_PROXY/HTTPS_PROXY` 功能尽量保持。
4. 不将凭证写进日志或 API 响应；Token 更新在进程重启后仍能加载。
5. 同一份 `ProxyServer` 应同时服务桌面与无头模式；任何修改不得破坏桌面端编译。

## 4. 实施步骤（按顺序执行，不跳过验收）

### P0 — 基线/影响面核查

任务：
- [ ] 确认 `dev` 从上述 `main` SHA 创建，检查工作树（仅修改 `dev`）。
- [ ] 检查 `src/main/proxy/*`、`src/main/kproxy/*`、`src/main/index.ts` 的**全部运行时 import**，画出 Electron 依赖链；重点是 `logger`、`kiroApi`、`proxyServer`、`systemProxy`、`selfSignedCert`。
- [ ] 检查 OIDC/BuilderId、Google/GitHub social 刷新所需字段和可能使用的设备标识；确认 `expiresAt` 单位为毫秒时间戳。
- [ ] 记录现有 `npm run typecheck` 与 `npm run build` 结果（如当前基线失败则记录原有失败，不把它当成本次引入问题）。
- [ ] 在目标机记录用户特殊 Node.js 22 的可执行路径、版本及 `glibc` 情况，不修改运行环境。

验收：列出所有需要解耦的模块和修改清单；能区分原有失败与本次变更。

### P1 — 最小解耦与 Token 刷新共享

任务：
- [ ] 将 `refreshOidcToken`、`refreshSocialToken`、`refreshTokenByMethod` 从 Electron `main/index.ts` 提取到**不导入 Electron**的共享模块；调用网络代理的逻辑沿用现有 `undici` 与 `safeCreateProxyAgent`。
- [ ] 保持原 `main/index.ts` 的刷新调用不变更行为；无头入口使用相同共享函数。
- [ ] 将日志默认目录的 `app.getPath('userData')` 替换为由调用方传入路径（桌面仍可传 Electron 用户目录）。
- [ ] 对 `getKProxyService` / `generateDeviceId` 使用可选注入、惰性引用或等效最小解耦；无头模式不导入 Electron/K-Proxy MITM。保留桌面代理能力。
- [ ] 核查 TLS、自签证书路径；先满足 HTTP loopback 运行，外部 TLS 优先通过现有显式 cert/key 或反向代理，不为它新增管理界面。
- [ ] 清理构建中可能产生的运行时 `require('electron')` 调用，允许桌面专用分支存在但不能被无头模式执行。

验收：
- [ ] 无头服务运行时依赖图不加载 Electron（可通过 import 检查/运行验证）。
- [ ] OIDC 和 social Token 刷新回调可注册，且返回正确的 `accessToken`、`refreshToken`、`expiresAt`。
- [ ] 桌面现有 TypeScript 检查及编译没有新增错误。

### P2 — 单账号 JSON 导入和持久化

只支持**一个 HTTP JSON 对象对应一个账号**，不做数组批量导入。桌面端已有的账号导入 UI 不改动。

建议接口：

```http
POST /admin/accounts
Authorization: Bearer <KIRO_SERVER_API_KEY>
Content-Type: application/json

{
  "id": "account-001",
  "email": "example@example.com",
  "accessToken": "REDACTED",
  "refreshToken": "REDACTED",
  "clientId": "REDACTED",
  "clientSecret": "REDACTED",
  "region": "us-east-1",
  "authMethod": "IdC",
  "expiresAt": 1790000000000
}
```

示例仅用于**字段说明**，不是可用凭证。真实值不写进仓库。字段以当前 `ProxyAccount` 为准，社交登录按既有协议需要的字段处理；`id` 可自动生成，导入相同 `id` 的账号采用明确的更新策略，不能产生重复项。

任务：
- [ ] 给既有路由增加 `POST /admin/accounts`，复用鉴权和请求体大小限制；只接受单对象。
- [ ] 按登录方式验证字段完整性：具备可用 access token；如果需要续期，则校验对应 refreshToken、OIDC clientId/clientSecret 等，明确返回 400 的原因而不回显凭证。不能将“已导入”冒充“账号已验证可用”。
- [ ] 加载单个 JSON 账号并调用 `AccountPool.addAccount/updateAccount`；新增或替换后安全持久化到单个 `accounts.json` 文件。
- [ ] `POST` 成功返回非敏感 `id` 和状态；既有 `GET /admin/accounts` 维持列表脱敏，不增加凭证输出。
- [ ] 启动时读入所有已保存账号以维持跨次启动状态，允许逐次 POST 导入多个账号，但**不提供批量导入接口**。
- [ ] Token 刷新后的新 token/过期时间、`profileArn` 自愈、账号封禁状态等必须同步持久化，且重启后有效。
- [ ] 首次创建数据目录限制权限（如 0700）、文件使用 0600，采用临时文件 + 原子重命名写入，避免中途写坏 JSON；不要把密钥放在配置示例中。
- [ ] 处理坏 JSON、缺字段、不可写目录、写入失败、重复导入、停机时落盘；异常不得导致内存和磁盘状态长期不一致。

验收：
- [ ] 单账号 POST 可导入，GET 能看到但不能读取凭证。
- [ ] 同 id 重复导入不产生额外账号；坏 JSON/缺字段返回 400 且原数据不受影响。
- [ ] 退出再启动，账号数、账号身份、可用 Token 刷新字段保持。
- [ ] 成功刷新 Token 后再启动，不回退到过期旧值。

### P3 — Server 启动入口与编译产物

任务：
- [ ] 新增 `src/server/index.ts`：读取 env、初始化数据目录/日志、构建 `ProxyConfig`、加载账号、创建 `ProxyServer`、注册刷新和账号更新回调、执行 `start()`。
- [ ] 只在 `src/server` 放置确实必要的薄适配层，不创建第二套 HTTP Server。
- [ ] 新增 `npm run build:server`，产生可在 Node.js 22 执行的 `dist/server/index.js`（如采用 `.mjs` 须同时统一脚本及文档）。
- [ ] 新增 `npm run serve`，运行上一步产物；不需要 Electron / DISPLAY。
- [ ] 尽量复用现有 Vite/TypeScript 构建依赖；解决 `uuid`、`electron-store`、ESM/CJS、Node.js built-in 等运行时打包差异；不得以 `tsc --noEmit` 代替真实编译。
- [ ] 保留 `npm run build`、`build:win`、`build:mac`、`build:linux` 的现有意义。

验收：
- [ ] `npm run typecheck:node`、`npm run typecheck:web`、`npm run build:server` 均退出码 0。
- [ ] 桌面 `npm run build` 不因新增入口产生新错误。
- [ ] **无 DISPLAY** 执行构建结果成功启动，`GET /health` 有正确响应。
- [ ] 运行时无 `Cannot find module 'electron'`、`ERR_REQUIRE_ESM` 或不受支持原生模块错误。
- [ ] 从生产运行目录调用可执行产物，不依赖源码 TS 解释器或桌面运行库。

### P4 — 环境变量及最小安全要求

只暴露确有必要的配置；默认可在本机安全启动。

| 环境变量 | 建议默认值 | 作用 |
| --- | --- | --- |
| `KIRO_SERVER_HOST` | `127.0.0.1` | 服务绑定地址 |
| `KIRO_SERVER_PORT` | `5580` | 监听端口 |
| `KIRO_SERVER_API_KEY` | 无，**缺失即拒绝启动** | API 与 admin 接口鉴权 |
| `KIRO_SERVER_DATA_DIR` | 可写的用户数据目录 | 账号 JSON、必要日志与状态 |

沿用既有 `HTTP_PROXY`、`HTTPS_PROXY`（如目标机需要），不另造代理配置体系。

任务：
- [ ] 校验 port 范围、数据目录可写和非空 API Key；错误配置立即退出并输出明确且脱敏的诊断。
- [ ] 无头模式默认仅监听 127.0.0.1；若配置 0.0.0.0，必须继续复用既有外网绑定安全护栏。
- [ ] 非 `/health` 的业务 API 和管理 API 必须校验 API Key（Header 支持现有 Bearer / X-Api-Key）。
- [ ] 管理接口不可泄露 token、clientSecret、完整 API Key；日志不得包含这些值。
- [ ] 不引入本次不需要的新鉴权框架、HTTPS 证书生成器或额外访问控制管理系统；公网暴露建议前置受控反向代理/TLS 或网络隧道。

验收：无 Key 启动失败；错误 Key 访问业务和管理接口返回 401；正确 Key 可用；`/health` 按现有行为访问。

### P5 — 优雅退出与 systemd 常驻

任务：
- [ ] 在 Server 入口处理 `SIGINT`、`SIGTERM`、`uncaughtException`、`unhandledRejection` 的日志和终止策略。
- [ ] 收到停止信号后禁止接收新请求，复用 `ProxyServer.stop()`，确保账号落盘完成、日志句柄释放；添加有限时强制终止保护。
- [ ] 创建**一个**最小 systemd service 模板和部署说明，服务以普通账号运行，不以 root 运行应用。
- [ ] `ExecStart` 使用**用户当前可运行的特殊 Node.js 22 的绝对路径**，不猜测位置；`WorkingDirectory` 指向部署目录。
- [ ] 使用 `EnvironmentFile` 注入 Key 与配置，文件权限建议 0600，账号 JSON 位于非仓库目录；systemd `Restart=on-failure`。
- [ ] 提供 `systemctl daemon-reload`、`enable --now`、`status`、`restart`、`stop`、`journalctl -u` 的实际使用说明。
- [ ] 检查 CentOS 7 自带 systemd 版本支持所用 unit 配置，不加入新发行版独有的 unit 指令。

验收：
- [ ] `systemctl start` / `stop` / `restart` 运行正确，日志可查看。
- [ ] 正常 stop 无残留监听或挂起进程；重启账号没有丢失。
- [ ] Node 异常退出时 systemd 能按配置重启（测试环境验证）。

## 5. 最终验证矩阵（P6）

以下测试**代码完成后执行**，未执行前不能标为通过。优先使用现有单元测试或轻量 Node 原生测试，不为此引入新的测试框架。

| 编号 | 验收项 | 标准 |
| --- | --- | --- |
| T01 | 分支和源码 | 仅 `dev` 存在本次修改；`main` 不变 |
| T02 | 类型和构建 | `typecheck:node`、`typecheck:web`、`build:server` 退出码 0 |
| T03 | 桌面回归 | 现有桌面构建成功，无新增 Electron 行为回归 |
| T04 | 无头启动 | 目标环境 `DISPLAY` 未设置，Node 22 可独立启动、`/health` 正常 |
| T05 | 安全鉴权 | 缺少环境 Key 不启动；错误 Key 业务/admin 401 |
| T06 | 单账号导入 | POST 1 个 JSON 成功，GET 脱敏可见；坏 JSON/缺字段被拒绝 |
| T07 | 重复导入 | 相同 id 更新，不出现重复记录 |
| T08 | 磁盘持久化 | 服务 stop/start 后账号和刷新信息保持 |
| T09 | 刷新链路 | mock 验证 OIDC/social 的选择及更新持久化；真实账户有条件时做在线验证 |
| T10 | 既有协议 | `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 路由和格式未被破坏 |
| T11 | 流式 | 有有效账号时验证 OpenAI/Claude SSE 响应；不得只用健康检查代替 |
| T12 | systemd | start/stop/restart、journalctl 和重新启动后数据加载通过 |
| T13 | 异常场景 | token 失效、上游网络不可达、文件写失败、端口占用均可诊断，不泄露凭证 |

执行建议（在 `Kiro-account-manager/` 下）：

```bash
npm ci
npm run typecheck:node
npm run typecheck:web
npm run build:server
npm run build
env -u DISPLAY npm run serve
```

注：`npm run build:server` / `npm run serve` 是**计划新增**的命令，当前版本尚未实现。CentOS 7 目标机使用已有特殊 Node 22；若 `npm ci` 安装的某个原生依赖在目标机不兼容，应定位该具体依赖并尽量避免将其引入 Server 依赖图，不以全局升级操作系统解决。

最小接口检查（代码完成且进程已启动后执行）：

```bash
curl -fsS http://127.0.0.1:5580/health
curl -i http://127.0.0.1:5580/admin/accounts
curl -H "Authorization: Bearer $KIRO_SERVER_API_KEY" \
  http://127.0.0.1:5580/admin/accounts
curl -X POST http://127.0.0.1:5580/admin/accounts \
  -H "Authorization: Bearer $KIRO_SERVER_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @/secure/path/one-account.json
```

不要在命令行、Git 日志、测试快照、CI artifact 中保存真实 token 或 Key。

## 6. 实施提交顺序及停工条件

开发应当按以下顺序小步提交到 `dev`，每一步记录**实际**验证结果和提交 SHA：

1. `docs: plan headless server mode` — 只新增本计划（本次任务）。
2. `refactor: isolate electron-dependent proxy utilities` — 完成 P0/P1。
3. `feat: add single-account JSON persistence and admin import` — 完成 P2。
4. `feat: add node server entry and server build` — 完成 P3/P4。
5. `feat: add systemd deployment and headless verification` — 完成 P5/P6（若没有新功能则以 docs/test 类型提交）。

停止推进的条件：

- 当前阶段**编译失败**，不得继续声称下一阶段完成；先修复当前新增问题。
- Electron 桌面构建出现新增错误，优先回归修复，不能以移除桌面功能换取 Server 通过。
- 服务器需要 Electron/显示服务器才能运行，不算成功。
- 导入后只能内存使用、token 刷新后不落盘，不能算完成。
- 尚未在 CentOS 7 特殊 Node.js 22 环境运行验证，只能标记“代码构建通过，目标环境待验收”，不能宣称已经部署成功。

## 7. 交付物与完成定义

最终仅交付必要的变更：

- `src/server/index.ts` 及极少量必要的共享/持久化代码；
- 相应原模块的最小解耦改动；
- `package.json` 的 `build:server` 与 `serve` 命令和必要构建配置；
- 一个单账号 JSON 导入接口；
- 最小 systemd service 模板和操作文档；
- 编译、无头运行、单账号导入/重启、鉴权和回归测试的可复核结果。

**完成定义**：在无桌面的目标 CentOS 7、用户既有 Node.js 22 环境上，用 systemd 启动 Node 服务；能通过认证的 JSON POST 导入单个账号并保留；API 能调用（有合法可用账号的条件下），token 可刷新且持久化；运行后可正常关闭并重启；新增 Server 构建和现有桌面构建均通过。

## 8. 当前执行记录

- [x] 核查项目现有 API 核心模块、Electron 依赖及管理接口代码。
- [x] 确认 `dev` 基于 `main` 的 `8f11db50f64cc4faf3f9c0dff8eca543c01cdc15` 建立。
- [x] 编写本文档并提交到 `dev` 的项目文档目录。
- [ ] P0 基线测试和依赖清单细化。
- [ ] P1 解耦。
- [ ] P2 单账号导入持久化。
- [ ] P3 无头入口和构建。
- [ ] P4 环境变量与鉴权。
- [ ] P5 systemd 与优雅退出。
- [ ] P6 完整验收。

> 本次任务到计划文档提交为止；**不实施以上待办，不修改 main，不声称已编译通过**。

## 9. 开发执行记录（2026-10-27）

> 当前状态：**代码已写入 dev，构建和目标机验收尚未完成**。不得将“已提交源码”当成“已编译通过”或“已经在 CentOS 7 运行成功”。

- [x] P0 静态核查：项目包含现有 ProxyServer、AccountPool、转换器；确认了从 Electron 日志和 K-Proxy 模块到运行时的依赖链。尚未拿到项目完整工作区的 baseline 编译结果。
- [x] P1 已编写共享 `tokenRefresh.ts` 与 `runtimeBridge.ts`，修改原主进程与代理模块调用关系；桌面 K-Proxy 通过可选解析器继续接入。
- [x] P2 已实现鉴权后的单账号 `POST /admin/accounts` 及本地 `accounts.json` 原子保存；导入成功后写入账号池；Token、封禁和 profileArn 更新接入存储。
- [x] P2 兼容桌面单账号导入的 `idp` 字段与仅有 `refreshToken` 的方式；无 `accessToken` 时先尝试刷新，刷新失败不落盘。
- [x] P3 已加入 `src/server/index.ts` 与 `build:server`、`serve` 脚本（产物 `dist/server/index.cjs`）。
- [x] P4 已加入必填环境 Key、端口和绑定地址及数据目录环境变量；默认只监听本机。
- [x] P5 已加入 SIGTERM/SIGINT 处理、日志落盘，`deploy/kiro-account-manager.service` 模板和部署文档。
- [x] P6 已编写离线 `test/headless-server.test.mjs`：无 Key 拒绝启动、鉴权、单账号导入、重复导入、文件权限和服务重启。
- [x] P6 GitHub Actions #1 的 Ubuntu 24.04 / Node.js 22 验证通过：`npm ci --ignore-scripts`、`typecheck:node`、`typecheck:web`、`build:server`、`test:server`、`build`；job 所有步骤 success。源码 SHA `d789512f06bba4ab53a2e076063e7a8aef301c35`，run https://github.com/eoncn/Kiro-account-manager/actions/runs/40458265199 。
- [ ] P6 完整 `npm ci`（带 Electron postinstall）在目标部署环境的兼容性，及合法账号真实 Kiro API / SSE / Token 刷新联机测试（CI 使用的是无效测试凭证）。
- [ ] 目标 CentOS 7 用户专有 Node.js 22 上的 systemd 启停和端到端验收。

静态依赖复核：从 `src/server/index.ts` 沿相对 `import` 和静态 `require` 展开到共享 API 模块，共检查 **17 个本地源码模块**，未发现 Server 静态运行时依赖链中直接 `import/require('electron')`。此结果**不能替代 esbuild/TypeScript 编译或运行测试**。现有 package-lock 包含 esbuild 0.25.12，属于 Vite 已有依赖，不新增安装依赖。

后续操作顺序仍以本计划第 5 节为准。仅在实际运行并记录通过后，才勾选上面的三个未完成验收项；若有错误先修复再宣称交付。

## 10. P6 验收记录（2026-10-27）

- [x] 已查询 GitHub Actions `Build & Release #1`，分支 `dev`，SHA `d789512f06bba4ab53a2e076063e7a8aef301c35`，run https://github.com/eoncn/Kiro-account-manager/actions/runs/40458265199 。
- [x] `Headless Server / Node 22` job **success**：Node.js 22 初始化、依赖安装（`--ignore-scripts`）、Node/Web 类型检查、Server esbuild 编译、离线账号/鉴权/重启测试、Electron 桌面源代码构建和 Server JS artifact 上传，各步骤均 success。
- [x] 该次运行中的 `get-version`、`build-windows`、`build-windows-arm64`、`build-macos`、`build-linux`、`release` 全部 **skipped**。截图中等待依赖关系不代表这些任务实际打包。
- [ ] 用户特殊 CentOS 7 Node.js 22 + systemd 实机环境尚未验收；需验证账户导入、真实上游模型/流式调用、Token 刷新持久化、优雅退出及重启。
- [ ] 本次 CI 编译并不能证明 Electron 在各桌面系统上完整打包发布成功；仅证明原有 `npm run build` 源码构建成功。

## 11. Actions 拆分为两个互不依赖的手动工作流

应用户要求，将此前暂时嵌入发布工作流的 Node 22 测试 job **独立拆分**。

| 工作流 | 文件 | 用途和触发方式 |
| --- | --- | --- |
| **Build & Release** | `.github/workflows/build.yml` | 保留原有正式发行流程；仅 `workflow_dispatch` 手动执行。在 `main` 运行原有完整 Windows/macOS/Linux 打包与 Release；`dev` 文件中对非 main 增加保护，避免在 dev 误发正式版本 |
| **Headless Server Test** | `.github/workflows/headless-server-test.yml` | 单一 Ubuntu 24.04 / Node.js 22 job：类型检查、Server 编译、离线集成测试、桌面源码构建；仅 `workflow_dispatch` 手动执行，仅在 `dev` 运行。无发布任务 |

**首次注册要求**：GitHub 仅显示存在于默认分支的手动工作流，因此测试 YAML 同时添加到 `main` 和 `dev`；这是**工作流配置注册**，并未向 `main` 合并任何 Server 业务代码。正式发布工作流的 `main` 原文件没有修改。

**正确操作**：Actions → **Headless Server Test** → **Run workflow** → 选择 **dev** → Run。不要再通过 Build & Release 去跑测试。测试成功会上传 `headless-server-node22`，7 天后自动过期；`dist/server/index.cjs` 不是包含全部依赖的独立部署包。

**后期移除测试工作流**：分别删除 `main`、`dev` 中的 `.github/workflows/headless-server-test.yml`，不需要修改 Build & Release，也不会删除已有的测试历史。避免再为临时测试开新 workflow。

**剩余验收**：真实 CentOS 7 上部署与测试，以及合法 Kiro 账号联机行为的验证；此前 GitHub Ubuntu / Node.js 22 离线验收已经通过，不要重复跑完整发布打包。

## 12. Standalone 单文件 Action（2026-10-27）

用户确认优先以 GitHub Actions 打包一个可由 CentOS 7 特殊 Node.js 22 直接运行的 `.cjs` 文件，不再要求 CentOS 7 本机编译或安装 node_modules。

- [x] 在 `dev` 添加 `build:standalone`：esbuild `--bundle --platform=node --target=node22 --format=cjs --legal-comments=inline`，**不使用 `--packages=external`**，生成 `dist/standalone/kiro-server.cjs`。
- [x] 保留现有 `build:server` 与 `serve` 行为，不破坏旧的服务部署方式。
- [x] 现有离线集成测试支持 `KIRO_SERVER_TEST_ENTRY` 指向临时位置的构建文件；子进程在该文件所在目录启动，`NODE_PATH` 置空。
- [x] 新增手动工作流 `.github/workflows/headless-standalone-package.yml`，只在 `dev` 执行 `typecheck:node`、`build:standalone` 和**没有 node_modules 的临时目录**里的现有服务验收测试；只在全部通过时上传 `kiro-server.cjs`、`SHA256SUMS.txt`，有效期七天。
- [x] 为使 GitHub Actions 页面能显示手动启动入口，将完全相同的新工作流 YAML 注册在默认 `main`；它被限制为仅在 `dev` 运行，不向 `main` 合并业务代码。
- [x] 将 `dev` 中原有 `.github/workflows/build.yml` **恢复成与 `main` 的 upstream 文件字节一致**，避免将原发布工作流改动携带进后续 main → dev 的合并；现有 `headless-server-test.yml` 不修改。
- [x] 记录 [HEADLESS-STANDALONE.md](HEADLESS-STANDALONE.md) 中的操作、环境变量、artifact 和 CentOS 7 部署说明。
- [ ] 新独立工作流还没有实际运行结果，**不能宣称这个单文件已经通过 no-node_modules 测试**。如 CI 报错，以实际失败日志修复 esbuild 入口、动态 require、数据文件等，直到通过。
- [ ] 在特殊版 Node.js 22 / CentOS 7 目标机实际执行 `node kiro-server.cjs`、`systemd` 启停及真实账号 API 验收。

操作：GitHub → Actions → **Headless Server Standalone Package** → Run workflow → 选择 **dev**。无需去旧的 Build & Release 里执行测试或打包；它只负责正式桌面发布。

未来可正常把上游 `main` 合并进 `dev`。此模式仅新增独立工作流文件，减少旧工作流文件合并冲突；但业务源码如有上游改动，仍需要正常处理对应文件冲突。
