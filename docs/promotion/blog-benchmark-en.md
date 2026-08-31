# Show HN: We measured how much dumber coding agents get on Windows PowerShell — then fixed it with a translation layer

*(FINAL — submit the GitHub repo URL as the Show HN link, then post the text
below as your first comment. HN title must be ≤ 80 chars including the prefix.)*

**HN title (79 chars):** Show HN: Fauxnix – bash for AI agents on Windows, no WSL (we measured the PS tax)

**Alt (78 chars):** Show HN: We measured the PowerShell tax on coding agents, then built the fix

---

First-comment text:

---

Cross-trained LLMs are dramatically worse at PowerShell than bash — same model,
same tasks, 2–3× the tool calls and error storms that burn context and time.
We measured it, then built the fix: **fauxnix**, an MCP `bash` tool that
deterministically translates bash to native PowerShell 5.1. No WSL, no VM, no
bash toolchain — `npm install -g fauxnix-cli`.

**The measurement.** Same Windows machine, same 5-task battery (grep counts,
recursive finds, and the killer task: create a file and report its exact byte
size), one condition per mode. PowerShell mode routed commands through
`powershell -NoProfile -Command`; the fauxnix condition gave the same models
an MCP `bash` tool.

| Model | PowerShell: calls / errors / time | fauxnix |
|---|---|---|
| deepseek-v4-pro | 15 / 14 / 174s | 7 / **0** / 70s |
| kimi-k2-thinking | 26 / 24 / 302s | 8 / **0** / 96s |
| glm-5-2 | 10 / 4 / 171s | 11 / **0** / 112s |

The failure mode is never "wrong final answer" — strong models recover. It's
the recovery that's expensive: `Get-Content | Set-Content` writes UTF-16/CRLF
by default, byte counts come back wrong, and the model burns turns on
`Format-Hex` forensics before landing on `[System.IO.File]::WriteAllLines`
with explicit encoding flags. In bash that task is
`head -2 f > out.txt; wc -c out.txt`. Two commands. All raw data is in the
repo's docs/ (one machine, n=1 per cell — directional, not statistical, and
reproducible in ten minutes).

**The fix.** A stdio MCP server exposing a `bash` tool. Each command is
parsed as a bash subset — pipes, `&&`/`||`, redirects, quoting, `$(...)`,
backticks, `[[ ]]` (including ERE + BASH_REMATCH), `if/elif/else/fi`,
`for x in …`, word-level `$((x+1))` arithmetic, `${name:-default}`,
`${name[n]}` — and translated to a self-contained PowerShell 5.1 script
honoring a contract: GNU-style output, bash-style errors
(`cat: x: No such file or directory`, not a CategoryInfo dump), coreutils
exit codes, per-file UTF-8/GBK sniffing (Chinese-Windows GBK files break
every default config; ours just work), POSIX path mapping. 108 commands
translated; unknown commands (git, node, npm…) pass through natively with
argv-style quoting.

Since v0.6 the host is one resident powershell.exe per session: warm tool
calls answer in **0.01–0.04s** (15× faster than respawning a shell per
command — same ballpark as any built-in Bash tool, without shipping one).
v0.9 added structured results (stdout/stderr/exitCode/timedOut/cancelled),
real cancellation, per-stream size limits, and native stderr that returns
exactly once.

**How seriously we take correctness:** three quality gates, all visible in
the repo — an external contributor ran a differential audit against real Git
Bash (every finding had a repro; all fixed within a day), the maintainer
re-verifies each release with Git-Bash differential batteries (arithmetic:
10/10 byte-identical), and an automated reviewer reads every merged PR
(its last catch: two P1s in a released version — redirected-file truncation
and UTF-8 mid-codepoint cuts — hotfixed in 0.9.1 with regression tests).
197 tests run on every push; unsupported constructs fail loudly with the
construct named, never silently misbehave.

Works with Claude Code, Codex, OpenCode, Kimi Code, Qwen Code — one-line
config each in the README.

Honest limits: it's a subset, not bash. Heredocs, `while`/`until`/`case`,
functions, and job control reject with actionable messages. If you need real
bash toolchains, use WSL. If you need your agent to stop fumbling on Windows,
try this.

Ask me anything — the hard parts were all PowerShell 5.1 arcana (one console
encoding knob, scriptblock scoping, CRLF discipline, the 32K command-line
cap) and they're documented in the repo.
