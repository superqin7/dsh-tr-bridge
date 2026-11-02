# TR Grok 原生提供方（0.4.0）

状态：**已实现；隔离 profile 的 Web UI、真实非默认 effort、重启恢复，以及真实 MCP 读取/批准写入/测试/失败/取消已验证**。本文记录 `tr-grok` 的协议事实、TokenRouter 路由过滤、工具桥、能力边界和验收依据；它不是模型白名单，菜单只使用 CLI 当次返回且经 TokenRouter 授权的模型。

## 1. 范围

- 提供方 ID：`tr-grok`；显示名：**TR Grok**。
- 和 `tr-codex` 一样，通过 `ctx.llm.registerAdapter` 注册，与普通 API 模型并列出现在 Harness 模型菜单，不改变已有默认模型。
- 模型清单来自 ACP 的 `session/new`：优先 `models.availableModels`，缺失时回退 `configOptions` 中 `id: "model"` 的选项；再与 `tr grok models` 的 TokenRouter 路由提示取交集。后者由 CLI 的 `Model '<id>' is using its own API key.` 提示和现有的 alias / routed 分类得到，不按 `grok-*` / `tokenrouter-*` 前缀硬编码，也不内置数量或名称。
- 交集为空、CLI 提示缺失、查询失败或清单不可解析时，目录刷新抛 `MODEL_DISCOVERY_FAILED`；不会显示裸 `grok-*`，也不会静默回退到厂商原生 Grok 或要求另一个 API Key。
- 选中的模型 ID 原样传给 `session/set_config_option`；CLI 回报的当前值不一致时抛 `MODEL_UNAVAILABLE`，不静默替换。
- 实际执行模型从 `session/prompt` 结果的 `_meta.modelId` 读取。路由别名（例如 CLI 返回的 `tokenrouter-*`）和真实模型身份是两层信息，不混为一谈。
- 不读取 TokenRouter/Grok 登录文件或 API Key；只启动已经登录的 `tr.exe`。

## 2. 已确认的 ACP 协议事实

`tr grok agent --no-leader stdio` 使用 JSON-RPC over JSONL：

| 方法 | 用途 |
| --- | --- |
| `initialize` | 握手；`protocolVersion: 1`，clientInfo 使用 `dsh_tr_bridge` |
| `session/new` | 建会话；返回 `sessionId`、`models`（对象，含 `currentModelId` / `availableModels`）、`configOptions`、`_meta` |
| `session/set_config_option` | 切模型或 effort；`configId: "model"` / `"reasoning_effort"`，`value` 是 CLI 返回的原始 id 或等级 |
| `session/prompt` | 发送一轮用户文本；返回 `stopReason` 和 `_meta.modelId` / `_meta.usage` |
| `session/update` | 流式通知；`params.update.sessionUpdate` 区分 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`config_option_update`、`available_commands_update`、`plan` 等 |
| `session/request_permission` | Grok 请求工具权限；MCP 工具的 `rawInput.tool_name` 是 `<serverName>__<toolName>`，选项含 `allow-once` / `reject-once` |
| `session/cancel` | 取消 |
| `session/close` | 关闭 |

`models` 在部分版本是对象而不是数组；把 `session.models` 直接当数组会得到空列表。解析器同时接受数组形式，以及 `configOptions` 回退。

ACP 当前没有分页请求。如果 `session/new` 的模型结果带 `nextCursor`，适配器会报 `MODEL_DISCOVERY_FAILED`，而不是把第一页当成完整清单。Codex 的 `model/list` 则是真正的游标分页，按 `nextCursor` 取完所有页。

## 3. 推理强度

- 模型自带的 `_meta.reasoningEfforts` / `model.reasoningEfforts` 被映射为 DSH 所需的嵌套 `reasoning.efforts`；`_meta.reasoningEffort` 或带 `default: true` 的项成为 `reasoning.defaultEffort`。只展示模型自己列出的等级，不全局写死 Low/Medium/High。
- 选中的等级通过 `session/set_config_option` 的 `reasoning_effort` 下发。适配器要求返回的 `configOptions` 中该值为同一个等级；不一致时抛 `UNSUPPORTED_OPTION`，不会只改 UI 文本。
- DSH 0.2.1 没有逐模型 effort 持久化 API。插件把成功执行过的等级按 `[provider, model]` 写入 `reasoningFile`（默认 `%APPDATA%\dsh-tr-bridge\reasoning-preferences.json`）。重启或首次进入某模型时，这个值作为默认值恢复；没有保存过则沿用 CLI 默认。
- 如果保存的值已不在当前模型的支持列表里，直接忽略；显式请求一个不支持的等级会在创建 ACP session 之前报 `UNSUPPORTED_OPTION`。

## 4. 工具能力：ACP + MCP，不伪装

ACP v1 没有“客户端注册动态工具”的一等通道，也没有客户端任意工具结果通道。对比 Codex app-server 的 `dynamicTools` / `item/tool/call`，Grok 的官方可选路径是：

