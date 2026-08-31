# RFC: Windows computer-use parity

Tracking: [#156](https://github.com/20000419/fauxnix/issues/156).
Roadmap: [#118](https://github.com/20000419/fauxnix/issues/118).

## Why

Computer-use agents are being trained on **real desktops**, not only GPU
clusters. *The Information* (30 Aug 2026; widely repeated) reported that
OpenAI bought tens of thousands of Mac mini / Mac Studio machines — no
screen, no keyboard — for reinforcement learning of agents that click,
edit, test, and run multi-step shell workflows. Anthropic is reported to
rent Mac minis through AWS for the same class of work.

That fleet is macOS. The language those agents emit is bash. Windows is
still the OS most people actually sit in front of. “Install Git Bash” or
“use WSL” makes Windows a guest Unix: wrong filesystem, wrong env, and a
model scored on a Mac.

fauxnix’s contract is the other direction: **translate, don’t emulate**.
The agent keeps the bash it was trained on. PowerShell 5.1 runs a faithful
subset. Anything else **fails loud**. v0.9.2 closed the post-v0.7 audit
([#131](https://github.com/20000419/fauxnix/issues/131)). What remains is
what still makes a Mac-trained agent silently wrong on Windows.

This is not a GNU-completeness wishlist. It is the same bar as #129/#130:
never silently-wrong argv, redirects, or ignored flags on the daily path
(`git` / `node` / `npm` / `python` / `ls` / `grep` / `find` / `cd` / `curl`).

## In scope (post-v0.9.2 leftovers)

| Slice | Why an agent hits it |
|---|---|
| `xargs` still `& cmd @array` | same empty/quote drop #148 fixed for `node` |
| `curl`/`wget`/`tar`/`ping` `nativeCall` splat | curl is the computer-use workhorse |
| Non-last-stage stdout (`echo hi >f \| cat`) | #147 RFC follow-up |
| CommandSpec on echo/printf/cat/tail/wc | unknown flags currently ignored |
| Later #143 families (filters, sysinfo, net, archive) | same fail-loud hole |

`find` stays unspec’d (predicates must compile).

## Out of scope

- WSL / Git Bash as the runtime.
- `pwsh` 7 `ArgumentList`.
- Version bump / npm publish.
- Primary-source access to *The Information*; this RFC cites the widely
  reported claim plus our own measurements
  (`docs/benchmark-deepseek-v4-pro.md`).

## Tests

Each slice is its own one-commit PR with unit + Windows integration, the
same bar as #147–#154. No silent “looks like bash” approximations.
