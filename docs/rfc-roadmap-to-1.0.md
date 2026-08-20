# RFC: fauxnix roadmap to 1.0

Status: **proposed** — tracking issue mirrors this file; discussion happens there.
Supersedes the informal "next steps" notes scattered across #81/#111 and the
v0.4–v0.6 release notes. Process precedent: #111 (wave 2), #113/#114 (wave 3),
#115 (wave 4) — RFC first, independently reviewable PRs second, integration
rule from CONTRIBUTING throughout.

## Where we are (v0.6.0, 2026-08-19)

- **Surface**: ~106 translated commands + native passthrough; `if`/`for`
  compound commands; `${name:-word}`/`:+`/`:?`, `${#name}`, `${name[n]}`,
  backticks, `command -v`, pipeline `read`, dotenv `source`; loud rejects for
  the rest (see README "Known deviations" — the honest list).
- **Engine**: one resident powershell.exe per session (JSON-lines frames);
  warm tool calls 0.01–0.04s measured (15× vs per-command respawn); timeout
  kills the host, session cold-restarts.
- **Quality**: 135/135 tests (CI ~1min); differential corpus vs real Git Bash
  52/53 byte-identical (scratch-only today); two external audits' findings
  all closed; Glama A across the board.
- **Distribution**: npm `fauxnix-cli` (latest = code); 8 GitHub releases;
  Glama listed with quality score; 5 harness integrations documented and
  verified on real machines (Claude Code, Codex, OpenCode, Kimi, Qwen).

## Principles (unchanged, restated because they decide the roadmap)

1. **Deterministic translation, not emulation.** Same input → same PowerShell.
2. **Fail loud, never silently-wrong.** Every unsupported construct gets an
   actionable error at translate time. Deviations are documented, not hidden.
3. **Windows-native.** Real processes, real env, real cwd. No WSL, no VM,
   no bundled bash. Execution stays Windows-only; introspection tools
   (`fauxnix_translate`, `fauxnix_session`) work anywhere.
4. **Measured claims only.** Every perf/quality number we publish is
   reproducible from the repo. No telemetry — privacy is a feature.
5. **Agent-corpus-driven surface growth.** We add syntax that agents actually
   emit (evidence: benchmark transcripts, real usage), not bash-completeness
   for its own sake.

## Track A — language surface (waves 5+)

Ordered by observed agent emission frequency in our benchmark transcripts:

