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

Publishing stays maintainer-manual and requires npm 2FA. Do not move or reuse a
release tag or npm version after it is public.

### Version PR

1. Run `npm version X.Y.Z --no-git-tag-version`. This updates `package.json`
   and both lockfile version fields; `src/version.ts` supplies the CLI and MCP
   versions at runtime, so do not hand-edit `src/cli.ts` or `src/mcp.ts`.
2. Add the new top `CHANGELOG.md` entry (`## vX.Y.Z — YYYY-MM-DD`) and prepare
   matching GitHub release notes.
3. Run `npm ci`, `npm run release:check`, `npm run typecheck`, `npm test`, and
   `npm run test:package`.
4. Open and merge the version PR only after CI is green on its exact head.

### Publish the merged commit

1. Update local `main` with a fast-forward pull. Confirm the worktree is clean,
   `package.json` and `package-lock.json` show the intended version, and CI is
   green for the exact commit to be tagged.
2. Run `npm whoami` and `npm profile get`; confirm the expected maintainer
   account has `auth-and-writes` 2FA. Confirm the target version is absent
   from `npm view fauxnix-cli versions --json`.
3. Create an annotated local tag (`git tag -a vX.Y.Z -m "vX.Y.Z"`) and run
   `npm publish --dry-run`. The publish lifecycle repeats the strict tag,
   typecheck, full-suite, and packed-install checks. Inspect the file manifest.
4. Push only that tag with `git push origin vX.Y.Z`, then compare the peeled
   commit from `git ls-remote origin "refs/tags/vX.Y.Z^{}"` with
   `git rev-list -n 1 vX.Y.Z`. An annotated tag's unpeeled ref is the tag
   object, not the release commit.
5. Publish from the same clean checkout, entering the OTP at npm's prompt:
   - release candidate: `npm publish --tag next`
   - stable release: `npm publish --tag latest`

   Never publish a release candidate without `--tag next`; npm otherwise moves
   `latest`, changing what an unversioned install receives.
6. Read the release back before announcing it:
   - `npm view fauxnix-cli@X.Y.Z version gitHead dist.integrity`
   - compare `gitHead` with `git rev-list -n 1 vX.Y.Z`
   - `npm dist-tag ls fauxnix-cli` (`next` for an RC, `latest` for stable)
   - `npx --yes --package=fauxnix-cli@X.Y.Z fauxnix --version`
7. Create the GitHub release from the already-published tag using the prepared
   CHANGELOG-derived notes (`gh release create ... --verify-tag --notes-file ...`).
   Add `--prerelease` for release candidates, then read the release page back.

### Failed release or rollback

- Before npm accepts the version, fix authentication/network failures and retry
  only if the commit and package are unchanged. If code must change after a
  public tag was pushed, issue a new version; do not move the tag.
- After npm accepts the version, never unpublish or reuse it. Move the affected
  channel back with `npm dist-tag add fauxnix-cli@LAST_GOOD latest` (or `next`),
  run `npm deprecate fauxnix-cli@BAD "upgrade to X.Y.Z: REASON"`, mark its GitHub
  release clearly, and publish a corrected patch or release candidate.

## Attribution note

External PRs #11 / #12 / #66 (by @r3wretrhy) were reviewed and merged under
an earlier version of this process: #11's conflict resolution against #12
was pushed directly to `main` with post-hoc CI (green). The integration-PR
rule above was adopted afterwards to close that gap.
