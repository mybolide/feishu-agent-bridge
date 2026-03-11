# feishu-agent-bridge

基于 Node.js 的飞书智能体运行时网关。  
通过飞书长连接接收事件，并将请求路由到已配置的不同运行时。

## 功能特性

- 飞书长连接事件处理
- 按线程工具选择做运行时路由
- 按线程 + 按工具持久化会话/模型
- 运行时与模型兼容性校验 + 自动回退
- 模型卡片分页展示（可浏览完整模型列表，不再只显示前 12 个）
- 流式卡片更新
- 支持中止 / 中止并新建会话
- 运行时提供方：
  - `opencode`（已对接）
  - `iflow-cli`（已对接）
  - `gemini-cli`（预留扩展点）
  - `codex-cli`（预留扩展点）

## 对接状态

- `opencode`：已完成接入并纳入统一路由。
- `iflow-cli`：已完成接入并纳入统一路由。
- 统一 Provider 接口已就绪，后续可继续扩展其他运行时。

## 环境要求

- Node.js `22+`（项目使用了 `node:sqlite`）
- PowerShell（用于 `scripts/` 下脚本）
- 飞书自建应用凭证
- 可选：
  - OpenCode CLI/Server
  - iFlow CLI 及鉴权配置

## 快速开始

1. 安装依赖：

```powershell
npm install
```

2. 准备环境变量：

```powershell
Copy-Item .env.example .env
```

3. 在 `.env` 中填写必填项：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`

4. 启动网关（默认热更新）：

```powershell
.\scripts\start.ps1
```

## 常用命令

```powershell
# 语法检查（CI/本地校验）
.\scripts\lint.ps1 -SkipInstall

# 单元测试
npm test
```

## 发布到 GitHub：哪些可以提交，哪些不可以

### 可以提交

- `gateway/**`
- `scripts/**`
- `docs/**`
- `tests/**`
- `.github/workflows/**`
- `package.json`
- `package-lock.json`
- `.env.example`
- `.gitignore`
- `README.md`
- `README.zh-CN.md`

### 不可以提交

- `.env`（包含密钥）
- `node_modules/`
- `logs/`
- `data.db`, `data.db-shm`, `data.db-wal`
- 本地缓存/临时文件
- 任何真实密钥、Token、密码

## 安全说明

- 如果历史上 `.env` 曾经提交过，请立刻轮换密钥：
  - 飞书 App Secret
  - 其他 API Key/密码
- `.env` 仅本地使用；对外只提供 `.env.example`。

## 架构说明

运行时路由逻辑见：

- `docs/architecture/runtime-routing-logic.md`
