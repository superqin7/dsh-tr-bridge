# Security policy / 安全说明

## 原生 TR Codex 提供方（v0.2.0）

- 通过 DSH subprocess 以显式 argv 启动 `tr.exe codex ... app-server --stdio`。不经过 shell，不读取 TokenRouter/Codex 登录文件，不读取或回传 API Key。
- 原生 Codex 的 shell、unified exec、browser、computer、apps、image generation、multi-agent、plugins、hooks、skill search、tool suggest 等能力在启动参数里设为 `false`；thread 使用 `sandbox: read-only`、`approvalPolicy: never`，工具只允许 Harness 的 `dynamicTools` 回传。**这是 Codex 配置与只读沙箱，不是 Windows 内核沙箱**；若某个未来版本忽略这些 key，仍以 Codex 自身限制为准。
- 子进程 stdout 是 JSONL JSON-RPC，可能包含会话文本；插件不把它写入日志。stderr 只累计字节数，不解析、不转发、不写日志。
- 模型清单只来自 `model/list`；不读取账号接口，不保存模型回复。模型被撤销时 `resolveModel` 会强制刷新并报 `MODEL_UNAVAILABLE`。
- 长驻子进程随插件 fiber 释放而 `terminate()`；单次请求/流取消会中断对应 turn 并释放 thread。真实桌面端的进程清理仍是未验证。
- 与原有 `tr_bridge` 相同：任务文本是单独 argv 元素，不做 shell 拼接；插件不把密钥写回环境。

## 运行权限

- 插件以启动 DeepSeek Harness 的操作系统身份运行。本插件**不是操作系统沙箱**。
- `codex` 通过 `tr codex exec --sandbox read-only` 请求只读沙箱，并加上 `--ephemeral`，避免写入 Codex 会话文件。真实限制由 Codex CLI 和操作系统决定。
- `grok` 通过 `tr grok -p` 调用，并附带 `--permission-mode dontAsk`、只读工具允许列表，以及对 `Bash`、`Edit`、`Write`、`MCPTool`、`WebFetch` 的拒绝规则。默认还有 `--disable-web-search`。
- Grok 文档中的内核沙箱使用 Linux Landlock 或 macOS Seatbelt。无法应用时，Grok 会警告并继续。**本插件不把 `--sandbox` 当作 Windows 安全边界。Windows 操作系统级隔离是「未验证」。**
- 插件把 argv 直接交给 DSH subprocess。0.2.1-rc.5 的 Windows 实现使用 `CreateProcessW`，只接受 `.exe` / `.com`。插件拒绝 `.cmd`、`.bat` 和 `.ps1`，因为把任务交给 `cmd.exe` 会解释 `&`、`|`、`%` 等字符。
- 任务文本始终是单独的 argv 元素，不拼进 shell 字符串。
- 插件不向仓库提交 TokenRouter Key、API URL、账号、Cookie 或登录凭据。不要把这些数据写入 Issue、日志或提示词。
- DSH 会在子进程环境中去掉名称匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量。插件不把密钥写回环境，也不要求用户再提供 API Key。登录应已经保存在 TokenRouter 自己的配置里。
- 输出脱敏只覆盖常见 Token 形态和 `API密钥` / `TR_SETUP_KEY` 片段，不能保证识别所有敏感数据，也不是 DLP。
- 原有工具桥接的模型清单只通过 `tr codex debug models` 和 `tr grok models` 获取；原生提供方用 `model/list`。两条路径都不读取 TokenRouter、Codex 或 Grok 的凭据文件，也不把 API Key 写进子进程环境。`debug models` / `grok models` 没有翻页参数；输出若带分页标记，插件拒绝把当前页当成全部模型。
- 配置页是浏览器半侧。它只通过宿主 Connection RPC 调用上述同一套刷新和保存逻辑，不读取登录凭据，不提供 API Key 输入框，也不运行 `tr status`。RPC 响应不返回任务文本、启动器完整路径或原始 CLI 状态。
- 已保存的默认模型放在 `%APPDATA%\dsh-tr-bridge\model-selection.json`，不是登录配置。使用前会重新查询清单；查询失败时不沿用旧清单。

## 发布状态

当前是 `v0.2.0` 预览版。Node 模拟测试和一次不产生模型回复的 app-server 握手通过，不等于 Windows 桌面版模型菜单、真实回复、工具往返或取消验收通过。

## 报告漏洞

请通过仓库的 GitHub Security / 私密漏洞报告渠道联系维护者。
涉及密钥、内部源码和客户数据时，不要公开提交 Issue。
