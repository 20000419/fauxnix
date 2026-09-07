# fauxnix B 站视频 · 实拍录制手册

> 本手册回答一个问题：**录制当天，作者坐在机器前，按什么顺序、敲什么、说什么、翻车了怎么办。**
> 配套提词器：`demo-commands.sh`(同目录，逐条复制照敲，不要整体执行)。
> 事实源：`research-digest.md`（同目录）；口播涉及数字与引文前，先过一遍文末「诚实条款速查」。
> 分镜号：本手册自定 **S1–S8** 作为演示锚点；若主文案脚本另有编号，以本手册的对照关系合并即可。
> 全部演示命令已于 2026-09-02 用 `node dist/index.js`(dist 构建 v0.11.0）在 zh-CN Windows 实跑验证，预期输出摘自真实回显。

---

## 0. 开录前检查单（每次开录前过一遍，约 3 分钟）

- [ ] 勿扰已开（设置 → 系统 → 通知 → 勿扰）；微信 / QQ / 钉钉 / Teams / Outlook / Steam 全部退出
- [ ] Windows 更新已暂停（设置 → Windows Update → 暂停 1 周），防录制中弹重启提示
- [ ] 电源：接通电源，屏幕超时设为「从不」（设置 → 系统 → 电源），防录到一半息屏
- [ ] Windows Terminal 已切到专用 `fauxnix-demo` profile（见第 2 节）,20pt，纯色不透明
- [ ] PSReadLine 历史已清空（防上翻泄隐私）:
  `Remove-Item (Get-PSReadLineOption).HistorySavePath -ErrorAction SilentlyContinue`
- [ ] 输入法默认英文（Win + Space 切到「英语（美国）」);S4 中文段落的切换时机已演练
- [ ] 演示目录已备好：`C:\fauxnix-demo\`，其中 `g.txt` 是**当场重新生成**的 GBK 文件（命令见 demo-commands.sh S4 段）
- [ ] 当前 shell 在仓库根 `D:\github_project\fauxnix`(S1/S2/S3/S7 都依赖这个 cwd)
- [ ] `demo-commands.sh` 里每条命令已完整预跑一遍，输出与注释里的预期一致
- [ ] OBS 试录 30 秒并回放：字体在手机上看也清楚、无爆音、无掉帧（OBS 底部状态栏无红色告警）
- [ ] 鼠标指针已移到屏幕角落；副屏摆好本手册 + demo-commands.sh

---

## 1. 录制设备与软件（OBS Studio)

### 1.1 画布与帧率

- 设置 → 视频：基础（画布）分辨率 **1920×1080**，输出（缩放）分辨率 **1920×1080**，帧率 **60**（整数帧率）。
- 终端录制的清晰度命门是「1:1 像素」：不要录 4K 再缩到 1080p，字体会糊。画布直接 1080p，终端窗口按第 2.2 节的尺寸摆进画布。

### 1.2 录制参数（质量优先，母版宁高勿低）

- 设置 → 输出 → 录制：
  - 格式 **mkv**(OBS 崩溃可保命；录完用 OBS 自带「文件 → 录像转封装」转 mp4)
  - 编码器：有 N 卡用 **NVENC H.264**，没有则 **x264**(preset `veryfast`)
  - 码率控制：**CQP 18 / CRF 18** 左右（质量优先）；若只能用 CBR，给 **20000 kbps**
  - 关键帧间隔 2s；音频 **AAC 320 kbps / 48 kHz**
- B 站二压参考线：1080p60 约 6000 kbps。后期导出 H.264 High@L4.2、8–12 Mbps 即可，母版留高码率是为了剪辑和放大裁切有余量。

### 1.3 采集源

- 首选「**窗口采集**」：来源选 `WindowsTerminal.exe`，捕获方式「Windows 图形捕获（Windows 10 1903+)」，勾选「客户端区域」。好处：只录终端，弹窗不会入镜。
- 备选「显示器采集」：录 B-roll 网页、或多个窗口对比（fauxnix 终端 vs Git Bash 窗口）时用。**此模式下任何弹窗都会进成片，勿扰和退出 IM 是硬前提。**
- 可选加分项：input-overlay 类按键显示插件，让观众看到 `Ctrl+C`、回车等真实击键——教学向视频的信任感来源。

### 1.4 音频

- 麦克风单独占一条音轨：设置 → 输出 → 录制勾选音轨 1+2；高级音频属性里把麦克风只分到轨 2，桌面音频只分到轨 1。后期可单独修人声。
- 麦克风滤镜链：噪声抑制（RNNoise)→ 噪声门限 → 压缩器；峰值控制在 -12 dB 左右。
- 机械键盘声别全灭：留一点是「真实终端实拍」的质感证据，观众分得出演播室配音和现场实敲。

### 1.5 真人出镜（画中画）

- 摄像头源 320×180 放右下角，与终端窗口留 16px 间距，不遮挡终端输出区（终端输出从左上加，右下角最安全）。
- 演示段落以终端为主画面；口播数据/观点段落可切全屏人像，避免「全程小窗念稿」。
- 戴眼镜注意屏幕反光：终端亮度别拉满，摄像头侧前方补一盏柔光。

### 1.6 试录

- 每个录制日正式开工前：30 秒试录 → 用**手机**回放。电脑显示器上「看着还行」的字号，在手机上经常不及格——B 站观众大头在移动端。

---

## 2. Windows Terminal 调教

### 2.1 专用 profile(settings.json 片段）

在 Windows Terminal 的 `settings.json` 里新增一个专用 profile，录制全程只用它：

```jsonc
{
  "profiles": {
    "list": [
      {
        "name": "fauxnix-demo",
        "commandline": "powershell.exe -NoProfile -NoLogo",
        "startingDirectory": "D:\\github_project\\fauxnix",
        "font": { "face": "Cascadia Code", "size": 20 },
        "colorScheme": "One Half Dark",
        "opacity": 100,
        "useAcrylic": false,
        "scrollbarState": "hidden",
        "padding": "16",
        "historySize": 9001
      }
    ]
  },
  "initialCols": 120,
  "initialRows": 28
}
```

要点说明：

- `-NoProfile -NoLogo`：防个人 `$PROFILE` 里的欢迎语、自定义提示符、代理变量入镜。
- 配色二选一并**全片贯穿**:`Campbell`（默认近黑底，「原生 Windows」气质，和红屏对比段气质统一）或 `One Half Dark`（更现代，深色视频封面更协调）。不要中途换。
- **关透明、关 acrylic**(`opacity: 100`):acrylic 会把桌面杂光揉进终端，成片显脏，还可能在压缩后出噪块。
- `scrollbarState: hidden`：隐藏滚动条，画面干净。
- 标签页：录制时只留一个 tab，或干脆全屏（`Alt+Enter`）隐藏标签栏。

### 2.2 字号与窗口尺寸（1080p 安全区）

- 字号 **20pt 起步**（视觉规范下限）。1080p 画布下：Cascadia Code 20pt、120 列 × 28 行 ≈ 1760×900 px，居中后四周留边，正好。
- 想更大只能后期放大裁切（所以母版码率要高）；不要在录制时拉 24pt 撑满屏，长命令折行会更难看。
- 窗口尺寸设好后**全程不要再拖动**；OBS 窗口采集会自动跟随。

### 2.3 字体必须显式声明（防字形回退）

- `font.face` 必须**显式写** `"Cascadia Code"`，不要留空吃系统默认——物料规范硬规则（`social-preview.png` 曾因字体回退把符号渲染成「路」字，同类事故不许在视频里重演）。
- S4 段落含中文（`grep -n 连接 g.txt`)，开录前在终端里先敲一句 `echo 连接测试` 实测：若出现方框/豆腐块，把该 profile 的 `face` 临时改为 `"Microsoft YaHei"`（中文兜底字体）重录该段；等宽感略降，但字形完整。
- 终端内**不要用 emoji** 做装饰，配色方案间渲染不一致。

### 2.4 提示符与历史卫生

- 默认 `PS D:\github_project\fauxnix>` 提示符保留——真实路径是实拍可信度的加分项，不遮。
- 每条正式开录前先 `clear`，上屏无残留。
- 历史已按第 0 节清空；录制中**不要按 ↑ 翻历史**（翻出来的东西不可控）。

---

## 3. 录制流程表（S1–S8)

录制顺序按「少切目录」优化：S1–S3、S7 在仓库根；S4 在 `C:\fauxnix-demo`;S5、S6、S8 目录无关。剪辑时按成片叙事自由重排，分镜号是锚点不是顺序约束。

口播提词只给一句话骨架，完整口播稿以文案物料为准；**所有数字说出口之前对照第 6 节诚实条款**。

---

### S1 · 冷开场：Windows 上长出 GNU 输出

- **画面**：仓库根目录，终端干净。敲命令，回车，GNU 长格式输出。
- **操作**:`fauxnix "ls -la src | head -2"`
- **预期输出**（实跑验证 2026-09-02，用户名/大小/日期以实拍为准）:

  ```
  -rw-r--r-- 1 lzy00 lzy00          4338 Sep  2 15:33 ast.ts
  -rw-r--r-- 1 lzy00 lzy00          4479 Sep  2 15:33 cli.ts
  ```

- **口播提词**:「这是 Windows，没有 WSL、没有 Git Bash——但 `ls -la` 给你的是 GNU 长格式。」
- **设计意图**：违和感即看点。第一秒就让懂行的观众坐直：这台机器上没有 bash。
- **翻车预案（核心命令 1/5)**:
  1. 输出内容随仓库演进变化是正常的——口播只讲「GNU 长格式」这个点，不念具体文件名，就不怕对不上。
  2. 若输出为空或报错，九成是 cwd 不在仓库根：`pwd` 确认后重敲。
  3. 觉得两行信息量太薄，现场升级 `fauxnix "ls -la src | head -8"`，pipeline 越长越有说服力。
  4. 每条命令录两条取优；敲错不要停，`Ctrl+C` 清行重敲，后期剪。

---

### S2 · 痛点对比：一行报错 vs 一屏红

- **画面 A(fauxnix)**：终端敲 `fauxnix "cat nope.txt"`，得到一行 bash 风格报错。
- **画面 B(B-roll 对比，单独录，见第 4 节 B6)**:PowerShell 标签页里敲 `cat nope.txt`，一整屏红色 CategoryInfo。
- **操作**:`fauxnix "cat nope.txt"`
- **预期输出**(exit code 1):

  ```
  cat: nope.txt: No such file or directory
  ```

- **口播提词**:「同一个错误，PowerShell 给你一屏红，fauxnix 给你一行——而且是模型在训练语料里见过一万次的那一行。」
- **设计意图**：错误整容流水线的可视化。中文版 Windows 的本地化报错（「找不到路径…」）对英文错误语料训练的模型是额外摩擦，这里把对比直接怼到观众脸上。
- **翻车预案（核心命令 2/5)**:
  1. 录前确认 `nope.txt` 真的不存在（手滑建过就全段作废）:`ls nope.txt` 应先报不存在。
  2. fauxnix 的 stderr 行**末尾无换行**，提示符会粘在同行——不是 bug 也不是录错，重敲前 `echo` 一下或 `clear`。
  3. 不要现场加 `; echo exit=$?` 秀 exit code——实测 stdout/stderr 分流后 `exit=1` 会排在报错行上方，观感混乱（已实跑验证）。
  4. 红屏对比**必须提前单独录好 B-roll**，不要现场切标签页——现场切屏是翻车和穿帮的高发区。

---

### S3 · 混用魔法：Windows 原生命令 × bash 语法

- **画面**：终端敲一条「混血」命令：bash 的 `$()` 和 `[[ ]]` 包着 Windows 原生的 `ipconfig`。
- **操作**:`fauxnix 'X=$(ipconfig | grep -c IPv4); [[ $X -gt 0 ]] && echo "online"'`
  （整条用**单引号**包，防 PowerShell 提前展开 `$X`；照抄 demo-commands.sh 即可。)
- **预期输出**(exit code 0):

  ```
  online
  ```

- **口播提词**:「`ipconfig` 是 Windows 原生的，`$( )` 和 `[[ ]]` 是 bash 的——它们在同一条命令里工作。」
- **设计意图**：一句话讲清「翻译不是模拟」：原生命令直接跑，bash 语法由 fauxnix 接住。顺带回答弹幕必问「那我自己的 exe 呢」——未知命令原样透传。
- **翻车预案（核心命令 3/5)**:
  1. 已在 zh-CN 机器实测：中文版 `ipconfig` 输出里仍含 ASCII 字面量 `IPv4`,`grep -c` 照常命中；中文标签乱码也不影响结果。
  2. 若录制机断网/网卡全禁用导致 `X=0`：什么都不打印，现场气氛尴尬。**录前必预跑**；真遇上就反向演示——「现在是 0，所以 `&&` 短路，什么都不打印，这正是 `[[ ]]` 的语义」，然后补一条 `fauxnix 'X=3; [[ $X -gt 0 ]] && echo "online"'` 把语法本体演完。
  3. 整条命令较长，手敲易错：允许从提词器粘贴（这条的看点是输出不是敲字）。

---

### S4 · 编码彩蛋：GBK 文件里 grep 中文

- **画面**：切到 `C:\fauxnix-demo`，现场生成 GBK 文件 → fauxnix grep 命中 2 行 →（剪辑插入 B-roll B7)Git Bash 同命令 0 命中。
- **操作**（完整序列见 demo-commands.sh S4 段，核心一条）:`fauxnix "grep -n 连接 g.txt"`
- **预期输出**(exit code 0):

  ```
  1:第一行：连接测试
  2:second line 连接 again
  ```

- **对比组**(Git Bash 窗口，B-roll):`grep -c 连接 g.txt` → 输出 `0`,exit 1。
- **口播提词**:「这个文件是 GBK 编码的。Git Bash 里 `grep` 一个汉字都匹配不到，fauxnix 逐文件嗅探编码，命中两行。」
- **设计意图**：中文用户的切肤痛点，且是可当场验证的硬对比（已在本机实测复现：fauxnix 2 行命中 / Git Bash 0 命中）。
- **翻车预案（核心命令 4/5)**:
  1. **最大风险：`g.txt` 被编辑器「顺手」另存为 UTF-8**——那 Git Bash 对比组也能命中，对比当场翻车。对策：录制当天用命令重新生成（demo-commands.sh 里有 Python 和 PowerShell 两条等价生成命令），生成后不要再用记事本/VS Code 打开保存它。
  2. 中文 pattern 需要输入法：提前演练「英文键盘 → Win+Space → 敲『连接』 → 回车」的节奏；或者这段允许粘贴（中文手敲拼音在镜头前观感差）。
  3. 终端里中文变方框 = 字体回退事故：停录，按第 2.3 节把 face 改 `Microsoft YaHei` 重录本段。
  4. Git Bash 对比窗口提前开好、摆好位置，用显示器采集一次录完两个窗口，避免现场调度。

---

### S5 · 安全护栏：给 agent 的 shell 装刹车

- **画面**：终端敲一条访问云元数据地址的 curl，被当场拒绝。
- **操作**:`fauxnix "curl http://169.254.169.254/"`
- **预期输出**(exit code 1):

  ```
  curl: fauxnix refused private/loopback address 169.254.169.254
  ```

- **口播提词**:「169.254.169.254 是云厂商的元数据地址。fauxnix 的 curl 在进程启动之前就拒绝它——这是给 agent 的 shell 装的刹车。」
- **设计意图**：安全人设的 10 秒实证。这个地址是全片最稳的一条命令：**它在触网前就被拒绝，离线可录，永不超时**——「网络命令超时怎么办」的答案就是选一条根本不会触网的网络命令。
- **备注**：若导演坚持要一条真实外网 curl（如 `curl -sI https://example.com`）做对照，录前预跑确认网络；真超时也别浪费——`Ctrl+C` 取消的 exit 130、timeout 的 exit 124 都是 POSIX 语义演示点（「连超时都是 bash 的 124」)，把翻车剪成内容。

