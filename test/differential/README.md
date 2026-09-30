# Differential corpus (RFC C-7 hard gate)

Institutional home for fauxnix vs Git Bash identity checks. Tracking:
[RFC 1.0 C-7](../../docs/rfc-1.0-completeness-usability.md) / [#118](https://github.com/20000419/fauxnix/issues/118).

## Gate status

The **1.0.0 hard gate** is:

- ≥ **200** curated cases
- ≥ **95%** byte-identical (stdout / stderr / exit, newlines normalized)
- two consecutive green **scheduled** oracle runs

`corpus.json` now contains **270 sourced, unique cases** grown from the
40-case scaffold and the shipped integration/audit regressions. The corpus
size gate is enforced in the default test suite, and an opted-in oracle run
must remain at or above 95% identity.

The Unicode `wc -m` case sets `LC_ALL=C.UTF-8` for that command explicitly.
The oracle otherwise runs under `LC_ALL=C`, where GNU `wc -m` counts each input
byte rather than UTF-8 codepoints. This keeps the comparison locale-specific
without changing the baseline locale of the rest of the corpus.

The identity corpus uses a BMP-only character-count fixture. The separate
`wc-astral-unicode-oracle` diagnostic retains `A😀é` plus newline: GNU on Linux
returns **5** under `C.UTF-8`, while Git for Windows returned **6** in
[validation run 36668228094](https://github.com/20000419/fauxnix/actions/runs/36668228094/job/109737417502).
Fauxnix must return **5**; the diagnostic and real-Windows golden tests assert
that result. The Git Bash observation is logged separately, not counted as an
identity pass or added to the mismatch allowlist. Replacing the newly added
astral identity fixture with the BMP fixture changes this corpus: do not
claim a same-case percentage improvement over the previous 270-case run.

The four currently reviewed differences are listed by case ID in
`gate.knownMismatchIds`. The oracle rejects every new mismatch even while the
aggregate stays above 95%; removing an entry after its behavior is fixed is
allowed. This prevents the percentage threshold from hiding regressions.

`bracket-leading-empty-alt` is an explicit oracle-platform difference. In
[Windows validation run 36671437509](https://github.com/20000419/fauxnix/actions/runs/36671437509/job/109747074932),
Git Bash rejected `|x` with `empty (sub)expression`, producing status 2;
fauxnix produced status 0. GNU Bash 5.2 on Linux accepts the same unchanged
command and produces status 0. [Bash uses the host POSIX regex interfaces](https://www.gnu.org/software/bash/manual/html_node/Conditional-Constructs.html),
and [empty alternatives are not portable](https://www.gnu.org/software/autoconf/manual/autoconf-2.64/autoconf.pdf).
The case remains in the corpus and the reviewed baseline; it is not an identity
pass. Fauxnix's translated .NET regex is not a full POSIX regex implementation:
POSIX's [leftmost-longest alternatives](https://www.gnu.org/s/gnulib/manual/html_node/Alternation-Operator.html)
can also differ from .NET's chosen captures. Matching this Git Bash rejection
or implementing full POSIX capture semantics requires an explicit compatibility
choice, rather than changing the reference case to improve the percentage.

This change satisfies the corpus-size half of C-7. It does **not** satisfy the
release-evidence half: two consecutive green **scheduled** oracle runs are
still required after the change reaches the default branch. Local runs and
`workflow_dispatch` are useful verification, but do not count as those two
scheduled runs.

A skip-safe weekly GitHub Actions cron (`.github/workflows/differential.yml`)
runs Mondays at 06:00 UTC plus `workflow_dispatch`. It is **not** hooked to
`pull_request` (fork PRs stay unblocked). The job is skip-safe: if Git Bash
`bash.exe` is missing the step succeeds; if it is present, identity below 95%
fails the job. Default `npm test` still imports `test/differential.test.ts`
and **skips** the comparison unless `FAUXNIX_DIFF_ORACLE` is set.

## Running the oracle

Git Bash is optional. If `FAUXNIX_DIFF_ORACLE` is unset **or** `bash.exe` is
missing, the runner skips (CI stays green).

```powershell
$env:FAUXNIX_DIFF_ORACLE = '1'
npx vitest run test/differential.test.ts
```

Point the env at `bash.exe` when Git for Windows is not in a default location:

```powershell
$env:FAUXNIX_DIFF_ORACLE = 'C:\Program Files\Git\bin\bash.exe'
npx vitest run test/differential.test.ts
```

Unset, empty, `0`, `false`, `no`, or `off` → skip. `bash.exe` missing → skip.

## Adding a case

1. Append an object to `cases` in [`corpus.json`](corpus.json). `id` must be unique.
2. Cite the audit / PR / RFC in `source`.
3. Put shared fixtures in `files` (written into a temp cwd). A case may add
   its own `files` overlay.
4. Keep the command self-contained; one fauxnix session runs the whole corpus.
5. Prefer cases that already have integration coverage so identity is plausible.
6. Keep every command unique; prefer a new semantic branch over value-only
   variants of an existing case.

```json
{
  "id": "grep-e-or",
  "cmd": "grep -e a -e c letters.txt",
  "source": "#152"
}
```

Do **not** add documented deviations (`uname -r`, `command -v echo`, `pwd` drive
letters). The comparison is newline-normalized stdout + stderr + exit.

## Runner contract

[`../differential.test.ts`](../differential.test.ts) always checks the 200-case
minimum, unique IDs/commands, and non-empty provenance (so CI imports the
file). The oracle `describe` is `skipIf` when the env is unset or git-bash
`bash.exe` is missing. When the oracle runs, each engine receives a separate,
fresh copy of the same fixtures for every case; a summary is printed and the
test fails below 95% identity or when a mismatch appears outside the reviewed
baseline IDs.
