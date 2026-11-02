# TR Grok 原生提供方（0.3.0 已实现）

状态：**已实现，隔离 profile 的 Web UI 与真实推理已验证**。本文记录 `tr-grok` 的协议事实、能力边界和验收依据；它不是模型白名单，菜单只使用 CLI 当次返回的模型。

## 1. 范围

- 提供方 ID：`tr-grok`；显示名：**TR Grok**。
- 和 `tr-codex` 一样，通过 `ctx.llm.registerAdapter` 注册，与普通 API 模型并列出现在 Harness 模型菜单，不改变已有默认模型。
- 模型清单完全来自 ACP 的 `session/new`：优先 `models.availableModels`，缺失时回退 `configOptions` 中 `id: "model"` 的选项。不按 `grok-*` / `tokenrouter-*` 前缀过滤，也不内置数量或名称。
- 选中的模型 ID 原样传给 `session/set_config_option`；CLI 回报的当前值不一致时抛 `MODEL_UNAVAILABLE`，不静默替换。
- 实际执行模型从 `session/prompt` 结果的 `_meta.modelId` 读取。路由别名（例如 CLI 返回的 `tokenrouter-*`）和真实模型身份是两层信息，不混为一谈。
- 不读取 TokenRouter/Grok 登录文件或 API Key；只启动已经登录的 `tr.exe`。

## 2. 已确认的 ACP 协议事实

`tr grok agent --no-leader stdio` 使用 JSON-RPC over JSONL：

| 方法 | 用途 |
| --- | --- |
| `initialize` | 握手；`protocolVersion: 1`，clientInfo 使用 `dsh_tr_bridge` |
| `session/new` | 建会话；返回 `sessionId`、`models`（对象，含 `currentModelId` / `availableModels`）、`configOptions`、`_meta` |
| `session/set_config_option` | 切模型；`configId: "model"`，`value` 是 CLI 返回的原始 id |
| `session/prompt` | 发送一轮用户文本；返回 `stopReason` 和 `_meta.modelId` / `_meta.usage` |
| `session/update` | 流式通知；`params.update.sessionUpdate` 区分 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`config_option_update`、`available_commands_update`、`plan` 等 |
| `session/cancel` | 取消 |
| `session/close` | 关闭 |

`models` 在部分版本是对象而不是数组；把 `session.models` 直接当数组会得到空列表。解析器同时接受数组形式，以及 `configOptions` 回退。

ACP 当前没有分页请求。如果 `session/new` 的模型结果带 `nextCursor`，适配器会报 `MODEL_DISCOVERY_FAILED`，而不是把第一页当成完整清单。Codex 的 `model/list` 则是真正的游标分页，按 `nextCursor` 取完所有页。

## 3. 工具能力：纯聊天，不伪装

ACP v1 没有“客户端注册动态工具”的一等通道。对比 Codex app-server 的 `dynamicTools` / `item/tool/call`，Grok 只能：

1. **纯聊天适配**：不向模型声明 Harness 工具；
2. **MCP 桥**：让 Grok 通过 MCP 调用工具，需另行实现和验证；
3. **文本约定**：在 prompt 里约定 JSON 再解析，本版本明确不做。

本版本选择 1：

- `stream()` 忽略 Harness 的 `tools` 列表，不把它们拼进 prompt；
- 收到 `session/request_permission` 时由传输层拒绝（`outcome: "cancelled"`）；
- 如果 CLI 仍产生 `tool_call` / `tool_call_update`，整轮抛 `UNSUPPORTED_TOOL_CALL`，不会假装工具已执行；
- 系统提示明确告诉模型“本提供方只有文本聊天，Harness 工具不可用”。

## 4. 上下文与工作目录

每轮使用新的 ACP session，发送 Harness 提供的完整文本 transcript；不在客户端伪造工具历史。`llmCwd` 是插件配置里的静态工作目录，也是发现和执行共用的目录。由于 LlmAdapter 接口没有提供会话实时工作区，切换 Harness 会话时不会自动改变这个静态 cwd；需要不同目录时请改插件配置。

Grok 没有 Codex 那种“目录决定 custom catalog 是否加载”的问题；但为保持两个提供方行为一致，仍使用同一个 `llmCwd`。

## 5. 能力边界

- 只接受文本和文本工具结果；图片/文件输入明确拒绝。
- `stop`、`temperature`、`maxTokens` 被拒绝，不静默忽略。
- `reasoning_effort` 作为可选 ACP config 传给 CLI；CLI 不接受时报错。
- 取消会发送 `session/cancel`，随后关闭 session。
- 子进程 stderr 只计字节、不转发；不把协议内容写日志。
- 进程断开、超时、模型撤销都会以明确错误码返回。

## 6. 验收依据

2026-11-02 在 `D:\AI-team\tr-e2e-work`、隔离 `DSH_HOME`、`tr-e2e` profile 中：

- 菜单出现 **TR Grok**，展开后显示当次 ACP 返回的全部模型（包括裸模型和路由别名），不依赖写死清单。
- 选择 `tokenrouter-grok-4.7` 后，UI 回复 `UI_GROK_OK`；选择 `tokenrouter-grok-4.5` 的适配器探针返回 `_meta.modelId = "grok-4.5"`，`tokenrouter-grok-4.7` 的探针返回 `_meta.modelId = "grok-4.7"`。
- 菜单出现 **TR Codex**，展开 7 个当次 `model/list` 返回的模型；选择 `gpt-6.1-sol` 后 `thread/start` 和 `turn/start` 都带有 `model: "gpt-6.1-sol"`，回复 `UI_CODEX_OK`。
- 重启隔离 Web 服务后，当前会话仍显示 `GPT-6.1-Sol`，选择被恢复。
- 以上为隔离 profile 验证；未修改正式 Desktop 插件，未发布 Release。