---

### S6 · 原理揭秘：translate 给你看翻译产物

- **画面**：终端敲 translate，40+ 行 PowerShell 刷满屏，慢速滚屏，口播在滚屏上展开。
- **操作**:`fauxnix translate "find . -name '*.log' -mtime +7 -delete"`
- **预期输出**：一段自包含 PowerShell（约 40 行），可见 `fx-find-delete` 函数、深度计算、`-clike '*.log'`、`TotalDays -ge 7` 等编译产物；开头几行是编码强制（`chcp 65001` / UTF-8)。
- **口播提词**:「它不是在模拟 bash——每一条命令都被确定性地编译成一段 PowerShell。零 LLM 调用，你可以 `translate` 看到每一个字。」
- **设计意图**：把「translate, don't emulate」从口号变成观众亲眼所见；顺带是「学 PowerShell 的彩蛋」。
- **翻车预案（核心命令 5/5)**:
  1. **输出太长一屏放不下**（约 40 行，20pt 下必超屏）：不要 `| head` 截断（截断像藏东西）。正确做法：全量输出后慢速滚屏拍摄，后期按需加速；或本段临时降到 16pt 录、后期放大。
  2. 口播纪律：这是**翻译演示不是执行演示**，别把 `-delete` 说成「它正在删除文件」——弹幕会抓。
  3. 想要更短的翻译产物做补充镜头：`fauxnix translate "cat nope.txt"`（与 S2 呼应），但它也有约 90 行样板，别指望更短——40 行的 find 已是优选。

