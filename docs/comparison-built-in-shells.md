# fauxnix vs built-in shells of Claude Code / Codex / OpenCode

Empirical comparison on one Windows 11 (zh-CN) machine, 2026-08-16. Probes run
through each harness's built-in shell tool; fauxnix through its MCP `bash` tool.

| Capability | Claude Code `Bash` | Codex shell | OpenCode built-in | Kimi Code `Bash` | fauxnix |
|---|---|---|---|---|---|
| What it actually is | Git Bash (requires Git for Windows) | **Windows PowerShell 5.1** | Git Bash (if bash.exe on PATH) | Git Bash | translated PowerShell |
| Commands authored in | bash | **PowerShell** | bash | bash | bash |
| `cd` persists across calls | ✔ (own snapshot/restore) | ✘ | ✘ | ✘ | ✔ |
| Sees full Windows process table | ✘ (MSYS procs only: 24) | ✔ (447) | ✘ (18) | ✘ (20) | ✔ (485) |
| `grep 连接` on a GBK file | ✘ 0 matches | ✘ (path broke first) | ✘ 0 matches | ✘ 0 matches | ✔ 1 match |
| POSIX paths (`/tmp/...`) | ✔ | ✘ (model mistranslated to `D:\tmp`) | ✔ | ✔ | ✔ (`/tmp` → `%TEMP%`) |
| Chinese output of native tools (ipconfig) | ✘ | ✘ | ✘ | ✘ | opt-in (`FAUXNIX_NATIVE_ENCODING=ansi`) |
| Error style shown to model | bash | localized PowerShell (e.g. zh-CN) | bash | bash | normalized English bash |
| Extra install needed | Git for Windows | none | bash on PATH | Git for Windows | `npm i -g fauxnix-cli` |

## Reading

- **Codex on Windows is the "PowerShell trap" scenario natively**: its shell is
  PowerShell 5.1 — the exact environment where cross-trained models degrade
  (see `docs/benchmark-deepseek-v4-pro.md` for the measured cost: 2.5× slower,
  2× tool calls, error storms on encoding/quoting defaults). No `cd` persistence,
  and POSIX-style paths break unless the model translates them correctly.
- **Claude Code's Bash = Git Bash + its own cwd persistence** — the strongest
  built-in option here, but it inherits Git Bash's blind spots: MSYS-only
  process table, single-locale encoding (GBK files fail), and it requires
  Git for Windows to be installed.
- **fauxnix is the only option combining** bash syntax + persistent session +
  real Windows semantics + per-file encoding sniffing + POSIX path
  normalization — with zero toolchain beyond Node.

Raw probe logs: `scratch/ds-test/` area (development machine, not published).
