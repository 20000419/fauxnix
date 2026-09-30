# RFC: fail-closed regular-file move replacement

Tracking: #232. Implementation candidate: #231.

## Why

Deleting an existing destination before `Move-Item -Force` can discard its data
when moving the source subsequently fails. Retrying PowerShell's force path does
not establish an all-or-nothing replacement contract.

## Contract

- Replace a regular file on the same volume with one `MoveFileExW` call using
  `MOVEFILE_REPLACE_EXISTING` only. Never predelete, copy/delete, or use
  `File.Replace` (whose destination metadata behavior is different).
- Obtain volume and full 128-bit file identifiers through open handles before
  replacement. Reject aliases/hardlinks to the same file. Fail closed if this
  identity API or native helper is unavailable.
- Reject leaf reparse points for replacement and incompatible file types.
- Reject cross-volume replacement explicitly, preserving both originals.
  Ordinary absent-target moves retain PowerShell behavior without `-Force`;
  cross-volume absent-target moves are not a transaction and are not upgraded
  by this RFC.
- Refuse existing empty-directory replacement rather than deleting the empty
  directory before a possibly failing move. Nonempty-directory errors remain.
- `-n` continues skipping an already existing target. `-f` does not override
  preservation limits or permissions. Do not change ACLs, read-only attributes,
  security settings, or require elevated privileges.
- Compile a namespaced, versioned helper lazily, at most once per persistent
  host. Compilation/PInvoke errors are terminating and produce a nonzero
  command result without a fallback mutation.

## Limits and non-goals

Identity checks and the path-based rename are separate operations: this is not
a race-proof namespace transaction or a durability guarantee. Network filesystem
identity/rename support can differ and fails closed when unavailable. Existing
path handling/long-path limits remain. No copy/rollback journal, native addon,
privileged setup, or full directory/reparse-point move compatibility is added.
Same-volume rename keeps the source file object and its metadata; it does not
merge the replaced destination's alternate streams or ACL into the source.

## Tests

Generated-code guards plus real PowerShell 5.1/7, x64/ARM64 tests cover ordinary
and Unicode replacement, source metadata/alternate streams, existing hardlink
aliases, locked/read-only failures, wrong types, no-clobber, empty-directory
preservation, absent targets, and helper-load failure. All fixtures are disposable.
Cross-volume coverage requires two verified existing writable volumes; do not
mount/create a volume or present an unrun case as tested.

## API references

- [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
- [FILE_ID_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)
- [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandleex)
- [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