---

### S7 · 管道日常：grep 一条龙（穿插段）

- **画面**：仓库根，一条管道出数字。
- **操作**:`fauxnix "grep -rn TODO docs | wc -l"`
- **预期输出**：一个数字（2026-09-02 验证值为 `3`，随仓库演进漂移属正常；口播不念具体数字，念「管道该什么样就什么样」)。
- **口播提词**:「`grep -rn` 接 `wc -l`，递归、行号、计数——你在 Linux 上怎么写，这里就怎么写。」
- **设计意图**：节奏调节段，插在数据段落前后，10 秒；证明日常管道零妥协。
- **备注**:digest 原参考命令是 `grep -rn TODO src | wc -l`，当前实测 src 为 `0`（镜头效果差），故改用 docs。若录制当天想换回 src，先预跑看数字是否非零。

---

### S8 · 收尾：自检全绿

- **画面**：终端敲 `fauxnix check`，四行全绿 OK；再敲 `fauxnix --version` 定格。
- **操作**:`fauxnix check` → `fauxnix --version`
- **预期输出**（以实拍为准；本次验证）:

  ```
  powershell : powershell.exe (Windows built-in)
  version    : 5.1.26100.9223
  commands   : 109 translated, others pass through
  status     : OK
  ```

- **口播提词**:「装完一条 `fauxnix check` 自检。`npm install -g fauxnix-cli`，命令就叫 fauxnix。」
- **设计意图**：收尾给出安装动作和「它在你机器上长什么样」的确定感；version 定格帧同时是片尾信息卡的底图。
- **备注**：口播若提版本号，以屏幕实拍的 `--version` 为准（本手册验证用 dist 构建显示 0.11.0,npm 全局安装版以安装时为准）——不口播具体版本号最稳。

