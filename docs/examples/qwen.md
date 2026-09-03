# Qwen Code

fauxnix is a bash→PowerShell translation layer for AI agents on Windows — no WSL, no VM. This harness talks to it over MCP stdio (`fauxnix mcp`); the tool name is `bash`.

## Prerequisites

- Windows
- Node.js ≥ 18
- `npm i -g fauxnix-cli` (the installed command is still `fauxnix`)
- PowerShell 5.1 (built-in)

## Install

Preferred (idempotent):

```bash
fauxnix install --qwen
```

The installer writes an absolute launcher for the Node executable and this
fauxnix installation's `dist/index.js`. That keeps Qwen Code startup independent
of its working directory and `PATH` order. Re-run the installer after moving or
reinstalling Node.js or fauxnix-cli.

**Path:** `%USERPROFILE%\.qwen\settings.json`

The generated shape is shown below. Paths are examples; use the values written
by `fauxnix install --qwen` rather than copying them from another machine.

```json
{
  "mcpServers": {
    "fauxnix": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\fauxnix-cli\\dist\\index.js",
        "mcp"
      ]
    }
  }
}
```

## Verify

```bash
fauxnix check
fauxnix doctor
```

Encoding is UTF-8 by default (`FAUXNIX_NATIVE_ENCODING` unset). `doctor` reports
whether Qwen's fauxnix entry uses the generated absolute launcher. Restart Qwen
Code so it reloads MCP.

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
