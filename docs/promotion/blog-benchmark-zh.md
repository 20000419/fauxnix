# 让 AI Agent 在 Windows 上写 bash：我们实测了 PowerShell 的"降智税"，然后修掉了它

*(终稿 — V2EX「分享创造」节点 + 掘金专栏，用你的账号发)*

标题（V2EX 用第 1 个，掘金用第 2 个更合适）：
1. 不装 WSL，让 Claude Code / Codex / Kimi 在 Windows 上丝滑写 bash（附降智实测数据）
2. 实测 PowerShell 让 AI 编程助手"降智"2.5 倍：我们做了一个 bash 翻译层来修

---

## 背景：这是个有数据的问题

跨厂商训练的模型写 PowerShell 的能力远弱于 bash——同样的模型、同样的任务，
PowerShell 模式下工具调用次数翻倍、报错风暴、耗时 2.5~3 倍。对照实验数据
（单机 n=1，方向性结论，原始数据全部开源在仓库 docs/ 下）：

| 模型 | 写 PowerShell（调用/报错/耗时） | 经 fauxnix 写 bash |
|---|---|---|
| deepseek-v4-pro | 15 次 / 14 错 / 174s | 7 次 / **0 错** / 70s |
| kimi-k2-thinking | 26 次 / 24 错 / 302s | 8 次 / **0 错** / 96s |
| glm-5-2 | 10 次 / 4 错 / 171s | 11 次 / **0 错** / 112s |

失败模式很有意思：顶级模型**最终都能答对**——贵在"恢复"这个过程。典型
例子：`Get-Content | Set-Content` 默认写 UTF-16/CRLF，字节数全错，模型被迫
`Format-Hex` 验尸、换 `[System.IO.File]::WriteAllLines` 加显式编码参数，
九次调用才完成 bash 里两条命令的活：`head -2 f > out.txt; wc -c out.txt`。

## 解法：fauxnix——确定性翻译，不是模拟

npm 一装，MCP 一接，你的 agent 继续写它最熟练的 bash：

```bash
npm install -g fauxnix-cli
# Claude Code:  claude mcp add fauxnix -- fauxnix mcp
# Codex:        codex mcp add fauxnix -- fauxnix mcp
# OpenCode / Kimi Code / Qwen Code 配置见 README（全部真机验证过）
```

它把 bash 语法子集（管道、`&&`/`||`、重定向、`$(...)`/反引号、`[[ ]]`
（含正则捕获 BASH_REMATCH）、`if/elif/else/fi`、`for x in ...`、词级算术
`$((x+1))`、`${name:-默认值}`、`${name[n]}`……共 108 个命令）**确定性翻译**
成 PowerShell 5.1 原生执行：

- 输出伪装成 GNU 格式（`ls -l` 列、coreutils 退出码）
- 错误伪装成 bash 风格英文（不是 CategoryInfo 堆栈，中文系统也不怕）
- **逐文件编码嗅探**：GBK 和 UTF-8 的中文文件 grep 都正确——这一点
  Git Bash 都做不到（实测 GBK 文件 `grep 连接`，Git Bash 0 命中、fauxnix 1）
- **常驻宿主进程**：暖调用 0.01–0.04 秒（比逐命令重启 shell 快 15 倍），
  和任何内建 Bash 工具一个量级，但不用装任何 bash
- v0.9 起带结构化结果（stdout/stderr/退出码/是否超时/是否取消）、真取消、
  流量上限与显式截断标记、原生 stderr 精确返回
- 不认识的命令（git/node/npm）argv 透传；不支持的构造**大声报错**并给
  替代方案，绝不静默出错

## 正确性是怎么保证的：三道质量闸

全部过程公开在仓库里：

1. **外部差分审计**：社区贡献者用真实 Git Bash 做 oracle 对全仓差分审计，
   每条发现都带复现步骤，全部在一天内修复（含 `cp -n` 静默覆盖这类
   危险偏差）；
2. **维护者差分验证**：每个版本发布前跑 Git Bash 差分电池（算术展开
   10/10 逐字节一致；有界输出 5/5 一致）；
3. **自动审查员**：每份合并后的 PR 由 Codex bot 复审——最近一次抓出
   已发布版本里的两个 P1（重定向文件被截断、UTF-8 截断劈开码点导致
   整段乱码），当天热修 0.9.1 并带回归测试。

197 项测试每次 push 全跑；翻译不支持的东西会指名道姓地报错。

## 诚实的边界

它是精选子集，不是完整 bash：heredoc、`while`/`until`/`case`、函数、
作业控制不支持（会明确报错并给替代方案）。需要真 bash 工具链的场景请用
WSL；需要 agent 在 Windows 上不犯傻的场景，试试这个：

**https://github.com/20000419/fauxnix**

（五 harness 内建 shell 对照实测、七模型基准、Glama MCP 目录全 A 评分、
全部数据在仓库 docs/ 下；MIT 协议，接受 PR——上周社区贡献者已经合并了
30+ 个 PR，RFC 流程见 CONTRIBUTING）
