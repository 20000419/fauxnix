# RFC: compiled MCP batch plans

## Motivation

The resident PowerShell host removed most per-command process startup, but it
did not remove the agent/model round trip around every MCP call. The existing
Codex benchmark already exposes that distinction: bundled PowerShell used five
tool calls and 159 seconds, while granular fauxnix use took eleven calls and
213 seconds. The same document notes that models which batch known commands
close most of the gap.

The original `bash` tool can already execute `;`, `&&`, and `||`, but its
current schema offers no explicit multi-step affordance or per-step result.
The server also cannot safely guess that a future MCP request should have been
merged: it must answer the current request before it knows the next command.

## Contract

`bash_batch` is an additive MCP tool; the existing `bash` schema and result stay
unchanged.

```json
{
  "steps": [
    { "id": "prepare", "command": "mkdir -p out && cd out" },
    { "id": "write", "command": "printf 'a\\r\\nb' > data.txt" },
    { "id": "measure", "command": "wc -c data.txt" }
  ],
  "stop_on_error": true,
  "timeout_ms": 120000,
  "stdout_limit_bytes": 262144,
  "stderr_limit_bytes": 65536
}
```

- 1–32 steps; optional IDs are labels only. Each command is at most 16,384 characters.
- Every command is parsed and translated before step 1 executes. A compile
  error therefore produces zero command side effects.
- Steps execute serially under one session lifecycle lock. No ordinary run or
  reset can interleave, and later steps see earlier cwd, environment, and file
  changes.
- Timeout and stdout/stderr limits cover the complete batch, not each step.
- Output defaults and maxima are 256 KiB stdout and 64 KiB stderr, leaving
  room for duplicated text/structured output and JSON escaping in stdio.
- `stop_on_error` defaults to true. Timeout, cancellation, and host startup
  failure always stop; ordinary nonzero exits may continue when explicitly
  requested.
- Structured content reports every requested step as completed, failed,
  timed-out, cancelled, infrastructure-error, compile-error, or skipped.
  Ordinary shell failure is not an MCP protocol failure.

## Compile and execute phases

The compiler phase produces the existing deterministic `SegmentPlan` IR for
every step. The executor then runs those groups through one atomic
`FauxnixSession.runBatch()` call. This removes model/harness turns while
preserving the mature parser, redirect, timeout, cancellation, and host-frame
contracts.

This first slice does **not** fuse every segment into one PowerShell frame.
`runPlans()` still invokes the host per segment because redirects, cwd changes,
and bash list status need their existing boundaries. Safe frame fusion can be
a later optimization over the same batch IR.

Batch compilation uses the existing pure translation context so it never reads
operand files. `sed -f` is rejected with an inline `sed -e` alternative, including
when nested in a compound command. This prevents preflight from reading scripts
under the server's cwd instead of the evolving session cwd.

## Byte-exact tasks

Batching does not make a model better at mentally counting CRLF bytes. Both
`bash` and `bash_batch` descriptions instead direct agents to measure the file
with `wc -c` or `stat -c %s`. This turns an encoding inference into a
deterministic verification step that can live in the same MCP request.

## Failure modes

| Event | Result |
|---|---|
| Any parse/translation failure | Zero steps execute; failing index/ID is returned |
| Ordinary nonzero exit | Stop and mark later steps skipped by default; optionally continue |
| Total deadline expires | Current step is timed out, remaining steps skipped, host recovery unchanged |
| AbortSignal fires | Current step is cancelled, remaining steps skipped, next session call remains usable |
| Host start failure | Stop as infrastructure error; do not execute later steps |
| Caller output budget exhausted | Later side effects still run when policy allows, but returned output remains globally bounded |
| Concurrent run/reset | Waits outside the one batch lifecycle lock; never interleaves between steps |

## Local directional baseline

Using the official MCP SDK on Windows PowerShell 5.1, a 15-round alternating
microbenchmark after warmup measured ten separate calls at median 337.8 ms and
one ten-step batch at 323.2 ms (about 4.5%). Shorter runs varied substantially;
this is directional evidence, not a large execution-speed claim. The batch
reduces ten tool turns to one when the agent submits the known sequence upfront.
An end-to-end model benchmark is needed to measure that additional benefit.
Run `npm run benchmark:mcp-batch` to repeat the local transport comparison.

## Non-goals

- Guessing or delaying future MCP calls to merge them automatically.
- Transactional rollback of file/process side effects.
- Hiding intermediate results when the model truly must interpret them.
- Claiming a single PowerShell frame or a fix for model reasoning on CRLF.
- Replacing shell pipelines, variables, loops, or `&&` when those are clearer.

## Verification

- whole-plan compile failure has zero side effects
- cwd/environment/files persist across steps
- stop/continue policy and skipped statuses
- one total deadline and cancellation recovery
- stdout/stderr budgets shared across all step results
- file redirects remain complete outside response budgets
- batch and ordinary session calls cannot interleave
- official MCP client discovers `bash_batch` and verifies a CRLF file via
  `wc -c` in one tool call
