# Show HN: We measured how much dumber coding agents get on Windows PowerShell — then fixed it with a translation layer

*(draft — publish from your account; HN title ≤ 80 chars, the Show HN prefix counts)*

**HN title:** Show HN: Fauxnix – bash for AI agents on Windows, no WSL (measured the PS tax first)

**Alt title:** We benchmarked DeepSeek-V4-Pro writing PowerShell: 2.5× slower, 14 error events (vs 0 in bash mode)

---

Cross-trained LLMs are dramatically worse at PowerShell than bash — same model,
same tasks, 2–3× the tool calls and error storms that burn context and time.
We measured it, then built the fix: **fauxnix**, an MCP `bash` tool that
deterministically translates bash to native PowerShell. No WSL, no VM, no bash
toolchain — `npm install -g fauxnix-cli`. And since v0.6.0's persistent
PowerShell host, warm tool calls answer in **0.01–0.04s** (15× faster than
respawning a shell per command) — same ballpark as any built-in Bash tool,
without shipping one.

## The measurement

Same Windows machine, same 5-task battery (grep counts, recursive finds, and
the killer task: create a file and report its exact byte size), one condition
per execution mode. Models asked to write PowerShell routed every command
through `powershell -NoProfile -Command`; the fauxnix condition gave the same
models an MCP `bash` tool.

| Model | PowerShell: calls / errors / time | fauxnix |
|---|---|---|
| deepseek-v4-pro | 15 / 14 / 174s | 7 / **0** / 70s |
| kimi-k2-thinking | 26 / 24 / 302s | 8 / **0** / 96s |
| glm-5-2 | 10 / 4 / 171s | 11 / **0** / 112s |

The failure mode is never "wrong final answer" — strong models recover. It's
the recovery itself that's expensive: `Get-Content | Set-Content` writes
UTF-16/CRLF by default, byte counts come back wrong, and the model burns turns
on `Format-Hex` forensics before landing on
`[System.IO.File]::WriteAllLines` with explicit encoding flags. In bash that
task is `head -2 f > out.txt; wc -c out.txt`. Two commands. No encoding
surprises.

All raw data: [benchmark docs](https://github.com/20000419/fauxnix/tree/main/docs).
One machine, n=1 per cell — directional, not statistical. Reproduce it in
ten minutes: the harness configs are in the README.

## The fix

fauxnix is a stdio MCP server exposing a `bash` tool. Each command is parsed
as a bash subset (pipes, `&&`/`||`, redirects, quoting, `$(...)`, `[[ ]]`,
`VAR=x cmd`, `${name[n]}`...) and translated to a self-contained PowerShell
5.1 script honoring a strict contract: GNU-style output formats, bash-style
errors (`cat: x: No such file or directory`, not a CategoryInfo dump),
coreutils exit codes, per-file UTF-8/GBK sniffing (Chinese Windows' GBK
files break every default config — ours just work), POSIX path mapping.

Unknown commands (git, node, npm, python, cargo…) are passed through via Win32 argv
(`fx-native`, CRT quoting) so empty args and embedded quotes survive. No string re-parsing.
Unsupported bash constructs fail loudly with the
construct named — never silently misbehave. ~105 commands translated;
correctness is verified differentially against real Git Bash (52/53
byte-identical on our battery; the one divergence is documented).

Works with Claude Code, Codex, OpenCode, Kimi Code, Qwen Code — one-line
config each (in the README). We also benchmarked the built-in shells of all
five: Codex on Windows is natively PowerShell 5.1 (the exact environment
above); Claude Code's Bash is Git Bash + its own cwd persistence; fauxnix
keeps session cwd/env across calls in every harness.

Honest limits: it's a subset, not bash. No heredocs, no `if`/`for`, no job
control — those reject with actionable messages. If you need real bash
toolchains, use WSL. If you need your agent to stop fumbling on Windows,
try this.

Ask me anything about the translation approach — the hard parts were all
PowerShell 5.1 arcana (single console-encoding knob, scriptblock scoping,
CRLF discipline, the 32K command-line cap) and they're all documented in
the repo's engineering notes.
