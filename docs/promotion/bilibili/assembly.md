# fauxnix B 站宣传视频 · 合成管线文档(assembly)

> 目标:让作者可以复跑整条管线,或只替换真人配音后重合成。
> 成片:`video/fauxnix-bilibili-draft.mp4`(软字幕轨)+ `video/fauxnix-bilibili-draft-hardsub.mp4`(硬字幕烧录版)。
> 中间产物:`scratch/video-build/`(ffprobe 可复现)。
> 规格:1920×1080 / 30fps / H.264(yuv420p, CRF 20)+ AAC 48kHz;总时长 ≈ 7:13.7(433.7s),与 `subtitles.srt` 逐场对齐。

## 1. 素材与对应关系

20 场分镜(`script-storyboard.md`)→ 25 个视频分段:

| 分段 | 来源 | 时长(s) | 对应分镜 |
|---|---|---|---|
| seg01a | cover.png pad 到 1920×1080 | 2.0 | S1 开场(封面帧,避免黑场) |
| seg01b | cards_png/s01_news.png | 27.2 | S1 冷开场·Mac 机队新闻(常驻「据广泛报道」角标) |
| seg02 | cards_png/s02_eliminate.png | 16.9 | S2 方案排除 |
| seg03 | cards_png/s03_tax.png | 12.9 | S3 降智税 |
| seg04 | cards_png/s04_t4task.png | 12.8 | S4 T4 任务卡 |
| seg05a | cards_png/s05a_autopsy.png | 22.0 | S5 T4 验尸重演(HUD 9 调用/7 报错/114s) |
| seg05b | cards_png/s05b_bashwin.png | 11.3 | S5 末段 bash 一遍过 |
| seg06 | cards_png/s06_quote.png | 8.8 | S6 金句静场 |
| seg07 | rec/dp4_bench.webm(demo-player 场景 4 录屏,speed=0.75) | 37.2 | S7 数据锤(benchmark 数据卡动画) |
| seg08a | rec/dp1_title.webm(demo-player 场景 1 录屏) | 7.0 | S8 fauxnix 登场(logo 动画) |
| seg08b | cards_png/s08b_arch.png | 25.0 | S8 架构流水线 + 四徽章 + Fail loud |
| seg09 | cards_png/s09_host.png | 16.9 | S9 常驻 host(1.1s → 0.03s,约 37×) |
| seg10 | rec/dp5_ls.webm(demo-player 场景 5 录屏) | 16.5 | S10 demo① GNU 长格式 |
| seg11a | rec/dp2_pserr.webm(demo-player 场景 2 录屏) | 13.0 | S11 demo② PowerShell 红屏 |
| seg11b | rec/dp3_fxcat.webm(demo-player 场景 3 录屏) | 12.1 | S11 demo② fauxnix 干净报错 |
| seg12 | rec/dp7_mix.webm(demo-player 场景 7 录屏) | 12.8 | S12 demo③ ipconfig 混用 |
| seg13 | rec/dp8_gbk.webm(demo-player 场景 8 录屏) | 16.9 | S13 demo④ GBK |
| seg14 | cards_png/s14_t4redo.png | 12.8 | S14 demo⑤ T4 复刻 |
| seg15 | cards_png/s15_translate.png | 12.9 | S15 demo⑥ translate(实跑输出截取) |
| seg16 | rec/dp9_cred.webm(demo-player 场景 9 录屏,speed=0.75) | 33.2 | S16 工程信誉·三闸 |
| seg17 | cards_png/s17_govern.png | 25.1 | S17 治理 + 安全 |
| seg18 | cards_png/s18_honest.png | 24.8 | S18 诚实条款(贵 19%–34% 主动交代) |
| seg19 | cards_png/s19_vision.png | 29.2 | S19 1.0 愿景 + 门槛清单 |
| seg20a | cards_png/s20a_boundary.png | 8.0 | S20 划界(请用 WSL) |
| seg20b | rec/dp10_end.webm(demo-player 场景 10 录屏) | 16.4 | S20 CTA(安装命令 + GitHub) |

分段时长 = 下一场开始时间 − 本场开始时间(场间 0.7s 呼吸口并入本场画面),合计 433.7s。

## 2. 管线步骤(全部命令可复跑,工作目录 `scratch/video-build/`)

### 2.0 环境准备

```bash
cd D:/github_project/fauxnix/scratch/video-build
python -m venv venv
./venv/Scripts/python.exe -m pip install edge-tts   # 实装 7.2.8
npm init -y && npm install playwright-core          # 不下载浏览器,用本机 Chrome
```

### 2.1 TTS 配音(104 段)

```bash
./venv/Scripts/python.exe gen_tts.py
```

