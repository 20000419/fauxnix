# RFC: native shell facade — become `bash.exe`

Status: **Proposed** (founder-authored, spike evidence attached). Target wave: post-1.0
(v0.14.x experimental → GA in v1.1). Discussion: #118.

## Motivation — three measured bottlenecks, one architecture

fauxnix today ships two surfaces: the CLI and an MCP server. Both leave value on the table.

1. **The MCP round-trip tax is still ours alone.** The HARD benchmark (2026-09-03) measured
   minimax-m3 through the MCP surface at 5/7 tasks / 533s while the *same model* through the
   harness's built-in shell did 6/7 / 249s; T7 (multi-step pipeline) timed out at 180s purely on
   per-call protocol overhead (`bash_batch` mitigates this for preplanned sequences, but the
   model must choose to plan). Every competitor that lives *inside* the built-in shell channel —
   Git Bash, WSL, PowerShell — pays no such tax at all. We currently sit beside the shell and
   rent it a translator.
2. **Install friction is the conversion bottleneck.** Traffic data since the awesome-mcp-servers
   merge: stars 96 → 143 in three days, unique visitors 87 on merge day, npm installs **0**.
   Visitors collect; they do not configure MCP servers. The smallest possible install is not a
   JSON block — it is one environment variable.
3. **Detection pain is proven demand.** anthropics/claude-code#73461 (Windows ARM64,
   `CLAUDE_CODE_GIT_BASH_PATH` set correctly, Git Bash still not detected) is exactly the failure
   mode a self-contained, npm-installed bash would erase.

The architecture that removes all three at once: **stop being a tool beside the shell — become
the shell.** A fauxnix-backed executable named `bash.exe` that harnesses point at as their
built-in shell backend. The agent's native Bash tool runs on fauxnix with zero MCP hops, zero
extra configuration surface, and our differential-verified GNU fidelity.

## Reconnaissance (what was verified, not assumed)

From the Claude Code binary (2.1.x, local install) and the market, 2026-09-10:

- `CLAUDE_CODE_GIT_BASH_PATH` selection: the path must exist and its **basename must be exactly
  one of `bash.exe`, `sh.exe`, `bash`, `sh`**. Anything else logs a warning and falls back to
  detection. Consequence: the facade must be a real PE executable with the right name — no
  `.cmd` shims, no scripts.
- Two invocation shapes exist in the harness: one-shot `exe -c <command> ...` and a persistent
  stdin session correlated with `<bash-input>...</bash-input>` markers (regex confirmed in the
  binary). The shell layer is already an abstraction over `bash`/`pwsh` backends — a substitute
  backend is an intended extension point, not a hack.
- Market: Microsoft AI Shell (Preview 6) treats Git Bash as one shell among several over MCP;
  busybox-w32 ships real GNU tools as a single native exe but has no agent story (no fail-loud
  validation, no encoding guarantees, no harness integration). No project currently ships a
  *translating* bash.exe for agent harnesses. The "agents are trained on bash" narrative is now
  mainstream press; Windows remains the only major desktop without a credible answer.

## Proposal

### The third surface

```
today:   agent ──MCP──▶ fauxnix server ──translate──▶ PowerShell
facade:  agent ──built-in Bash tool──▶ bash.exe (fauxnix) ──translate──▶ PowerShell
```

`fauxnix facade` is a hidden subcommand implementing the bash process contract; a launcher
executable named `bash.exe` forwards to it. The MCP server and CLI remain unchanged — the facade
is additive and reuses `FauxnixSession`, the parser/translator, CommandSpec validation, the
network guard, and the differential corpus end to end.

### The launcher problem (basename `bash.exe` ⇒ a real PE file)

- **Option A — install-time Node SEA (experimental phase).** `fauxnix install --claude-shell`
  copies the active `node.exe` to a fauxnix-owned directory as `bash.exe` and injects a SEA
  bundle (postject). Zero new build infrastructure, ~100 MB, coupled to the local Node version.
  Good enough to prove the surface in v0.14.x.
- **Option B — prebuilt stub (GA).** A ≤300 KB launcher cross-compiled in CI (zig/Go), shipped
  as platform packages (`@fauxnix/launcher-win32-x64`, `-arm64`; the esbuild distribution model)
  with checksums and provenance. Small, auditable, standard.
- Rejected: renaming/copying `node.exe` without SEA (wrong argv contract), `.cmd` wrappers
  (basename allowlist), symlinks (same argv problem).

Recommendation: **A now, B before GA.**

### Session model

- **Marker session (persistent stdin):** one facade process = one `FauxnixSession`; `cwd`, env,
  `export`/`unset`, positional parameters persist across `<bash-input>` blocks, exactly like the
  MCP session. Warm host, 30–50 ms per command.
- **One-shot `-c`:** stateless by default (each invocation is a fresh process). The exit code of
  the last command is the process exit code. `$0`/`$1`… from trailing `-c` operands wire into the
  session positional state.

### GNU rendering mode

