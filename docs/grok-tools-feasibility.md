# TR Grok 工具调用：协议与安全可行性检查（v0.4.0）

日期：2026-11-02  
环境：DeepSeek Harness `0.2.1-rc.5`；本机 Grok CLI `1.0.30 (04b7ffed98c6)`；Windows。  
结论：**可行，采用 Grok ACP 的 MCP 服务器通道，不使用模型文本冒充工具调用。** 没有发现需要绕过官方协议的阻断点。

## 1. 先检查协议，而不是先写“工具”

### 1.1 ACP 没有客户端任意工具结果通道

`tr grok` 的 stdio ACP 会话已真实探测（证据文件：`D:\AI-team\tr-bridge-test\acp-capabilities.jsonl`）：

- `initialize` 的 `agentCapabilities.mcpCapabilities` 为 `{ http: true, sse: true }`。
- `promptCapabilities.embeddedContext` 为 `true`，`image` / `audio` 为 `false`。
- ACP 的 `session/prompt` 只发送文本内容；**没有**让客户端把任意工具结果注入回 Agent 的标准方法。
- 因此不能把 Harness 的 `tool-call` 块直接塞进 ACP 文本；那会变成“模型输出文本冒充工具调用”，明确禁止。

### 1.2 Grok 支持在 `session/new` 挂载 MCP 服务器

同一探测中，`session/new` 接受：

```json
{
  "cwd": "D:\\AI-team\\tr-bridge-test",
  "mcpServers": [
    {
      "name": "dsh_probe",
      "command": "node",
      "args": ["probe-mcp-server.mjs"],
      "env": []
    }
  ]
}
```

Grok 启动该 stdio MCP 子进程，真实执行 `tools/list` 与 `tools/call`。MCP 服务端收到：

```json
{"method":"tools/call","params":{"name":"echo_probe","arguments":{"text":"hello-from-grok"}}}
```

并返回 `MCP_PROBE_OK:hello-from-grok`；Grok 的 prompt 以 `end_turn` 完成并返回 usage。  
探测还确认：工具在 Grok 侧被命名为 `<serverName>__<toolName>`，例如 `dsh_probe__echo_probe`。  
证据：`D:\AI-team\tr-bridge-test\acp-mcp-probe.jsonl`、`mcp-probe.log`。

### 1.3 权限请求是真实的 ACP 请求

Grok 对 MCP 工具发起：

```json
{
  "method": "session/request_permission",
  "params": {
    "sessionId": "...",
    "toolCall": {
      "rawInput": {
        "variant": "UseTool",
        "tool_name": "dsh_probe__echo_probe"
      }
    },
    "options": [
      {"optionId":"always-allow","kind":"allow_always"},
      {"optionId":"allow-once","kind":"allow_once"},
      {"optionId":"reject-once","kind":"reject_once"}
    ]
  }
}
```

本插件只对**本会话随机生成的 MCP 服务器前缀**返回 `allow-once`；其他工具（包括 Grok 内置工具）一律返回 `cancelled`，并在会话中记录一次拒绝。没有“自动允许所有工具”的开关。

### 1.4 Harness 侧的工具与审批契约

已从本机 Harness 安装包解出并核对：

- `dsh-llm` 的 `LlmAdapter.stream()` 可以接收 `GenerateOptions.tools`，但 ACP 传输没有原生结果通道。
- `dsh-agent-loop` 会执行 assistant 的原生 `tool-call` 块；本插件不走这条伪造路径。
- `dsh-tools` 的 `ctx.tools.execute({ name, arguments, agent, callId, signal })` 返回 `{ content, isError }`，并经过现有工具策略、文件策略和超时策略。
- `dsh-user-approval` 的 `ctx.approval.request({ agent, toolName, callId, reason, signal })` 需要开放的 turn；结果包含 `allowed-once`、`rejected`、`cancelled`、`unavailable`。没有 answerer 时 fail closed。
- Harness 的 `edit` 工具参数包含 `sandbox_permissions` / `justification` 扩展字段；本插件从暴露给 Grok 的 schema 和实际参数中都删除这两个字段，防止 Grok 请求升级沙箱。

## 2. 采用的架构

