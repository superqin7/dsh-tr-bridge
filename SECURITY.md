# Security policy / 安全说明

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

## 发布状态

当前是 `v0.1.0-rc.2` 预览版。Node 模拟测试通过不等于 Windows 宿主或真实调用链路验收通过。

## 报告漏洞

请通过仓库的 GitHub Security / 私密漏洞报告渠道联系维护者。
涉及密钥、内部源码和客户数据时，不要公开提交 Issue。
