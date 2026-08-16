# Benchmark: DeepSeek-V4-Pro — PowerShell vs fauxnix vs Git Bash

Same model (`deepseek/deepseek-v4-pro`), same 5 tasks, three execution modes in OpenCode:

- **ps** — model authors PowerShell, executed via `powershell -NoProfile -Command`
- **fauxnix** — model authors bash, executed through the fauxnix MCP `bash` tool
- **sh** — model uses the built-in tool, which resolves to Git Bash on this machine
  (the practical "just give the model a real bash" ceiling)

Fixtures: two small text files; ground truth verified before the runs.
One run per cell — directional evidence, not statistics.

## Results

| Task | PS: calls / errors / time | fauxnix | Git Bash | Answer (all modes) |
|---|---|---|---|---|
| T1 count TODO lines | 1 / 0 / 14s | 1 / 0 / 16s | 1 / 0 / 11s | 2 ✓ |
| T2 count .txt files | 1 / 0 / 12s | 1 / 0 / 14s | 1 / 0 / 11s | 2 ✓ |
| T3 lines + occurrences | **3 / 2** / 23s | 3 / 0 / 18s | 1 / 0 / 18s | 2, 2 ✓ |
| T4 head -2 → out.txt, byte size | **9 / 7** / **114s** | 2 / 0 / 18s | 1 / 0 / 17s | 11 ✓ |
| T5 read missing file | 2 / 3 / 18s | 1 / 2 / 13s | 1 / 3 / 13s | ✓ (see below) |
| **Totals (T1–T4)** | **14 / 9 / 163s** | **7 / 0 / 66s** | **4 / 0 / 57s** | 5/5 all |

"errors" = unexpected PowerShell error output (CategoryInfo / ParserError / …).
T5's error is intentional (missing file), so its error lines are the expected signal.

## What actually happened

**Final-answer accuracy did not collapse in any mode** — DeepSeek-V4-Pro is a strong
model that recovers. What collapsed in PowerShell mode was *efficiency and stability*:

- **T4 anatomy (9 calls):** `Get-Content | Set-Content` wrote UTF-16/CRLF by default,
  so every byte count came back wrong (26, 24, …). The model burned invocations on
  `Format-Hex` inspections and finally landed on
  `[System.IO.File]::WriteAllLines` with explicit UTF8-no-BOM and LF handling.
  In bash this task is `head -2 src/words.txt > out.txt; wc -c out.txt` — two
  commands, byte-exact, no encoding surprises.
- **T3:** first attempt died with `EmptyPipeElement`; retry with restructured
  pipeline succeeded.
- **Locale trap:** PowerShell errors came back localized in Chinese
  (`找不到路径...`) on this machine — extra friction for models trained on English
  error corpora. fauxnix normalized the same failure to the standard
  `cat: src/config.yaml: No such file or directory`.

## Reading

- PowerShell mode: **2.5× slower, 2× the tool calls, 9 unexpected error events**
  versus fauxnix on identical tasks, with the gap concentrated exactly where PS
  defaults bite hardest (byte-exact file writes).
- fauxnix lands within ~15% of the real-Git-Bash ceiling while requiring no
  bash toolchain on the machine — the translation layer itself costs almost
  nothing measurable at this task scale.
- For weaker models the same friction typically turns into outright failures
  rather than slow recovery; fauxnix removes the whole class of
  encoding/quoting/pipe-semantics surprises.

Raw logs: `scratch/ds-test/logs/` (development machine only, not published).

## Addendum: does adding fauxnix to Claude Code / Codex improve performance?

Same 5-task matrix, each harness's own model, built-in tool vs fauxnix MCP
(logs: `scratch/ds-test/logs-gains/`). All 20 runs answered correctly —
fauxnix never broke a harness.

| Harness (model) | Built-in is | Calls | Errors | Wall/model time |
|---|---|---|---|---|
| Claude Code (default) | Git Bash | 11 | 0 | 163.9s api |
| Claude Code + fauxnix | bash via fauxnix | 10 | 0 | **142.7s api** |
| Codex (gpt-5.6-luna) | PowerShell 5.1 | 5 (bundled one-shots) | T5: 4-line localized dump | **159s** |
| Codex + fauxnix | bash via fauxnix | 11 (granular) | T5: 1 clean line | 213s (+34%) |

Reading:

- **Claude Code**: parity — its built-in Bash is already Git Bash with cwd
  persistence, and Claude models write bash natively. fauxnix's value there is
  the semantic set (GBK file sniffing, real process table, error
  normalization), not speed. Measured slightly faster but within n=1 noise.
- **Codex**: *model-dependent*. gpt-5.6-luna authors efficient bundled
  PowerShell one-shots, so fauxnix costs ~34% wall time on these micro-tasks
  (granular calls + MCP + PowerShell spawn per call) while improving error
  readability (1 line vs a 4-line localized CategoryInfo dump) and adding
  cd persistence / POSIX-path safety. Cross-trained models like
  DeepSeek-V4-Pro show the opposite (see main benchmark: PowerShell mode
  2.5× slower with error storms) — for them fauxnix on Codex is a large win.
- Practical note: the wall-time gap scales with call granularity; a model
  that batches commands closes most of it.

### Kimi Code (kimi-for-coding)

Built-in Bash = Git Bash, one bundled call per task (very efficient bash
author). Same 5-task matrix, tool usage verified per condition
(`mcp__fauxnix__bash` vs `Bash` only):

| | built-in (Git Bash) | fauxnix |
|---|---|---|
| tool calls | 5 | 6 |
| wall time | 90s | 107s (+19%) |
| correctness | 5/5 | 5/5 |

Reading: like Claude Code, no speed story (model already writes bash well and
bundles), ~19% overhead. The functional gains matter more here because Kimi's
built-in Bash **lacks cd persistence** (fresh shell per call — verified),
while fauxnix keeps cwd/env across calls, plus GBK-file sniffing and the real
Windows process table.
