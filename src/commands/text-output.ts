/**
 * Terminal-aware write. When this block's output goes straight to the console
 * (a lone `& { }` scriptblock — $MyInvocation name is empty — or the last
 * stage of a pipeline):
 *   - a string ending in \n is emitted as line items (the console formatter
 *     appends the final newline; still correct inside $(...) substitution);
 *   - a string without a trailing newline is written with the exact bytes so
 *     `echo -n`, `printf 'x'`, `base64 -w0`, `head -c N` stay GNU-exact.
 * Inside a pipeline stage emit one string item instead (line semantics
 * downstream; embedded \n is preserved for consumers that re-split).
 */
export const PS_WRITE_FN = [
  'function fx-write($s, $term) {',
  "  if ($s -eq '') { return }",
  // Inside quoted/assignment $(...) the collector wants one string object
  // so interior newlines survive (PS would otherwise join lines with spaces).
  '  if ($script:fx_csub) { $s; return }',
  '  if (-not $term) { $s; return }',
  '  if (-not $s.EndsWith([string][char]10)) { [Console]::Out.Write($s); return }',
  '  $t = $s.Substring(0, $s.Length - 1)',
  '  foreach ($fx_l in $t.Split([char]10)) { $fx_l }',
  '}',
].join('\n');

/** $fx_term: is this block's output console-terminal? (see PS_WRITE_FN) */
export function fxTermLine(position: 'first' | 'middle' | 'last'): string {
  return (
    "$fx_term = (($MyInvocation.MyCommand.Name -eq '') -or " +
    (position === 'last' ? '$true' : '$false') +
    ')'
  );
}