```text
Grok ACP child
  └─ stdio MCP child (grok-mcp-server.js)
       └─ HTTP 127.0.0.1:<random port>  (bearer token, per Grok turn)
            └─ HarnessToolBridge (plugin)
                 ├─ ctx.tools.execute(read/glob/grep/edit)
                 ├─ ctx.approval.request(edit/run_tests)
                 ├─ ctx.subprocess.spawn(fixed test argv)
                 └─ JSONL audit (redacted)
```

- 每个 Grok turn 生成随机 MCP server 名与随机 bearer token；HTTP 只绑定 `127.0.0.1`，请求体限制 1 MB。
- Grok 只看到四个 Harness 文件/搜索工具，加上一个**固定 argv** 的 `run_tests`；没有 `write`、`pwsh`、`bash` 或任意命令参数。
- `run_tests` 不接受命令参数；命令来自用户配置 `grokTestCommand`（argv 数组），绝不是模型可写的字符串。
- `read` / `glob` / `grep` 仍通过 `ctx.tools.execute`，受 Harness 文件策略约束；`edit` / `run_tests` 额外必须得到用户的一次性批准。
- 工具失败、拒绝、取消都作为 MCP `isError` 结果返回；不会把失败改写成成功。
- ACP 的 `session/cancel` 会中止本 turn；适配器把 abort signal 传给 bridge，bridge 再中止审批、原生工具和测试子进程。

## 3. 隔离 profile 的真实验收

隔离 `DSH_HOME`：`D:\AI-team\dsh-e2e-home`，profile `tr-e2e`；正式 Desktop 未升级，仍为 0.3.1。  
验收项目：`D:\AI-team\tr-e2e-work`。  
审计：`D:\AI-team\dsh-e2e-home\grok-tool-audit.jsonl`（不含完整文件内容或密钥）。

已实际完成：

| 项目 | 结果 | 证据 |
|---|---|---|
| 真实读取项目文件 | `read src/value.js` 成功，返回文件内容 | 审计 `read` result `isError:false`；UI 显示 `MCP read` |
| 经批准的修改 | `edit` 等待用户点击“允许一次”后，`return 41` 改为 `return 42` | 审计 `edit` `approval:"allowed-once"`, `isError:false`；文件已变更 |
| 测试执行 | `node --test test/value.test.js` 退出码 0，1 pass | 审计 `run_tests` `isError:false`；UI 显示 exit code 0 |
| 工具失败 | 读取 `src/does-not-exist.js` 返回 `not found` | 审计 `read` `isError:true`；UI 显示 `Failed to call read` |
| 取消 | 慢测试运行中点击“停止生成”，测试子进程被终止，结果明确为 cancelled | 审计 `run_tests` `isError:true`, `error:"...cancelled and the test process was terminated."`；没有残留慢测试进程 |
| 拒绝未知工具 | Grok 内置工具/permission 请求只返回 `cancelled` | 传输测试与 `GrokAppServer` 的 `deniedPermissionCount` |

已验证的边界：模型自己生成文本“假装调用工具”不会被执行；插件只响应真实 MCP `tools/call`。  
已验证的取消路径：UI 停止 → ACP `session/cancel` → adapter abort → bridge abort → approval/tool/子进程终止。

## 4. 未验证或需要明说的限制

1. **正式 Desktop 仍是 0.3.1**，本分支没有升级它；以上全部在隔离 profile 完成。
2. 工具调用**不会**显示成 DSH 原生 `tool/call` 卡片/会话事件；它们是 ACP MCP 调用，记录在插件 JSONL 审计和 Harness 审批记录中。这是协议边界，不是伪造。
3. `read` / `glob` / `grep` 不逐次弹审批，但仍走 Harness 工具和文件策略；`edit` / `run_tests` 逐次审批。若用户要求“读取也必须每次弹窗”，可把只读工具也加入审批，但会显著增加交互次数。
4. Grok 内置工具的权限请求已验证会被拒绝；如果某个 Grok 版本对某个内置工具**完全不发**权限请求就直接执行，本客户端无法拦截该执行。当前 1.0.30 的已测路径会发请求；建议在升级 Grok 后重跑探测。
5. 测试命令是用户配置的固定 argv，不是沙箱。它能执行用户明确配置的程序；本插件不把它扩展成任意 shell。
6. 未在正式 Desktop 的模型菜单/工具往返/所有取消路径上验收；不能据此声称 Stable、Official 或 Production Ready。