The facade speaks GNU at the process boundary: `pwd` prints POSIX-form paths (`/d/foo`),
stdout uses LF line endings (byte-comparable with Git Bash output), and error program names are
bare (`ls:`, not `/usr/bin/ls:`). CLI behavior is unchanged; this is a surface-level render mode
backed by the same execution layer. The spike (appendix) confirms these are the only remaining
cosmetic deltas on an ad-hoc battery — the two product gaps below must land first.

## Security and trust

An executable impersonating `bash.exe` raises the trust stakes; the rules:

- **Disclosure, never stealth.** `--version` identifies fauxnix; `fauxnix doctor` detects and
  reports facade installs; `fauxnix uninstall` removes the env var and the launcher directory.
- **The harness's own approval flow governs.** In MCP mode our tool calls carry annotations and
  per-call approval UI; in facade mode the harness's native Bash approval flow applies instead.
  `fauxnix install --claude-shell` must state this trade-off in its output.
- Translation-layer guarantees carry over unchanged: CommandSpec fail-loud validation, the
  loopback/private-network refusal for `curl`/`wget`, bounded outputs, and the host kill
  semantics documented in SECURITY.md.

## Conformance and test plan

1. **Differential corpus through the facade entry** — all 253 cases, same ≥95% byte-identity
   gate, executed via `bash.exe -c` rather than the in-process runner. This is the single
   largest reuse: the oracle does not care which front door the command came from.
2. **Protocol conformance fixtures** — recorded `<bash-input>` transcript shapes replayed
   against both the facade and real Git Bash under the same env var; exit-code channel, stdout
   framing, and cwd persistence asserted byte-exact.
3. **Benchmark gate (hard, before GA)** — HARD T6/T7 through built-in-Bash+facade vs built-in
   PowerShell vs MCP fauxnix: facade must match the built-in PowerShell baseline within noise
   and beat the MCP path on multi-step tasks. The T7 minimax timeout must not reproduce.

## Rollout

- **Phase 0 (this RFC):** recon + spike merged as evidence; two product gaps filed.
- **Phase 1 (v0.14.x, experimental):** `fauxnix facade` + `install --claude-shell` via Option A,
  behind an explicit `--experimental` flag; differential-through-facade wired into CI; protocol
  fixtures; honest `doctor` wiring.
- **Phase 2:** benchmark gate executed on two more harnesses' research (Codex shell backend
  configurability, OpenCode); POSIX rendering and `-c` positional semantics complete.
- **Phase 3 (GA, v1.1):** Option B launchers (x64 + ARM64), provenance/checksums, uninstall
  hygiene, SECURITY.md facade section.

## Success metrics

- T7 (minimax-m3) completes under the built-in Bash tool with no timeout where MCP timed out.
- `npx` try-it conversion: measurable non-zero installs within a week of `--claude-shell`.
- One closed external pain point: a reproducible answer for #73461-class Git Bash detection
  failures.

## Non-goals

- Full bash grammar (the documented subset policy is unchanged; unsupported constructs fail
  loud as today).
- Interactive TTY features: job control, `read -p`, line editing.
- Invisibility: the facade always identifies itself.

## Alternatives considered

- **Forever-MCP:** keeps the round-trip tax; `bash_batch` only covers preplanned sequences.
- **BASH_ENV injection into a real Git Bash:** still requires a Git Bash install — concedes the
  ARM64/detection pain and ships a second runtime.
- **Forking MSYS2/busybox-w32:** an emulation tree to maintain; violates translate-don't-emulate
  and forfeits our differential-testing leverage.

## Appendix — spike evidence (2026-09-10)

`scratch/facade-spike/bash-facade.mjs` (gitignored; reproduced here for review) implements the
argv contract (`-c`, `--version`, stdin marker session) over `dist/` — no new execution code:

```javascript
import '../../dist/commands/install-all.js';            // handler registration is mandatory
import { parseCommand } from '../../dist/parser.js';
import { translateCommandList, EXECUTE_TRANSLATION } from '../../dist/translator.js';
import { FauxnixSession } from '../../dist/executor.js';

const MARKER_RE = /<bash-input>([\s\S]*?)<\/bash-input>/;

async function runOne(session, cmd) {
  return session.run(translateCommandList(parseCommand(cmd), EXECUTE_TRANSLATION));
}
// -c: translate, execute, write stdout/stderr, process.exit(result.exitCode)
// stdin: for every <bash-input> block run + emit `<bash-exit>N</bash-exit>`;
//        one FauxnixSession per process ⇒ cwd/env persist across markers.
```

Results against real Git Bash as oracle (`bash -c`, same cwd, byte comparison of stdout+exit):

- 5/7 byte-identical on the ad-hoc battery (pipes, `$((...))`, `for`, awk aggregation, grep).
- Persistent marker session verified: `cd src` → `pwd` → `ls | wc -l` across three markers with
  cwd persistence and per-command exit markers.
- Remaining deltas (filed): `2>&1` merge drops the separating newline after stderr; `pwd`/error
  names need GNU rendering mode. Both are small, enumerable, and facade-load-bearing.
- Spike lesson re-confirmed: any standalone entry point must import `install-all.js`; without
  handler registration everything degrades to native passthrough (the wave-2 lesson, now
  standing CI guidance for the facade's own smoke test).
