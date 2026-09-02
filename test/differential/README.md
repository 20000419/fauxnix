# Differential corpus (RFC C-7 scaffold)

Institutional home for fauxnix vs Git Bash identity checks. Tracking:
[RFC 1.0 C-7](../../docs/rfc-1.0-completeness-usability.md) / [#118](https://github.com/20000419/fauxnix/issues/118).

## This is a scaffold, not the 1.0 gate

The **1.0.0 hard gate** is:

- ≥ **200** curated cases
- ≥ **95%** byte-identical (stdout / stderr / exit, newlines normalized)
- two consecutive green **scheduled** oracle runs

`corpus.json` is a **high-value subset** (15–40 cases) sourced from already-shipped
audit repros and integration tests (`echo hi >/dev/null`, `printf … | grep`,
`head --lines=-1`, `grep -e a -e c`, …). It does **not** claim the 200-case gate.
Grow it from benchmark transcripts, audit repros, and each merged completeness PR.

A weekly GitHub Actions cron is **not** added here. The oracle is opt-in
(`FAUXNIX_DIFF_ORACLE`) and Git Bash is **not** required on developer machines or
assumed on GH Windows. Default `npm test` imports `test/differential.test.ts` and
**skips** the comparison. A commented / `if: false` workflow would be worse than
this note; add a scheduled job later only when it is skip-safe or the image
explicitly provides the oracle.

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
6. Stay under the 1.0 gate until you are deliberately growing toward 200.

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

[`../differential.test.ts`](../differential.test.ts) always sanity-checks this
corpus (so CI imports the file). The oracle `describe` is `skipIf` when the env
is unset or git-bash `bash.exe` is missing. When the oracle runs, each case goes
through a fauxnix session **and** `bash.exe`; a summary is printed; the test
fails if identity is below 95% of **this** small corpus.
