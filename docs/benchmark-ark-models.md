# Benchmark: Volcano Ark Coding Plan — models × harnesses × fauxnix

Multi-model study on one Windows 11 (zh-CN) machine, 2026-08-16, using the Ark
Coding Plan endpoints (`/api/coding` Anthropic-compatible, `/api/coding/v3`
OpenAI-compatible). Same 5-task battery as `benchmark-deepseek-v4-pro.md`
(ground truth fixed; T4 = byte-exact file write — the encoding-trap canary).

## Coding Plan model coverage

Supported (verified): deepseek-v4-pro, deepseek-v4-flash, kimi-k2-thinking,
kimi-k2, glm-5-2, doubao-seed-2-0-code, doubao-seed-2-1-turbo.
Rejected by the endpoint ("does not support the coding plan feature"):
glm-4-7, qwen3-14b, deepseek-v3-2 — would incur extra charges.

## P1 — OpenCode × fauxnix screen (5 tasks per model)

| Model | calls | time | score | notes |
|---|---|---|---|---|
| deepseek-v4-pro | 7 | 70s | 5/5 | most efficient bash author |
| deepseek-v4-flash | 13 | 116s | 5/5 | chattier |
| kimi-k2-thinking | 11 | 105s | 5/5 | |
| glm-5-2 | 16 | 162s | 5/5 | slowest T4 (7 calls) but correct |
| doubao-seed-2-0-code | 7 | 171s | 5/5 | |
| doubao-seed-2-1-turbo | ~5 | 111s | 5/5 | |
| kimi-k2 (250905) | ~7 | 102s | 5/5 | |

Several models answered T4 with 13 instead of 11 — that was fauxnix's CRLF
redirect bug (fixed in PR #1), not model error; models faithfully reported the
bytes they saw.

## P2 — PowerShell degradation (same harness, forced PS vs fauxnix)

| Model | PS: calls/err/time | fauxnix: calls/err/time |
|---|---|---|
| deepseek-v4-pro | 15 / 14 / 174s | 7 / 0 / 70s |
| **kimi-k2-thinking** | **26 / 24 / 302s** (T4: 18 calls, 15 errors, 199s) | 8 / 0 / 96s |
| glm-5-2 | 10 / 4 / 171s | 11 / 0 / 112s |

kimi-k2-thinking shows the worst PowerShell degradation measured so far —
3.1× slower with an error storm on the byte-write task; glm-5-2 authors
comparatively safe PowerShell yet still finishes 35% faster on fauxnix.

## P3 — Claude Code × Ark (Anthropic endpoint)

The Anthropic-compatible endpoint routes `claude-*` model names to Doubao:
sonnet/opus → doubao-seed-2-1-turbo, haiku → doubao-seed-code. Native Ark
model IDs passed through `--model` are rejected (modelCode does not exist).
haiku→seed-code scored a perfect 5/5 including byte-exact T4; sonnet→turbo
4/5 (self-inflicted: created a file mid-count).

## P4 — other harnesses

- **Qwen Code** (gemini-cli fork): works with the OpenAI-compatible endpoint
  via `--auth-type openai` flags; deepseek-v4-pro 4/5, glm-5-2 1.5/5 —
  MCP sessions occasionally drop mid-run (harness-side instability).
- **Gemini CLI**: requires Google OAuth, no credentials available — skipped.
- **Crush / Goose**: not npm-distributable / TUI-first — skipped.

## P5 — real development task (create → count → list → verify)

deepseek-v4-pro completed a multi-step file-manipulation task correctly in
both modes; via fauxnix it used 7 fluent one-liner bash calls
(`echo | tee a b c`, `grep -c | awk sum`, `grep -l | sort >`), all executed
correctly — while the PowerShell path resorted to writing and deleting a
temporary .ps1 script.

## Harness quirks discovered

- Claude Code: custom `--model` IDs are mangled before reaching the endpoint;
  use claude-tier names and let the provider route.
- Codex 0.144: only `wire_api = "responses"`; Ark supports it, but Codex's
  WebSocket transport attempt stalls (~2.5 min timeout before fallback).
- Qwen Code: `--output-format`/`-p` flag order matters; project MCP config
  lives in `.qwen/settings.json`.

Raw logs: `scratch/ark-test/logs-*` (development machine, not published).
