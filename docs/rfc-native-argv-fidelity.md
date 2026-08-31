# RFC: native argv fidelity on PowerShell 5.1

Follow-up to [#131](https://github.com/20000419/fauxnix/issues/131) item 4.

## Why

Native passthrough uses `& $name @fx_na`. On Windows PowerShell 5.1 that is
**not** CreateProcess argv:

| Source | `node` argv slice(2) |
|---|---|
| direct Node `"" "a b"` | `["", "a b"]` |
| through fauxnix | `["a b"]` (empty dropped) |
| argument `a"b` | `ab` (quote eaten) |

Empty config values, compiler `-DFOO=""`, and embedded quotes silently change.
That violates fail-loud / never silently-wrong.

## Contract

- Literal native invocations (git/node/npm/…) go through `fx-native`, which
  builds a Win32 command line (`fx-winargv`) and starts
  `System.Diagnostics.Process` with redirected stdio. Empty arguments become
  `""`; quotes follow the CRT quoting rules.
- Stdout/stderr are `ReadToEndAsync` started **before** writing stdin (a
  chatty child must not fill the 64KB pipe). PS 5.1 cannot run a scriptblock
  on the thread pool, so `Task.Factory.StartNew({ $p.StandardOutput.ReadToEnd() })`
  throws and the wrap catch turns that into exit 1.
- Empty `[object[]]` must not unwrap to `$null` (that became a phantom `""`
  argv). `.cmd`/`.bat` Applications go through `cmd.exe /d /s /c` because
  `CreateProcess` cannot launch them with `UseShellExecute = $false`. The
  `/c` tail is wrapped in extra quotes (`/s` strips that pair); arguments
  containing `& | ( ) < > ^` are CRT-quoted so cmd.exe does not split them.
- Pipelines still work: `$input` is copied to the child stdin; stdout/stderr
  are captured without the `& @array` splat.
- Dynamic/`[@]` command names use the same helper. If the name is not an
  Application (e.g. splat that expands to `echo`), fall back to `&` so PS
  aliases still run; empty-argv fidelity applies to executables.
- Translated builtins are unchanged (they never went through `& @array`).
- `xargs` composing a native command is a follow-up (it still builds `&`).

## Non-goals

- Byte-identical cmd.exe quirks beyond that quoting (`%VAR%` expansion,
  delayed-expansion `!`, nested quote encoding).
- `pwsh` 7 `ArgumentList`.
- Version bump / npm publish.

## Tests

`node dump-argv.js` (`JSON.stringify(process.argv.slice(2))`) with:
empty arg, space, embedded `"`, leading `--foo`.
(`node -e` is a bad oracle on Windows: `-e` is omitted from `process.argv`,
so `slice(2)` drops the first user argument.)
`.cmd` that echoes `%*`: `'a&b'` / `'--flag=a&b'` stay one argument containing `&`.
