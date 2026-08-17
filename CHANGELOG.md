# Changelog

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
