# RFC: positional parameters (`$1`, `$#`, `$@`, `set --`)

Tracking: [#118](https://github.com/20000419/fauxnix/issues/118) item **C-3**.
Status: **accepted / implemented**.

## Why

Agent scripts use `$1` / `"$@"` constantly (`grep -n "$1"`, `set -- "$@" extra`).
fauxnix’s MCP `bash` tool has **no argv**: each call is one command string, not
`bash script.sh a b c`. Inventing `$1` from the chat would be silently wrong.

## Contract (as implemented)

- **Source of truth is the session**, not the MCP JSON-RPC frame.
- `set --` is the only writer. `set -- a b c` stores a session-scoped list in
  `$env:FAUXNIX_POS` (packed with `fx-svenc` / char-30, like arrays) so the host
  env sidecar already dumps it. `set --` with no words clears. `set -e` stays
  the existing loud reject. `set` with no args stays a no-op.
- `$1`..`$n`, `$#`, `$*`, `"$@"` expand from that list. Unset list ⇒ empty
  (`$#` = 0, `$1` empty, `"$@"` empty), not a crash.
- `$0` is `$env:FAUXNIX_ARG0` if set, else `fauxnix`. MCP `startMcpServer` sets
  `process.env.FAUXNIX_ARG0` to the tool name (`bash` by default /
  `FAUXNIX_TOOL_NAME`) so child env inherits it — not a Windows path.
- `shift` [n] drops n (default 1) from the front. `shift` when empty (or past
  the end) is exit 1 and leaves the list unchanged, matching bash.
- CLI one-shot `fauxnix "echo $1"` has empty positionals unless the command
  itself runs `set --`.
- `fauxnix_session status` reports `positionals: N`.

## Non-goals

- Real `bash script.sh args` invocation (no script file runner).
- Functions’ local `$1` (functions are 1.0 wontfix).
- `getopts`.
- Version bump.

## Tests

- `set -- a b; echo $1 $#` → `a 2`
- `set -- a b; echo "$@"` → `a b`
- `set -- a 'x y'; echo "$2"` → `x y`
- MCP / session: two `run` calls; second `echo $1` still sees the first call’s
  `set --`; `reset` / `set --` clears it.
- Differential cases live in `test/differential/corpus.json`.
