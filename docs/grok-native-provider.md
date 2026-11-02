# TR Grok 原生提供方：设计准备（不实现）

状态：**设计稿 / 未实现**。本文件只记录第二阶段允许的“共用传输层与独立设计”，不包含 Grok 代码，也不改变模型菜单。

## 1. 范围与门槛

- 本分支只实现 `tr-codex`。TR Grok 必须等 Codex 的 Desktop E2E 通过后再继续。
- 不实现 `DSH_TOOL` 文本解析来冒充原生工具调用。
- 不发起真实 Grok 调用，除非单独批准。
- 不在配置页或模型菜单里提前展示 Grok 原生提供方。

## 2. 已确认的协议事实（只读探针）

`tr grok agent stdio`（grok 1.0.30）是 ACP 风格 JSON-RPC：

| 方法 | 用途 | 本机只读结果 |
| --- | --- | --- |
| `initialize` | 握手 | 成功；`protocolVersion: 1`，`sessionCapabilities: {list, resume, close}` |
| `session/new` | 建会话 | 成功；返回 `configOptions`、`_meta.modelState.availableModels` |
| `session/set_config_option` | 切模型/参数 | **未执行** |
| `session/prompt` | 一轮用户输入 | **未执行** |
| `session/update` | 流式通知 | **未执行** |
| `session/cancel` | 取消 | **未执行** |
| `session/close` | 关闭 | **未执行** |

`availableModels` 同时包含：

- `tokenrouter`（当前选中）；
- `tokenrouter-grok-4.5/4.6/4.7/4.7-build-fast`（TokenRouter 路由别名）；
- `grok-4.5/4.6`（CLI 原生 xAI 模型）。

`tr grok models` 的 notice 还说明 `tokenrouter` 使用自己的 API Key。原生提供方只应展示 **TokenRouter 路由别名**，并把底层模型（`grok-4.7` 等）作为说明信息；不能把裸 `grok-4.x` 混进“TR 设备授权”菜单。

## 3. 关键协议缺口

ACP v1 没有“客户端注册工具”的一等通道。对比：

- Codex app-server 有 `dynamicTools` 与 `item/tool/call`，Harness 工具由宿主执行；
- Grok ACP 的 `session/update` 只有计划、消息、工具调用等通知，没有“请客户端执行这个 Harness 工具并回传结果”的请求方法。

因此可选路径只有：

1. **纯聊天适配**：不提供 Harness 工具调用。模型仍可能尝试 CLI 原生工具；必须全部拒绝。
2. **MCP 桥**：由 Harness 侧起一个 MCP server，让 Grok 通过 MCP 调用工具；需要验证 Grok 的 MCP 支持、权限和工具结果回流。
3. **文本约定**：在 prompt 里约定 JSON，由适配器解析。可靠性、可注入性和流式工具结果都差，本阶段明确不做。

在本阶段，只能把 Grok 定位为“可靠纯聊天适配”候选；如果产品要求原生工具调用，Grok 应保持 NO-GO，直到 MCP 路径被验证。

## 4. 可复用部分

`llm/rpc.js` 已与 Codex 解耦：

- `LineBuffer`：任意 JSONL 子进程分帧；
- `RpcPeer`：请求/响应、超时、AbortSignal；
- `EventQueue`：按会话排队通知；
- `TrLlmError`：统一错误码。

Grok 还需要新增：

- `llm/grok-transport.js`：启动 `tr.exe grok agent stdio`，处理 `session/update` 分发与 `session/close`；
- `llm/grok-catalog.js`：从 `session/new` 的 `availableModels` / `configOptions` 取 `tokenrouter-*`，TTL 刷新，下线报错；
- `llm/grok-adapter.js`：`session/new` → `set_config_option(model)` → `session/prompt`，把 `session/update` 映射成 `StreamChunk`；`session/cancel` 对应取消；
- 权限处理：对原生工具请求一律拒绝；如果做 MCP，再单独设计权限审批。

## 5. 设计约束

- 只启动已经登录的 `tr.exe`，不读取 TokenRouter/Grok 登录文件或 API Key。
- spawn 使用 `ctx.subprocess.spawn` 的显式 argv，Windows 只用 `.exe`，不经过 shell。
- stderr 只计字节、不转发；stdout 的协议内容不写日志。
- 模型 ID 原样传给 `set_config_option`；找不到时 `MODEL_UNAVAILABLE`，不静默替换。
- 多轮上下文：优先复用 ACP session；无法复用时发送完整 transcript，而不是伪造工具历史。
- 纯聊天适配必须在 README/模型描述里明确“不能调用 Harness 工具”，不能把文本约定包装成原生工具。

## 6. 验证计划（待批准）

1. `session/new` + `set_config_option` 后读取 `currentModelId`，确认模型真的切换。
2. `session/prompt` 的流式 update 形态、结束标记、usage（若有）。
3. 多轮上下文、取消、超时、进程退出与重启。
4. 纯聊天能力下，拒绝原生工具的路径。
5. 若走 MCP：工具发现、调用、结果、权限审批、取消的完整链路。

在 Codex E2E 通过前，以上都不进入实现。
