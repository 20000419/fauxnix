# RFC: fauxnix 1.0.0 — completeness & usability roadmap (v2)

Status: **proposed** — supersedes the milestone section of
[rfc-roadmap-to-1.0.md](rfc-roadmap-to-1.0.md) (its track analysis remains
valid history). Tracking: #118. Discussion there.

## Where we are (v0.9.3, day 17)

- **Surface**: 108 commands; `if/elif/else`, `for`, `$((x+1))`, `${name:-d}`,
  `${name[n]}`, `${#name}`, backticks, `command -v`, pipeline `read`,
  dotenv `source`. Loud-rejects: heredocs, `while`/`until`/`case`, functions,
  job control, `env -i`.
- **Engine**: resident host (warm ~30–50ms, first frame ~0.27s), protocol v2
  (chunked frames, limits + UTF-8-boundary truncation, native stderr marker),
  cancellation, serialized lifecycle.
- **Correctness**: audit #131 fully cleared (argv fidelity, redirect fd
  ownership, per-fd last-wins); CommandSpec on **29/108** commands; 251
  tests; differential batteries run manually (corpus still in `scratch/`).
- **Distribution**: npm 0.9.3, Glama all-A, juejin article live, two awesome
  lists in review.

## What 1.0.0 means

> **A Mac-fleet-trained agent dropped onto Windows daily-drives fauxnix
> without noticing it isn't bash — and any maintainer can verify that claim
> from the repo alone.**

