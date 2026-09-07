# fauxnix · 开发者计划申请一页纸 / Developer Program One-Pager

<!-- 用法:按申请表语言粘贴下方对应一半;表格为 Markdown,纯文本表单可只取单元格。所有数字可在本仓库核验:CHANGELOG.md、docs/benchmark-deepseek-v4-pro.md、docs/benchmark-ark-models.md、CONTRIBUTING.md、SECURITY.md、docs/rfc-1.0-completeness-usability.md。「作者」行为占位符,提交前替换。 -->

---

## 中文

**项目**:fauxnix(npm 包 `fauxnix-cli`,MIT,v0.10.0;Windows + PowerShell 5.1+ + Node ≥18)
**定位**:bash→PowerShell 确定性翻译层——agent 写 bash,Windows 原生执行,无 VM、无 WSL、无 bash 工具链。

**问题**
据广泛报道(*The Information*,2026-08),OpenAI/Anthropic 以数万无头 Mac 机队训练 computer-use agent:评分环境是 macOS,agent 说 bash,而大多数人坐在 Windows 前。模型直写 PowerShell 要交"降智税":同模型同任务慢 2.5×、调用翻倍、意外错误 9 起——不是答错,是恢复太贵。

**方案:三原则**

- 翻译而非模拟:bash→AST→PowerShell 确定性编译,零 LLM 调用;
- 响亮失败:翻不了即报错附替代,绝不悄悄给错;
- Windows 原生:真进程表、逐文件 UTF-8/GBK 嗅探。

约 105 个命令,管道/重定向/`$()`/if/for/while/case,GNU 风格输出与退出码。

**实测**
单机 n=1,方向性证据而非统计结论;方法与数据:`docs/benchmark-deepseek-v4-pro.md`、`docs/benchmark-ark-models.md`。

| 同模型同 5 任务(DeepSeek-V4-Pro,T1–T4 合计) | PowerShell 直写 | **fauxnix** | Git Bash(上限) |
|---|---|---|---|
| 工具调用 / 意外错误 | 14 / 9 | **7 / 0** | 4 / 0 |
| 耗时 | 163s | **66s** | 57s |

| 模型 | PowerShell:调用/错误/耗时 | fauxnix:调用/错误/耗时 |
|---|---|---|
| kimi-k2-thinking | 26 / 24 / 302s | 8 / 0 / 96s(**3.1×**) |
| deepseek-v4-pro | 15 / 14 / 174s | 7 / 0 / 70s(**2.5×**) |

7 模型经 fauxnix 全部 5/5,距真 bash 上限 ~15%。诚实对照:Claude Code/Codex/Kimi 等自带 Git Bash 的 harness 上,fauxnix 反而贵 19–34%,换干净错误与 cd 持久化。

**工程纪律**
271 项测试(v0.10.0;16 天前 60 项)· 126 条语料对拍真 Git Bash,字节级 ≥95% 一致才放行、每周 CI · 17 天 17 个 tag(v0.1.0→v0.10.0)· RFC 先行(7+ 份)· 冲突必走 integration PR——"单个 PR 审过 ≠ 组合审过"(CONTRIBUTING.md)。

**安全与边界**
`fauxnix mcp` = 授予 agent 一个 Bash 工具:以你身份、无沙箱运行,"this is not a security product"(SECURITY.md);curl/wget 默认拒回环/内网(SSRF 护栏)。需真 bash,请用 WSL。

**路线图**
v0.11 可用性 → v0.12 平台矩阵 → rc → 外部审计 → npm 浸泡 14 天零 P1/P2 → 1.0。门槛:≥200 条对拍语料 95% 字节一致连两周绿、日常 60 命令全覆盖;永不遥测。

**链接**

- GitHub:https://github.com/20000419/fauxnix
- npm:https://www.npmjs.com/package/fauxnix-cli
- Glama MCP(全 A 上架):https://glama.ai/mcp/servers/20000419/fauxnix

**作者**:[姓名] · [邮箱] · [GitHub ID](占位)

---

## English

**Project**: fauxnix — npm package `fauxnix-cli`, MIT, v0.10.0; Windows + PowerShell 5.1+ + Node ≥18.
**One-liner**: a deterministic bash→PowerShell translation layer: agents keep writing bash, Windows executes natively — no VM, no WSL, no bash toolchain.

**Problem**
Widely reported (*The Information*, 2026): OpenAI bought and Anthropic rents (via AWS) tens of thousands of headless Macs to train computer-use agents. Scoring is macOS, agents emit bash, and Windows is the OS most people sit in front of. Models writing raw PowerShell pay a tax: same model, same tasks — 2.5× slower, 2× the tool calls, 9 unexpected error events. The failure mode is never a wrong answer; the recovery is what's expensive.

**Approach: three rules**

- Translate, don't emulate: bash → AST → PowerShell, deterministic, zero LLM calls at runtime;
- Fail loud: untranslatable constructs error out with an alternative — never silently wrong;
- Windows-native: real process table, per-file UTF-8/GBK sniffing.

~105 commands plus full shell syntax (pipes, redirects, `$()`, if/for/while/case), GNU-style output and exit codes.

**Measured**
Single machine, n=1 per cell — directional evidence, not statistics (`docs/benchmark-deepseek-v4-pro.md`, `docs/benchmark-ark-models.md`).

| DeepSeek-V4-Pro, T1–T4 totals | raw PowerShell | **fauxnix** | Git Bash (ceiling) |
|---|---|---|---|
| tool calls / unexpected errors | 14 / 9 | **7 / 0** | 4 / 0 |
| wall time | 163s | **66s** | 57s |

| model | PowerShell: calls/errors/time | fauxnix: calls/errors/time |
|---|---|---|
| kimi-k2-thinking | 26 / 24 / 302s | 8 / 0 / 96s (**3.1×**) |
| deepseek-v4-pro | 15 / 14 / 174s | 7 / 0 / 70s (**2.5×**) |

All 7 models scored 5/5, within ~15% of the real-bash ceiling. Honest counterpoint: on harnesses already shipping Git Bash (Claude Code/Codex/Kimi), fauxnix costs 19–34% more, buying clean errors and cd persistence.

**Engineering discipline**
271 tests (v0.10.0; 60 sixteen days earlier) · 126-case differential corpus vs real Git Bash — ≥95% byte-identical stdout/stderr/exit, weekly CI · 17 tags in 17 days (v0.1.0→v0.10.0) · RFC-first for new syntax (7+ in repo) · conflicts resolved only via integration PR — "individually reviewed PRs do not imply their combination is reviewed."

**Security & boundaries**
`fauxnix mcp` = handing the agent a Bash tool: runs as you, no sandbox — "this is not a security product" (SECURITY.md); curl/wget refuse loopback/private addresses (SSRF guard). Need real bash? Use WSL.

**Roadmap**
v0.11 usability → v0.12 platform matrix → rc → second external audit → 14-day npm soak → 1.0. Gates: ≥200 differential cases at ≥95% byte-identity, green two consecutive weeks; agent-daily-60 commands covered. Telemetry: never.

**Links**

- GitHub: https://github.com/20000419/fauxnix
- npm: https://www.npmjs.com/package/fauxnix-cli
- Glama MCP (all-A listing): https://glama.ai/mcp/servers/20000419/fauxnix

**Author**: [name] · [email] · [GitHub ID] (placeholder)
