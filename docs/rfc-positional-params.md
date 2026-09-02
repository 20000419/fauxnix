# RFC: positional parameters (`$1`, `$#`, `$@`, `set --`)

Tracking: [#118](https://github.com/20000419/fauxnix/issues/118) item **C-3**.
Status: proposed mini-RFC (discussion on #118 before implementation).

## Why

Agent scripts use `$1` / `"$@"` constantly (`grep -n "$1"`, `set -- "$@" extra`).
fauxnix’s MCP `bash` tool has **no argv**: each call is one command string, not
`bash script.sh a b c`. Inventing `$1` from the chat would be silently wrong.

## Contract (proposed)

- **Source of truth is the session**, not the MCP JSON-RPC frame.
- `set -- a b c` stores a session-scoped positional list (persist like
  `export` / `cd` via the host env sidecar).
- `$1`..`$n`, `$#`, `$*`, `"$@"` expand from that list. Unset list ⇒ empty
  (`$#` = 0), not a crash.
- `$0` is the string `fauxnix` (CLI) or the MCP tool name (`bash` by default).
  Not the Windows executable path.
- `shift` drops `$1`. `set --` with no words clears the list.
- CLI one-shot `fauxnix "echo $1"` has empty positionals unless the command
  itself runs `set --`.
- No `FAUXNIX_ARGV` smuggling from the harness unless a later MCP tool
  (`fauxnix_session`) is specified in a follow-up. Out of this RFC.

## Non-goals

- Real `bash script.sh args` invocation (no script file runner).
- Functions’ local `$1` (functions are 1.0 wontfix).
- `getopts`.
- Version bump.

## Tests (when implemented)

- `set -- a b; echo $1 $#` → `a 2`
- `set -- a b; echo "$@"` → `a b`
- `set -- a 'x y'; echo "$2"` → `x y`
- MCP: two tool calls; second `echo $1` still sees the first call’s `set --`
  in the same session; `reset` clears it.

## Ask

Confirm `set --` as the only writer for v0.10. If a harness needs to inject
argv, that is a new MCP tool, not a hidden env.
