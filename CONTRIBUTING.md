# Maintaining fauxnix

This documents the review and merge process used by this repository's
maintainers (humans and agents alike). The core principle:

> **Individually reviewed PRs do not imply their combination is reviewed.**
> The final tree that lands on `main` must itself carry evidence.

## PR review checklist

1. **Fork PRs don't run Actions automatically** (`action_required`). Either
   approve the workflow run on the PR page, or verify locally:
   `npx vitest run --dir test` (the `--dir test` scope matters — stray
   untracked `*.test.ts` files elsewhere in a working tree get picked up by
   vitest's default include and inflate/contaminate counts).
2. Read the full diff, not just the description.
3. Run the suite on the PR branch.
4. **Behavior spot-check the claimed fix by hand** — run the exact failing
   command before/after. Tests shipped in the PR can be self-fulfilling.
5. Leave a review comment recording the verification evidence and any
   accepted semantic deviations.

## Conflict resolution policy

When two PRs touch the same region and the second one cannot auto-merge:

1. Merge the clean PR(s) normally.
2. Create an integration branch from updated `main`
   (e.g. `integration/pr-11-after-12`).
3. Merge the conflicting PR into it and resolve conflicts there.
4. Run the full suite.
5. **Open an integration PR for the resolved tree** — the conflict resolution
   is new, unreviewed Δ. CI must run green on exactly this tree before it
   reaches `main`.
6. Merge the integration PR.

Never push a hand-resolved merge directly to `main`, even when the result
tests green locally. (Post-hoc CI on `main` detects problems but does not
make the delta reviewable — that's detection, not gating.)

## RFC process

An RFC is required before implementation when the change is any of:

- a new language surface (syntax, builtins, or session-visible features)
- a host protocol change
- a semantic change to redirects, argv, or session env

Template: a short `docs/rfc-*.md` (see [docs/rfc-template.md](docs/rfc-template.md))
plus a tracking issue. Implementation PRs stay independently reviewable
per the checklist above.

Existing RFCs (shape to copy):

- [docs/rfc-1.0-completeness-usability.md](docs/rfc-1.0-completeness-usability.md)
- [docs/rfc-computer-use-windows.md](docs/rfc-computer-use-windows.md)
- [docs/rfc-redirect-fd-ownership.md](docs/rfc-redirect-fd-ownership.md)
- [docs/rfc-native-argv-fidelity.md](docs/rfc-native-argv-fidelity.md)
- [docs/rfc-bounded-cancellable-execution.md](docs/rfc-bounded-cancellable-execution.md)

Expect review on the integration tree per the checklist above; do not merge
your own PRs. There is no SLA.

## Releases

1. Version-bump PR (`package.json` + `src/cli.ts` + `src/mcp.ts`), CI green, merge.
2. Tag `vX.Y.Z`, push tag.
3. `npm run test:package` green.
4. `npm publish` (requires maintainer 2FA).

## Attribution note

External PRs #11 / #12 / #66 (by @r3wretrhy) were reviewed and merged under
an earlier version of this process: #11's conflict resolution against #12
was pushed directly to `main` with post-hoc CI (green). The integration-PR
rule above was adopted afterwards to close that gap.
