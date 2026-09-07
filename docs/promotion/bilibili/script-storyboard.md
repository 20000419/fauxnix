# fauxnix B 站宣传视频 · 分镜脚本

> 交付三件套:本文件(分镜+制作规范)+ `narration.txt`(纯口播,TTS 直读)+ `subtitles.srt`(成片字幕,与口播逐条对应)。
> 事实源:`docs/promotion/bilibili/research-digest.md`;所有演示输出为本机 v0.10.0 `dist` 实跑抓取,非手编。
> 合规自检见文末第 4 节,逐条对照 digest 第 9 节"雷区与诚实条款"。

## 0. 基本信息

- 时长:**7 分 14 秒**(7–9 分钟目标内),20 场,104 条口播 cue
- 画幅:1920×1080,16:9;节奏:冷开场 28.5 秒立住矛盾,demo 段真录屏,数据段慢给足
- 目标观众:Windows 上用 Claude Code / Codex / Kimi / OpenCode / Qwen 的开发者
- 叙事弧:Mac 机队新闻(冷开场)→ PowerShell 降智税(T4 验尸主叙事 + 26/24/302s 数据锤)→ fauxnix 登场(translate don't emulate + 常驻 host)→ 现场 demo(6 连)→ 工程信誉(三闸+治理+安全)→ 诚实条款(贵的场景主动交代)→ 1.0 愿景 + 划界 + CTA

### 标题候选

1. 实测:PowerShell 让 AI 编程助手"降智"3 倍,我给它写了个 bash 翻译层
2. OpenAI 的 agent 在 Mac 机队里学 bash,而你坐在 Windows 前
3. 不装 WSL,让 Claude Code / Codex / Kimi 在 Windows 上丝滑写 bash

### 封面文案

- 大字:**PowerShell 降智税**(税字用错误红 #f48771)
- 副标:26 次调用 24 次报错 → 8 次调用 0 报错
- 角落:终端窗口小图(`$` 绿提示符)+ fauxnix 字样

## 1. 全局视觉规范

**色彩**(沿用 `docs/assets/demo.svg`):

- 终端窗口底 `#1e1e1e`,标题栏三灯 `#ff5f57 / #febc2e / #28c840`,标题居中
- 提示符绿 `#6a9955`、命令/输出浅灰 `#d4d4d4`、错误红 `#f48771`、标语蓝 `#569cd6`、注释灰 `#808080`
- 视频主背景 `#141414`;强调黄复用三灯里的 `#febc2e`

**字体(硬性要求,必须显式声明,防字形回退)**:

- 终端/代码:`Cascadia Code` → `JetBrains Mono` → `Consolas`,monospace 兜底
- 中文标题/花字:`Microsoft YaHei Bold`(兜底 `Microsoft YaHei`)
- 底部字幕:`Microsoft YaHei`,白字黑描边
- **禁止**不声明字体的默认渲染;**勿复用** `docs/assets/social-preview.png`(有字体回退缺陷,符号被渲染成"路"字)

**终端窗口组件**:圆角深色窗口 + 三灯 + 居中标题栏;绿色 `$` + 命令,输出在下;所有 demo 输出以实跑为准(录屏时若 `src/` 文件大小变化,`ls -la` 字节数以实况为准,口播不念具体字节数,无冲突)。

**字幕**:`subtitles.srt` 直接导入剪映/必剪(UTF-8 带 BOM,CRLF);每条 1.5–4 秒、≤2 行、每行 ≤22 字,时间码自 `00:00:00,000` 连续单调递增,总时长与本分镜表一致。

**TTS 建议**:中文科技区男声/女声均可,语速约 240–260 字/分钟,语气"冷静讲事",不要播音腔。若实际 TTS 偏慢,按同比例整体拉伸(场景间留有 0.7 秒缓冲可吃)。

## 2. 分镜表(20 场,总时长 7:13.7)

| 场景号 | 时长 | 画面(屏幕内容与视觉处理) | 口播(=cue 编号,全文见 narration.txt) | 屏幕字幕/花字 | BGM/音效建议 |
|---|---|---|---|---|---|
| S1 冷开场·无屏机队 | 0:00.0–0:28.5(28.5s) | 黑场渐入深蓝夜景。"新闻卡片"浮出(仿科技媒体排版,顶部常驻角标"据广泛报道 · 2026.08"),关键词打字机弹出:"数万台 Mac mini / Mac Studio""无屏幕""无键盘""强化学习训练 agent";切线框风格机架阵列插画,镜头缓推;Anthropic + AWS 字样淡入卡片角落。末三句切三联图标:macOS 机队 ↔ `bash` ↔ Windows 桌面,Windows 图标放大定格 | 据广泛报道,OpenAI 买了数万台 Mac。<br>Mac mini 和 Mac Studio,没屏幕,没键盘。<br>整批塞进机架,训练 computer-use agent。<br>Anthropic 也在通过 AWS 租 Mac mini。<br>听出别扭了吗:机队全是 macOS。<br>agent 嘴里说的,全是 bash。<br>可我们真正坐着的系统,是 Windows。 | 常驻角标:「据广泛报道」;逐词弹跳:"数万台""没屏幕,没键盘";结尾大字:"机队说 bash,你坐的是 Windows" | 低频氛围 drone + 慢脉冲;开场三灯"叮";结尾低音 hit 定格 |
| S2 方案排除 | 0:29.2–0:45.4(16.2s) | 三张方案卡片翻牌:Git Bash、WSL、"让 agent 直接写 PowerShell"。前两张被盖灰色印章"客居的 Unix":文件系统图标打叉、环境图标打叉、小字标注"评分环境仍是 Mac" | 训练在 Mac,评分在 Mac,落地却在 Windows。<br>你说装 Git Bash、开 WSL?<br>那等于让 Windows 客居一个 Unix。<br>错的文件系统、错的环境,评分那边还是 Mac。 | "训练在 Mac,评分在 Mac,落地在 Windows";"客居的 Unix = 错的文件系统 · 错的环境" | 翻牌 whoosh;盖章"咚"×2 |
| S3 降智税 | 0:46.1–0:58.3(12.2s) | 黑底大字"降智税"砸下("税"字 #f48771)。分屏动画:同一大脑图标,左侧 bash 路绿灯直通,右侧 PowerShell 路红灯连环爆 | 那让 agent 直接写 PowerShell 总行吧?<br>行,但要交税,圈子里叫它降智税。<br>同一个模型,写 bash 是学霸,写 PowerShell 就犯傻。 | 大字:"降智税";小字:"同一个模型,两种智商" | 大字落地低音 boom;右侧爆错短促"错误咚" |
| S4 T4 任务卡 | 0:59.0–1:11.1(12.2s) | 任务卡片特写:"T4:写文件前两行 → 数字节数"(标注:来自仓库 benchmark 实测任务)。下方终端样式打出 bash 解法两行:`head -2 src/words.txt > out.txt` / `wc -c out.txt` | 不信?看个真实案例,我们 benchmark 里的 T4。<br>任务很朴素:写文件的前两行,再数字节数。<br>bash 里就两条命令,head 接 wc,字节精确。 | "bash:两条命令,字节精确" | 转入悬疑 ticking(秒表声),铺垫验尸段 |
| S5 T4 验尸重演 | 1:11.8–1:44.4(32.6s) | 终端窗口重演 benchmark 过程(演示动画,数据为实测记录):`Get-Content \| Set-Content` 键入 → 字节数"26"跳出 → 再试变"24" → 数字抖动;`Format-Hex` 十六进制转储快速滚动,红色高亮 `FF FE`(BOM)与 `0D 0A`(CRLF);最终落到 `[System.IO.File]::WriteAllLines` 长命令。右上 HUD 实时递增:调用 ×9、报错 ×7、计时 114s。末帧切 bash 两行一遍过,亮绿灯 | PowerShell 模式下,模型选了另一条路。<br>它写的是 Get-Content 接 Set-Content,看着挺对。<br>但这俩默认写 UTF-16 加 CRLF。<br>字节数怎么都对不上,二十六、二十四,来回跳。<br>模型被逼急了,掏出 Format-Hex 给文件验尸。<br>最后落到 .NET,显式指定无 BOM 的 UTF8。<br>九次调用,七次报错,一百一十四秒。<br>bash 那边呢?两条命令,一遍过。 | "26?24?——字节数每次都不一样";"Format-Hex 验尸现场";HUD:"9 调用 · 7 报错 · 114s(实测,T4 单项)" | 字节错误"嗡";计数器咔哒;bash 通过"叮" |
| S6 金句·静场 | 1:45.1–1:53.2(8.1s) | 黑场,白字逐字打出;上方英文原文小字:"The failure mode is never 'wrong final answer'. It's the recovery that's expensive." | 注意,顶级模型最后都能答对。<br>失败模式从来不是答错,是恢复太贵。 | 大字:"不是答错,是恢复太贵" | 全部音效骤停,只留 drone,静场强调 |
| S7 数据锤 | 1:53.9–2:30.4(36.5s) | 常驻左上诚实角标:"单机实测 · n=1 · 方向性证据 · 原始数据见仓库 docs/"。对照表从中间展开:kimi-k2-thinking 行先出——PowerShell 列 26 调用/24 错/302s(红),fauxnix 列 8/0/96s(绿),"3.1×" 从中炸出放大;deepseek-v4-pro 行随后(15/14/174s vs 7/0/70s,2.5×);表底小字:"火山方舟 7 款模型经 fauxnix 全部 5/5 满分" | 先打预防针:这是单机单次的实测。<br>方向性证据,不是统计学证明。<br>但这个趋势,跨模型稳得吓人。<br>最惨的是 kimi-k2-thinking。<br>写 PowerShell:二十六次调用,二十四个错误,三百零二秒。<br>走 fauxnix:八次调用,零错误,九十六秒。<br>三点一倍差距,还附赠一场错误风暴。<br>对照 deepseek-v4-pro。<br>十五次调用十四错,对七次零错。 | 红:"26 调用 24 错 · 302s";绿:"8 调用 0 错 · 96s";特大:"3.1×";常驻角标:"单机实测 · n=1 · 方向性证据" | 每行落地"咚";3.1× 炸出重低音 |
| S8 fauxnix 登场 | 2:31.1–3:02.4(31.3s) | 名称打出:fauxnix(花字注解命名彩蛋:"faux = 假,nix = Unix:假 Unix,真 Windows")。架构流水线动画:bash 命令 → parser → AST → translator → PowerShell → powershell.exe,回流支路标注"GNU 风格输出 / bash 风错误"。四徽章依次盖戳:零 LLM 调用、零 VM、零 WSL、零 bash 工具链;末尾红字锤章:"Fail loud,翻译不了就大声报错" | 为了拆掉这个税,我们写了 fauxnix。<br>思路一句话:translate,don't emulate。<br>翻译,不模拟。<br>agent 继续写它被训练出来的 bash。<br>fauxnix 把每条命令确定性翻译成 PowerShell。<br>在 Windows 原生执行,再把输出伪装回 GNU。<br>全程零 LLM 调用,零 VM,零 WSL。<br>翻译不了的,大声报错,绝不静默出错。 | 标语蓝(#569cd6):"translate, don't emulate";"确定性翻译 · 零 LLM 调用";"Fail loud,never silently-wrong" | 节奏转正,轻快 synth 底;盖戳"啪"×4 |
| S9 常驻 host | 3:03.1–3:19.3(16.2s) | 对比示意:左侧"每次新建 powershell.exe",进程图标反复生灭(标 ~1.1s);右侧"常驻 host"一盏长明灯,JSON 行 + base64 帧在管道里流动。数字翻牌:1.1s → 0.03s,"约 37×" 放大 | 性能上还有个狠活,常驻 PowerShell host。<br>把 powershell.exe 变成一台 RPC 服务器。<br>首条工具调用,一点一秒压到零点零三秒。<br>暖命令几十毫秒,约三十七倍的预热提升。 | "把 powershell.exe 变成 RPC 服务器";"首条调用 1.1s → 0.03s(预热后实测)" | 进程生灭"啵啵"声;翻牌机械声 |
| S10 demo① GNU 输出 | 3:20.0–3:35.8(15.7s) | 真录屏(终端组件)。键入 `$ fauxnix "ls -la src \| head -2"`,输出实跑原文:`-rw-r--r-- 1 lzy00 lzy00 5799 Sep 2 15:15 ast.ts` / `-rw-r--r-- 1 lzy00 lzy00 4771 Sep 2 15:01 cli.ts`。镜头推近权限列 `-rw-r--r--`;角落小窗闪 winver 画面强调"纯 Windows" | 光说不练假把式,上机。<br>第一条,ls 长格式,管道给 head。<br>看这输出,权限列、时间列,GNU 那味儿。<br>可这是一台纯 Windows。 | "GNU 长格式,在 Windows 上" | 真实键入声;输出出现轻"叮" |
| S11 demo② 错误对比 | 3:36.5–4:00.9(24.4s) | 左右分屏。左(fauxnix 实跑):`$ fauxnix "cat nope.txt"` → `cat: nope.txt: No such file or directory`(退出码 1,绿框圈出)。右(同机 PowerShell 5.1 实跑截取,中文系统):`cat : 找不到路径"D:\github_project\fauxnix\nope.txt",因为该路径不存在。` + `CategoryInfo: ObjectNotFound…` 红屏截选,做"红屏震动"效果 | 第二条,cat 一个不存在的文件。<br>bash 风格英文报错,退出码一,干净。<br>同一台机,PowerShell 原生报错长这样。<br>中文系统直接中文红屏,模型先得过语言关。<br>fauxnix 把它归一化成标准英文。<br>连中文版系统的本地化报错都正则改写。 | "左:agent 看得懂;右:先过语言关";"本地化报错也改写成 bash 风格" | 右侧红屏"警报嗡";左侧"叮" |
| S12 demo③ 混用 | 4:01.6–4:13.7(12.2s) | 实跑:`$ fauxnix "X=$(ipconfig \| grep -c IPv4); [[ $X -gt 0 ]] && echo online"` → `online`。语法分段高亮:`$()` 命令替换(蓝)、`[[ ]]`(绿)、`ipconfig`(黄,标注"Windows 原生命令") | 第三条,Windows 原生命令混进 bash 语法。<br>ipconfig 数 IPv4,大于零就 echo online。<br>命令替换加双方括号判断,一把过。 | "Windows 原生命令 × bash 语法,混着写" | 键入声;"online" 出现"叮" |
| S13 demo④ GBK | 4:14.4–4:30.6(16.1s) | 实跑:先展示 `g.txt` 花字标注"GBK 编码老文件",再 `$ fauxnix "grep 连接 g.txt"` → `连接`。对照小窗:Git Bash 下同样命令 0 命中(画面标注"实测记录见仓库 docs/ 博客") | 第四条,中文用户专属,GBK 老文件。<br>grep 中文关键词,命中。<br>同一个文件,Git Bash 系零命中,全军覆没。<br>因为 fauxnix 逐文件嗅探编码,不看 locale 脸色。 | "逐文件编码嗅探,不看 locale 脸色";"Git Bash 系:0 命中(实测)" | 命中"叮";0 命中"空荡嗡" |
| S14 demo⑤ T4 复刻 | 4:31.3–4:43.4(12.2s) | 实跑:`$ fauxnix "printf 'alpha\nbeta\ngamma\ndelta\n' > words.txt; head -2 words.txt > out.txt; wc -c out.txt"` → `11 out.txt`。左上小窗闪回 S5 的 114s 验尸画面(Glitch 转场),大字定格"11 字节,一遍过" | 第五条,把 T4 的验尸现场复刻一遍。<br>printf 造文件,head 取两行,wc 数字节。<br>十一字节,一次到位,精确到字节。 | "刚才 114 秒的坑,现在一遍过" | 闪回 Glitch 音;通过"叮" |
| S15 demo⑥ translate | 4:44.1–4:56.3(12.2s) | 实跑:`$ fauxnix translate "find . -name '*.log' -mtime +7 -delete"` → 翻译产物(40+ 行 PowerShell)在终端滚动,定格高亮两行:`-clike '*.log'` 与 `TotalDays -ge 7` | 最后一条私心推荐,translate 子命令。<br>一条 bash 会被翻成什么样,直接给你看产物。<br>顺手还能学 PowerShell,隐藏福利。 | "bash 进,PowerShell 出——顺便学 PowerShell" | 滚动沙沙声;定格"咔" |
| S16 工程信誉·三闸 | 4:57.0–5:29.5(32.6s) | 三道闸门卡片依次立起:①差分对拍——同一语料喂 fauxnix 与真 Git Bash(bash.exe),stdout/stderr/exit code 三路字节级比对动画,语料计数 126;角标"每条可溯源到真实修过的 bug · 每周一 06:00 UTC CI · 无 Git Bash 自动 skip 永不红"。②测试数滚动:60 → 271(16 天)。③版本时间轴:v0.1.0(08-16)→ v0.10.0(09-02),17 个 tag 依次点亮 | 演示爽完,聊点严肃的,凭什么信?<br>第一道闸,拿真 GNU 当裁判。<br>每条语料同时喂 fauxnix 和真 Git Bash。<br>stdout、stderr、退出码,三路字节级对拍。<br>一百二十六条语料,条条溯源到修过的 bug。<br>每周一定时 CI,没 Git Bash 的机器自动跳过。<br>第二道闸,测试数,十六天从六十涨到二百七十一。<br>第三道闸,节奏,十七天发了十七个版本。 | "拿真 GNU 当裁判";"126 条语料 · 字节级对拍";"60 → 271 项测试";"17 天 17 个版本" | 转沉稳;闸门立起"铿"×3 |
| S17 治理+安全 | 5:30.2–5:54.6(24.4s) | 文档截图风卡片:CONTRIBUTING 金句英文原文 + 中文对照:"Individually reviewed PRs do not imply their combination is reviewed.";SECURITY.md 节选:"This is not a security product.";小字补充:"孙进程可能杀不掉——也白纸黑字写在文档里" | 治理上有句话我很喜欢,写在贡献指南里。<br>单个 PR 审过,不等于组合起来审过。<br>落到 main 的每一棵树,必须自带证据。<br>安全文档更耿直,这不是安全产品。<br>把 agent 接上 fauxnix,就是给它 Bash 工具的信任。<br>连孙进程可能杀不掉,都白纸黑字写进文档。 | "单个 PR 审过 ≠ 组合审过";"This is not a security product." | 纸张翻阅声;BGM 压低 |
| S18 诚实条款·主动交代 | 5:55.3–6:19.4(24.0s) | 黑底自曝卡片:"在 Codex / Kimi 上,fauxnix 反而贵 19%–34%"(数字用强调黄 #febc2e,不用红绿);原因一行:"这些模型本来就擅长打包 one-shot";换来三项收益图标:干净错误 / cd 持久化 / POSIX 路径 | 还有件事,必须主动交代。<br>但在 Codex 和 Kimi 上,fauxnix 反而更贵。<br>贵百分之十九到三十四。<br>因为这些模型,本来就擅长打包一把梭。<br>多花的钱,换来干净错误和会话持久化。<br>我们觉得值,但你必须知情。 | 大字:"主动交代:这里我们更贵 19%–34%";"值不值,你知情后自己定" | 音乐收小,近乎独白;无音效,靠留白 |
| S19 1.0 愿景 | 6:20.1–6:48.6(28.5s) | 愿景逐字打出(中文大字 + 英文原句小字):"Mac 机队训练出来的 agent,扔到 Windows 日用 fauxnix,察觉不到它不是 bash";下方 1.0 门槛清单逐项打勾:200 条差分语料 · ≥95% 字节一致 · 连续两周绿 · 五 harness quickstart · 第二轮外部审计 · npm 14 天浸泡零 P1/P2 | 最后画个饼,1.0 长什么样。<br>一句话,Mac 机队训练出来的 agent。<br>扔到 Windows 日用 fauxnix,察觉不到它不是 bash。<br>而且任何维护者,光凭仓库就能验证这句话。<br>门槛全公开,两百条差分语料。<br>百分之九十五字节一致,连续两周绿。<br>外加第二轮外部审计,npm 十四天浸泡零事故。 | "1.0 的定义,可以验证";"光凭仓库,就能验证" | BGM 渐起 uplift;打勾"嗒"×6 |
| S20 划界+CTA | 6:49.3–7:13.7(24.4s) | 先划界卡(灰底白字,克制):"它是精选子集,不是完整 bash——需要真 bash 工具链,请用 WSL"。转亮,安装命令大字终端:`$ npm install -g fauxnix-cli`、`$ fauxnix install --claude`(小字:--codex / --opencode / --kimi / --qwen)。GitHub 卡片:github.com/20000419/fauxnix,MIT 徽章 + Glama 全 A 徽章。结尾三联:关注/点赞/投币 +"欢迎来锤" | 也划个界,它是精选子集,不是完整 bash。<br>需要真 bash 工具链,请用 WSL,这是官方口径。<br>需要 agent 在 Windows 上不犯傻,试试 fauxnix。<br>npm 一行装好,五个主流 harness 都有抄作业配置。<br>GitHub 搜 fauxnix,MIT 协议,欢迎来锤。<br>觉得有用就点个赞,我们下期见。 | 大字命令:`npm install -g fauxnix-cli`;"github.com/20000419/fauxnix";"需要真 bash 工具链,请用 WSL" | 收尾明亮;最后一次回车键声定格,画面渐黑 |

## 3. 发布物料

**视频简介**(发布时粘贴):

> 让 AI agent 在 Windows 上原生写 bash:不装 WSL、不装 Git Bash,fauxnix 把 bash 确定性翻译成 PowerShell 5.1 执行,输出和报错都是 GNU/Linux 的样子。实测(单机 n=1,方向性证据,原始数据在仓库 docs/):kimi-k2-thinking 写 PowerShell 26 次调用 24 次报错 302 秒,走 fauxnix 8 次调用 0 报错 96 秒。
> GitHub:https://github.com/20000419/fauxnix
> 安装:npm install -g fauxnix-cli
> 说明:它是精选子集,不是完整 bash;需要真 bash 工具链的场景请用 WSL。Mac 机队新闻为广泛报道转述,无一一手源。

**标签**:fauxnix、AI agent、bash、PowerShell、Windows、Claude Code、Codex、Kimi、MCP、开源、编程

**置顶评论**(数据出处 + 防杠):

> 数据出处:docs/benchmark-deepseek-v4-pro.md 与 docs/benchmark-ark-models.md(单机 n=1,方向性实测)。已知边界:在 Codex / Kimi 上 fauxnix 反而贵 19–34%(模型本来就擅长打包 one-shot),换来干净错误与 cd 持久化;需要完整 bash 请用 WSL。和 WSL 不是竞争关系:WSL 给你真 Linux,fauxnix 让 Windows 本身对 agent 友好。

## 4. 合规自检(对照 research-digest 第 9 节)

| 条款 | 落点 | 状态 |
|---|---|---|
| ① benchmark 必须带"实测/方向性"限定,禁"统计学证明" | 口播 cue 28–29 + S7 常驻角标 + 简介 | ✓ |
| ② Mac 机队新闻必须带"据广泛报道" | 口播 cue 1 首句 + S1 常驻角标 + 简介 | ✓ |
| ③ 不虚构 star / 下载量 | 全片只用可验证事实:17 天 17 版、271 测试、126 语料、Glama 全 A 徽章(2026-08-18 上架记录) | ✓ |
| ④ 旧博客的过时能力清单不得复述(相关语法现已支持) | 全片未复述;划界只说"精选子集,不是完整 bash" | ✓ |
| ⑤ Codex/Kimi 上贵 19–34% 主动讲 | S18 整场 + 置顶评论 | ✓ |
| ⑥ "需要真 bash 工具链请用 WSL"结尾划界 | 口播 cue 100 + S20 划界卡 + 简介 | ✓ |
| ⑦ 不改 src/test/dist、不跑 npm test/build | 演示输出全部用 `node dist/index.js "..."` 实跑(v0.10.0) | ✓ |
| ⑧ 勿用 social-preview.png;smoke 命令里的拼写笔误不得照抄 | 全片未使用该 PNG;物料中无该错拼词 | ✓ |
| ⑨ 视觉字体显式声明(Microsoft YaHei 兜底) | 第 1 节字体规范 | ✓ |

## 5. 配套文件说明

- `narration.txt`:104 行纯口播,一行一条 cue,无任何标注/序号,TTS 直接朗读;标点已统一为全角,数字已写成中文读法(如"一百一十四秒""三点一倍"),避免 TTS 读错。
- `subtitles.srt`:与 `narration.txt` 逐行一一对应(104 条 cue,条数严格相等);UTF-8 带 BOM、CRLF 行尾;时间码自 `00:00:00,000` 起连续单调递增;每条 1.5–4 秒、≤2 行、每行 ≤22 字;总时长 7:13.7,与第 2 节分镜表逐场对齐(场间 0.7 秒呼吸口)。
