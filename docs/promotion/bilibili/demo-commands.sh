#!/usr/bin/env bash
# ============================================================================
# fauxnix B 站视频 · 演示命令提词器(2026-09-02 验证版)
#
# ★ 本文件是提词器,不是脚本:请逐条复制到终端照敲,不要整体 bash 执行。
#
# 验证口径:以下每条命令均于 2026-09-02 在 zh-CN Windows 上用
#   node D:/github_project/fauxnix/dist/index.js "..."   (dist 构建 v0.11.0)
# 实跑验证,注释中的「预期输出」摘自真实回显。
#
# 录制现场:镜头里的 shell 是 Windows Terminal 里的 PowerShell(手册第 2 节);
# 若已 `npm install -g fauxnix-cli`,直接敲 fauxnix(效果相同,镜头上也是用户视角);
# 预期输出中的用户名/日期/计数随环境漂移,以实拍为准。
# 引号纪律:命令含 $ 的一律用【单引号】包(S3),防 PowerShell 提前展开变量。
#
# 分镜号 S1–S8 与《live-demo-runbook.md》第 3 节一一对应;翻车预案查手册。
# ============================================================================


# ──────────────────────────────────────────────────────────────────────────
# S0 · 准备(不开录)
# ──────────────────────────────────────────────────────────────────────────

# 0.1 演示主目录:仓库根(S1/S2/S3/S7 依赖这个 cwd;提示符里的真实路径是
#     实拍可信度的加分项,不遮)
cd D:\github_project\fauxnix

# 0.2 清屏,上屏无残留
clear

# 0.3 GBK 演示目录(S4 用;镜头外提前建好,生成命令见 S4 段)
#     PowerShell:  New-Item -ItemType Directory -Force C:\fauxnix-demo


# ──────────────────────────────────────────────────────────────────────────
# S1 · 冷开场:Windows 上长出 GNU 输出
# 设计意图:违和感即看点——没有 WSL、没有 Git Bash,`ls -la` 却是 GNU 长格式。
# 口播:「这是 Windows,没有 WSL、没有 Git Bash——但 ls -la 给你的是 GNU 长格式。」
# ──────────────────────────────────────────────────────────────────────────
fauxnix "ls -la src | head -2"
# 预期输出(用户名/大小/日期以实拍为准):
#   -rw-r--r-- 1 lzy00 lzy00          4338 Sep  2 15:33 ast.ts
#   -rw-r--r-- 1 lzy00 lzy00          4479 Sep  2 15:33 cli.ts
# 翻车速查:输出为空 = cwd 不对,先 pwd;嫌信息量薄就升级 head -8。


# ──────────────────────────────────────────────────────────────────────────
# S2 · 痛点对比:一行报错 vs 一屏红
# 设计意图:错误整容流水线的可视化;对比组(PowerShell 红屏)单独录 B-roll。
# 口播:「同一个错误,PowerShell 给你一屏红,fauxnix 给你一行——而且是模型
#        在训练语料里见过一万次的那一行。」
# ──────────────────────────────────────────────────────────────────────────
fauxnix "cat nope.txt"
# 预期输出(stderr,exit 1;注意行尾无换行,提示符会粘在同行,属正常):
#   cat: nope.txt: No such file or directory
# 录前必查:ls nope.txt 应先报不存在——手滑建过这个文件,全段作废。
# 注意:不要现场加 `; echo exit=$?` 秀 exit code——实测 stdout/stderr 分流后
#   exit=1 会排在报错行上方,观感混乱(2026-09-02 实跑验证)。

# S2 对比组(B-roll B6,在普通 PowerShell 标签页敲,不走 fauxnix):
#   cat nope.txt
# 预期:一整屏红色 CategoryInfo 报错(中文版 Windows 为中文红字,正是要的效果)。


# ──────────────────────────────────────────────────────────────────────────
# S3 · 混用魔法:Windows 原生命令 × bash 语法
# 设计意图:一句话讲清「翻译不是模拟」——原生命令直接跑,bash 语法 fauxnix 接住。
# 口播:「ipconfig 是 Windows 原生的,$( ) 和 [[ ]] 是 bash 的——它们在同一条
#        命令里工作。」
# ──────────────────────────────────────────────────────────────────────────
fauxnix 'X=$(ipconfig | grep -c IPv4); [[ $X -gt 0 ]] && echo "online"'
# 预期输出(exit 0):
#   online
# 已实测:中文版 ipconfig 输出仍含 ASCII 字面量 IPv4,grep -c 照常命中。
# 翻车速查:断网导致 X=0 时什么都不打印——反向讲「&& 短路」语义,再补:
fauxnix 'X=3; [[ $X -gt 0 ]] && echo "online"'
# 预期输出:
#   online


# ──────────────────────────────────────────────────────────────────────────
# S4 · 编码彩蛋:GBK 文件里 grep 中文(全片最硬的当场可验证对比)
# 设计意图:中文用户切肤痛点——Git Bash 0 命中,fauxnix 逐文件嗅探编码命中 2 行。
# 口播:「这个文件是 GBK 编码的。Git Bash 里 grep 一个汉字都匹配不到,
#        fauxnix 逐文件嗅探编码,命中两行。」
# ──────────────────────────────────────────────────────────────────────────

# 4.1 现场生成 GBK 文件(录制当天重新生成;生成后不要再用编辑器打开保存它,
#     被另存为 UTF-8 对比就翻车了)。二选一(两条均已实跑验证,产物等效):
# (a) Python(在 PowerShell 里敲;\n 会原样传给 Python 再解释成换行):
python -c "open(r'C:\fauxnix-demo\g.txt','w',encoding='gbk').write('第一行:连接测试\nsecond line 连接 again\n第三行无关\n')"
# (b) 纯 PowerShell(无 Python 的机器):
#   [IO.File]::WriteAllText('C:\fauxnix-demo\g.txt', "第一行:连接测试`nsecond line 连接 again`n第三行无关`n", [Text.Encoding]::GetEncoding(936))

