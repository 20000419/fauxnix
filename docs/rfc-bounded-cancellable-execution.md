# RFC: Bounded, cancellable, stream-preserving execution results

Follow-up to the persistent PowerShell host ([#115](https://github.com/20000419/fauxnix/pull/115) / [docs/rfc-persistent-powershell-host.md](./rfc-persistent-powershell-host.md)).
Tracks [#129](https://github.com/20000419/fauxnix/issues/129) as the v0.8 wire/result contract (paired with [#130](https://github.com/20000419/fauxnix/issues/130)).

## Why the one-line host frame is now the bottleneck

The resident `powershell.exe` delivered the latency win. The spawn-era convenience of “one JSON line per segment, flatten into one MCP text blob” now crosses several boundaries the suite did not exercise:

1. **Native stderr is outside the frame.** `[Console]::SetError()` captures PowerShell/.NET writes; `git`/`npm`/`node` still write the OS stderr handle. Node appends those bytes to `stderrChunks` and never reads them.
2. **One result is unbounded.** PowerShell buffers both streams, base64-encodes them, and sends one JSON line. An 11 MB MCP result exceeds the SDK’s 10 MiB read buffer and closes the connection. PS 5.1 `ConvertTo-Json` itself caps at ~2 MiB (`MaxJsonLength`).
3. **Cancellation is not execution cancellation.** The MCP SDK provides `extra.signal`; the bash handler ignores it. Cancelling `sleep 3` returns to the client while the command keeps the session lock.
4. **Lifecycle operations race.** Concurrent `fauxnix_session reset` can create multiple live hosts. Stdio EOF does not dispose the session.
5. **The MCP result loses structure.** stdout/stderr/exit are flattened; `.trim()` drops whitespace-only output; infrastructure failures look like shell exits.

These are one cluster: framing, limits, cancellation, and lifecycle need an explicit contract before a v1 interface freeze.

## Constraints

- Windows PowerShell 5.1 remains the execution baseline.
- One persistent host per `FauxnixSession` remains the latency model.
- Existing MCP clients must keep receiving readable `content[].text` during migration.
- The stdio transport has a finite frame limit and is not an unbounded byte pipe.
- Timeout/cancellation must terminate the owned process or explicitly report a weaker guarantee.
- `ChildProcess.kill()` does **not** job-object the process tree (same as today’s timeout). Grandchildren may survive. Windows Job Object kill-on-close is a later step (roadmap B4), not this RFC’s first land.

## Implementation split

| PR | Ships | Does not ship |
|---|---|---|
| **A (this land)** | RFC; structured MCP results; `extra.signal` cancel by killing the host (same recovery as timeout); one lock for run/reset/dispose; dispose on stdin EOF / SIGINT / SIGTERM; stop `.trim()` of whitespace-only stdout; drain/clear native `stderrChunks` per request; ConvertTo-Json overflow becomes a loud frame error instead of a dead loop | v2 handshake, chunked frames, deterministic native-stderr marker |
| **B (follow-up)** | `{v:2,type:ready,…}` handshake (still accept v1 `{ready:true}`); chunked stdout/stderr + `end`; `stdoutLimit`/`stderrLimit` + `truncated`; `FAUXNIX_ERR_END:<id>` marker on the OS stderr pipe so native bytes return exactly once | runspace `Stop()` in-flight cancel; Job Object tree kill; Linux/macOS |

PR-A keeps speaking the v1 host frame:

```json
{"ready":true}
{"id":"f…","scriptB64":"…","env":{"FAUXNIX_CWD":"…","FAUXNIX_PREV_EXIT":"0","FAUXNIX_STDIN_FILE":""}}
{"id":"f…","stdoutB64":"…","stderrB64":"…","exitCode":0}
```

PR-B proposed frames (Node still reassembles into one `ExecResult`; MCP clients never see host chunks):

```json
{"v":2,"type":"ready","capabilities":{"cancel":false,"maxChunkBytes":65536,"stderrMarker":true}}
{"v":2,"type":"run","id":"r1","scriptB64":"…","env":{},"stdoutLimit":8388608,"stderrLimit":1048576}
{"v":2,"type":"stdout","id":"r1","seq":0,"dataB64":"…"}
{"v":2,"type":"stderr","id":"r1","seq":0,"dataB64":"…"}
{"v":2,"type":"end","id":"r1","exitCode":0,"timedOut":false,"cancelled":false,"truncated":false}
```

`capabilities.cancel: false` is honest until a nested runspace can read a cancel frame while `& $fx_sb` is running. Until then Node kills the host process, matching timeout recovery.

## MCP result contract (PR-A)

During migration, return both the current text content and versioned structured content:

```json
{
  "schemaVersion": 1,
  "stdout": "   ",
  "stderr": "",
  "exitCode": 0,
  "timedOut": false,
  "cancelled": false,
  "truncated": false,
  "sessionId": "a1b2c3d4"
}
```

- Normal shell nonzero exits stay command results (`isError` unset). Host startup failure, malformed frames, translate/parse throws, and a dead transport are infrastructure (`isError: true`).
- Whitespace-only stdout is byte-faithful in `structuredContent.stdout`. The text view may still strip a single trailing newline for display; it must not `.trim()`.
- Cancel uses exit **130** (`128+SIGINT`). Timeout stays **124**.
- Default budgets: 8 MiB stdout, 1 MiB stderr. Crossing a budget sets `truncated: true` and must not close the MCP connection.

## Failure modes

| Event | Behavior |
|---|---|
| `extra.signal` abort | Kill the host (same as timeout). Return `cancelled: true`, exit 130. Later list segments do not run. Next `run()` cold-starts a host. |
| `ExecOptions.timeoutMs` | Unchanged: kill host, exit 124, session remains usable. |
| Concurrent `reset` / `run` / `dispose` | One lifecycle lock. Exactly one live host after they settle. `reset()` mutates the existing `FauxnixSession` (does not allocate a second object). |
| Stdio EOF / SIGINT / SIGTERM | Idempotent `dispose()`: stop host, unlink cwd/env/script/host temp files. |
| Native stderr on the OS pipe | PR-A: concatenate whatever arrived on the pipe during the frame and **clear** `stderrChunks`. Not deterministic across two OS pipes (stated). PR-B: `FAUXNIX_ERR_END:<id>` marker. |
| ConvertTo-Json > ~2 MiB | Loud stderr on that frame (`exit 1`), host loop stays alive. PR-B chunks so this path is unused for payload. |
| `powershell.exe` missing | Unchanged 127 + sandbox message. Marked as infrastructure in MCP. |

## Non-goals

- Linux/macOS execution.
- Turning fauxnix into a security sandbox.
- Changing bash’s normal exit-code semantics.
- Requiring every MCP client to consume streaming chunks.
- Version bump / npm publish.
- Job-object tree kill (B4) and per-frame runspace `Stop()` (B3).

## Correctness that must stay green

Session cwd, `FAUXNIX_SETVALS` / arrays, prefix `VAR=value` non-leak, `[[ ]]` + `BASH_REMATCH`, `if`/`for`, redirects including `2>&1` and failed `>` order, timeout 124, no-powershell 127, warm `echo hi` p50, PATHEXT restore.
