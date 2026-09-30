# RFC: strict streaming gzip decoding

Tracking: #233. Candidate: #231.

## Why

Windows .NET GZipStream accepted ordinary truncated inputs in three retained
fixtures. Header/footer checks alone are not a complete decoder. A reported
successful decode can otherwise cause the original archive to be deleted.

## Contract

Use Node's built-in `createGunzip` with its default strict finish behavior as the
actual decoder for file/test/text-output and existing text-stdin paths. Decode
all concatenated members. Reject incomplete streams, bad checksums, and trailing
non-gzip garbage; the last rule is deliberately stricter than GNU's warning.
No extra npm dependency or host protocol change is required.

Executable plans pin `process.execPath`; pure rendered PowerShell scripts resolve
`node.exe` on PATH and fail explicitly if unavailable or below the package's
Node support floor. User paths are encoded data
arguments, never interpolated into JavaScript. File inputs are held read-only
through decoding. Text stdin still has the documented binary round-trip limits.

The decoder only reads the supplied input and writes binary stdout. It never
renames/deletes the input or commits a destination. PowerShell drains binary
stdout directly to an owned stream and drains diagnostic stderr concurrently.
`-t` discards decoded chunks, so memory is bounded and decoded-size disk space is
not required. File output retains the existing sibling-stage/no-clobber commit.
Text stdout validates into a delete-on-close spool before emitting any text:
this uses O(decoded-size) temporary disk space. Decoder buffers are bounded;
the existing text-line interface still needs O(longest-line) memory. Disk exhaustion
fails without committing or deleting the archive. UTF-8/GBK text handling remains.

Normal failure disposes streams, kills a still-running owned helper and removes
owned temporary artifacts. PowerShell holds a private redirected stdin pipe open
for the decoder lifetime; EOF aborts decoding. This is not compressed input or
a host RPC change. Output-pipe failure also aborts. A PID watcher is best effort
only: a PID-only backpressure test did not terminate reliably on Windows. Owner
pipe closure bounds the decoder's own shutdown if a stalled output cannot drain. The normal command
budget still belongs to the host. Direct standalone scripts have no added wall
clock limit. No speedup is claimed; child startup and stdout spooling cost are
measured separately.

## Limits

A PID watcher is not a Windows Job Object and cannot eliminate PID reuse races.
An abruptly killed PowerShell may leave the existing sibling output stage; it
must never turn a failed decode into deletion of source or preexisting destination.
Delete-on-close stdout/input spools are OS-handle owned. No binary host protocol,
compression rewrite, arbitrary process-tree ownership, or recursive cleanup is
introduced. File commit and later source deletion remain separate operations.

## Tests

Portable tests execute the real Node helper against complete, empty,
concatenated, truncated, checksum-corrupt and trailing-garbage disposable inputs.
Windows PS5.1/7 and ARM64 execute translated commands with source/destination
preservation, no stdout before validation, helper failures, cancellation,
no-clobber collisions and large legitimate archives. The earlier accepted-
truncation characterization cases become explicit rejection assertions.

Reference: [Node zlib](https://nodejs.org/api/zlib.html#class-zlibgunzip).