- 逐行读 `narration.txt`(104 行),edge-tts 生成 `tts/001.mp3 … 104.mp3`。
- 音色:**zh-CN-YunxiNeural**(男声),语速 **+4%**,其余默认。
- 每行重试 3 次;本次 104/104 成功。

### 2.2 音频对齐与混音

```bash
./venv/Scripts/python.exe build_audio.py   # 生成 wav/NNN.wav + timeline.csv
./venv/Scripts/python.exe mix_audio.py     # 生成 narration.wav(48kHz stereo)
```

- slot = 下一条 cue 开始 − 本条 cue 开始(末条为 end−start + 1.0s 尾巴)。
- TTS 长于 slot 时:比率 ≤1.15 用 `atempo=比率` 刚好塞进;>1.15 用 `atempo=1.15` 并允许溢出(amix 与下一条自然混合)。
- 本次:42 段做了 atempo 微调;13 段轻微溢出(见第 4 节)。
- 混音:`adelay=ms|ms` 逐段延时 + `amix=inputs=104:normalize=0:duration=longest`。
- 产出 `narration.wav` 时长 **433.006s**(srt 尾码 433.67s,结尾留 0.7s 静场)。

### 2.3 demo-player 场景录屏(playwright-core + 本机 Chrome)

```bash
node record.js   # 生成 rec/dpN_*.webm(1920×1080)
```

- `chromium.launch({ channel: 'chrome', headless: true })` + `recordVideo`(VP8 webm)。
- 逐场景打开 `demo-player.html?scene=N&speed=…`,并在页面里把该场 `hold` 改大防止自动切场;录够目标时长后关 context 落盘。
- 长静态场(dp4/dp9)用 speed=0.75 放慢动画;其余 speed=1。

### 2.4 叙事卡片(HTML → 1920×1080 PNG)

