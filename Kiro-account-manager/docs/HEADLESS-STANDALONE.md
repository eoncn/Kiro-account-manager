# CentOS 7 单文件版：Headless Server Standalone Package

本方案不改变旧的 `Build & Release`、`Headless Server Test`。新增一个独立的 **Headless Server Standalone Package** 手动工作流，专用于 `dev`。

> **2026-10-27 更新（新包尚未重新运行 CI 验证）**：Standalone Package 已改为同时构建、测试和上传 `kiro-server.cjs`、`kiro-tool.cjs` 及覆盖两个文件的 `SHA256SUMS.txt`。下方历史成功记录属于修改前的旧产物（不含 CLI），需要在 `dev` 分支重新手动运行工作流，才能下载新压缩包。

## 历史打包验收（修改前的旧产物）

- **Actions：** [Headless Server Standalone Package #1](https://github.com/eoncn/Kiro-account-manager/actions/runs/40462163279)，2026-10-27，状态 `success`。
- **构建源码提交：** `a5896bce545e3868aa607ad36cf544a3c2702c6e`（后续仅文档更新不代表重新打包）。
- **真实 CI 日志：** Node 22 下 TypeScript 检查、esbuild 单文件编译及临时目录（不含 `node_modules`）运行测试成功；`node:test` **2 passed，0 failed**。
- **文件大小：** JS 文件约 7.4 MB，GitHub artifact 压缩文件约 2.98 MB。esbuild 对文件体积的警告不影响运行。
- **旧 Artifact：** `kiro-headless-server-standalone-node22`（ID `12714309589`），只包含 `kiro-server.cjs` 和 `SHA256SUMS.txt`，**不包含 `kiro-tool.cjs`**。**有效期至 2026-11-03 06:37 UTC**。请使用修改后新运行生成的同名 Artifact。
- **尚未测试：** 用户 CentOS 7 特殊 Node.js 22 的实际兼容性、systemd 启停、真实有效 Kiro 账号与上游模型/流式通信。这些不能由 Ubuntu Runner 的成功自动推定。

## 1. 在 GitHub Actions 生成文件

1. 打开 `https://github.com/eoncn/Kiro-account-manager/actions/workflows/headless-standalone-package.yml`。
2. 选择 **Run workflow → Branch: dev → Run workflow**。工作流不会由 push 自动启动；选 `main` 时任务会跳过。
3. CI 使用 Ubuntu 24.04 和 Node.js 22 执行 `npm ci --ignore-scripts`、`typecheck:node`、`build:standalone` 及 `build:tool`，随后将 **Server 和 CLI 一起**复制到不含 `node_modules` 的临时目录，执行 `node --check`、CLI 帮助输出检查及 `npm run test:server`（集成测试使用临时目录中的两个文件）。
4. 所有测试成功后，可下载名为 `kiro-headless-server-standalone-node22` 的 artifact。**新运行**的压缩包必须含有 `kiro-server.cjs`、`kiro-tool.cjs`、`SHA256SUMS.txt` 三个文件（两个 JS 均有哈希校验）。GitHub artifact 保留 7 天。

编译脚本：

```bash
npm run build:standalone
# 输出：dist/standalone/kiro-server.cjs
```

它与旧的 `npm run build:server` 不同：新命令不使用 `--packages=external`，会尝试将第三方 JS 依赖一并打入单个 CJS 文件。**是否确实独立可用以这次新的 GitHub Actions 工作流实际通过为准**，不是仅看编译产出。

`SHA256SUMS.txt` 用于验证文件在传输后没有损坏。

## 2. 拷贝到 CentOS 7

前提：你已有可正常运行的特殊版 Node.js 22；无需在 CentOS 7 安装 npm、TypeScript、Electron、esbuild 或项目 `node_modules`。

```bash
# 找到现有特殊 Node.js 22 的绝对路径
node -v
node -p 'process.execPath'

# 由普通运行用户执行，将解压后的 JS 放到目标目录
mkdir -p "$HOME/kiro-headless"
cp kiro-server.cjs kiro-tool.cjs SHA256SUMS.txt "$HOME/kiro-headless/"

# 校验两个 JS 文件
cd "$HOME/kiro-headless"
sha256sum -c SHA256SUMS.txt

# CLI 为纯 Node.js 单文件工具，无需 npm/node_modules
node ./kiro-tool.cjs --help
node ./kiro-tool.cjs account list
node ./kiro-tool.cjs account add /path/to/account1.json
node ./kiro-tool.cjs account disable 2
node ./kiro-tool.cjs account enable 2
node ./kiro-tool.cjs account refresh 2
node ./kiro-tool.cjs account info 2
node ./kiro-tool.cjs account overage enable 2   # 可能产生费用，需确认
node ./kiro-tool.cjs account overage disable 2
node ./kiro-tool.cjs account delete 2
```

CLI 会自动从当前目录、脚本目录及 `/etc/kiro-server.env`、`/etc/kiro-account-manager/server.env` 查找包含 `KIRO_SERVER_API_KEY` 的配置文件，因此管理账号时无需每次追加 `--env-file /etc/kiro-server.env`。需要强制指定时仍可使用 `--env-file`。`account refresh` 立即更新指定账号的 Token，并将轮换后的 Refresh Token 持久化；失败不会自动取得新凭证，也不会解除手动停用或封禁。`account info 2` 实时查询 Kiro Credits 用量、余额、订阅及超限状态；`account overage enable|disable 2` 使用 Kiro 官方超限计费偏好接口，开启可能产生费用，交互需确认或非交互使用 `--yes`。

配置环境变量：

```bash
export KIRO_SERVER_API_KEY='替换为你自己的强随机密钥'
export KIRO_SERVER_HOST='127.0.0.1'
export KIRO_SERVER_PORT='5580'
export KIRO_SERVER_DATA_DIR="$HOME/.local/share/kiro-account-manager-server"

# 不依赖 node_modules，不需 DISPLAY
node ./kiro-server.cjs
```

注意：上面的导出 Key 命令仅示意本地测试；正式 systemd 部署使用限制权限的 `EnvironmentFile`。保持默认 `127.0.0.1`；需要远程使用时通过反向代理 TLS 或 SSH 隧道访问，不要直接在公网明文传输 Key。

## 3. systemd 常驻

可以复用 `deploy/kiro-account-manager.service` 的其它设置，但必须修改 `ExecStart` 以指向 **特殊 Node 22 的绝对路径**和 **单文件实际部署路径**：

```ini
# 仅示意 ExecStart 路径，替换为你机器上的实际路径
ExecStart=/absolute/path/to/your/node22 /opt/kiro-headless/kiro-server.cjs
```

无需设置 `WorkingDirectory` 为源码仓库，但需要保证服务用户能读取 JS 和写入 `KIRO_SERVER_DATA_DIR`。CentOS 7 中的系统管理器实际启动与否仍须在目标服务器验证。

## 4. 原有 API 与数据文件保持不变

- 健康检查：`GET /health`。
- API 鉴权：`Authorization: Bearer <KIRO_SERVER_API_KEY>`。
- 单账号导入：`POST /admin/accounts`，每次一个 JSON 对象。
- 兼容 API：`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 等原有路由。
- 数据：`KIRO_SERVER_DATA_DIR/accounts.json`（0600），启动后加载，Token 刷新落盘。

**单文件只包括程序代码，绝不预置账号或密钥。** CI 使用的是假账号数据，不代表真实 Kiro 服务和流式上游调用已通过。

## 5. 两种构建方式与后续维护

| 用途 | 命令 | 运行时是否需要项目 node_modules |
| --- | --- | --- |
| 原 Server 构建 | `npm run build:server` | 需要 |
| 新 Server 单文件构建 | `npm run build:standalone` | **目标不需要**，由独立 CI 的无依赖测试验证 |
| CLI 单文件构建 | `npm run build:tool` | **目标不需要**，打包工作流会复制进相同 Artifact |
| 原 Electron 桌面发布 | `Build & Release` | 未改变原工作流 |
| 现有无头代码回归 | `Headless Server Test` | 未改变原工作流 |

未来将上游 `main` 更新合并到 `dev` 时，本方案主要增加独立工作流文件、一个 npm script 和复用的测试入口，不修改旧发布 YAML，可以减少合并冲突。后期如不再需要临时验收 Action，可以删除 `.github/workflows/headless-server-test.yml`（`main` 和 `dev` 各删一次）；**单文件打包 Action 可以继续保留以便发版**。
