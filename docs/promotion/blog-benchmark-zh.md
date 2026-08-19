# 让 AI Agent 在 Windows 上写 bash：我们实测了 PowerShell 的"降智税"，然后修掉了它

*(V2EX / 掘金 版草稿，发布账号是你的)*

标题备选：
1. 实测 DeepSeek-V4-Pro 在 Windows PowerShell 下降智 2.5 倍，我用一个翻译层修好了
2. 不装 WSL，让 Claude Code / Codex / Kimi 在 Windows 上丝滑写 bash

---

## 背景：这是个真实且有数据的问题

跨厂商训练的模型写 PowerShell 的能力远弱于 bash——同样的模型、同样的任务，
PowerShell 模式下工具调用次数翻倍、报错风暴、耗时 2.5~3 倍。这不是玄学，
我们做了对照实验（单机 n=1，方向性结论，全部原始数据开源）。
而 v0.6.0 的常驻 PowerShell 宿主进程把暖调用延迟压到 **0.01–0.04 秒**
（对比每命令重启 shell 快 15 倍）——和任何内建 Bash 工具一个量级，
但不用装任何 bash。

| 模型 | 写 PowerShell（调用/报错/耗时） | 经 fauxnix 写 bash |
|---|---|---|
| deepseek-v4-pro | 15 次 / 14 错 / 174s | 7 次 / **0 错** / 70s |
| kimi-k2-thinking | 26 次 / 24 错 / 302s | 8 次 / **0 错** / 96s |
| glm-5-2 | 10 次 / 4 错 / 171s | 11 次 / **0 错** / 112s |

失败模式很有意思：顶级模型**最终都能答对**——贵在"恢复"这个过程。
典型例子：`Get-Content | Set-Content` 默认写 UTF-16/CRLF，字节数全错，
模型被迫用 `Format-Hex` 验尸、换 `[System.IO.File]::WriteAllLines` 加显式
编码参数，九次调用才完成 bash 里两条命令的活：
`head -2 f > out.txt; wc -c out.txt`。

## 解法：fauxnix——确定性翻译，不是模拟

npm 一装，MCP 一接，你的 agent 继续写它最熟练的 bash：

```bash
npm install -g fauxnix-cli
# Claude Code:  claude mcp add fauxnix -- fauxnix mcp
# Codex:        codex mcp add fauxnix -- fauxnix mcp
# OpenCode/Kimi/Qwen Code 配置见 README（都真机验证过）
```

它把 bash 语法子集（管道、`&&`/`||`、重定向、`$(...)`、`[[ ]]`、赋值、
`${name[n]}`……约 105 个命令）**确定性翻译**成 PowerShell 5.1 原生执行：
- 输出伪装成 GNU 格式（`ls -l` 列、coreutils 退出码）
- 错误伪装成 bash 风格英文（不是 CategoryInfo 堆栈，中文系统也不怕）
- **逐文件编码嗅探**：GBK 和 UTF-8 的中文文件 grep 都正确——这个是
  Git Bash 都做不到的（实测 GBK 文件 `grep 连接` Git Bash 0 命中、fauxnix 1）
- 会话持久：cd/环境变量跨调用保持
- 不认识的命令（git/node/npm）argv 透传；不支持的 bash 构造**大声报错**
  并给替代方案，绝不静默出错
- 正确性对照真实 Git Bash 差分验证：53 例中 52 例逐字一致

## 诚实的边界

它是精选子集，不是完整 bash：heredoc、`if`/`for`、作业控制不支持
（会明确报错）。需要真 bash 工具链的场景请用 WSL；需要 agent 在
Windows 上不犯傻的场景，试试这个：

**https://github.com/20000419/fauxnix**

（五 harness 内建 shell 对照实测、七模型基准、全部数据在仓库 docs/ 下）
