# feishu-agent-bridge Runtime 路由逻辑清单

## 1. 入口与事件流

1. Feishu 长连接接收事件（消息 + 卡片动作）。
2. 事件去重（`message_id` / `event_id` / action fingerprint）。
3. 文本命令优先进入导航与 `/oc` 命令处理。
4. 普通文本进入 `run` 执行链路。

## 2. 执行链路（Run Pipeline）

1. 读取线程状态：`repo_path`、`thread_tool`、`thread_model`、`thread_session`。
2. 根据 `thread_tool` 选择 Runtime Provider。
3. 运行前做模型决策：
   - 校验当前模型是否在该 Provider 可用列表中；
   - 不可用时自动回退到可用模型并回写状态；
   - OpenCode 在未设置模型时自动选择默认可用模型。
4. Provider 列会话，优先复用当前会话；无可复用会话则新建。
5. 发送“执行中”卡片并进入进度更新（心跳 + 流式预览）。
6. 调用 Provider `run.sendMessage`：
   - 支持增量回调 `onProgress`；
   - 支持中止 `AbortSignal`。
7. 成功：更新结果卡片；失败/中止：更新失败/中止卡片。

## 3. Feishu 前端能力（卡片）

1. 工具切换（`change_tool`）：
   - 持久化 `thread_tool`；
   - 按 `thread_id + tool_id` 恢复 `thread_session + thread_model`；
   - 恢复后再次做模型可用性校验，必要时自动纠正。
2. 模型切换（`change_model`）：
   - 按当前工具拉取模型并严格校验。
3. 模型分页（`change_model_page`）：
   - 支持浏览完整模型列表（分页），不再限制前 12 条。
4. 会话选择/新建会话：
   - 按当前工具的会话空间操作。
5. 中止对话/中止并新建：
   - 基于 run 的 `runtimeId` 调用对应 Provider 的 `abort`。
6. “更多”操作：
   - 点击“更多”只返回操作按钮卡片，不返回目录/文件列表。

## 4. Provider 统一接口

每个 Runtime Provider 需要实现：

1. `session.list(directory)`
2. `session.create(directory, title)`
3. `session.abort(directory, sessionId)`
4. `model.list(forceRefresh)`
5. `run.sendMessage(directory, sessionId, text, model, { signal, onProgress })`
6. `run.isAbortLikeError(error)`

## 5. 当前对接状态

1. `opencode`：已完成接入并上线到统一路由。
2. `iflow-cli`：已完成接入并上线到统一路由。
3. `gemini-cli`：预留扩展点（待接入）。
4. `codex-cli`：预留扩展点（待接入）。

## 6. 状态模型（SQLite）

`gateway_thread_state`：
- `repo_path`
- `thread_tool`
- `thread_model`
- `thread_path`
- `thread_session`

`gateway_thread_tool_state`：
- `thread_id + tool_id` 维度的 `thread_model`、`thread_session`

`gateway_queued_runs` / `gateway_run_refs`：
- `runId`
- `status`
- `sessionId`
- `runtimeId` / `toolId`
- `progressMessageId`

## 7. 可靠性与重试

1. iFlow：
   - 会话状态异常可在当前会话重试；
   - 首包超时支持切换新会话重试。
2. OpenCode：
   - 默认使用 `promptAsync + 消息轮询/事件流` 避免长请求头超时；
   - 可选开启 `OPENCODE_TIMEOUT_RETRY_ENABLED` 后，轮询超时可触发一次新会话重试。

## 8. 回归检查清单

1. `/oc bind`、`/oc status`、`/oc help` 正常。
2. `/oc tool` 能展示并切换工具。
3. 切换工具后发送消息，实际路由到选中 Provider。
4. `/oc model` 能分页查看全部模型并切换。
5. `ls` 目录卡片显示：工具、模型、会话。
6. “中止”与“中止并新建”对当前工具会话生效。
7. 重启后 `thread_tool`、`thread_model`、`thread_session` 持久化不丢失。
