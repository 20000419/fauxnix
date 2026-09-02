# Harness quickstarts

Copy-paste MCP config and a 10-command smoke for each harness. Preferred installer is `fauxnix install --<harness>` (RFC U-1); each page also has the same keys for a manual paste. Smoke is v0.10.0-safe (no `while`/`until`/`case`, no arrays). Encoding is UTF-8 by default.

| Harness | Config file | Install |
|---|---|---|
| [Claude Code](claude.md) | `%USERPROFILE%\.claude.json` | `fauxnix install --claude` |
| [Codex](codex.md) | `%USERPROFILE%\.codex\config.toml` | `fauxnix install --codex` |
| [OpenCode](opencode.md) | `%USERPROFILE%\.config\opencode\opencode.json` | `fauxnix install --opencode` |
| [Kimi Code](kimi.md) | `%USERPROFILE%\.kimi-code\mcp.json` | `fauxnix install --kimi` |
| [Qwen Code](qwen.md) | `%USERPROFILE%\.qwen\settings.json` | `fauxnix install --qwen` |

Env overrides (when set): `CLAUDE_CONFIG_DIR` → that dir `\.claude.json`; `CODEX_HOME` → `%CODEX_HOME%\config.toml`; `XDG_CONFIG_HOME` → `%XDG_CONFIG_HOME%\opencode\opencode.json`; `KIMI_CODE_HOME` → `%KIMI_CODE_HOME%\mcp.json`. Qwen has no override.

Each page: prerequisites, one-liner + manual block, `fauxnix check` / `fauxnix doctor`, then the smoke. After install, restart the harness so it reloads MCP (`fauxnix mcp`). RFC 1.0 **U-4** / #118.
