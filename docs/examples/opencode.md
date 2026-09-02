# OpenCode

fauxnix is a bash→PowerShell translation layer for AI agents on Windows — no WSL, no VM. This harness talks to it over MCP stdio (`fauxnix mcp`); the tool name is `bash`.

## Prerequisites

- Windows
- Node.js ≥ 18
- `npm i -g fauxnix-cli` (the installed command is still `fauxnix`)
- PowerShell 5.1 (built-in)

## Install

Preferred (idempotent; writes the same keys as the block below):

```bash
fauxnix install --opencode
```

If `install` is not in your build, paste the block by hand.

**Path:** `%USERPROFILE%\.config\opencode\opencode.json`

If `XDG_CONFIG_HOME` is set, the file is `%XDG_CONFIG_HOME%\opencode\opencode.json` instead. Merge; do not wipe other keys.

Default shape (`mcp.fauxnix`):

```json
{
  "mcp": {
    "fauxnix": { "type": "local", "command": ["fauxnix", "mcp"] }
  }
}
```

If `mcp.servers` already exists as an object, put fauxnix there instead (`mcp.servers.fauxnix`) — do not also add a sibling `mcp.fauxnix`:

```json
{
  "mcp": {
    "servers": {
      "fauxnix": { "type": "local", "command": ["fauxnix", "mcp"] }
    }
  }
}
```

## Verify

```bash
fauxnix check
fauxnix doctor
```

Encoding is UTF-8 by default (`FAUXNIX_NATIVE_ENCODING` unset). `doctor` reports `opencode : fauxnix MCP configured (...)` when either shape is present. Restart OpenCode so it reloads MCP.

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