| # | Item | Notes | Target |
|---|---|---|---|
| A1 | `while`/`until`, `case x in ...) ;; esac`, `elif` | natural completion of the control-flow family started in #109/#110; `case` is common in install snippets agents copy | v0.7 |
| A2 | word-level `$((...))` arithmetic | currently loud-reject (#113); the emit-rate is high (loop counters) — implement on the existing fx-arith engine | v0.7 |
| A3 | array assignment `A=(x y z)` + `${name//pat/str}`, `${name:off:len}` | arrays already exist via sidecar (FAUXNIX_ARRS); assignment is the missing door | v0.8 |
| A4 | positional params `$1`/`$@`/`set --` | needed by sourced-script patterns; interacts with A6 | v0.8 |
| A5 | `$(cmd1; cmd2)` multi-segment substitution | translate-time recursion exists; segment plumbing is local | v0.8 |
| A6 | shell functions + real `source` of scripts | **leaning wontfix**: sessions persist across PowerShell hosts, functions do not survive a host death; would need a function registry sidecar. Revisit only with corpus evidence | open |
| A7 | heredocs | **leaning wontfix**: rare in agent one-liners; `printf` covers the emit case. Revisit with corpus evidence | open |

Rule for A-track waves: every accepted item lands with (a) translate-time
tests, (b) real-PowerShell integration tests, (c) a differential case against
Git Bash appended to the corpus (see C1), (d) README deviations updated.

## Track B — performance & lifecycle

| # | Item | Notes | Target |
|---|---|---|---|
| B1 | host prewarm on session create | hides the 1.1s cold-start from the first tool call (boot at MCP initialize, not at first bash call) | v0.7 |
| B2 | one-shot CLI spawn fallback | `fauxnix "cmd"` currently pays host boot (+0.2s vs v0.5); auto-detect single-command → spawn path | v0.7 |
| B3 | per-frame runspace `Stop()` | timeout currently kills the whole host; finer-grained cancel keeps the host warm | v0.8 |
| B4 | job-object tree kill | timeout grandchildren may survive today (documented); Windows job objects make kills hermetic | v0.8 |

## Track C — correctness & platform matrix

| # | Item | Notes | Target |
|---|---|---|---|
| C1 | differential corpus promoted into the repo | 52/53 cases live in scratch today; move to `test/differential/` with a Git-Bash-optional runner (`FAUXNIX_DIFF_ORACLE` env), grow toward 200 cases, run as a scheduled CI job | v0.7 |
| C2 | locale matrix | all real-PowerShell validation so far is one zh-CN box; CI (en-US) covers only part; add explicit zh-CN/en-US case set for error wording + encoding | v0.7 |
| C3 | PowerShell 7 (`pwsh`) compatibility tier | document deltas, allow `FAUXNIX_PS=pwsh`; PS 5.1 stays the contract | v0.8 |
| C4 | ARM64 in the CI matrix | GitHub has windows-11-arm runners; claim currently untested | v0.8 |

## Track D — distribution & adoption

| # | Item | Notes | Target |
|---|---|---|---|
| D1 | `fauxnix install --claude/--codex/--opencode/--kimi/--qwen` | one command per harness writing the right config (paths verified in our 5-harness matrix) | v0.7 |
| D2 | Smithery / PulseMCP / mcp.so submissions | web forms, listed in docs/promotion/targets.md | v0.8 |
| D3 | docs/examples per harness | runnable 5-minute quickstarts with expected output | v0.8 |
| D4 | awesome-claude-code | gate clears 2026-08-30 | v0.8 |

## Track E — process & governance

| # | Item | Notes | Target |
|---|---|---|---|
| E1 | RFC process mini-doc | this file + a CONTRIBUTING section: what warrants an RFC, template, maintainer turnaround | v0.7 |
| E2 | SECURITY.md | document the trust model (local agent shell, same as any harness Bash tool), the host protocol surface, kill semantics, curl SSRF guard, and how to report | v0.7 |
| E3 | release cadence | feature wave → minor, audit/fix → patch; npm publish stays maintainer-manual (2FA) | standing |

## Milestones

- **v0.7 — "script completeness + latency polish"**: A1, A2, B1, B2, C1, C2, D1, E1, E2
- **v0.8 — "platform matrix + reach"**: A3, A4, A5, B3, B4, C3, C4, D2, D3, D4
- **v1.0 — stability promise** (all of):
  - differential ≥ 95% byte-identical on a ≥ 200-case corpus (C1)
  - locale matrix green (zh-CN + en-US, C2); PS 7 tier documented (C3); ARM64 green (C4)
  - the 5 harnesses re-verified on their then-current versions with `fauxnix install`
  - SECURITY.md reviewed externally once
  - README/CHANGELOG complete; no known silent-wrong behaviors open
  - the CLI/MCP/session interfaces marked stable (semver from here)

## Non-goals (restated + additions)

- Becoming bash; POSIX certification; running on Linux/macOS hosts
- WSL, MSYS bundling, or shipping any bash runtime
- Telemetry of any kind; update nagging
- Sandboxing/policy beyond the current network guard (that belongs to the
  harness, not the shell)
- A7 heredocs and A6 functions **unless** corpus evidence changes the verdict

## Open questions (discuss on the tracking issue)

1. `case` with fallthrough (`;&`) — support or reject loudly in v0.7's A1?
2. Should B2's spawn fallback also serve `fauxnix check` (no host needed)?
3. Is a `--dry-run`/`fauxnix translate --explain` (annotated PS output for
   learning) worth D3's quickstarts, or scope creep?
4. Who else wants maintainer rights on npm (currently single-publisher)?
