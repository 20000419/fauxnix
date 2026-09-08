# Runtime checkpoint fast path

Every translated segment currently resets cwd and rebuilds an environment
snapshot through `Get-ChildItem Env:` and `ForEach-Object`, serializes it with
`ConvertTo-Json`, and writes two files. This cost repeats even for a warmed
`printf` that changes no session state. Batching MCP calls does not remove it.

The resident host can compile this repeated work once alongside its existing
bounded-stream helper. A small .NET helper enumerates environment strings,
escapes them into JSON, orders the keys, and writes only changed checkpoints.
The cwd checkpoint likewise writes only when its value changes. The command
preamble avoids resetting an already matching PowerShell or .NET cwd.
Native pipeline spool directories and raw-stderr files are created lazily on
first use. A plain translated command no longer creates an unused directory
and an empty stderr file merely to remove them at the end of its request.

## Behavior

- Every completed segment still checks for state changes. Updates and unsets
  reach disk before the next segment; timeout recovery retains earlier state.
- Only transport metadata is omitted from persistent environment snapshots:
  FAUXNIX_CWD, FAUXNIX_PREV_EXIT, FAUXNIX_STDIN_FILE and FAUXNIX_NATIVE_SPOOL_DIR.
  Node supplies these afresh on each request. User environment strings,
  including quotes, control characters and Unicode, remain exact.
- A deleted checkpoint is recreated even when the cached value is unchanged.
  Caches are updated only after a successful write and are discarded when the
  host process stops. The internal checkpoint files have a single writer.
- One-shot translated scripts retain their self-contained PowerShell path.
- No command-result caching, reordered side effects or host-frame fusion is
  introduced. This optimizes the default runtime without changing the tool API.

## Measurement

Build both the baseline and candidate checkouts, then run:

```powershell
npm run build
node scripts/benchmark-runtime-workloads.mjs C:/path/to/baseline .
$env:FAUXNIX_PS = 'pwsh'
node scripts/benchmark-runtime-workloads.mjs C:/path/to/baseline .
```

The benchmark alternates order, uses separate sessions and fixtures, excludes
boot/setup/translation from execution timing, verifies outputs, and returns raw
samples. It includes 32-segment reporting/state workloads and the supplied
rename and city-count tasks. FAUXNIX_BENCH_ROUNDS defaults to 15;
FAUXNIX_BENCH_ENV_COUNT optionally adds synthetic environment entries.

These are runtime measurements. They must not be represented as reductions in
model inference time or proof that a previously slow end-to-end agent run is
fixed. Whole-plan fusion remains a separate compiler project: redirects and
intermediate state checkpoints cannot simply be discarded when concatenating
generated bodies.
