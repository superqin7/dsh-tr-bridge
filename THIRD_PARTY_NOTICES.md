# Third-party notices / 第三方代码声明

`dsh-tr-bridge` 0.4.0 的 Codex app-server 传输与事件映射，参考并改编自 **dsh-connect**（作者 Canary Builds，MIT License）的 `src/transport.js`、`src/adapter.js` 及安全启动参数思路。改编部分位于本仓库的 `llm/codex-app-server.js`、`llm/codex-adapter.js`；它们已按 `tr.exe` 启动方式、TokenRouter 登录和 Harness 0.2.1-rc.5 的 `StreamChunk` 契约重写。Grok ACP 传输、目录和适配器为独立实现。

The Codex app-server transport and event mapping in this repository adapt ideas and code structure from **dsh-connect** by Canary Builds, licensed under MIT.

Upstream: https://github.com/Canary-Builds/dhs-connect

## dsh-connect license / 许可证

```text
MIT License

Copyright (c) 2026 Canary Builds

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