---

## 4. B-roll 清单（单独截取的画面）

通用规范：浏览器开 **InPrivate/无痕窗口**（防个人账号头像、书签、历史泄露）；隐藏书签栏（Ctrl+Shift+B)；页面缩放 **125–150%** 让表格文字在手机上可读；每页慢速滚动录 10–15 秒；显示器采集模式录制。**本地仓库正处 merge 中间态，所有文档类 B-roll 一律拍 GitHub 网页版（已发布状态），不拍本地文件。**

| # | 画面 | 地址/来源 | 用途（对应分镜） | 注意事项 |
|---|---|---|---|---|
| B1 | Glama 评分页（全 A,bash 工具 4.6/5.0) | https://glama.ai/mcp/servers/20000419/fauxnix | 第三方背书段 | 评分页会更新，以实拍为准；口播带时间状语「上架时」 |
| B2 | GitHub 仓库首页（README + 徽章区） | https://github.com/20000419/fauxnix | 片头/收尾 | **不口播 star 数/下载数**（诚实条款），镜头可以扫过徽章但不定格读数 |
| B3 | GitHub tags 页 | https://github.com/20000419/fauxnix/tags | 「17 天 17 版」节奏段 | 以页面实拍为准，口播口径「几乎每天一个版本」(2026-08-16 → 09-02) |
| B4 | npm 包页 | https://www.npmjs.com/package/fauxnix-cli | 安装引导（S8) | 画面停留在一行：`npm install -g fauxnix-cli`；提醒弹幕包名是 fauxnix-**cli** |
| B5 | benchmark 主表 + T4 验尸段 | https://github.com/20000419/fauxnix/blob/main/docs/benchmark-deepseek-v4-pro.md | 数据段 | 定格三模式对比表（14/9/163s vs 7/0/66s vs 4/0/57s);T4 段（字节数 26、24…反复不对）单独一镜 |
| B6 | **PowerShell 红屏对比** | WT PowerShell 标签页敲 `cat nope.txt` | S2 对比 | 与 S2 同字号同配色录；中文版 Windows 会出中文 CategoryInfo 红字，正是要的效果；**此画面是红屏，不是故障，不用修** |
| B7 | Git Bash GBK 0 命中对比 | Git Bash 窗口 `grep -c 连接 g.txt` → `0` | S4 对比 | Git Bash 默认主题与 WT 不同，视觉对比天然成立；两个窗口同框或硬切均可 |
| B8 | ark 7 模型退化表 | https://github.com/20000419/fauxnix/blob/main/docs/benchmark-ark-models.md | 数据段高潮 | 高亮 kimi-k2-thinking 行（26 调用 / 24 错误 / 302s → 8/0/96s);**口播必须带「单机实测、方向性证据」** |
| B9 | CHANGELOG v0.10.0 段（271 测试） | https://github.com/20000419/fauxnix/blob/main/CHANGELOG.md | 工程信誉段 | 定格「271 tests」行；配合口播「16 天从 60 到 271」 |
| B10 | RFC 缘起段（Mac 机队引文） | https://github.com/20000419/fauxnix/blob/main/docs/rfc-computer-use-windows.md | 开场钩子 | 口播**必须带「据广泛报道」**;无一一手源是写在 RFC 里的 |
| B11 | demo.svg 底图 | `docs/assets/demo.svg`（浏览器打开） | 片头/转场 | ⚠️ `docs/assets/social-preview.png` 有字体回退缺陷（符号被渲染成「路」字）,**严禁入镜**;svg 无此问题 |

