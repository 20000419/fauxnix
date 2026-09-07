# fauxnix 研究摘要(视频/推广物料生产的统一事实源)

> 本文由 4 个研究 agent 对仓库全面调研后汇总(2026-09-02)。所有对外文案必须遵守文末"雷区与诚实条款"。
> 项目:fauxnix(npm: `fauxnix-cli`,GitHub: `20000419/fauxnix`,MIT,当前 v0.10.0)
> 一句话:bash→PowerShell 确定性翻译层,让 AI agent 在 Windows 上原生跑 Linux 风格命令——无 VM、无 WSL、无 bash 工具链。

## 1. 缘起故事(视频开场钩子)

来源 `docs/rfc-computer-use-windows.md:8-18`:
- 据广泛报道(*The Information* 2026-08-30,多方转述):**OpenAI 购入数万台 Mac mini / Mac Studio——没屏幕、没键盘**——用于强化学习训练 computer-use agent(点击、编辑、测试、跑多步 shell 工作流);**Anthropic 通过 AWS 租 Mac mini** 做同类工作。
- 核心矛盾句(原文):"That fleet is macOS. The language those agents emit is bash. Windows is still the OS most people actually sit in front of."(那支机队全是 macOS,agent 说的全是 bash,但 Windows 才是大多数人真正坐着的系统。)
- "装 Git Bash / 用 WSL"等于让 Windows 变成"客居的 Unix":错的文件系统、错的环境、评分环境还是 Mac。
- 项目定位(原文 L20-22):"translate, don't emulate. The agent keeps the bash it was trained on. PowerShell 5.1 runs a faithful subset. Anything else fails loud."
- **诚实边界(引用时必须带)**:RFC L47-49 声明无 *The Information* 一手源,系广泛报道转述。

## 2. Benchmark 硬数字

### 2.1 主实验(DeepSeek-V4-Pro,同一模型同一 5 任务,三种执行模式,`docs/benchmark-deepseek-v4-pro.md`)

| | PowerShell 直写 | **fauxnix** | Git Bash(真 bash 上限) |
|---|---|---|---|
| 工具调用 / 意外错误(T1–T4) | 14 / 9 | **7 / 0** | 4 / 0 |
| 耗时(T1–T4) | 163s | **66s** | 57s |

- 结论原文(L47-52):"PowerShell mode: 2.5× slower, 2× the tool calls, 9 unexpected error events";fauxnix "lands within ~15% of the real-Git-Bash ceiling while requiring no bash toolchain"。
- **T4 验尸故事(最好的微叙事,L32-37)**:任务=写文件前两行再数字节。PowerShell 的 `Get-Content | Set-Content` 默认写 UTF-16/CRLF,字节数反复不对(26、24…),模型烧 9 次调用、7 次报错、114 秒,用 `Format-Hex` 验尸,最后落到 `[System.IO.File]::WriteAllLines` 显式 UTF8-no-BOM。bash 里就是 `head -2 src/words.txt > out.txt; wc -c out.txt`——两条命令,字节精确。
- 中文语境加成(L40-43):zh-CN 机器上 PowerShell 报错是中文的("找不到路径…"),对英文错误语料训练的模型是额外摩擦;fauxnix 归一化成标准英文 `cat: src/config.yaml: No such file or directory`。
- 英文博客金句:"The failure mode is never 'wrong final answer' — strong models recover. It's the recovery that's expensive."(失败模式从来不是答错,是"恢复"太贵。)

### 2.2 火山方舟 7 模型(`docs/benchmark-ark-models.md`)

7 模型经 fauxnix 全部 5/5 满分:deepseek-v4-pro(7 调用/70s,最佳)、deepseek-v4-flash(13/116s)、kimi-k2-thinking(11/105s)、glm-5-2(16/162s)、doubao-seed-2-0-code(7/171s)、doubao-seed-2-1-turbo(~5/111s)、kimi-k2-250905(~7/102s)。

PowerShell 退化对照(P2,最狠的一张表):

| 模型 | PowerShell:调用/错误/耗时 | fauxnix:调用/错误/耗时 |
|---|---|---|
| deepseek-v4-pro | 15 / 14 / 174s | 7 / 0 / 70s(2.5×) |
| **kimi-k2-thinking** | **26 / 24 / 302s**(T4 单项 18 调用 15 错误 199s) | 8 / 0 / 96s(**3.1×**) |
| glm-5-2 | 10 / 4 / 171s | 11 / 0 / 112s(快 35%) |

原文(L39-41):kimi-k2-thinking 是"the worst PowerShell degradation measured so far — 3.1× slower with an error storm"。

### 2.3 Harness 附录(诚实加分项)

