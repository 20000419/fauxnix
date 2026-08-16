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
