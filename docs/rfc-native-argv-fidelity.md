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
- Stdout/stderr start concurrent `FauxnixTextPump.CopyAsync` drains into
  temporary disk spools **before** stdin is written (a chatty child must not
  fill the 64KB pipe). After the child exits, the spools are replayed through
  the bounded host capture or the next pipeline stage and then removed.
- Empty `[object[]]` must not unwrap to `$null` (that became a phantom `""`
  argv). `.cmd`/`.bat` Applications go through `cmd.exe /d /s /c` because
  `CreateProcess` cannot launch them with `UseShellExecute = $false`. The
  `/c` tail is wrapped in extra quotes (`/s` strips that pair), delayed
  expansion is forced off, and arguments containing `! ^ & | ( ) < >` are
  quoted so cmd.exe does not split them. A separate `fx-cmdargv` boundary
  rejects `%`, embedded double quotes, CR/LF, and NUL because cmd.exe cannot
  represent those values losslessly in this command-string path.
- Pipelines still work: `$input` is copied to the child stdin; stdout/stderr
  are captured without the `& @array` splat.
- Dynamic/`[@]` command names use the same helper. If the name is not an
  Application (e.g. splat that expands to `echo`), fall back to `&` so PS
  aliases still run; empty-argv fidelity applies to executables.
- Translated builtins are unchanged (they never went through `& @array`).
- `xargs` composing a native command uses `fx-native $fx_cmd $fx_argv` (typed
  object array, no splat). Built-ins are still rejected; `-t`/`-n`/`-I`/
  `--no-run-if-empty` are unchanged. `fx-native` already records
  `$script:fx_exit` from ExitCode, so xargs does not also copy `$LASTEXITCODE`.

## Non-goals

- Lossless `.cmd`/`.bat` arguments outside the documented `fx-cmdargv`
  character contract; they fail loudly instead of being rewritten.
- `pwsh` 7 `ArgumentList`.
- Version bump / npm publish.

## Tests

`node dump-argv.js` (`JSON.stringify(process.argv.slice(2))`) with:
empty arg, space, embedded `"`, leading `--foo`.
(`node -e` is a bad oracle on Windows: `-e` is omitted from `process.argv`,
so `slice(2)` drops the first user argument.)
`printf -- 'a b\n' | xargs node dump-argv.js` → `["a","b"]` (xargs splits on blanks).
Direct `.cmd`/`.bat` plus xargs default/`-n`/`-I` cover preserved empty,
space, backslash, parentheses, `! ^ & | < >` arguments and fail-loud `%`,
double-quote, CR/LF, and NUL boundaries.
  });

`.cmd` that echoes `%*`: `'a&b'` / `'--flag=a&b'` stay one argument containing `&`.
