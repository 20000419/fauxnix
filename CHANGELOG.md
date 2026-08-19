# Changelog

## v0.5.1 — 2026-08-19

- `$((...))` word-level arithmetic expansion now rejects loudly with an
  actionable message (was: parsed as `$( (expr) )` and became a confusing
  empty-command error). Spaced `$( (cmd) )` keeps command-substitution
  semantics (#113)
- `wrapScript` emits only the fx- helpers a body actually calls (explicit
  dependency graph, transitive closure) instead of the full ~170-line catalog
  on every command (#114). Measured effect on simple-command wall time is
  ~zero (spawn cost dominates); the win is smaller scripts through
  -EncodedCommand and cleaner generated output
## v0.5.0 — 2026-08-18

Wave 2 "agent script surface" (RFC #111, by r3wretrhy; integration merge):

- `if/then/else/fi` and `for x in words; do ...; done` as compound commands,
  one PowerShell process per segment; `elif`/C-style `for`/`while` fail loudly
- Parameter expansions: `${name:-word}` `:+` `:?` (and non-colon forms),
  `${#name}` / `${#name[@]}` counts
- Backtick command substitution `` `cmd` `` (same pipeline as `$(...)`)
- `command -v` (+ bare `command NAME` no-alias run), `read`/`read -r` from
  pipelines into session vars, dotenv-style `source` (NAME=VALUE files)
- `set -e/-u/-x` now refuses loudly (exit 2) instead of silently ignoring
- `${arr[@]}` in command position with an empty array promotes the next word
  (bash parity)
- Docs: README known-deviations updated for the new supported surface
  (+ `command -v` builtin-path deviation noted)

## v0.4.2 — 2026-08-18

- Glama/Linux-host readiness (audit follow-up):
  - `powershell.exe` ENOENT now returns an actionable platform error
    (exit 127) instead of a raw spawn message — sandboxes without
    PowerShell get a clear "run on Windows" explanation
  - MCP `serverInfo.version` reads from package.json (single source —
    was a hardcoded string that drifted)
  - Tool metadata hardening: per-parameter descriptions on
    `fauxnix_translate.command` / `fauxnix_session.action`, and MCP
    annotations (readOnly/destructive/idempotent/openWorld hints) on all
    three tools; `bash` description states the Windows/PowerShell
    requirement
- Housekeeping: dev deps audited to 0 vulnerabilities (vitest 2.1.9 →
  3.2.6, 111/111 tests green), package-lock version drift (0.2.1)
  resolved, stale `fauxnix-cli-0.2.0.tgz` removed from the repo

## v0.4.0 — 2026-08-17

- `[[ ]]` ecosystem completed (RFC #81 "Next" roadmap):
  - `${name[n]}` / `${name[@]}` / `${name[*]}` subscript expansion with
    case-exact array sidecar (`FAUXNIX_ARRS`) — `BASH_REMATCH` is now a real
    array populated by `=~`, cleared on miss (#90, #84)
  - Command-substitution newline contract: quoted `"$(...)"` and assignments
    keep interior newlines; unquoted `$(...)` approximates IFS word
    splitting (#91, #83)
- Hotfix: `exprOfWord` callback misuse from the #90×#91 combination (#92)

## v0.3.0 — 2026-08-17

- `[[ ]]` as a real builtin (v1 per RFC #81): file/string unaries, glob +
  extglob `==`, lexicographic `<`/`>`, signed-64-bit integer compares with
  bases (`0x`, `0oct`, `n#`), POSIX ERE `=~` with groups, inner
  `&&`/`||`/`!`/`( )`, env shadow with case-exact names and empty values,
  syntax aborts that fail loudly (#80)
- Standalone assignment segments: `X=1; cmd` now works and persists,
  translating through the export path — `X=; [[ -v X ]]` is true (#85, #82)
- Differential testing vs real Git Bash adopted as a maintainer verification
  method (52/53 byte-identical; the one divergence documented)

## v0.2.1 — 2026-08-16

- Redirect-written files use LF line endings (GNU parity) (#1)
- `VAR=value cmd` / `env NAME=v cmd` are command-scoped — no session leaks (#66)
- Intentional CRLF from exact writers preserved (#12)
- Redirects resolve against the cwd after `cd` (#11)
- Maintainer process codified in CONTRIBUTING.md (#67)

## v0.2.0 — 2026-08-16

- `FAUXNIX_NATIVE_ENCODING=ansi` mode for GBK native-tool pipelines
- Harness integration docs verified on real machines: Claude Code, Codex
  (incl. exec approval bypass), OpenCode, Kimi Code
- Benchmark docs: DeepSeek-V4-Pro PowerShell degradation, harness built-in
  shell comparison, Volcano Ark multi-model study

## v0.1.0 — 2026-08-16

- Initial release: bash subset parser, deterministic PowerShell translation,
  ~105 translated commands, native passthrough, UTF-8/GBK handling,
  CLIXML unwrapping, bash-style error rewriting, session persistence
  (cwd/env/OLDPWD), MCP server + CLI, 60 tests incl. 29 real-PowerShell
  integration tests
