/** Small ASCII fixtures also run against Bash so expected text is independent. */
export const commandOutputFiles: Record<string, string> = {
  'dups.txt': 'a\na\nb\nc\nc\nc\n',
  'case-dups.txt': 'A\na\nb\n',
  'first.txt': 'a1\na2\n',
  'second.txt': 'b1\nb2\n',
  'blank.txt': 'top\n\nbottom\n',
  'empty.txt': '',
};

export const commandOutputCases: Array<[string, string]> = [
  ['uniq -c dups.txt', '      2 a\n      1 b\n      3 c\n'],
  ['uniq -d dups.txt', 'a\nc\n'],
  ['uniq -u dups.txt', 'b\n'],
  ['uniq -cd dups.txt', '      2 a\n      3 c\n'],
  ['uniq -dc dups.txt', '      2 a\n      3 c\n'],
  ['uniq -cu dups.txt', '      1 b\n'],
  ['uniq -uc dups.txt', '      1 b\n'],
  ['uniq -du dups.txt', ''],
  ['uniq -ud dups.txt', ''],
  ['uniq -cdu dups.txt', ''],
  ['uniq -cdi case-dups.txt', '      2 A\n'],
  ['uniq -cd empty.txt', ''],
  [String.raw`printf 'a\na\nb\n' | uniq -cd`, '      2 a\n'],
  ['tac first.txt second.txt', 'a2\na1\nb2\nb1\n'],
  ['tac second.txt first.txt', 'b2\nb1\na2\na1\n'],
  ['tac empty.txt first.txt empty.txt second.txt', 'a2\na1\nb2\nb1\n'],
  ['tac blank.txt second.txt', 'bottom\n\ntop\nb2\nb1\n'],
  ['tac empty.txt', ''],
  [String.raw`printf 'x\ny\n' | tac first.txt - second.txt`, 'a2\na1\ny\nx\nb2\nb1\n'],
];

export const commandOutputErrorCases: Array<[string, string]> = [
  ['tac first.txt missing.txt second.txt', 'a2\na1\nb2\nb1\n'],
  ['uniq -cd missing.txt', ''],
];
