# Awk field assignment for record normalization

An observed agent run attempted `awk '{$1=$1; print}'` while preparing a
tabular result. The current parser rejects the first `$`; the agent then
removed its formatting stage. This proposal adds the common field-rebuild
operation so that this valid idiom executes directly.

Supported statements are `$N = expression`, with a literal field index from
1 through 65535. Evaluate the right-hand side before changing the record,
extend missing fields with empty strings, update NF, and rebuild $0 with OFS.
OFS defaults to a space and can be supplied through `-v` or a normal assignment.
Comma-separated print arguments use the same OFS.

`$0` assignment, computed field indices, compound assignment and changing NF
are not implemented by this slice. Unsupported field-assignment syntax fails
explicitly with a print-based alternative. There is no command execution or
new external dependency in the implementation.

Validation covers whitespace normalization, subsequent field reordering,
extension beyond NF, custom OFS, and preservation of an untouched record.
The corresponding GNU oracle programs are:

```sh
printf '   1    LA\n   2    NYC\n' | awk '{$1=$1; print}'
printf '   1    LA\n   2    NYC\n' | awk '{$1=$1; print $2, $1}'
printf 'a b\n' | awk 'BEGIN {OFS=":"} {$4="x"; print NF, $0}'
```

This removes a demonstrated failed tool call. It does not guarantee that a
model will choose the required column order or reduce every task's wall time.
