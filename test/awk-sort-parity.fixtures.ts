/** Text-only correctness fixtures. All comparisons use the C locale. */
export const parityFiles: Record<string, string> = {
  'nums.txt': '1 2\n3 4\n5 6\n',
  'empty.txt': '',
  'single.txt': 'Apple\n',
  'mixed-case.txt': 'banana\nApple\napple\nBanana\n',
  'case-ties.txt': 'apple\nAPPLE\nApple\nbanana\nBANANA\nBanana\n'.repeat(4),
  'case-blanks.txt': 'a  b\nA b\na b\nA  b\n z\nZ\n[\n_\n',
  'case-keys.txt': 'apple z\nAPPLE a\nbanana z\nBanana a\n',
};

// printf has no implicit newline or separator:
// https://www.gnu.org/software/gawk/manual/html_node/Basic-Printf.html
export const awkTextCases: Array<[string, string]> = [
  [String.raw`awk '{printf "%s:%s\n", $1, $2}' nums.txt`, '1:2\n3:4\n5:6\n'],
  [String.raw`awk '{printf "%s", $1}' nums.txt`, '135'],
  [String.raw`awk '{printf "%s:", $1; printf "%s\n", $2}' nums.txt`, '1:2\n3:4\n5:6\n'],
  [String.raw`awk '{printf "%s:", $1; print $2}' nums.txt`, '1:2\n3:4\n5:6\n'],
  [String.raw`awk 'BEGIN {print "start"} {printf "%s", $1} END {print "end"}' nums.txt`, 'start\n135end\n'],
  [String.raw`awk 'BEGIN {printf "[%s]", "start"} {print} END {printf "%s", "end"}' nums.txt`, '[start]1 2\n3 4\n5 6\nend'],
  [String.raw`awk 'BEGIN {printf ""; print "x"; printf ""}'`, 'x\n'],
  [String.raw`awk 'BEGIN {printf "{literal}%%"}'`, '{literal}%'],
  [String.raw`awk 'BEGIN {printf ""}'`, ''],
  [String.raw`awk 'BEGIN {printf "\n\n"}'`, '\n\n'],
  [String.raw`awk 'BEGIN {printf "%s%c\n", "x", 13}'`, 'x\r\n'],
  [String.raw`awk 'BEGIN {printf "%s", "你好"}'`, '你好'],
  [String.raw`awk '{printf "%s", $1}' empty.txt`, ''],
  [String.raw`awk 'END {printf "%s", NR}' empty.txt`, '0'],
  [String.raw`awk '{printf "%s", $1; exit} END {printf "%s", "end"}' nums.txt`, '1end'],
  [String.raw`printf '1 2\n3 4\n' | awk '{printf "%s:%s\n", $1, $2}'`, '1:2\n3:4\n'],
  [String.raw`awk '{printf "%s", $1}' nums.txt | wc -c`, '3\n'],
  [String.raw`awk '{printf "%s:%s\n", $1, $2}' nums.txt | wc -l`, '3\n'],
  [String.raw`awk '{printf "%s:", $1; print $2}' nums.txt | grep '3:4'`, '3:4\n'],
  [String.raw`printf '<%s>' "$(awk '{printf "%s", $1}' nums.txt)"`, '<135>'],
  [String.raw`printf '<%s>' "$(awk '{printf "%s\n", $1}' nums.txt)"`, '<1\n3\n5>'],
  [String.raw`OUT=$(awk '{printf "%s", $1}' nums.txt); printf '<%s>' "$OUT"`, '<135>'],
  [String.raw`awk 'BEGIN {OFS=":"; printf "%s", "pre"} {print $1, $2}' nums.txt`, 'pre1:2\n3:4\n5:6\n'],
  [String.raw`awk '{printf "%s:%s\n", $1, $2}' nums.txt | awk -F: '{printf "%s%s", $2, $1}'`, '214365'],
  [String.raw`printf '<%s>' "$(awk '{printf "%s:%s\n", $1, $2}' nums.txt | awk -F: '{printf "%s%s", $2, $1}')"`, '<214365>'],
];

// GNU -f folds ASCII to uppercase. Default ties compare the original line;
// -u disables that last resort and retains the first equal input record.
// https://www.gnu.org/software/coreutils/manual/html_node/sort-invocation.html
export const sortTextCases: Array<[string, string]> = [
  ['sort -f mixed-case.txt', 'Apple\napple\nBanana\nbanana\n'],
  ['sort --ignore-case mixed-case.txt', 'Apple\napple\nBanana\nbanana\n'],
  ['sort -fr mixed-case.txt', 'banana\nBanana\napple\nApple\n'],
  ['sort -fu mixed-case.txt', 'Apple\nbanana\n'],
  ['sort -fur mixed-case.txt', 'banana\nApple\n'],
  ['sort -fu case-ties.txt', 'apple\nbanana\n'],
  ['sort -fur case-ties.txt', 'banana\napple\n'],
  ['sort -f case-blanks.txt', ' z\nA  b\na  b\nA b\na b\nZ\n[\n_\n'],
  ['sort -fu case-blanks.txt', ' z\na  b\nA b\nZ\n[\n_\n'],
  ['sort -f -k1,1 case-keys.txt', 'APPLE a\napple z\nBanana a\nbanana z\n'],
  ['sort -f -u -k1,1 case-keys.txt', 'apple z\nbanana z\n'],
  ['sort -f -u -r -k1,1 case-keys.txt', 'banana z\napple z\n'],
  ['sort -f empty.txt', ''],
  ['sort -fu empty.txt', ''],
  ['sort -fur single.txt', 'Apple\n'],
  [String.raw`printf 'b\nB\na\nA\n' | sort -f`, 'A\na\nB\nb\n'],
];