---

## 5. 常见翻车清单（系统级规避）

| 翻车 | 后果 | 规避方法 |
|---|---|---|
| 字号太小 | 手机端观众看不清，弹幕刷「盲人视频」 | 20pt 起步；试录片段用**手机**回放验收（第 1.6 节） |
| 终端反光/透明 | 画面脏、压缩后出噪块 | `opacity: 100` + 关 acrylic；出镜时屏幕亮度别拉满，侧前方补光 |
| 中文输入法弹窗 | 候选框遮挡命令行，穿帮 | 默认英文键盘（Win+Space);S4 中文段提前演练切换时机或粘贴；必要时 设置 → 时间和语言 → 输入，关闭「在桌面显示输入法工具栏」 |
| 通知打扰 | 微信/邮件弹窗进成片，重录 | 勿扰模式；IM/邮件客户端**退出**不是最小化；Windows Update 暂停；浏览器通知关掉 |
| 历史上翻泄露 | 旧命令里的路径/token 入镜 | 录前清 PSReadLine 历史（第 0 节）；录制中不按 ↑ |
| 浏览器账号泄露 | 头像/书签/内部系统入镜 | B-roll 全程无痕窗口；隐藏书签栏；必要时新建浏览器 profile |
| 手滑敲错 | 长命令拼错，输出报错 | 别停录，`Ctrl+C` 重敲，后期剪；长命令（S3）允许从提词器粘贴 |
| 输出与预期不符 | 口播和画面对不上 | 每条命令录前预跑一遍（第 0 节）；预期输出漂移（文件变动/版本更新）以实拍为准，口播稿不锁死具体数字 |
| 鼠标指针乱入 | 指针挡输出 | 开录后指针移到屏幕角落；或用 OBS 窗口采集（不录指针） |
| 爆音/喷麦 | 人声轨报废 | 峰值 -12 dB;RNNoise + 压缩器；麦克风侧放不正对嘴 |
| 锁屏/息屏 | 录制中断 | 电源接通 + 屏幕超时「从不」 |
| 全屏游戏模式弹窗 | Xbox Game Bar 提示入镜 | 设置 → 游戏 → 关闭 Game Bar 提示 |

---

## 6. 诚实条款速查（口播红线，摘自 research-digest 第 9 节）

1. Benchmark 全部是**单机、每格 n=1**，官方自我定性「方向性证据，不是统计」：口播说「单机实测」，**禁止**「统计学证明」「显著提升」。
2. Mac 机队新闻**必须带**「据广泛报道/据报道」；项目无一一手源，这一点 RFC 里自己写明了。
3. **不虚构、不口播** GitHub star 数、npm 下载量；只用可验证事实（「17 天 17 版」「271 项测试」「Glama 全 A」)。
4. **不要再说**「不支持 while/until/case」——已合并支持，旧博客口径过时。
5. 讲性能时必须带平衡句：「在 Codex / Kimi 这类擅长打包命令的 harness 上，fauxnix 反而贵 19%–34%——换来的是干净错误、会话保持和 POSIX 路径。」主动讲是防杠加分。
6. 划界句是加分项不是软肋：「需要真 bash 工具链的场景，请用 WSL。」
7. 物料纪律：`social-preview.png` 勿用；示例命令里的 `FELLBACK` 是仓库原始拼写笔误，物料里写 `FALLBACK`。