Two pillars — **completeness** (the agent's bash works) and **usability**
(a human gets value in five minutes) — plus a trust/process pillar that
keeps both true as contributors rotate. Every item below is an ownable,
single-wave PR unit with an explicit definition of done.

## Pillar C — completeness (the agent's bash works)

| ID | Item | Definition of done | Size |
|---|---|---|---|
| C-1 | `while`/`until` loops, `case x in …) ;; esac` (incl. deciding the `;&` fallthrough question from #118) | translate-time + integration tests; differential cases; README surface updated | M |
| C-2 | Array assignment `A=(x y z)`; `${name//pat/str}`, `${name:off:len}` | arrays ride the existing FAUXNIX_ARRS sidecar; differential vs Git Bash ≥10 cases | M |
| C-3 | Positional parameters `$1..$n`, `$#`, `$@`, `set --` | session-scoped; documented interplay with MCP (no true argv — exposed via `fauxnix_session` or an env prelude; needs a mini-RFC first) | S+RFC |
| C-4 | Multi-segment command substitution `$(cmd1; cmd2)` | recursion through the existing translator; newline contract preserved | S |
| C-5 | **CommandSpec to the agent-daily 60** (today 29/108; `find` stays predicate-compiled, not option-spec'd) | every command in the curated daily list spec'd or excluded with rationale in docs/command-specs.md; unknown-option = usage error everywhere spec'd | L (family waves per #143) |
| C-6 | Per-stage stdout/stderr in pipelines (`echo hi >f \| cat`) — RFC #157 | contract from #157 landed or RFC-closed with documented semantics | M |
| C-7 | **Differential corpus institutionalized** — the correctness *institution* | `test/differential/` with ≥200 curated cases, `FAUXNIX_DIFF_ORACLE`-gated runner (skips without Git Bash), scheduled weekly CI, green gate ≥95% byte-identical; corpus sourced from benchmark transcripts + audit repros + every merged feature's cases | L |

C-7 is the single highest-leverage item in this RFC: it converts every past
and future "verified vs real bash" claim from a one-off maintainer action
into a repeatable gate.

## Pillar U — usability (five minutes to value)

| ID | Item | Definition of done | Size |
|---|---|---|---|
| U-1 | `fauxnix install --claude/--codex/--opencode/--kimi/--qwen` | writes/patches the right config per harness (paths verified on real machines); idempotent; prints what changed | M |
| U-2 | `fauxnix doctor` | extends `fauxnix check`: PowerShell present/version, encoding, harness config detection with fix hints, MCP connectivity self-test | M |
| U-3 | Error-message guarantee | every loud-reject carries a one-line actionable alternative; audit by grepping all emit sites; add a unit test asserting the pattern for new rejects | S |
| U-4 | Quickstarts `docs/examples/<harness>.md` ×5 | copy-paste config + a 10-command smoke script with expected outputs | M |
| U-5 | PowerShell 7 tier | `FAUXNIX_PS=pwsh` supported with documented deltas; CI job runs the suite on pwsh | M |
| U-6 | ARM64 CI matrix | `windows-11-arm` runner green on the full suite | S |
| U-7 | Locale matrix | zh-CN + en-US error-wording cases pinned in the suite (no more "validated on one zh-CN box") | S |
| U-8 | Performance guard | warm p50 <50ms and first-frame <400ms asserted in CI (budget test) so the 15× win can't regress silently | S |

## Pillar T — trust & process (contributor longevity)

| ID | Item | Definition of done |
|---|---|---|
| T-1 | `SECURITY.md` | trust model (local agent shell, same as any harness Bash tool), host-protocol surface, kill semantics, network guard, reporting policy |
| T-2 | CONTRIBUTING: the RFC rule | when an RFC is required (new surface, protocol change, semantics), template pointer, maintainer turnaround expectation |
| T-3 | Release checklist | **Complete**: CONTRIBUTING codifies CHANGELOG, tag, release notes, RC/stable npm tags, 2FA publish, readback and rollback; `release:check` gates metadata and strict tagged publishes |
| T-4 | Stability freeze | at 1.0.0-rc: CLI verbs, MCP tool schema, session env-var contract, host protocol v2 marked frozen; semver from 1.0.0 |

## Sequencing (each wave = independently reviewable PRs)

1. **v0.10.0 — language completeness**: C-1, C-2, C-4 (+C-3 mini-RFC)
2. **v0.11.0 — usability**: U-1, U-2, U-3, U-4, U-8
3. **v0.12.0 — institutions & matrix**: C-7, C-5 (family waves), C-6, U-5, U-6, U-7, T-1, T-2
4. **1.0.0-rc → audit → soak → 1.0.0**

Ordering rationale: language gaps block agents today (C-first); usability
converts interest into retained users once content brings them (U-second);
institutions must exist before the freeze (T-third). C-7 sits in wave 3 only
because corpus curation benefits from C-1/C-2 landing first (their cases
join the corpus); if a contributor wants it earlier, it composes fine.

## 1.0.0 hard gates (auditable checklist)

1. C-7 differential: ≥200 cases, ≥95% byte-identical, two consecutive green
   scheduled runs
2. C-1..C-4 landed or wontfix'd with README documentation
3. C-5: agent-daily-60 spec coverage complete (or per-command rationale)
4. U-1/U-2 shipped; U-4 quickstarts published
5. U-6 ARM64 green; U-7 locale matrix green; U-8 perf guard green
6. T-1 SECURITY.md merged; T-2 RFC rule merged
7. **External audit round 2** on the rc tag (fresh eyes; vulragrag-star
   invited, not required)
8. 14-day npm soak of the rc with zero open P1/P2
9. T-4 freeze + semver statement in README

## Non-goals (unchanged)

Functions and heredocs stay leaning-wontfix pending corpus evidence
(function state cannot survive a host death without a registry sidecar;
heredocs are rare in agent one-liners). No Linux execution, no sandboxing
policy, no bash-completeness for its own sake.

## For wave authors

The working pattern is settled: mini-RFC (issue or `docs/rfc-*.md`) →
single-commit PRs with tests → integration rule per CONTRIBUTING →
maintainer verification with differential evidence. New since v0.9: every
completeness PR should append its differential cases to the corpus target
(`test/differential/` once C-7 lands, scratch battery before).
