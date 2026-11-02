# Open-source attribution / 开源致谢

`dsh-tr-bridge` is an independently implemented, unofficial community plugin. Its design was **inspired by existing open-source work**. Credit for the original ideas and projects belongs to their respective authors.

`dsh-tr-bridge` 是一个独立实现的非官方社区插件。设计思路**借鉴了其他开源项目**；感谢并尊重下列原作者。

| Project / 项目 | Author / 作者 | Inspiration / 借鉴之处 |
| --- | --- | --- |
| [dsh-agent-conductor](https://github.com/MJorgin/dsh-agent-conductor) | MJorgin | Dispatching tasks from DeepSeek Harness to external agent CLIs such as Codex and Grok / 外部 CLI 代理派发思路 |
| [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | NanmiCoder | Captain-led multi-agent coordination and task delegation / 团队调度需求与交互场景 |
| [dsh-agent-arena](https://github.com/Tikzen/dsh-agent-arena) | Tikzen | Multi-agent chat and collaboration experience / 多 AI 群聊与协作场景 |
| [dsh-connect](https://github.com/Canary-Builds/dhs-connect) | Canary Builds | Codex app-server transport/event mapping and dynamic-tool flow adapted under MIT / Codex app-server 传输、事件映射与动态工具流程 |
| [DeepSeek Harness](https://github.com/deepseek-ai) | DeepSeek | Host plugin and tool/bundle ecosystem / 宿主插件接口及生态 |

## Relationship to upstream projects / 与参考项目的关系

- This repository is **not** an official product, official fork, endorsed integration, or continuation maintained by any of the projects named above.
- The one-shot bridge code in this repository was independently written for the `tr codex` and `tr grok` use case; it does **not directly copy source code** from the attributed projects.
- The 0.2.0 native Codex transport (`llm/codex-app-server.js`, `llm/codex-adapter.js`) **adapts** the MIT-licensed dsh-connect app-server transport/event mapping for `tr.exe`, TokenRouter login and the Harness 0.2.1-rc.5 `StreamChunk` contract. The required copyright and permission notice is reproduced in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
- It does **not** currently provide the group-chat UX or persistent multi-agent team orchestration found in other projects.
- The names of other products and projects are used solely for attribution and compatibility descriptions. Their trademarks and original source remain under their respective owners and licenses.

## License / 许可证

**All source files in this repository are public and offered under the [MIT License](./LICENSE).** You may use, inspect, modify and redistribute this project's code under that license. This does not relicense the separate upstream projects or any proprietary TokenRouter, Codex, Grok or DeepSeek service.

**本仓库源码完整公开，遵循 [MIT 许可证](./LICENSE)**；你可以依许可证使用、查看、修改及再分发本项目的代码。但这不意味着其他项目源码、第三方商业服务及商标的权利归本项目所有。
