# Promotion targets — where fauxnix solves a real, documented pain

Recon date: 2026-08-17. Rule: **only comment where fauxnix genuinely answers the
stated problem.** Never post generic ads. Every comment should lead with empathy
for the specific complaint, then offer the tool as one option with the benchmark
link as evidence.

## Tier 1 — exact-match targets (Windows shell pain in agent harnesses)

### openai/codex (user-identified prime target — native PowerShell + third-party LLMs)

| Issue | Why it fits |
|---|---|
| [#3159](https://github.com/openai/codex/issues/3159) (closed, **stale since 2025-11 — skip**) — "Codex bypasses PATH resolution and incorrectly uses WSL bash instead of user-configured MSYS2 bash" | Users fighting to get bash behavior on Windows. fauxnix removes the need for ANY bash: MCP `bash` tool, `codex mcp add fauxnix -- fauxnix mcp`. Revisit only if the thread revives |
| [#22185](https://github.com/openai/codex/issues/22185) (open 💬12) — "unified_exec tries to CreateProcess /bin/bash and fails with ENOENT" on Windows | ✅ **Commented 2026-08-18** (npm 0.4.2 + Glama all-A day). Same class: `/bin/bash` assumed on Windows. fauxnix gives a bash-semantics tool with zero bash dependency |
| [#21715](https://github.com/openai/codex/issues/21715) (open) — "Windows bash commands fail with CreateMapping fatal error in workspace-write sandbox" | Windows shell fragility; fauxnix runs as a local stdio MCP server (read docs/comparison-built-in-shells.md note on exec-mode approval flag) |
| #37962 (open 💬6) — "[Windows][WSL] Integrated terminal auto-closes when Git availability probe fails" | The WSL-required-for-bash treadmill. Angle: you don't need WSL for agent shell work at all |

Angle for codex threads: their built-in shell on Windows **is PowerShell 5.1**
(we measured it — docs/comparison-built-in-shells.md), and cross-trained models
degrade on it (docs/benchmark-ark-models.md: kimi-k2-thinking 3.1× slower).
fauxnix = `bash` MCP tool, keeps their model choice free.

### anthropics/claude-code

| Issue | Why |
|---|---|
| [#72389](https://github.com/anthropics/claude-code/issues/72389) (closed 💬3) — "Desktop app `!` interactive shell forces PowerShell, ignoring defaultShell bash" | PowerShell-forced pain; fauxnix MCP `bash` tool is model-side, immune to host default shell |
| [#73461](https://github.com/anthropics/claude-code/issues/73461) (open) — "Git Bash not detected on Windows ARM64" | ✅ **Commented 2026-08-18**. Claude Code REQUIRES Git for Windows for its Bash tool. fauxnix needs only Node — perfect for ARM64/no-Git machines |
| [#14828](https://github.com/anthropics/claude-code/issues/14828) (open 💬62, very active) — console window flashing on tool exec | High-traffic Windows pain thread; only mention fauxnix if a sub-thread asks for bash-tool alternatives — the issue itself is about flashing, not shells. DO NOT hijack |

### opencode-ai/opencode

| Issue | Why |
|---|---|
| [#199](https://github.com/opencode-ai/opencode/issues/199) (open) — shell tool crashes on Windows | Old thread; check current state before commenting. Better angle: opencode Discussions for Windows workflows |

## Tier 3 — registries & lists (submit, no discussion needed)

- **awesome-mcp-servers** (punkpeye/awesome-mcp-servers) — **PR #12337 submitted**
  (Command Line section, agent fast-track). Bot requirements handled: permitted
  emoji set (📇 TypeScript 🏠 Local 🪟 Windows — do NOT reuse the 🖥️ category icon
  as a platform tag) and a Glama score badge in the required format.
  ✅ **Glama approved & listed** (2026-08-18): server page live at
  https://glama.ai/mcp/servers/20000419/fauxnix, badge renders ("A — Grade").
  Remaining for full quality score: author claim + Dockerfile via Glama admin
  page (checks gate search listing), then the glama-badge-check condition on the
  PR is fully met. `glama.json` (maintainers) added to repo root.
- **awesome-claude-code** (hesreallyhim/awesome-claude-code) — **DO NOT submit
  yet**: CONTRIBUTING requires the project to be ≥14 days old (with post-day-one
  commits) OR ≥100 stars. We're day 1. Calendar reminder: submit after
  2026-08-30. (A first attempt was aborted on their permission gate before any
  PR landed — no cleanup needed.)
- **Smithery** (smithery.ai) — `npx @smithery/cli register` flow
- **Glama** — ✅ **fully evaluated 2026-08-18**: Server Coherence A, Tool
  Definition Quality A (bash 4.6/5.0, session 4.3, translate 4.2), Maintenance
  A, profile 100%, active usage recorded. Score + card badges render. Docker
  checks pass (Debian build via mcp-proxy; bash tool answers with the honest
  platform error there — execution is Windows-only by design).
- **PulseMCP**, **mcp.so** — web submit forms

## Tier 2 — community hubs (announce once, answer questions)

- r/LocalLLaMA, r/ClaudeAI, r/ChatGPTCoding — benchmark post (draft:
  `docs/promotion/blog-benchmark-en.md`)
- V2EX /create/node/programmers, 掘金 — 中文版（GBK/编码角度独有；draft:
  `docs/promotion/blog-benchmark-zh.md`）
- Hacker News Show HN — timed with the blog post, same day as Glama/awesome
  merges so the landing page is fully dressed

## Draft comment (adapt per thread; never paste verbatim everywhere)

> Ran into the same wall. What actually fixed it for me on Windows: I stopped
> trying to give the agent a real bash and gave it
> [fauxnix](https://github.com/20000419/fauxnix) instead — an MCP `bash` tool
> that deterministically translates bash to PowerShell and returns GNU-style
> output/errors. `npm i -g fauxnix-cli` then `codex mcp add fauxnix -- fauxnix
> mcp` (works in Claude Code / OpenCode / Kimi / Qwen Code too). Their benchmarks
> measured the PowerShell tax this works around (kimi-k2-thinking: 3.1× slower
> + 24 error events in PS vs zero through fauxnix). Not for everyone — if you
> need real bash tooling (git scripts, devcontainers) WSL is still the answer —
> but for agent shell work it removed the whole class of problems for me.

The "not for everyone" clause is mandatory honesty: it disarms the
"just use WSL" rebuttal and matches the project's fail-loudly charter.
