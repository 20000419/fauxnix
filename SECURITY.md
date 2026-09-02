# Security

fauxnix is a local shell translator. Pointing an agent at `fauxnix mcp` is
the same trust decision as giving that agent a Bash tool: it runs **as you,
on this machine, with no sandbox**.

This is not a security product. Isolation and approval belong to the
harness (Claude Code, Codex, OpenCode, …), not to fauxnix. The 1.0 RFC
lists sandboxing policy as a non-goal.

## Trust model

- **Same user, same privileges.** `fauxnix` and `fauxnix mcp` spawn
  `powershell.exe` as the logged-in user. Translated commands (`rm`,
  `chmod`, `kill`, …) and native passthrough (`git`, `node`, `npm`,
  `python`, `cargo`, … via `fx-native`) inherit that identity.
- **No isolation.** There is no container, AppContainer, filesystem jail,
  or Windows Job Object around the session. MCP `bash` persists cwd,
  `export`/`unset`, and environment across calls like a logged-in shell.
- **MCP annotations are honest.** The `bash` tool is `destructiveHint: true`,
  `openWorldHint: true`, `readOnlyHint: false`. `fauxnix_translate` never
  executes. `fauxnix_session` can inspect or reset the host.
- **Approval is the harness's job.** Codex non-interactive `exec` auto-denies
  MCP tools unless `--dangerously-bypass-approvals-and-sandbox`. fauxnix
  does not add a second prompt.

## Host-protocol surface

One `FauxnixSession` owns one resident `powershell.exe` 5.1 process
(`src/ps-host.ts`; RFC
[`docs/rfc-persistent-powershell-host.md`](docs/rfc-persistent-powershell-host.md)).

The host is started as:

```
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <temp>/fauxnix-<id>-host.ps1
```

Frames are UTF-8 JSON lines on the process stdin/stdout pipes (raw
`OpenStandardInput`/`OpenStandardOutput`, not PS 5.1's default UTF-16LE
pipe encoding). Command stdout/stderr travel as base64 so the pipe
encoding cannot scramble bytes.

Handshake (protocol v2; v1 `{"ready":true}` is still accepted):

```json
{"v":2,"type":"ready","capabilities":{"cancel":false,"maxChunkBytes":65536,"stderrMarker":true}}
```

Node → host, per segment:

```json
{"v":2,"type":"run","id":"…","scriptB64":"…","env":{"FAUXNIX_CWD":"…","FAUXNIX_PREV_EXIT":"0","FAUXNIX_STDIN_FILE":""},"stdoutLimit":8388608,"stderrLimit":1048576}
```

`scriptB64` is decoded to UTF-8 and invoked as a scriptblock in that
process. `env` values are strings; an empty string unsets the variable
(so a missing `<` redirect cannot leak `FAUXNIX_STDIN_FILE`). The host
emits chunked `stdout`/`stderr` frames plus an `end` frame. Native exe
stderr on the OS pipe is delimited with `FAUXNIX_ERR_END:<id>`.

`capabilities.cancel` is **false**: the host cannot stop an in-flight
`& $fx_sb` without killing the process. `fauxnix translate` never starts
a host. Session sidecars live under `%TEMP%`
(`fauxnix-<id>-host.ps1`, `-cwd.txt`, `-env.json`, `-script.ps1`).

## Kill semantics

Cancel and timeout **kill the host process**. The next `run()`
cold-starts a new `powershell.exe`. This is the RFC #129 leftover:
per-frame runspace `Stop()` (roadmap B3) is not implemented.

| Event | What happens |
|---|---|
| MCP `extra.signal` abort | `ChildProcess.kill()` on `powershell.exe`. Result: `cancelled: true`, exit **130**. Later list segments do not run. |
| `timeout_ms` / `ExecOptions.timeoutMs` (default 120s) | Same kill. Result: `timedOut: true`, exit **124**. |
| `fauxnix_session reset` / `dispose()` | Kill host, unlink temp files. Reset re-prewarms the same session object. |
| Stdio EOF / SIGINT / SIGTERM | Idempotent dispose. |
| Host dies mid-frame | That frame fails; the script is **not** retried. Next `run()` cold-starts. |

`ChildProcess.kill()` does **not** assign a Windows Job Object.
Grandchildren the script spawned may survive the host. Job-object tree
kill is roadmap B4, not shipped. Details:
[`docs/rfc-bounded-cancellable-execution.md`](docs/rfc-bounded-cancellable-execution.md).

## Network guard

`curl` and `wget` run `fx-netguard` (`src/commands/net.ts`) over every
argv element that starts with `http://` or `https://` **before**
`curl.exe` / `wget.exe` is launched. Matching destinations are refused
with `curl: fauxnix refused private/loopback address …` (exit 1).

Refused hosts: `localhost`, `::1`, `127.x`, `10.x`, `192.168.x`,
`169.254.x`, `172.16–31.x`.

This is a **safety default for agent-driven HTTP**, not a sandbox and
not a complete SSRF defense:

- Only `curl` / `wget`. `ping`, `nslookup`, `dig`, `host`, and native
  passthrough are unguarded.
- Hostname strings are not DNS-resolved; a public name that points at a
  private address is not blocked.
- Non-`http(s)` URLs, post-connect redirects, IPv6 ULA/link-local besides
  `::1`, and decimal/hex IP encodings are out of scope.

## Reporting

Report vulnerabilities via
[GitHub Security Advisories](https://github.com/20000419/fauxnix/security/advisories/new)
(private). Public [issues](https://github.com/20000419/fauxnix/issues)
are fine when the finding is already obvious from this document (for
example “there is no sandbox”) or you cannot open an advisory.

Include `fauxnix --version` (npm package `fauxnix-cli`), a local
reproducer, and impact. Pre-1.0, the supported target is the latest
npm release.
