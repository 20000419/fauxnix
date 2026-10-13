/** Shared lexical expectations, checked against Bash and real PowerShell. */
export const lexicalCases: Array<[string, string, number, string?]> = [
  ['for x in do; do echo "$x"; done', 'do\n', 0],
  ['for x in one do two; do echo "$x"; done', 'one\ndo\ntwo\n', 0],
  ['for x in; do echo wrong; done', '', 0],
  ['for x in do\n# body follows\n do echo "$x"; done', 'do\n', 0],
  [String.raw`printf '%s\n' \~ \~/docs '~' "~"`, '~\n~/docs\n~\n~\n', 0],
  [String.raw`FX_VALUE=\~; printf '%s\n' "$FX_VALUE"`, '~\n', 0],
  [String.raw`FX_VALUE=\~/docs; printf '%s\n' "$FX_VALUE"`, '~/docs\n', 0],
  [String.raw`FX_VALUE=\(x\); printf '%s\n' "$FX_VALUE"`, '(x)\n', 0],
  [String.raw`FX_VALUE=\~ printenv FX_VALUE`, '~\n', 0],
  ['FX_ARRAY=(x y); printf "%s\\n" "${FX_ARRAY[@]}"', 'x\ny\n', 0],
  [String.raw`\FX_LEXICAL=1 echo wrong; echo $?`, '127\n', 0, 'FX_LEXICAL=1: command not found'],
  [String.raw`FX_LEXICAL\=1 echo wrong; echo $?`, '127\n', 0, 'FX_LEXICAL=1: command not found'],
  [`'FX_'LEXICAL=1 echo wrong; echo $?`, '127\n', 0, 'FX_LEXICAL=1: command not found'],
  [`"FX_"LEXICAL=1 echo wrong; echo $?`, '127\n', 0, 'FX_LEXICAL=1: command not found'],
];

export const invalidForHeaders = [
  'for x in one; two; do echo "$x"; done',
  'for x in one do echo "$x"; done',
  'for x in one; ; do echo "$x"; done',
  'for x in one\n; do echo "$x"; done',
  'for x in one;; do echo "$x"; done',
];