1. **纯聊天适配**：不向模型声明 Harness 工具；
2. **MCP 桥**：让 Grok 通过 MCP 调用工具；
3. **文本约定**：在 prompt 里约定 JSON 再解析。

0.4.0 选择 2，并已完成真实探测：

- `session/new` 带 `mcpServers: [{ name, command, args, env }]`；Grok 启动 stdio MCP 子进程，真实执行 `tools/list` / `tools/call`。
- 工具名在 Grok 侧是 `<serverName>__<toolName>`；权限请求只允许本 turn 生成的随机前缀。
- 插件只暴露 `read` / `glob` / `grep` / `edit` 和固定 argv 的 `run_tests`；不声明任意 shell。
- `read` / `glob` / `grep` 走 `ctx.tools.execute`；`edit` / `run_tests` 再走 `ctx.approval.request`，只接受 `allowed-once`。
- 工具结果和错误原样作为 MCP 结果返回；模型文本不能生成/伪造工具结果。
- 没有配置 `grokTestCommand` 时 `run_tests` 明确不可用；测试不经过 shell。
- 系统提示只说明本轮可用的 MCP 工具，不把 Harness 原生工具列表直接塞给 ACP。

完整协议证据、安全边界和验收记录见 [grok-tools-feasibility.md](./grok-tools-feasibility.md)。

## 5. 上下文与工作目录

每轮使用新的 ACP session，发送 Harness 提供的完整文本 transcript；不在客户端伪造工具历史。`llmCwd` 是插件配置里的静态工作目录，也是发现和执行共用的目录。由于 LlmAdapter 接口没有提供会话实时工作区，切换 Harness 会话时不会自动改变这个静态 cwd；需要不同目录时请改插件配置。

Grok 没有 Codex 那种“目录决定 custom catalog 是否加载”的问题；但为保持两个提供方行为一致，仍使用同一个 `llmCwd`。

## 6. 能力边界

- 只接受文本和文本工具结果；图片/文件输入明确拒绝。
- `stop`、`temperature`、`maxTokens` 被拒绝，不静默忽略。
- `reasoning_effort` 只在选中时下发；CLI 不确认时报错。
- 取消会发送 `session/cancel`，随后关闭 session；MCP 桥、待处理的审批、原生工具和测试子进程随 abort signal 终止。
- MCP 桥的 HTTP 只绑定 loopback，带随机 bearer token；拒绝未知工具和未知参数；`edit` 不允许 `sandbox_permissions` / `justification` 升级。
- 工具调用不会显示成 DSH 原生 `tool/call` 卡片；记录在插件 JSONL 审计与 Harness 审批记录中。这是 ACP 协议边界，不是伪造。
- 子进程 stderr 只计字节、不转发；不把协议内容写日志。
- 进程断开、超时、模型撤销都会以明确错误码返回。

## 7. 验收依据

2026-11-02 在 `D:\AI-team\tr-e2e-work`、隔离 `DSH_HOME`、`tr-e2e` profile 中：

- 菜单出现 **TR Grok**，搜索 `grok` 只显示当次 TokenRouter 授权的 4 个 `TR · Grok ...` 路由；没有裸 `grok-4.6` / `grok-4.5`，也没有静态 `tokenrouter-*` 白名单。路由查询失败时整组报 `MODEL_DISCOVERY_FAILED`。
- 选择 `tokenrouter-grok-4.7` 后 UI 回复 `UI_GROK_OK`，该模型菜单显示 `Extra High / High / Medium / Low`；选择 `low` 后适配器的 `lastExecution.reasoningEffort = "low"`，真实回复 `UI_GROK_LOW_OK`，偏好文件记录该 provider/model 的 `low`。直接探针的 `reasoning_effort = "medium"` 也被 CLI 确认，`_meta.modelId = "grok-4.5"`，回复 `GROK_EFFORT_PROBE_OK`。
- 菜单出现 **TR Codex**，展开当次 `model/list` 返回的模型；选择 `gpt-6.1-sol` 后 `thread/start` 和 `turn/start` 都带有 `model: "gpt-6.1-sol"`。真实非默认 effort 探针自动选择了一个非默认等级（当次为 `low`），`turn/start.effort = "low"` 并回复 `CODEX_EFFORT_PROBE_OK`；UI 选择 `medium` 后回复 `UI_CODEX_MEDIUM_OK`。
- 重启隔离 Web 服务后，当前会话仍显示所选模型；新建会话时 Codex 的已保存 `medium` 和 Grok 的已保存 `low` 作为逐模型默认值恢复。偏好文件同时保存两个模型，互不覆盖。
- 0.4.0 工具验收：同一 profile 中，Grok 真实读取 `src/value.js`；UI 显示“TR Grok wants to modify a project file for src/value.js through Harness.”，点击“允许一次”后 `return 41` 变为 `return 42`；`node --test test/value.test.js` 返回 exit code 0。读取不存在的文件返回真实 `not found`。慢测试运行中点击“停止生成”，审计记录 `Error: TR Grok test call was cancelled and the test process was terminated.`，无残留测试进程。
- 以上为隔离 profile 验证；正式 Desktop 插件仍为安装好的 0.3.1，未发布 Release。
