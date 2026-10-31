# dsh-tr-bridge · TokenRouter × DeepSeek Harness

![Status](https://img.shields.io/badge/status-preview-orange) ![Node](https://img.shields.io/badge/node-%3E%3D20-blue) ![License](https://img.shields.io/badge/license-MIT-green)

> **预览版本 v0.1.0-rc.2 / Preview.** 社区开发的独立插件，非 DeepSeek Harness 官方组件，也不是 TokenRouter 官方组件。已对照本机安装的 DeepSeek Harness **0.2.1-rc.5** 插件契约做静态检查，并通过 Node 模拟测试。**Windows 桌面版的插件加载、工具出现和会话内真实派发仍是「未验证」。** 请勿将本项目标记为 Stable、Official 或 Production Ready。

> **开源来源声明 / Attribution：** 本项目受开源社区项目 **[dsh-agent-conductor（MJorgin）](https://github.com/MJorgin/dsh-agent-conductor)**、**[dsh-agent-teams（NanmiCoder）](https://github.com/NanmiCoder/dsh-agent-teams)** 和 **[dsh-agent-arena（Tikzen）](https://github.com/Tikzen/dsh-agent-arena)** 的启发。尤其借鉴了前者的外部 CLI 代理派发思路，以及后两者的多 Agent 协作场景。**这是独立实现的非官方社区项目，不是上述项目的官方分支或官方维护版本，也不声称首创相关概念。** 项目完整源代码以 [MIT License](./LICENSE) 公开。具体出处请见 [NOTICE.md](./NOTICE.md)。

**English:** A local, host-only DeepSeek Harness bridge that delegates bounded tasks to the user's existing `tr codex` and `tr grok` launchers. It does not request, store or forward TokenRouter API keys. Early preview. Windows desktop plugin load and in-app dispatch are **未验证**.

一个专门为 Windows 上已经能运行 `tr codex`、`tr grok` 的用户准备的 DeepSeek Harness **Host 插件**。它使用 TokenRouter 已经保存的登录，不额外要求 API Key。

## 0.2.1-rc.5 接口检查

对照本机 `DeepSeek Harness.exe` 文件版本 `0.2.1-rc.5` 里的包契约检查了这些点。这不是桌面版加载测试。

| 契约 | 结论 |
| --- | --- |
| `package.json` 的 `dsh.bundle.patch` 与 `cordis.patch.yml` 的 `insert` | 与 0.2.1-rc.5 Host bundle 安装方式一致 |
| `export function apply(ctx, config)` + `inject: ['tools', 'subprocess', 'workingDirectory']` | 与 Host 插件入口一致。Desktop 基础 profile（`dsh-base`）提供这三个服务 |
| `ctx.tools.register` | 0.2.1-rc.5 直接保存传入定义，并用 `assertSupportedJsonSchema` 检查 `output.schema`。`parameters` 必须已经是模型可见的 JSON Schema，不是 `defineTool` 的作者 DSL。本插件按这个子集注册 |
| `ctx.subprocess.spawn({ argv, cwd, stdio, graceMs, signal })` | 与 subprocess seam 的显式 argv 请求一致。不经过 shell |
| Windows `CreateProcessW` | 只解析 `.exe` / `.com`。`.cmd`、`.bat`、`.ps1` 和 PowerShell 函数不能安全承载任务文本 |

插件管理器在缺少 locale 时会回退到 `package.json` 的名称和描述。本版本补了 `locale/zh.json`、`locale/en.json` 和 `icon.svg`，但**图标和标题是否在桌面版正确渲染仍是「未验证」。**

## Windows 桌面版安装

这些步骤按 0.2.1-rc.5 插件管理器文档编写。**点击安装、启用和会话内调用尚未在本仓库的自动化测试里完成，状态为「未验证」。**

1. 安装并登录 TokenRouter，使普通 PowerShell 能运行 `tr.exe`。不要把 API Key 写进插件、Issue 或截图。
2. 在 PowerShell 确认启动器类型，不要粘贴含密钥的输出：

   ```powershell
   Get-Command tr | Format-List CommandType, Source, Definition
   tr codex status
   tr grok status
   ```

   `CommandType` 必须是 `Application`，`Source` 必须以 `tr.exe` 结尾。如果看到 `Function` 或 `Alias`，桌面版无法调用它。
3. 把本仓库放到例如 `D:\dsh-tr-bridge`。目录根下要直接有 `package.json`、`cordis.patch.yml`、`index.js` 和 `resolve-tr.js`。
4. 打开 DeepSeek Harness 0.2.1-rc.5 桌面版，进入 **插件**，添加本地目录 `D:\dsh-tr-bridge`，安装后 **启用**。如果界面要求重启，重启应用。不需要 `npm install`，本包没有第三方依赖。
5. 如果桌面版提示找不到 `tr`，在插件行配置里设置 `trCommand` 为上一步看到的完整路径，例如 `C:\Users\你的用户名\AppData\Local\Programs\TokenRouter\tr.exe`。不要填 `.cmd`、`.bat` 或 PowerShell 函数名。
6. 选择一个不含重要文件的临时 Git 工作区，新建会话。先发送：

   > 请确认已加载 `tr_bridge` 工具。先以 `agent=codex, task=只回复 CODEX_OK, dryRun=true` 预览启动参数，不要真正执行。

7. 预览里的工作目录和启动器路径正确后，再发送：

   > 请调用 `tr_bridge` 工具分别让 Codex 和 Grok 只回复 `CODEX_OK` 和 `GROK_OK`，完成后显示两份原始回复。不要修改任何文件。

第 6 步如果找不到 `tr_bridge`，不要改用 Shell 冒充插件调用。先看插件是否启用，以及是否要求重启。

## 能力与限制

- 一个工具：`tr_bridge(agent, task, dryRun)`。`agent` 只能是 `codex` 或 `grok`。
- 工作目录使用当前会话的 `workingDirectory.ensure()`。用户后来用 `cd` 换过目录时，不会退回会话创建时的原始路径。服务不可用时才读取 `session.header.cwd`。
- 不读取、不保存、不转发 TokenRouter API Key。登录仍由 `tr` 自己的配置负责。
- Codex 实际执行 `tr.exe codex exec --sandbox read-only --color never --ephemeral -- <task>`。`--` 用来避免以 `-` 开头的任务被当成参数。
- Grok 实际执行 `tr.exe grok --permission-mode dontAsk --tools read_file,grep,list_dir --no-subagents --deny Bash --deny Edit --deny Write --deny MCPTool --deny WebFetch --disable-web-search -p <约束提示 + task>`。
- Grok 的工具允许列表和拒绝规则不是 Windows 内核沙箱。Grok 文档中的 `--sandbox read-only` 依赖 Linux Landlock 或 macOS Seatbelt；无法应用时会警告并继续。**因此本插件不把该标志当作 Windows 安全边界，Windows 上的操作系统级隔离是「未验证」。**
- DeepSeek Harness 会从子进程环境里去掉名称匹配 `KEY|PASSWORD|SECRET|TOKEN` 的变量，以及 `DSH_*`。这是宿主行为。本插件不把 API Key 写回去。只要 `tr` 使用磁盘上的已有登录，就不需要额外密钥。
- 两个任务互相独立，可以并行，都会消耗各自模型额度。
- 每次都是一次性外部 CLI 调用，不是 DSH AgentTeams 成员，也没有群聊。
- 任务最多 20,000 字符，默认最长 10 分钟，返回文本截断到约 24,000 字符。支持取消信号。
- 不安装 CLI，不重新登录，不修改 DSH 现有账号配置。

可选插件配置：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `trCommand` | `tr` | `tr` 或 `tr.exe` 的完整路径。相对路径、`.cmd`、`.bat`、`.ps1` 会被拒绝 |
| `timeoutMs` | `600000` | 单次执行上限，限制在 1 秒到 30 分钟 |
| `grokWebSearch` | `false` | 只有显式设为 `true` 才去掉 `--disable-web-search` |

## Windows 启动问题

**PowerShell 能运行 `tr`，桌面版找不到：** 桌面进程的 PATH 可能是登录时的旧 PATH，也可能和当前终端不同。插件会依次查找进程 PATH、用户/系统注册表 PATH，以及 `%LOCALAPPDATA%\Programs\TokenRouter\tr.exe`。仍失败时，把 `Get-Command tr` 的 `Source` 写入 `trCommand`。

**`tr` 是 PowerShell 函数或别名：** 桌面版不能启动它。请使用 TokenRouter 安装的 `tr.exe`。

**PATH 里先出现 `tr.cmd`：** 插件会跳过 `.cmd` / `.bat` / `.ps1`，优先使用同名 `.exe`。0.2.1-rc.5 的 Windows runner 用 `CreateProcessW`，不能直接运行 `.cmd`。如果把任务交给 `cmd.exe /c`，`&`、`|`、`%` 会被解释成命令，所以插件直接拒绝脚本启动器。

**Codex 停在 `Reading additional input from stdin...`：** Codex 在 stdin 是管道且同时收到 prompt 时会继续等输入。本插件在启动后立刻关闭 stdin。如果自己用脚本复现，也要立刻 `stdin.end()`；不要用 PowerShell `Start-Process -ArgumentList` 判断参数是否正确，它会按空格拆开参数。

**Codex 报不是 trusted directory：** 在 Harness 里选择已信任的 Git 项目。不要为了避错关闭信任检查。

**Grok 无输出或超时：** 先在同一工作区手工运行下面的命令。需要界面确认或重新登录的任务，本插件不会自动处理。

```powershell
tr grok --permission-mode dontAsk --tools read_file,grep,list_dir --no-subagents -p "只回复 GROK_OK"
```

## 本地开发测试

```bash
npm test
```

`npm test` 只使用 Node 内置 mock，不访问 TR、Codex、Grok 或网络。GitHub Actions 的 Windows job 同样只跑这些 mock；它不能代替桌面版验收。

## 来源与维护说明

**致谢与引用来源（按照思路影响划分）：**

- [MJorgin/dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor)：参考其在 DeepSeek Harness 中调度 Codex、Grok 等外部 CLI 的插件思路，是本项目在功能上最直接的灵感来源。
- [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams)：参考其组队、队长调度和子任务分派场景；本项目目前**不包含**这类组队编排功能。
- [Tikzen/dsh-agent-arena](https://github.com/Tikzen/dsh-agent-arena)：参考其多 AI 讨论和协作群体验；本项目目前**不包含**群聊界面或持续多人对话机制。
- [DeepSeek Harness](https://github.com/deepseek-ai)：本项目面向其插件系统开发，使用 Host Tool / Bundle 的接口形态；与 DeepSeek 官方无隶属或背书关系。

本项目的桥接逻辑为独立编写，无运行时依赖，不直接复制上述项目代码。引用链接用于说明设计灵感和尊重原作者贡献；相关商标、项目名称及其原始源码归各自权利人所有。详细说明请读 [NOTICE.md](./NOTICE.md)。

**状态：v0.1.0-rc.2，预览。** Node 模拟测试覆盖命令参数、Windows 启动器选择和凭据脱敏。Windows DeepSeek Harness `0.2.1-rc.5` 的真实安装、运行和取消仍是「未验证」。问题请开 GitHub Issue，附脱敏日志、版本和复现步骤，**不要上传 TokenRouter Key 或包含客户资料的截图**。

## Open source

- Repository: https://github.com/superqin7/dsh-tr-bridge
- License: [MIT](./LICENSE)
- Attribution & credits: [NOTICE.md](./NOTICE.md)
- 本项目代码已完全公开；可以遵循 MIT 许可自由使用、修改和再发布。
- Security notes: [SECURITY.md](./SECURITY.md)
- 建议 GitHub Topics：`deepseek-harness`、`dsh-plugin`、`tokenrouter`、`codex-cli`、`grok-cli`、`windows`。
