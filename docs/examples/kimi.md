# Kimi Code

fauxnix is a bash→PowerShell translation layer for AI agents on Windows — no WSL, no VM. This harness talks to it over MCP stdio (`fauxnix mcp`); the tool name is `bash`.

## Prerequisites

- Windows
- Node.js ≥ 18
- `npm i -g fauxnix-cli` (the installed command is still `fauxnix`)
- PowerShell 5.1 (built-in)

## Install

Preferred (idempotent; writes the same keys as the block below):

```bash
fauxnix install --kimi
```

If `install` is not in your build, paste the block by hand.

**Path:** `%USERPROFILE%\.kimi-code\mcp.json`

MCP servers live in this JSON file, not the Kimi TOML config. If `KIMI_CODE_HOME` is set, the file is `%KIMI_CODE_HOME%\mcp.json` instead. Merge `mcpServers.fauxnix`; do not wipe other servers.

```json
{
  "mcpServers": {
    "fauxnix": { "command": "fauxnix", "args": ["mcp"] }
  }
}
```

## Verify

```bash
fauxnix check
fauxnix doctor
```

Encoding is UTF-8 by default (`FAUXNIX_NATIVE_ENCODING` unset). v0.10.0 `doctor` does not list a kimi row; it still confirms PowerShell, encoding, and `mcp : module loads`. Restart Kimi Code so it reloads MCP.

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