# 4.2 切到演示目录
cd C:\fauxnix-demo

# 4.3 正题:fauxnix 命中 2 行
fauxnix "grep -n 连接 g.txt"
# 预期输出(exit 0):
#   1:第一行:连接测试
#   2:second line 连接 again
# 注意:中文 pattern 需切输入法(Win+Space),或允许粘贴——中文手敲拼音不上镜。
#      若中文显示为方框=字体回退事故,停录,把 WT 字体 face 改 Microsoft YaHei 重录。

# 4.4 对比组(B-roll B7,在 Git Bash 窗口敲):
#   grep -c 连接 g.txt
# 预期输出(exit 1):
#   0
# (已实测复现:同一文件,Git Bash 系 0 命中——它只匹配自己 locale 假定的编码。)


# ──────────────────────────────────────────────────────────────────────────
# S5 · 安全护栏:给 agent 的 shell 装刹车(全片最稳的一条,离线可录)
# 设计意图:169.254.169.254 是云元数据地址;curl 在进程启动前就被拒绝,
#          永不触网——「网络命令超时怎么办」的答案就是选一条不会触网的命令。
# 口播:「fauxnix 的 curl 在进程启动之前就拒绝它——这是给 agent 的 shell 装的刹车。」
# ──────────────────────────────────────────────────────────────────────────
fauxnix "curl http://169.254.169.254/"
# 预期输出(exit 1):
#   curl: fauxnix refused private/loopback address 169.254.169.254
# 加演(可选,需网络):fauxnix "curl -sI https://example.com"
#   真超时别浪费:Ctrl+C 取消 exit 130、timeout 命令 exit 124,都是 POSIX 语义演示点。


# ──────────────────────────────────────────────────────────────────────────
# S6 · 原理揭秘:translate 给你看翻译产物(与 S1 首尾呼应)
# 设计意图:把「translate, don't emulate」从口号变成亲眼所见;零 LLM 调用。
# 口播:「每一条命令都被确定性地编译成一段 PowerShell。零 LLM 调用,
#        你可以 translate 看到每一个字。」
# ──────────────────────────────────────────────────────────────────────────
fauxnix translate "find . -name '*.log' -mtime +7 -delete"
# 预期输出:约 40 行自包含 PowerShell,可见:
#   - 开头编码强制:[Console]::OutputEncoding / chcp 65001
#   - function fx-find-delete { ... Remove-Item ... }
#   - 谓词编译:$fx_i.Name -clike '*.log'、(Get-Date) - $fx_i.LastWriteTime).TotalDays -ge 7
#   - 结尾 exit $script:fx_exit
# 翻车速查:一屏放不下属正常——不要 | head 截断(像藏东西),全量输出后
#   慢速滚屏拍摄,后期加速。口播纪律:这是翻译演示,别说成「正在删除文件」。
# 补充镜头(与 S2 呼应):fauxnix translate "cat nope.txt"(约 90 行,更长)。


# ──────────────────────────────────────────────────────────────────────────
# S7 · 管道日常:grep 一条龙(节奏调节段,10 秒)
# 设计意图:日常管道零妥协——递归、行号、计数,在 Linux 上怎么写这里就怎么写。
# 口播:「grep -rn 接 wc -l,你在 Linux 上怎么写,这里就怎么写。」
# ──────────────────────────────────────────────────────────────────────────
cd D:\github_project\fauxnix       # 回到仓库根
fauxnix "grep -rn TODO docs | wc -l"
# 预期输出(exit 0):一个数字(2026-09-02 验证值为 3;随仓库演进漂移,口播不念数字)
# 备注:digest 原参考命令 grep -rn TODO src | wc -l 当前实测为 0(镜头效果差),
#   故改用 docs;想换回 src 请先预跑确认非零。


# ──────────────────────────────────────────────────────────────────────────
# S8 · 收尾:自检全绿 + 版本定格
# 设计意图:给出安装动作和「它在你机器上长什么样」的确定感;version 定格帧
#          同时是片尾信息卡底图。
# 口播:「装完一条 fauxnix check 自检。npm install -g fauxnix-cli,命令就叫 fauxnix。」
# ──────────────────────────────────────────────────────────────────────────
fauxnix check
# 预期输出(以实拍为准;本次验证):
#   powershell : powershell.exe (Windows built-in)
#   version    : 5.1.26100.9223
#   commands   : 109 translated, others pass through
#   status     : OK
fauxnix --version
# 预期输出: fauxnix 0.11.0(dist 构建;npm 全局安装版以安装时为准,口播不锁版本号)

# ──────────────────────────────────────────────────────────────────────────
# 片尾信息卡口播(不敲命令,画面定格):
#   npm install -g fauxnix-cli     ← 包名是 fauxnix-cli,命令是 fauxnix
#   fauxnix install --claude       ← 接入 agent(--codex/--opencode/--kimi/--qwen)
#   GitHub: 20000419/fauxnix
# 诚实红线(brief):benchmark 是单机 n=1 方向性证据,口播说「单机实测」;
#   Mac 机队新闻必须带「据广泛报道」;不口播 star/下载量;不说「不支持 while/case」;
#   讲性能带平衡句「Codex/Kimi 上贵 19–34%」;划界句「要真 bash 请用 WSL」。
# ──────────────────────────────────────────────────────────────────────────
