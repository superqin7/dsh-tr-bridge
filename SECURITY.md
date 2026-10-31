# Security policy / 安全说明

## 运行权限

- 插件以用户启动 DeepSeek Harness 的操作系统身份运行，本插件 **不是操作系统沙箱**。
- `codex` 的任务通过 `tr codex exec --sandbox read-only` 请求只读沙箱；真实限制由 Codex CLI 和操作系统决定。
- `grok` 的任务通过 `tr grok -p` 调用，目前只在输入提示词中要求只读；**没有技术级写入阻断**。在共享、敏感或生产项目上使用前必须自行确认 Grok 的工具权限。
- 插件调用 DSH 的 subprocess 服务直接传递 argv，不经过 shell 字符串插值。请仍对 TR 启动器本身及其依赖做安全审查。
- 插件不向仓库提交 TokenRouter Key、API URL、账号信息、登录 Cookie、用户凭据。不要将这些数据写入 Issue、日志或提示词。
- 输出脱敏只覆盖常见 Token 形态，不能保证识别所有敏感数据；不应当视作全面的 DLP 方案。

## 发布状态

当前是 `v0.1.0-rc.1` 预览版。Node 模拟测试通过不等于 Windows 宿主或真实调用链路验收通过。

## 报告漏洞

请通过仓库的 GitHub Security / 私密漏洞报告渠道（如仓库已启用）联系维护者。
涉及密钥、内部源码和客户数据时，请勿公开提交 Issue。
