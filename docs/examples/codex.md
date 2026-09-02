# Codex

fauxnix is a bash→PowerShell translation layer for AI agents on Windows — no WSL, no VM. This harness talks to it over MCP stdio (`fauxnix mcp`); the tool name is `bash`.

## Prerequisites

- Windows
- Node.js ≥ 18
- `npm i -g fauxnix-cli` (the installed command is still `fauxnix`)
- PowerShell 5.1 (built-in)

## Install

Preferred (idempotent; writes the same keys as the block below):

```bash
fauxnix install --codex
```

If `install` is not in your build, paste the block by hand.

**Path:** `%USERPROFILE%\.codex\config.toml`

If `CODEX_HOME` is set, the file is `%CODEX_HOME%\config.toml` instead. Append the table; do not wipe other sections.

```toml
[mcp_servers.fauxnix]
command = "fauxnix"
args = ["mcp"]
```

Harness CLI equivalent: `codex mcp add fauxnix -- fauxnix mcp`.

In non-interactive `codex exec`, MCP tool calls are auto-denied by the approval layer. Pass `--dangerously-bypass-approvals-and-sandbox`, or run interactively and approve once.

## Verify

```bash
fauxnix check
fauxnix doctor
```

Encoding is UTF-8 by default (`FAUXNIX_NATIVE_ENCODING` unset). `doctor` reports `codex : fauxnix MCP configured (...)` when the table is present. Restart Codex so it reloads MCP.

## Smoke

Run each line through the MCP `bash` tool (not PowerShell). v0.10.0-safe: no `while`/`until`/`case`, no arrays. Comments are expected stdout; every command exits 0. The `for` loop prints two lines (`a` then `b`).

```
echo hi                          # hi
printf '%s=%d\n' x 42            # x=42
echo $(echo nested)              # nested
echo $((1+1))                    # 2
unset X; echo ${X:-def}          # def
if true; then echo YES; fi       # YES
for x in a b; do echo $x; done   # a\nb
false || echo FELLBACK           # FELLBACK
echo hi | grep hi                # hi
true; echo $?                    # 0
```

CLI equivalent (same stdout): `fauxnix 'echo hi'`.