卡片源文件:`cards/*.html`(15 张,色板沿用 demo.svg:#1e1e1e 底、#6a9955/#d4d4d4/#f48771/#569cd6、mac 三灯;字体显式声明 Microsoft YaHei / Cascadia Code)。

```bash
node shot.js   # playwright 截 cards_png/*.png(本机 chrome --headless --screenshot 在本机不稳定,故走 playwright)
```

诚实条款落点:S1 卡片常驻「据广泛报道 · 2026.08」角标;S7 录屏画面自带「单机实测 n=1 · 方向性证据」;S18 数字用强调黄不用红绿。

### 2.5 视频分段(统一 1920×1080 / 30fps / x264 CRF20 / yuv420p / 无音轨)

```bash
bash build_segments.sh   # 生成 segs/seg*.mp4(25 段)
```

- 图片段:`ffmpeg -loop 1 -framerate 30 -i X.png -vf "zoompan=z='1+0.05*on/(30*DUR)':d=1:s=1920x1080:fps=30,format=yuv420p" -t DUR -c:v libx264 -crf 20 -preset medium -an`(缓慢推镜)。
- 录屏段:`ffmpeg -i X.webm -t DUR -vf "fps=30,format=yuv420p" -c:v libx264 -crf 20 -preset medium -an`。
- 封面预处理:`ffmpeg -i cover.png -vf "scale=-2:1080,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x141414" cards_png/cover1920.png`。

### 2.6 合成与输出

```bash
bash assemble.sh
```

1. `ffmpeg -f concat -safe 0 -i concat.txt -c copy video_only.mp4`(分段参数一致,可 stream copy;失败自动重编码)。
2. 软字幕版:视频 copy + 音频 `loudnorm=I=-16:TP=-1.5:LRA=11` → AAC 192k + `subtitles.srt` 以 `mov_text` 软字幕轨封装 → `video/fauxnix-bilibili-draft.mp4`。
3. 硬字幕版:`subtitles` 滤镜烧录(force_style: Microsoft YaHei,FontSize 20,白字 2px 黑边,底部 MarginV 36)重编码 + 同一响度处理 → `video/fauxnix-bilibili-draft-hardsub.mp4`。

## 3. 真人配音重合成指引

1. 按 `narration.txt` 逐行录制 104 条,或直接录一整条 7:13 的音轨(采样率不限)。
2. 若逐行录制:把文件命名为 `wav/001.wav … 104.wav`(48kHz stereo 可由 ffmpeg 转:`ffmpeg -i in.mp3 -ar 48000 -ac 2 out.wav`),然后重跑 `./venv/Scripts/python.exe mix_audio.py` 得到新 `narration.wav`(对齐逻辑见 build_audio.py;真人录音一般不需要 atempo,可跳过 build_audio.py,直接把 wav 放好跑 mix_audio.py)。
3. 若录整条:直接覆盖 `narration.wav`(转成 48kHz stereo)。
4. 重跑合成(视频无需重做):

```bash
cd D:/github_project/fauxnix/scratch/video-build
ffmpeg -y -i video_only.mp4 -i narration.wav -i "D:/github_project/fauxnix/docs/promotion/bilibili/subtitles.srt" \
  -map 0:v -map 1:a -map 2:s -c:v copy \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k \
  -c:s mov_text -movflags +faststart \
  "D:/github_project/fauxnix/docs/promotion/bilibili/video/fauxnix-bilibili-draft.mp4"
ffmpeg -y -i video_only.mp4 -i narration.wav \
  -vf "subtitles='D\\:/github_project/fauxnix/docs/promotion/bilibili/subtitles.srt':force_style='FontName=Microsoft YaHei,FontSize=20,PrimaryColour=&HFFFFFF,OutlineColour=&H000000,Outline=2,Shadow=0,Alignment=2,MarginV=36'" \
  -c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 48000 -c:a aac -b:a 192k \
  -movflags +faststart \
  "D:/github_project/fauxnix/docs/promotion/bilibili/video/fauxnix-bilibili-draft-hardsub.mp4"
```

> 若真人配音总时长与 433.7s 相差较大,需按新音轨长度重新分配分段时长(改 build_segments.sh 里的秒数),或接受结尾画面定格/截断。

## 4. 已知瑕疵

- **TTS 溢出段(13 条,atempo=1.15 仍略长于槽位,与下一条 cue 开头轻微叠音)**:cue 8(+0.14s)、15(+0.12s)、21(+0.20s)、23(+0.39s)、32(+0.51s)、43(+0.20s)、60(+0.87s)、67(+0.22s)、78(+0.55s)、94(+0.09s)、95(+0.09s)、100(+0.60s)、102(+0.18s)。最大 0.87s(cue 60),听感为下一句提前起步半秒左右;如需完美可对这些行换更快音色或精简文案。
- **录屏画面底部可见播放器铬件**(demo-player 的场景圆点与右下角快捷键提示,44px 高、9px 圆点):draft 保留;正式版可在录屏 URL 加 `&freeze=1` 之外的样式隐藏,或在 vid_seg 里 `crop=1920:1036:0:0,pad=1920:1080:0:0:color=0x101012`。
- **静态卡片段较长**(S8 架构卡 25s、S19 愿景卡 29.2s 等)仅有 zoompan 缓推,无更多动效;TTS 草稿节奏以信息传达为主。
- **edge-tts 合成音**为机器配音草稿,正式版建议按第 3 节替换真人配音。
- S7/S16 录屏用 speed=0.75 放慢动画,静止尾巴较长;如需更满可把 `record.js` 中 speed 再调低重录。

## 5. 质检结果(2026-09-02 实测)

| 项 | draft.mp4(软字幕) | draft-hardsub.mp4(硬字幕) |
|---|---|---|
| 时长 | 433.700s(7:13.7) | 433.700s |
| 文件大小 | 43,699,333 B(≈41.7 MiB) | 43,391,880 B(≈41.4 MiB) |
| 视频流 | h264 1920×1080 30fps yuv420p(CRF 20) | 同左 |
| 音频流 | aac 48000Hz(响度见下) | 同左 |
| 字幕 | mov_text 软字幕轨(language=chi)存在 | 烧录入画面 |

- 响度:loudnorm 复测 Input Integrated **-16.4 LUFS**,True Peak **-1.3 dBTP**(目标 -16 LUFS 达标)。
- 音轨时长 433.006s ≈ 视频 433.700s(结尾 0.7s 静场,设计如此)。
- 抽帧目检(ReadMediaFile):t=1 封面帧(非黑场)✓;t=10 硬字幕烧录可读(微软雅黑、白字黑边)✓;t=100 S5b bash 复刻卡 ✓;t=150 S7 benchmark 录屏数据卡 ✓;t=300 S16 工程信誉录屏卡 ✓;t=430 结尾 CTA ✓。
- 修复记录:初版 seg05b 卡片 tbody 未声明 `white-space:pre-wrap` 导致三行坍缩成一行,已修卡重截重合成(见 git 之外的卡片源 `cards/s05b_bashwin.html`)。

## 6. 文件清单(scratch/video-build/)

- `gen_tts.py` / `build_audio.py` / `mix_audio.py` — TTS 与音频对齐管线
- `record.js` / `shot.js` — playwright 录屏 / 卡片截图
- `build_segments.sh` / `assemble.sh` / `concat.txt` — 分段与合成
- `tts/`(104 mp3)、`wav/`(104 wav)、`narration.wav`、`timeline.csv` — 音频中间产物
- `cards/`(15 html)、`cards_png/`(16 png 含 cover1920)、`rec/`(9 webm)、`segs/`(25 mp4)、`video_only.mp4` — 视频中间产物
- `venv/`、`node_modules/`、`package.json` — 隔离依赖(edge-tts 7.2.8 / playwright-core)

