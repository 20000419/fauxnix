# RFC: per-stage redirection ownership

Follow-up to [#131](https://github.com/20000419/fauxnix/issues/131) item 2.
Foundational contracts (#129 host, #130 CommandSpec) have landed; this is the
focused implementation RFC the audit asked for.

## Why

`translateCommandList` concatenates every pipeline command's redirects into one
segment-level list. The executor then applies that list to the **whole**
pipeline after capture.

Two independently reproduced failures:

| Command | bash | fauxnix today |
|---|---|---|
| `echo hi >/dev/null` | no output | prints `hi` (`devNull` is set and never applied) |
| `printf x \| cat < README.md \| head -1` | first line of README | `x` (`<` is fed to stage 0) |

A correct model is bash's: each pipeline stage owns its fds. A stdin redirect
on a middle stage **replaces** the pipe, it does not move to the first stage.
`>/dev/null` discards that stage's stdout; for a one-command segment that is
the caller's stdout.

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
- Non-last-stage **stdout** redirects (`echo hi >f \| cat`) stay a documented
  follow-up: they need the stage to write the file inside PowerShell instead of
  the pipe. Not silent-wrong for the audit's two cases.

## Non-goals

- Heredocs, process substitution, `n>` for fds other than 1/2.
- Job-object / Linux hosts.
- Version bump / npm publish.

## Tests

- `echo hi >/dev/null` → empty stdout, no `NUL` file in cwd.
- `printf x | cat < fruits.txt | head -1` → `apple`.
- Existing `> >> 2>/dev/null 2>&1` and failed-`>` order tests stay green.
