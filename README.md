# dsh-tr-bridge · TokenRouter × DeepSeek Harness

![Status](https://img.shields.io/badge/status-preview-orange) ![Node](https://img.shields.io/badge/node-%3E%3D20-blue) ![License](https://img.shields.io/badge/license-MIT-green)

> **预览版本 v0.1.0-rc.1 / Preview.** 社区开发的独立插件，非 DeepSeek Harness 官方组件。已通过 Node 模拟测试；**尚未在 Windows DeepSeek Harness 0.2.1-rc.5 完成插件加载及真实 CLI 派发验收**。请勿将本项目标记为 Stable、Official 或 Production Ready。

> **开源来源声明 / Attribution：** 本项目受开源社区项目 **[dsh-agent-conductor（MJorgin）](https://github.com/MJorgin/dsh-agent-conductor)**、**[dsh-agent-teams（NanmiCoder）](https://github.com/NanmiCoder/dsh-agent-teams)** 和 **[dsh-agent-arena（Tikzen）](https://github.com/Tikzen/dsh-agent-arena)** 的启发。尤其借鉴了前者的外部 CLI 代理派发思路，以及后两者的多 Agent 协作场景。**这是独立实现的非官方社区项目，不是上述项目的官方分支或官方维护版本，也不声称首创相关概念。** 项目完整源代码以 [MIT License](./LICENSE) 公开，欢迎阅读、修改、分发与贡献；具体出处请见 [NOTICE.md](./NOTICE.md)。

**English:** A local, host-only DeepSeek Harness bridge that delegates bounded tasks to the user's existing `tr codex` and `tr grok` launchers. It does not request, store or forward TokenRouter API keys. Early preview; Windows end-to-end compatibility is unverified.

一个专门为 Windows 上已能运行 `tr codex`、`tr grok` 的用户准备的 DeepSeek Harness **Host 插件**。

## 已验证的前置条件

在项目开发者的 Windows 电脑上，已分别验证下列 **TR 命令链路**（不是桥接插件本身）：

```powershell
# 在可信任的 Git 项目内
tr codex exec "只回复 CODEX_OK"
# 结果：CODEX_OK，provider: tokenrouter，sandbox: read-only

tr grok -p "只回复 GROK_OK"
# 结果：GROK_OK
```

这说明 **TR 本身的命令链路正常**，不意味着本插件已通过 Windows DSH 宿主验证。

## 安装（Windows 桌面版，先验收再正式使用）

1. 把本文件夹解压到例如 `D:\dsh-tr-bridge`。确认该文件夹直接包含 `package.json`、`cordis.patch.yml` 和 `index.js`。
2. DeepSeek Harness 桌面版 → **插件** → **添加插件** → 输入本地目录 `D:\dsh-tr-bridge` → 安装 → **启用**。
3. 如果程序要求重启，请重启 DeepSeek Harness。无需单独安装 Node 依赖；此包未声明第三方依赖。
4. 首次测试请优先选择一个不含重要文件的临时 Git 工作区，确认安全后再进入日常项目。新建会话。
5. 首先发送：

   > 请确认已加载 `tr_bridge` 工具。先以 `agent=codex, task=只回复 CODEX_OK, dryRun=true` 预览启动参数，不要真正执行。

6. 确认工具预览输出的工作目录与 `tr codex exec --sandbox read-only` 命令都正确之后，再发送：

   > 请调用 `tr_bridge` 工具分别让 Codex 和 Grok 只回复 `CODEX_OK` 和 `GROK_OK`，完成后显示两份原始回复。不要修改任何文件。

**重要：** 第 5 步若提示找不到 `tr_bridge`，不要把 Shell 命令冒充为插件调用；先检查插件是否启用及工具注册日志。

## 能力与限制

- 一个工具：`tr_bridge(agent, task, dryRun)`，代理名为 `codex` 或 `grok`。
- Codex 实际执行 `tr codex exec --sandbox read-only <task>`，TR 注入的 TokenRouter 路由保持不变。
- Grok 实际执行 `tr grok -p <task>`，并在任务前加入“禁止修改文件”的文字提示。**这不是 Grok 的真实沙箱**。在尚未单独验收 Grok 的只读/工具权限前，请仅用于可信、无需改文件的工作区。
- 两个任务互相独立，可以并行调用，都会消耗各自模型的使用额度。
- 每次是一次性的外部 CLI 调用，不是独立的 DSH AgentTeams 成员，也不提供实时微信群式对话。
- 任务最多 20,000 字符，单次最长 10 分钟，返回文本截断到约 24,000 字符；支持 DSH 取消信号。
- 不主动写文件、安装 CLI、重新登录、管理 TR 的 API Key，也不修改 DSH 现有配置。

## 排查 Windows 启动问题

**PowerShell 能运行 `tr`，但桌面版插件提示找不到：** 桌面程序的 PATH 可能与终端不同。可以在 PowerShell 使用 `Get-Command tr | Format-List CommandType,Source,Definition` 检查其类型与路径（不要粘贴含敏感参数的配置）。如果它是可执行文件，可在 DSH 的插件配置中为 `tr-bridge` 行设置 `config.trCommand` 为该可执行文件的完整路径；如果它是 PowerShell 别名或函数，不能直接以可执行文件的方式调用，需要另行提供安全的命令入口。

**Codex 报不是 trusted directory：** 在 Harness 里先选受信任的 Git 项目文件夹；不建议为了避错直接关闭信任检查。

**Grok 无输出或超时：** 先在同一个工作区手工重试 `tr grok -p "只回复 GROK_OK"`。对于需要界面交互、授权提示或登录步骤的任务，本插件不会自动处理。

## 本地开发测试

```bash
node --test
```

测试只使用 Node 内置 mock，不访问 TR、Codex、Grok 或网络。

## 来源与维护说明

**致谢与引用来源（按照思路影响划分）：**

- [MJorgin/dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor)：参考其在 DeepSeek Harness 中调度 Codex、Grok 等外部 CLI 的插件思路，是本项目在功能上最直接的灵感来源。
- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)：参考其组队、队长调度和子任务分派场景；本项目目前**不包含**这类团队编排功能。
- [Tikzen/dsh-agent-arena](https://github.com/Tikzen/dsh-agent-arena)：参考其多 AI 讨论和协作群体验；本项目目前**不包含**群聊界面或持续多人对话机制。
- [DeepSeek Harness](https://github.com/deepseek-ai)：本项目面向其插件系统开发，使用 Host Tool / Bundle 的接口形态；与 DeepSeek 官方无隶属或背书关系。

本项目的桥接逻辑为独立编写，无运行时依赖，不直接复制上述项目代码。引用链接用于说明设计灵感和尊重原作者贡献；相关商标、项目名称及其原始源码归各自权利人所有。详细说明请读 [NOTICE.md](./NOTICE.md)。

**状态：v0.1.0-rc.1，预览安装包**。Node 模拟单元测试已通过；尚需 Windows DeepSeek Harness `0.2.1-rc.5` 真实安装、运行、取消验收。不承诺已通过 Windows 实机加载。问题请开 GitHub Issue，附脱敏日志、版本和复现步骤，**不要上传 TokenRouter Key 或包含客户资料的截图**。

## Open source

- Repository: https://github.com/superqin7/dsh-tr-bridge
- License: [MIT](./LICENSE)
- Attribution & credits: [NOTICE.md](./NOTICE.md)
- 本项目代码已完全公开；可以遵守 MIT 许可自由使用、修改和再发布。`private` npm 发布设置（若存在）不影响 GitHub 开源许可。
- Security notes: [SECURITY.md](./SECURITY.md)
- 建议 GitHub Topics：`deepseek-harness`、`dsh-plugin`、`tokenrouter`、`codex-cli`、`grok-cli`、`agent-orchestration`、`windows`。
