# Changelog

## v0.10.0 — 2026-09-02

First wave claimed against the 1.0 roadmap v2 (all by r3wretrhy):

- **C-4**: multi-segment command substitution `$(cmd1; cmd2)` (#179)
- **C-5 (partial)**: CommandSpec for the text-filters family — sort/uniq/
  cut/tr and friends fail loud on unknown options (#177)
- **C-6 (interim)**: stdout redirects on non-last pipeline stages reject
  loudly with the #157 workaround in the message (#175)
- **C-7 scaffold**: `test/differential/` corpus + oracle-gated runner
  (`FAUXNIX_DIFF_ORACLE=1`, skip-safe without Git Bash); 25-seed corpus,
  ≥95% identity gate; the 200-case 1.0 target grows from here (#176)
- **T-1**: SECURITY.md — trust model, host protocol, kill semantics,
  network guard, reporting policy (#174)
- **T-2**: CONTRIBUTING gains the RFC rule (#173)
- **U-2**: `fauxnix doctor` — PowerShell/encoding checks plus harness
  config detection with fix hints (verified detecting real Claude/Codex/
  OpenCode configs) (#178)
- C-3 mini-RFC: session-scoped positional parameters proposed
  (docs/rfc-positional-params.md) — implementation awaits #118 discussion

271 tests (251 + differential corpus suite).
## v0.9.3 — 2026-08-31

Windows computer-use parity wave #1 (RFC #156, #158-#167 by r3wretrhy):

- **Strategic RFC**: "computer-use agents are trained on Mac fleets" —
  docs/rfc-windows-computer-use-parity.md anchors translate-don't-emulate as
  the v1.0 narrative (#156/#158)
- **fx-native everywhere**: curl/wget/tar/ping and xargs now launch through
  the argv-faithful path (CRT quoting, no PS 5.1 splat) (#159/#160)
- `2>&1 >/dev/null` keeps the already-dup'd stderr — per-fd last-wins
  matching bash dup semantics (#164)
- `.cmd`/`.bat` argv: cmd.exe metacharacters are quoted (#163)
- `grep -F -o` emits matches in input order across multiple -e (#162)
- CommandSpec: text-io family (echo/printf/cat/tail/wc…) fails loud on
  unknown flags (#161); `ls --color` accepted as a no-op (#166)
- command-not-found for `python3`/`.sh` rewrites carry Windows hints (#167)
- Docs: native passthrough described as fx-native/CRT, stale argv text
  killed (#165); blog drafts finalized in-tree

251 tests.
## v0.9.2 — 2026-08-31

The #131 audit backlog, cleared (#147-#154, by r3wretrhy):

- **Per-stage redirect ownership** (#147, RFC in docs/rfc-redirect-fd-ownership.md):
  last stage owns output apply, first stage owns stdin feed, middle-stage `<`
  replaces the pipe; `>/dev/null` discards; last-win for successive redirects.
  `echo hi >/dev/null` prints nothing; `printf x | cat < f | head -1` reads f
- **Native argv fidelity** (#148): literal native invocations go through
  fx-native (System.Diagnostics.Process + Win32 command-line builder, CRT
  quoting; async reads before stdin write; .cmd/.bat via cmd.exe). Empty
  args, spaces, and embedded quotes now survive byte-exact
- `docs/command-specs.md` regenerated in lockstep with the registry (#149)
- `fauxnix check` prints FAILED on spawn errors instead of an unhandled
  stack (#150)
- `head -n -N` / `--lines=-N` / `--bytes=-N` print all but the last N (#151)
- `grep -e` repeats OR-accumulate patterns (#152)
- printf-style exact-writer output re-splits into lines for pipeline
  consumers (grep/sed/awk/sort/uniq/tr) (#153)
- hard links report as regular files, not symlinks (#154)

223 tests.
## v0.9.1 — 2026-08-23

Hotfix for the two P1 findings from the Codex review of #145 (both verified
on published 0.9.0):

- **Redirected files are never truncated by response budgets** — limits
  apply only to data returned to the caller; `printf … > file` under a small
  (or default 8 MiB) budget was writing a clipped file
- **Truncation cuts at valid UTF-8 boundaries** — a mid-codepoint cut made
  Node's decoder reject the whole buffer and fall back to GBK mojibake;
  the cut now backs off to a sequence boundary (lead-byte scan)
## v0.9.0 — 2026-08-23

Protocol v2 + bounded outputs (#141 #142 #144):

- **Host protocol v2** (#129 PR-B): versioned handshake (v1 still accepted),
  chunked stdout/stderr frames with per-stream seq, per-run
  `stdoutLimit`/`stderrLimit` with explicit `truncated` markers, and a
  native-stderr end marker so bytes from `git`/`npm`/`node` return exactly
  once — the audit's "native stderr dropped" gap is closed
- **Bootstrap slimmed**: first frame after prewarm back to **~0.27s** (from
  0.7s; was 0.137s pre-#138) and prewarm itself to ~0.6s (from ~2s) —
  closes the #140 regression; warm frames unchanged (~40ms)
- **Bounded-output family spec'd** (#141): `grep -m`, `head --lines`,
  `du --max-depth` match GNU (differential 5/5 vs real bash);
  `docs/command-specs.md` generated from CommandSpec
- **File-command specs expanded** (#144): ls/mkdir/rmdir/mktemp/ln/readlink/
  realpath/basename/dirname/stat… — unknown options fail loud (e.g.
  `ls -Z` is now a usage error)

197 tests.
## v0.8.0 — 2026-08-23

Execution-contract wave (#129 PR-A + #130 first families + syntax fail-loud):

- **Bounded, cancellable, structured MCP results** (#129 PR-A): bash tool
  returns versioned structured content (stdout/stderr/exitCode/timedOut/
  cancelled) alongside the text; whitespace-only stdout is preserved instead
  of collapsing to "(no output)"; per-request AbortSignal cancels by host-kill
  with the same recovery as timeout (measured: sleep 8 cancelled at 0.4s,
  session survives via cold restart); run/reset/dispose share one lock
  (concurrent reset can no longer leak hosts); dispose on stdin EOF/SIGINT/
  SIGTERM; native stderr drained per request; ConvertTo-Json overflow is a
  loud frame error. v2 chunked frames stay a follow-up (PR-B).
- **CommandSpec fail-loud** (#130): cp/mv/rm/touch/tee carry typed option
  specs — unknown options are GNU-style usage errors, cp -n / mv -n /
  touch -c / tee --append match GNU semantics; fauxnix list --json exposes
  the capability metadata (108 commands)
- **find predicates compiled, not ignored** (#137): !, -o, -a, grouping
  parens, -delete precedence follow GNU; unknown predicates and broken
  expressions fail loud with GNU wording
- **Syntax fail-loud** (#135): trailing &&, ; ;, and env -i now reject with
  actionable errors instead of executing something surprising

Note: #138's richer host bootstrap raises the first frame after prewarm to
~0.7s (from 0.137s; warm frames unchanged at ~50ms) — tracked for a
bootstrap-slimming follow-up.

186 tests.
## v0.7.1 — 2026-08-23

Post-v0.7 audit fixes (issue #131 by @vulragrag-star; integration of #123–#128):

- `grep -r` restored: recursive search honors `--include`/`--exclude`/
  `--exclude-dir` filters without misparsing short bundles (#123)
- Pipeline exit status now comes from the final stage (per-stage status slots
  replace the shared flag that let earlier failures leak) (#124)
- `find -maxdepth`/`-mindepth` semantics fixed + GNU-style argument
  validation (#125)
- Release integrity: CI uses `npm ci`, a `test:package` job validates the
  packed tarball and clean-source install (catches missing executables and
  stale versions), README source-install instructions fixed (#126)
- One timeout deadline per request: later segments no longer run after the
  budget expires; exit 124 propagates immediately (#127)
- `PATHEXT` restored when the official MCP SDK's sanitized Windows
  environment omits it (extensionless native commands like `node` resolve
  again in real clients) (#128)

156/156 tests green.
## v0.7.0 — 2026-08-20

First roadmap wave (docs/rfc-roadmap-to-1.0.md): A2, part of A1, B1.

- Word-level `$((...))` arithmetic expansion — implemented on the existing
  fx-arith engine (replaces the #113 loud-reject); differential-checked
  byte-identical with real bash on precedence, truncating division, modulo,
  power, negatives, quoted embedding, and assignment-through-arith (#119)
- `elif` chains — desugared to nested if (else + if), innermost clause
  closes `fi` (#120)
- MCP host prewarm — powershell.exe boots during initialize (and after
  session reset), hiding the cold start: first tool call measured
  1.12s -> 0.137s (#121)

139/139 tests green.
## v0.6.0 — 2026-08-19

- **Persistent PowerShell host per session** (#115, RFC in
  docs/rfc-persistent-powershell-host.md): one resident powershell.exe per
  FauxnixSession speaking JSON-lines frames — session-mode latency drops from
  ~1.1s to **~0.03s per warm command (measured 15×)**; the full test suite
  runs ~3× faster as a side effect
  - Timeout kills the host (exit 124) and the next command cold-starts a
    fresh one; host death mid-frame fails that frame without retrying
  - `fauxnix translate` still prints the spawn-style script and never starts
    a host; MCP warm tool calls measure 0.01-0.04s end to end
  - One-shot CLI keeps working but pays host boot (~+0.2s); agents batch via
    MCP/CLI session paths and see the full win
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