- Claude Code + fauxnix:打平甚至略快(142.7s vs 163.9s),价值在语义层不在速度。
- **Codex / Kimi 上 fauxnix 反而贵 19%–34%**(模型本来就擅长打包 one-shot)——但换来干净错误、cd 持久化、POSIX 路径。主动讲这段是可信度加分。
- **Codex 出厂陷阱**(`docs/comparison-built-in-shells.md:20-24`):Codex 在 Windows 上内置 shell 就是 PowerShell 5.1,"陷阱是出厂配置"。
- 能力对照表亮点:看全 Windows 进程表 fauxnix 485 个 vs Git Bash 系仅 18–24 个(MSYS 盲区);GBK 文件里 `grep 连接`:Git Bash 系全部 0 命中,fauxnix 1 命中(逐文件编码嗅探)。
- "fauxnix is the only option combining bash syntax + persistent session + real Windows semantics + per-file encoding sniffing + POSIX path normalization — with zero toolchain beyond Node."

## 3. 工程亮点(适合"炫技"段落)

1. **常驻 PowerShell host = 把 powershell.exe 变成 RPC 服务器**(`src/ps-host.ts`):每会话一个常驻进程,stdin/stdout 走 UTF-8 JSON 行 + base64 帧(防 PS 5.1 UTF-16LE 管道编码污染),预热后首条工具调用 **~1.1s → ~0.03s(约 37 倍)**,暖命令 0.01–0.04s(CHANGELOG v0.6.0)。
2. **错误整容流水线**(`src/errors.ts:21-106`):剥离 CategoryInfo 红屏噪音、解包 CLIXML、连中文版 Windows 的本地化报错("无法将…项识别为")都正则改写成 bash 风格。
3. **SSRF 护栏**(`src/commands/net.ts:9-54`):curl/wget 在进程启动前拒绝 localhost/127.x/10.x/192.168.x/169.254.x(云元数据)/172.16–31.x——"给 agent 的 shell 装刹车"。
4. **bash 级语义较真**:fd 快照(`2>&1 >/dev/null` 的顺序语义)、`rm out.txt > out.txt` 自删文件、超时=exit 124、取消=exit 130、逐字节回退的 UTF-8 安全截断(防半个码点引发 GBK 乱码误判)。
5. **手写 Win32 CRT 命令行引号**(`fx-winargv`):空参数、内嵌引号不被 PS 5.1 splatting 吃掉;`.cmd/.bat` 走 `cmd /d /s /c`。
6. 规模:~102 个注册命令;37 个命令有逐选项 CommandSpec(未知选项响亮报 GNU 风格 usage 错);74 个 unspec'd 命令有诚实清单(`docs/command-specs.md`)。shell 语法:管道、`&&/||/;`、8 种重定向、`$()`、反引号、`$(())`、if/for/while/until/case、数组、`set --` 位置参数、`~` 展开、POSIX 路径归一化(`/tmp`、`/d/foo`)。

## 4. 工程信誉(可信度段落)

- **测试**:v0.10.0 官方口径 **271 项测试**(`CHANGELOG.md:24`);16 天从 60 → 271,4.5 倍。
- **差异化对拍(differential oracle)**:每条语料同时喂 fauxnix 和**真 Git Bash 的 bash.exe**,stdout/stderr/exit code 三路**字节级**一致 ≥95% 才放行;语料现有 126 条,每条可溯源到真实修过的 bug;每周一 06:00 UTC 定时 CI;没有 Git Bash 的机器自动 skip 永不红。1.0 硬门槛:≥200 条语料 + ≥95% 字节一致 + 连续两周绿。
- **版本节奏**:17 天 17 个 tag(v0.1.0 2026-08-16 → v0.10.0 2026-09-02),约每天一个版本。
- **治理金句**(`CONTRIBUTING.md:6-7`):"Individually reviewed PRs do not imply their combination is reviewed."(单个 PR 审过 ≠ 组合审过,落到 main 的树必须自带证据)——冲突解决必须走 integration PR;曾违反一次后立规。新语法/协议必须先写 RFC(docs/rfc-*.md 有 7+ 份)。
- **安全人设**(`SECURITY.md:3-8`):"Pointing an agent at `fauxnix mcp` is the same trust decision as giving that agent a Bash tool: it runs as you, on this machine, with no sandbox.""This is not a security product." 连"孙进程可能杀不掉"都写进文档。
- **发布工程**:v0.7.1 出过"打包缺可执行文件"事故 → 有了 `scripts/package-smoke.mjs`(CI 模拟干净安装 + npm pack tarball 验证)。
- **第三方背书**:Glama MCP registry 全 A 上架(bash 工具 4.6/5.0,2026-08-18);外部审计者 @vulragrag-star;Codex bot review 抓过两个 P1。
- 已知翻车自曝:benchmark 中几个模型 T4 答 13 而非 11,是 fauxnix 自己的 CRLF 重定向 bug(已修),"models faithfully reported the bytes they saw"。

## 5. 路线图(结尾画饼)

