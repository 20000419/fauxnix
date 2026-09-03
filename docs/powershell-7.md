# PowerShell 7 support

Windows PowerShell 5.1 remains fauxnix's built-in default. PowerShell 7 is an
opt-in compatibility tier that runs the same unit, integration, package, and
performance checks in CI.

## Select PowerShell 7

Install PowerShell 7 so `pwsh.exe` is in a non-empty, absolute `PATH` directory,
then set the variable **before** starting fauxnix:

```powershell
$env:FAUXNIX_PS = 'pwsh'
fauxnix check
```

`check` must report the resolved absolute `pwsh.exe` path and `edition : Core`.
For an MCP integration,
set `FAUXNIX_PS=pwsh` in the environment that launches the harness and restart
the harness. Changing the variable inside a running fauxnix shell does not
replace its resident host.

Accepted values are case-insensitive:

| `FAUXNIX_PS` | Selected host |
|---|---|
| unset or empty | fixed `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (`Desktop`, default) |
| `powershell` or `powershell.exe` | same fixed system executable (`Desktop`) |
| `pwsh` or `pwsh.exe` | first eligible absolute `PATH` match (`Core`) |

Any other value is a configuration error. If the requested executable is
missing, `check`/`doctor` return nonzero and command execution exits 127 with
recovery guidance; fauxnix never silently switches editions.

The Desktop entries resolve only to
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`. The Core entry is
resolved once from `PATH`, ignoring empty entries, relative entries, and an
absolute entry equal to the current working directory. The resulting absolute
path is fixed for the session, including host restarts. This deliberately avoids
normal Windows current-directory executable search: placing a same-named EXE in
the active checkout does not select it. Arbitrary executable paths remain
unsupported. Other absolute `PATH` entries are still process-startup
configuration and are honored in their declared order.

## Compatibility contract

- The bash surface, output framing, exit codes, timeout behavior, and native
  argv path are the same on both editions. A difference is a bug unless it is
  documented here.
- PowerShell 7 is installed separately; Windows PowerShell 5.1 ships with
  supported Windows versions.
- Startup latency can differ by host version. The warm-host performance budgets
  are identical and run against both editions in CI.
- `FAUXNIX_NATIVE_ENCODING` remains an independent setting. Selecting `pwsh`
  does not change its value or the documented native-tool encoding policy.
- fauxnix supplies its fixed `-NoProfile -NonInteractive -ExecutionPolicy
  Bypass` arguments. `FAUXNIX_PS` is an edition selector, not a place for extra
  PowerShell arguments or an arbitrary executable path.

Run the local matrix manually:

```powershell
Remove-Item Env:FAUXNIX_PS -ErrorAction SilentlyContinue
npm test

$env:FAUXNIX_PS = 'pwsh'
npm test
```
