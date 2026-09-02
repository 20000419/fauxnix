# RFC: per-stage redirection ownership

Follow-up to [#131](https://github.com/20000419/fauxnix/issues/131) item 2.
Foundational contracts (#129 host, #130 CommandSpec) have landed; this is the
focused implementation RFC the audit asked for.

## Why

`translateCommandList` concatenates every pipeline command's redirects into one
segment-level list. The executor then applies that list to the **whole**
pipeline after capture.

Two independently reproduced failures (fixed in #147):

| Command | bash | fauxnix before #147 |
|---|---|---|
| `echo hi >/dev/null` | no output | prints `hi` (`devNull` is set and never applied) |
| `printf x \| cat < README.md \| head -1` | first line of README | `x` (`<` is fed to stage 0) |

A correct model is bash's: each pipeline stage owns its fds. A stdin redirect
on a middle stage **replaces** the pipe, it does not move to the first stage.
`>/dev/null` discards that stage's stdout; for a one-command segment that is
the caller's stdout.

#147 applied last-stage output and per-stage `<`. That made a previously
accidental identity-pipe look wrong (`echo hi >f | cat` truncated `f` empty
and printed `hi`). C-6 first slice (#157): **fail loud** at translate time
for non-last `>` `>>` `&>` `&>>`. Full in-stage writes remain the follow-up.

## Contract

- Prep still walks **all** redirects left-to-right (failed earlier `>` must not
  truncate a later file). Missing `<` targets still fail before the command.
- **Output apply** (captured stdout/stderr → files / discard) uses the **last**
  stage's redirects only.
- **Stdin feed** (`FAUXNIX_STDIN_FILE`) uses the **first** stage's `<` only.
- A non-first stage with `< file` reads that file as `$input` and does not
  consume the previous stage's stream (the previous stage still runs).
- `< /dev/null` on any stage is empty input. `>/dev/null` / `&>/dev/null` on
  the last stage discards captured stdout (and stderr for `&>`).
- Successive stdout redirects last-win: `>/dev/null >file` writes the command
  output to `file`; `>file >/dev/null` truncates `file` and discards output.
  `2>/dev/null` must not undo a prior `>/dev/null`.
- Non-last-stage **stdout** redirects (`echo hi >f \| cat`) **fail at
  translate time** with an actionable alternative (`cmd >f; cat f` or wait
  for per-stage fds). In-stage writes (the stage writes the file inside
  PowerShell instead of the pipe) stay the #157 follow-up. `2>` on a
  non-last stage is still silently wrong and is not rejected in this slice.

## Non-goals

- Heredocs, process substitution, `n>` for fds other than 1/2.
- Job-object / Linux hosts.
- Version bump / npm publish.

## Tests

- `echo hi >/dev/null` → empty stdout, no `NUL` file in cwd.
- `echo hi >/dev/null > lastwins.txt` → file contains `hi`.
- `cat missing.txt &>/dev/null` → empty stderr.
- `printf x | cat < fruits.txt | head -1` → `apple`.
- Existing `> >> 2>/dev/null 2>&1` and failed-`>` order tests stay green.
- `echo hi >f | cat` → translate-time `FauxnixParseError` (C-6 first slice).
- `echo hi >f` and last-stage `echo hi | cat >f` still write.