- 1.0 定义句(`rfc-1.0-completeness-usability.md:24-26`):"A Mac-fleet-trained agent dropped onto Windows daily-drives fauxnix without noticing it isn't bash — and any maintainer can verify that claim from the repo alone."
- 1.0.0 门槛:200 条差分语料 95% 字节一致、agent 日常 60 命令全覆盖、五 harness quickstart、ARM64+双语 locale CI、性能预算守卫(warm p50 <50ms)、第二轮外部审计、npm 14 天浸泡期零 P1/P2。
- 节奏:v0.10 语言完备 → v0.11 可用性 → v0.12 制度/平台矩阵 → rc → audit → soak → 1.0。
- 五条原则:确定性翻译不模拟 / Fail loud never silently-wrong / Windows 原生无 WSL 无 VM / Measured claims only 无遥测 / 只加 agent 真实会写的语法。
- Non-goals:不做 POSIX 认证、不上 Linux/macOS、不捆绑 bash runtime、永不上遥测。

## 6. 视觉语言(沿用 demo.svg,`docs/assets/demo.svg`)

- 深色圆角窗口 `#1e1e1e`,顶部红黄绿三灯 `#ff5f57/#febc2e/#28c840`,标题栏居中。
- 提示符绿 `#6a9955`,命令浅灰 `#d4d4d4`,错误红 `#f48771`,标语蓝 `#569cd6`,注释灰 `#808080`。
- 版式:绿色 `$` + 命令,下方输出;底部蓝色标语 "no VM · no WSL · no bash toolchain — npm install -g fauxnix-cli"。
- 等宽字体栈:`Cascadia Code, JetBrains Mono, Consolas, monospace`;中文用 `Microsoft YaHei` 兜底。
- **注意**:`docs/assets/social-preview.png` 有字体回退缺陷(两处符号被渲染成"路"字),不要直接复用该 PNG。

## 7. 已有推广物料(可复用)

- 中文博客终稿 `docs/promotion/blog-benchmark-zh.md`(V2EX/掘金用),"降智税"概念出处,四段结构:数据问题 → 确定性翻译 → 三道质量闸 → 诚实的边界。
- 英文 Show HN 稿 `docs/promotion/blog-benchmark-en.md`。
- 渠道清单 `docs/promotion/targets.md`(纪律:只在真正解决问题的楼下评论,评论必带 "not for everyone" 条款;**B 站是空白渠道**)。
- 5 份 harness quickstart(`docs/examples/`),10 条 smoke 命令(注意其中 `FELLBACK` 是仓库原文拼写笔误,物料里应写 `FALLBACK`)。

## 8. 演示命令参考(真实输出可运行 `node dist/index.js "..."` 获取;仓库正处 merge 中间态,src 不能 build,用现成 dist)

- `ls -la src | head -2` → GNU 长格式输出(违和感即看点)
- `cat nope.txt` → `cat: nope.txt: No such file or directory`(exit 1;对比 PowerShell 红屏 CategoryInfo/中文本地化报错,可运行 `powershell -NoProfile -Command "cat nope.txt"` 抓真实对比)
- `X=$(ipconfig | grep -c IPv4); [[ $X -gt 0 ]] && echo "online"` → online(Windows 原生命令与 bash 语法混用)
- `grep -rn TODO src | wc -l` → 数字
- GBK 演示:用 python 造 GBK 文件(`open('g.txt','w',encoding='gbk')` 写"连接"),`grep 连接 g.txt` 命中;Git Bash 下 0 命中(博客 L47)
- `fauxnix translate "find . -name '*.log' -mtime +7 -delete"` → 展示翻译产物(学 PowerShell 彩蛋)

## 9. 雷区与诚实条款(所有文案必须遵守)

1. Benchmark 全部是**单机、每格 n=1**,原文自我定性 "directional evidence, not statistics"——文案说"实测/方向性证据",禁止"统计学证明/显著提升"。
2. Mac 机队新闻必须带"据广泛报道/据报道",无一一手源。
3. 不要虚构 GitHub star 数、npm 下载量;只用徽章和"17 天 17 版"等可验证事实。
4. **时效**:旧博客说"不支持 while/until/case"已过时——当前分支已合并(v0.11 方向),文案不要再说"不支持 case/while"。
5. Codex/Kimi harness 上 fauxnix 贵 19–34% 要主动讲,防杠。
6. "需要真 bash 工具链请用 WSL"是官方口径,结尾划界反而加分。
7. 仓库当前处于 merge 中间态(9 个 UU 冲突文件),物料生产 agent **不得修改 src/test/dist,不得跑 npm test/build**。
8. `social-preview.png` 有字体缺陷勿直接用;smoke 命令里的 `FELLBACK` 拼写照抄会被弹幕抓。

## 10. 关键链接

- GitHub: https://github.com/20000419/fauxnix
- npm: https://www.npmjs.com/package/fauxnix-cli
- Glama MCP: https://glama.ai/mcp/servers/20000419/fauxnix
- 安装: `npm install -g fauxnix-cli`,接入: `fauxnix install --claude`(或 --codex/--opencode/--kimi/--qwen)
