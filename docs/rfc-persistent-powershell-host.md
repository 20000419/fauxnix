# RFC: Persistent PowerShell host per FauxnixSession

Follow-up to [#111](https://github.com/20000419/fauxnix/issues/111) / [#114](https://github.com/20000419/fauxnix/pull/114).
Not a request to implement word-level `$((…))` — that stays a loud reject until a later PR.

## Why spawn is the latency root cause

#114 slimmed `wrapScript` so `echo hi` no longer ships the full ~170-line `fx-*` catalog.
Maintainer measurement on that branch:

> **1.25s/cmd vs 1.26s on main** — wall time is unchanged because `powershell.exe` spawn + Node startup dominate, and parsing the old preamble was only milliseconds.

Today every `SegmentPlan` is `spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'|'-File'])`.
`FauxnixSession` already persists cwd / env / `$?` across calls via temp files, but the process is thrown away each time.

The architectural lever is one resident `powershell.exe` per session, with an RPC-style frame for each translated segment.

## Proposal

- One MCP / CLI `FauxnixSession` = one `powershell.exe` 5.1 host.
- Node sends one JSON line per segment; the host captures stdout/stderr, returns one JSON line, and **does not `exit`**.
- `Set-Location` + `[Environment]::CurrentDirectory` stay in that process so the next frame sees the same cwd.
- `fauxnix_session reset` / `dispose()` kill the host.
- `fauxnix translate` still prints a spawn-style script and never starts a host.

## Protocol

UTF-8 JSON lines on the process stdin/stdout pipes (raw `OpenStandardInput` / `OpenStandardOutput` + `UTF8Encoding($false)` so PS 5.1's default UTF-16LE pipe encoding does not own the channel).

Host → Node, once at boot:

```json
{"ready":true}
```

Node → Host, per segment:

```json
{"id":"<uuid>","scriptB64":"<utf-8 script>","env":{"FAUXNIX_CWD":"...","FAUXNIX_PREV_EXIT":"0","FAUXNIX_STDIN_FILE":""}}
```

`env` values are strings. An empty string unsets that variable (so a missing `<` redirect cannot leak `FAUXNIX_STDIN_FILE`).

Host → Node:

```json
{"id":"<uuid>","stdoutB64":"<bytes>","stderrB64":"<bytes>","exitCode":0}
```

Captured command streams are the UTF-8 bytes of `[Console]::Out` / `[Console]::Error` after redirecting those writers for the frame. Pipeline objects (`Write-Output` / `fx-write` line mode) are `WriteLine`d to the same `Console.Out` as they arrive so `echo -n` / `printf` exact writes still interleave correctly. Node runs the existing `decodeOutput` + `normalizeHostNewlines` path on those bytes.

The per-frame script is `wrapScript(body, { mode: 'host' })`: same cwd/env persist files and try/catch as spawn mode, **no `exit`**, **no helper re-emit** (the bootstrap already defined every `fx-*`).

## Failure modes

| Event | Behavior |
|---|---|
| `powershell.exe` missing (`ENOENT`) | Same 127 + current Linux-sandbox message. No retry loop. |
| Host dies mid-frame | That frame fails with the close code / an unexpected-exit message. The next `run()` cold-starts a new host with `session.childEnv()` (cwd/env last synced from the sidecar files). **The failed script is not retried** (it may have been what killed the host). |
| `ExecOptions.timeoutMs` | Node kills the host process (grandchildren may survive — same limitation as today's `child.kill()`). Exit **124**, session remains usable; next command starts a fresh host. Per-frame runspace `Stop()` is a later optimization, not required to beat spawn latency. |
| Host ignores a frame / handshake timeout | Treated as a dead host: kill, cold start on the next command. |
| `set -e` | Unchanged loud reject, exit 2. |

## Non-goals

- Defaulting to `pwsh` 7 or WSL.
- Re-implementing bash inside PowerShell.
- Word-level `$((…))` (already loud-reject via #113).
- Windows job-object tree kill for timeout grandchildren.
- Dropping Node-side redirect preflight (`>` must not truncate a later file when an earlier redirect fails).
- Version bump / npm publish.

## Correctness that must stay green

Session cwd, `FAUXNIX_SETVALS` / array sidecars, prefix `VAR=value` non-leak, `[[ ]]` + `BASH_REMATCH`, `if`/`for`, redirects including `2>&1` and failed `>` order, timeout 124, no-powershell 127.
