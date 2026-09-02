import {
  Assignment,
  CommandList,
  FauxnixParseError,
  ListSegment,
  Pipeline,
  Redirect,
  RedirectOp,
  SimpleCommand,
  IfCommand,
  ForCommand,
  WhileCommand,
  CaseCommand,
  CaseArm,
  ShellCommand,
  Word,
  WordPart,
  isUnquotedLiteral,
  wordToString,
} from './ast.js';

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type TokType = 'WORD' | 'OP' | 'EOF';
interface Token {
  type: TokType;
  /** For WORD: the parsed parts. For OP: the operator text. */
  op?: string;
  parts?: WordPart[];
  /** True when this token was not preceded by whitespace. */
  tightLeft?: boolean;
}

const OPERATORS = [
  '&&', '||', '>>', '<<', '2>&1', '1>&2', '2>', '&>>', '&>', '>', '<', '|', ';;', ';', '&',
] as const;

const BACKGROUND_MSG =
  'fauxnix: background & is not supported yet. Run the command in the foreground instead.';
const WHILE_UNTIL_MSG =
  'fauxnix: while/until loops are not supported yet. Use `for x in ...; do ...; done` over a known list instead.';
const CASE_MSG = 'fauxnix: case is not supported yet. Use if/elif/else instead.';
const FUNCTION_MSG =
  'fauxnix: functions are not supported yet. Inline the body or repeat the command instead.';
const IF_IN_PIPELINE_MSG =
  'fauxnix: if in a pipeline is not supported. Run the if as its own list segment instead of piping into it.';
const FOR_IN_PIPELINE_MSG =
  'fauxnix: for in a pipeline is not supported. Run the for as its own list segment instead of piping into it.';
const CSTYLE_FOR_MSG =
  'fauxnix: C-style for ((...)) is not supported yet. Use `for x in ...; do ...; done` instead.';

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const pushWord = (parts: WordPart[], tightLeft: boolean) => {
    if (parts.length > 0) tokens.push({ type: 'WORD', parts, tightLeft });
  };

  let cur: WordPart[] = [];
  let fdDigits = '';
  let lastWasWs = true;
  let wordTightLeft = false;

  const flush = () => {
    pushWord(cur, wordTightLeft);
    cur = [];
    fdDigits = '';
  };

  const beginWordPart = () => {
    if (cur.length === 0) wordTightLeft = !lastWasWs;
    lastWasWs = false;
  };

  while (i < n) {
    const ch = input[i];

    // whitespace separates words; newline acts as ';'
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      lastWasWs = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      flush();
      tokens.push({ type: 'OP', op: '\n', tightLeft: false });
      lastWasWs = true;
      i++;
      continue;
    }

    // comments
    if (ch === '#' && cur.length === 0) {
      while (i < n && input[i] !== '\n') i++;
      continue;
    }

    // line continuation
    if (ch === '\\' && i + 1 < n && input[i + 1] === '\n') {
      i += 2;
      continue;
    }

    // try operators (longest first — list above is ordered)
    let matched: string | undefined;
    for (const op of OPERATORS) {
      if (input.startsWith(op, i)) {
        matched = op;
        break;
      }
    }
    if (matched) {
      // bash folds a leading fd digit into the redirect: `2>`, `2>>`, `2>&1`
      const isRedirectish =
        matched[0] === '>' || matched[0] === '<' || matched === '&>' || matched === '&>>';
      const curIsFd =
        fdDigits.length > 0 &&
        cur.length === fdDigits.length &&
        cur.every((p, idx) => p.kind === 'Text' && p.text === fdDigits[idx]);
      let advance = matched.length;
      if (isRedirectish && matched !== '<<' && curIsFd) {
        cur = []; // drop the digits from the pending word
        if (matched === '>>') matched = fdDigits + '>>';
        else if (matched === '>') {
          if (input.startsWith('&1', i + 1)) matched = fdDigits + '>&1';
          else if (input.startsWith('&2', i + 1)) matched = fdDigits + '>&2';
          else matched = fdDigits + '>';
        }
        // the fd digits were consumed earlier; advance past the operator tail only
        advance = matched.length - fdDigits.length;
        fdDigits = '';
      }
      if (matched === '<<') {
        throw new FauxnixParseError(
          'fauxnix: heredocs (<<) are not supported yet. Pass the text via echo pipe or a temp file instead.',
        );
      }
      const tightLeft = !lastWasWs;
      flush();
      tokens.push({ type: 'OP', op: matched, tightLeft });
      lastWasWs = false;
      i += advance;
      continue;
    }

    // single quotes — fully literal
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new FauxnixParseError('fauxnix: unclosed single quote');
      beginWordPart();
      cur.push({ kind: 'SingleQuoted', text: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // double quotes — interpolated
    if (ch === '"') {
      beginWordPart();
      i++;
      const parts: WordPart[] = [];
      let buf = '';
      while (i < n && input[i] !== '"') {
        const c = input[i];
        if (c === '\\' && i + 1 < n && '"$`\\'.includes(input[i + 1])) {
          buf += input[i + 1];
          i += 2;
          continue;
        }
        if (c === '$') {
          const v = readDollar(input, i);
          if (v) {
            if (buf) {
              parts.push({ kind: 'Text', text: buf });
              buf = '';
            }
            parts.push(v.part);
            i = v.next;
            continue;
          }
        }
        if (c === '`') {
          const v = readBacktick(input, i);
          if (buf) {
            parts.push({ kind: 'Text', text: buf });
            buf = '';
          }
          parts.push(v.part);
          i = v.next;
          continue;
        }
        buf += c;
        i++;
      }
      if (i >= n) throw new FauxnixParseError('fauxnix: unclosed double quote');
      i++;
      if (buf) parts.push({ kind: 'Text', text: buf });
      cur.push({ kind: 'DoubleQuoted', parts });
      continue;
    }

    // dollar — variable or command substitution
    if (ch === '$') {
      const v = readDollar(input, i);
      if (v) {
        beginWordPart();
        cur.push(v.part);
        i = v.next;
        continue;
      }
      beginWordPart();
      cur.push({ kind: 'Text', text: '$' });
      i++;
      continue;
    }

    if (ch === '`') {
      const v = readBacktick(input, i);
      beginWordPart();
      cur.push(v.part);
      i = v.next;
      continue;
    }

    // escape outside quotes — keep the escape so [[ =~ ]] / == can
    // treat `\*` as a literal rather than a metacharacter
    if (ch === '\\' && i + 1 < n) {
      beginWordPart();
      cur.push({ kind: 'Text', text: input[i + 1], escaped: true });
      i += 2;
      continue;
    }

    // track leading digits (potential fd number for redirects)
    if (/[0-9]/.test(ch) && cur.length === 0 && fdDigits.length < 2) {
      beginWordPart();
      fdDigits += ch;
      cur.push({ kind: 'Text', text: ch });
      i++;
      continue;
    }
    fdDigits = '';

    beginWordPart();
    cur.push({ kind: 'Text', text: ch });
    i++;
  }
  flush();
  tokens.push({ type: 'EOF' });
  return tokens;
}

function isNameStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}
function isNameChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/** Parse `cmd` as command substitution (same AST as $(cmd)). */
function readBacktick(input: string, i: number): { part: WordPart; next: number } {
  if (input[i] !== '`') throw new FauxnixParseError('fauxnix: expected backtick');
  let k = i + 1;
  while (k < input.length) {
    if (input[k] === '\\' && k + 1 < input.length) {
      k += 2;
      continue;
    }
    if (input[k] === '`') {
      return { part: { kind: 'CmdSub', cmd: input.slice(i + 1, k) }, next: k + 1 };
    }
    k++;
  }
  throw new FauxnixParseError('fauxnix: unclosed backtick');
}

/** Expand `$…` constructs that appear inside `$((…))`. */
function readArithParts(input: string): WordPart[] {
  const parts: WordPart[] = [];
  let buf = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] === '$') {
      const v = readDollar(input, i);
      if (v) {
        if (buf) {
          parts.push({ kind: 'Text', text: buf });
          buf = '';
        }
        parts.push(v.part);
        i = v.next;
        continue;
      }
    }
    buf += input[i];
    i++;
  }
  if (buf) parts.push({ kind: 'Text', text: buf });
  return parts;
}

/** Integer or `$name` operand of `${name:offset:length}`. */
function readSliceNum(s: string, i: number): { val: string; next: number } | null {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i >= s.length) return null;
  if (s[i] === '$') {
    const j = i + 1;
    if (j < s.length && isNameStart(s[j])) {
      let k = j + 1;
      while (k < s.length && isNameChar(s[k])) k++;
      return { val: s.slice(i, k), next: k };
    }
    if (j < s.length && (/[0-9]/.test(s[j]) || s[j] === '?' || s[j] === '$')) {
      return { val: s.slice(i, j + 1), next: j + 1 };
    }
    return null;
  }
  let sign = '';
  if (s[i] === '-' || s[i] === '+') {
    sign = s[i];
    i++;
  }
  if (i >= s.length || !/[0-9]/.test(s[i])) return null;
  let k = i;
  while (k < s.length && /[0-9]/.test(s[k])) k++;
  return { val: sign + s.slice(i, k), next: k };
}

/** Parse `offset` / `offset:length` after `${name:`. Null if not a slice. */
function parseSliceSpec(after: string): { offset: string; length?: string } | null {
  const off = readSliceNum(after, 0);
  if (!off) return null;
  let i = off.next;
  while (i < after.length && (after[i] === ' ' || after[i] === '\t')) i++;
  if (i >= after.length) return { offset: off.val };
  if (after[i] !== ':') return null;
  i++;
  while (i < after.length && (after[i] === ' ' || after[i] === '\t')) i++;
  if (i >= after.length) return { offset: off.val, length: '0' };
  const len = readSliceNum(after, i);
  if (!len) return null;
  i = len.next;
  while (i < after.length && (after[i] === ' ' || after[i] === '\t')) i++;
  if (i !== after.length) return null;
  return { offset: off.val, length: len.val };
}

/** Parse $VAR, ${VAR}, $(cmd substitution), $((arith)). Returns null when not a valid dollar construct. */
function readDollar(input: string, i: number): { part: WordPart; next: number } | null {
  const n = input.length;
  if (input[i] !== '$') return null;
  let j = i + 1;
  if (j >= n) return null;

  // ${...}
  if (input[j] === '{') {
    const end = input.indexOf('}', j);
    if (end === -1) throw new FauxnixParseError('fauxnix: unclosed ${');
    const inner = input.slice(j + 1, end);
    const nextPos = end + 1;

    const hash = inner.match(/^#([A-Za-z_][A-Za-z0-9_]*)(\[([0-9]+|@|\*)\])?$/);
    if (hash) {
      return {
        part: { kind: 'Var', name: hash[1], index: hash[3], length: true },
        next: nextPos,
      };
    }
    // ${1} ${#} ${@} ${*} — positional / special params (not ${#name} length)
    if (inner === '#' || inner === '@' || inner === '*' || /^[0-9]+$/.test(inner)) {
      return { part: { kind: 'Var', name: inner }, next: nextPos };
    }

    const sub = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\[([0-9]+|@|\*)\]$/);
    if (sub) {
      return { part: { kind: 'Var', name: sub[1], index: sub[2] }, next: nextPos };
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*\[([0-9]+|@|\*)\]/.test(inner)) {
      throw new FauxnixParseError(
        'fauxnix: ${name[@]:offset:length} subarray slice is not supported; use ${name:offset:length} on a scalar or ${name[i]} per element',
      );
    }

    const ident = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (ident) {
      const nm = ident[1];
      const rest = inner.slice(nm.length);

      if (rest.startsWith('/#') || rest.startsWith('/%')) {
        throw new FauxnixParseError(
          'fauxnix: ${name/#pat/str} and ${name/%pat/str} are not supported; use ${name//pat/str} instead',
        );
      }

      if (rest.startsWith('/')) {
        const global = rest.startsWith('//');
        const body = rest.slice(global ? 2 : 1);
        const slash = body.indexOf('/');
        const pat = slash === -1 ? body : body.slice(0, slash);
        const repl = slash === -1 ? '' : body.slice(slash + 1);
        return {
          part: { kind: 'Var', name: nm, replace: { global, pat, repl } },
          next: nextPos,
        };
      }

      if (rest.startsWith(':')) {
        const after = rest.slice(1);
        let t = 0;
        while (t < after.length && (after[t] === ' ' || after[t] === '\t')) t++;
        const lead = t < after.length ? after[t] : '';
        const hadSpace = t > 0;
        const paramLead =
          lead === '+' || lead === '?' || lead === '=' || (lead === '-' && !hadSpace);
        if (!paramLead && lead !== '') {
          const sl = parseSliceSpec(after);
          if (sl) {
            return { part: { kind: 'Var', name: nm, slice: sl }, next: nextPos };
          }
        }
      }

      const pm = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)(:?[-+?])(.*)$/);
      if (pm) {
        const op = pm[2] as ':-' | ':+' | ':?' | '-' | '+' | '?';
        return {
          part: { kind: 'Var', name: pm[1], param: { op, word: pm[3] } },
          next: nextPos,
        };
      }

      if (rest === '') {
        return { part: { kind: 'Var', name: nm }, next: nextPos };
      }
    }

    if (!inner || !isNameStart(inner[0]) || !inner.split('').every(isNameChar)) {
      // ${VAR:=default} etc. still raw text
      return { part: { kind: 'Text', text: input.slice(i, end + 1) }, next: nextPos };
    }
    return { part: { kind: 'Var', name: inner }, next: nextPos };
  }

  // $((...)) arithmetic expansion — distinct from `$( (cmd) )` (space after
  // the first paren is command substitution of a grouped body).
  if (input[j] === '(' && j + 1 < n && input[j + 1] === '(') {
    let depth = 0;
    let k = j;
    while (k < n) {
      const c = input[k];
      if (c === "'" || c === '"') {
        const q = c;
        k++;
        while (k < n && input[k] !== q) {
          if (input[k] === '\\') k++;
          k++;
        }
        k++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          k++;
          break;
        }
      }
      k++;
    }
    if (depth !== 0) throw new FauxnixParseError('fauxnix: unclosed $(( ))');
    return {
      part: { kind: 'Arith', parts: readArithParts(input.slice(j + 2, k - 2)) },
      next: k,
    };
  }

  // $(cmd substitution) — captured with balanced parens; the translator
  // recursively translates this text before embedding it.
  if (input[j] === '(') {
    let depth = 1;
    let k = j + 1;
    while (k < n && depth > 0) {
      if (input[k] === '(') depth++;
      else if (input[k] === ')') depth--;
      else if (input[k] === "'" || input[k] === '"') {
        const q = input[k];
        k++;
        while (k < n && input[k] !== q) {
          if (input[k] === '\\') k++;
          k++;
        }
      }
      k++;
    }
    if (depth !== 0) throw new FauxnixParseError('fauxnix: unclosed $( )');
    const cmdText = input.slice(j + 1, k - 1);
    return { part: { kind: 'CmdSub', cmd: cmdText }, next: k };
  }

  // $NAME
  if (isNameStart(input[j])) {
    let len = 1;
    while (j + len < n && isNameChar(input[j + len])) len++;
    return { part: { kind: 'Var', name: input.slice(j, j + len) }, next: j + len };
  }

  // special: $? $$ $0-$9 $# $@ $* — kept as symbolic Var; the translator maps them
  if ('?$_#@*'.includes(input[j]) || /[0-9]/.test(input[j])) {
    return { part: { kind: 'Var', name: input[j] }, next: j + 1 };
  }
  return null;
}

function hasBareAmp(w: Word): boolean {
  let depth = 0;
  for (const p of w) {
    if (p.kind !== 'Text' || p.escaped) continue;
    for (const c of p.text) {
      if (c === '(') depth++;
      else if (c === ')' && depth > 0) depth--;
      else if (c === '&' && depth === 0) return true;
    }
  }
  return false;
}

function looksLikeArithWord(w: Word): boolean {
  const s = wordToString(w);
  return (
    /^[0-9a-fA-FxX#+\-*/%()<>&=!~|^?,: \t]+$/.test(s) && /[+\-*/%<>&=!~|^?]/.test(s)
  );
}

function hasBareNonExtglobParen(w: Word): boolean {
  const chars: string[] = [];
  for (const p of w) {
    if (p.kind === 'Text' && !p.escaped) {
      for (const c of p.text) chars.push(c);
    } else {
      chars.push('\0');
    }
  }
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '(') continue;
    const prev = i > 0 ? chars[i - 1] : '';
    if (prev !== '@' && prev !== '*' && prev !== '?' && prev !== '+' && prev !== '!') return true;
  }
  return false;
}

function regexHasExtraClose(w: Word): boolean {
  let depth = 0;
  for (const p of w) {
    if (p.kind !== 'Text' || p.escaped) continue;
    for (const c of p.text) {
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) return true;
        depth--;
      }
    }
  }
  return false;
}

function unmatchedOpenParen(w: Word): boolean {
  let depth = 0;
  for (const p of w) {
    if (p.kind !== 'Text' || p.escaped) continue;
    for (const c of p.text) {
      if (c === '(') depth++;
      else if (c === ')' && depth > 0) depth--;
    }
  }
  return depth > 0;
}

/** True when `w` has an unclosed unquoted `@(…)`, `+(…)`, `*(…)`, `?(…)`, or `!(…)`. */
function unmatchedExtglob(w: Word): boolean {
  const chars: string[] = [];
  for (const p of w) {
    if (p.kind === 'Text' && !p.escaped) {
      for (const c of p.text) chars.push(c);
    } else {
      chars.push('\0');
    }
  }
  let depth = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (
      (c === '@' || c === '*' || c === '?' || c === '+' || c === '!') &&
      chars[i + 1] === '('
    ) {
      depth++;
      i++;
      continue;
    }
    if (c === ')' && depth > 0) depth--;
  }
  return depth > 0;
}

/**
 * Peel grouping `(` / `)` that bash tokenizes even without spaces,
 * but leave extglob `@(…)` / `!(foo)bar` intact.
 */
function splitCondParens(w: Word): Word[] {
  const leading: Word[] = [];
  const trailing: Word[] = [];
  let rest: Word = w.map((p) => (p.kind === 'Text' ? { ...p } : p));

  for (;;) {
    if (rest.length === 0) break;
    const p = rest[0];
    if (p.kind !== 'Text' || p.escaped || !p.text.startsWith('(')) break;
    leading.push([{ kind: 'Text', text: '(' }]);
    rest =
      p.text.length === 1
        ? rest.slice(1)
        : [{ kind: 'Text', text: p.text.slice(1), escaped: p.escaped }, ...rest.slice(1)];
  }

  for (;;) {
    if (rest.length === 0) break;
    const last = rest[rest.length - 1];
    if (last.kind !== 'Text' || last.escaped || !last.text.endsWith(')')) break;
    const without: Word =
      last.text.length === 1
        ? rest.slice(0, -1)
        : [
            ...rest.slice(0, -1),
            { kind: 'Text', text: last.text.slice(0, -1), escaped: last.escaped },
          ];
    if (unmatchedExtglob(without) || unmatchedOpenParen(without)) break;
    trailing.unshift([{ kind: 'Text', text: ')' }]);
    rest = without;
  }

  const mid = rest.length > 0 ? [rest] : [];
  return [...leading, ...mid, ...trailing];
}

function groupingDepth(args: Word[]): number {
  let d = 0;
  for (const w of args) {
    if (isUnquotedLiteral(w, '(')) d++;
    else if (isUnquotedLiteral(w, ')')) d--;
  }
  return d;
}

/** Peel trailing grouping `)` off a `=~` operand when a `(` is still open. */
function peelTrailingGroupCloses(w: Word, max: number): Word[] {
  if (max <= 0) return w.length ? [w] : [];
  const { rest, trailing } = (() => {
    const trailing: Word[] = [];
    let rest: Word = w.map((p) => (p.kind === 'Text' ? { ...p } : p));
    while (trailing.length < max) {
      if (rest.length === 0) break;
      const last = rest[rest.length - 1];
      if (last.kind !== 'Text' || last.escaped || !last.text.endsWith(')')) break;
      const without: Word =
        last.text.length === 1
          ? rest.slice(0, -1)
          : [
              ...rest.slice(0, -1),
              { kind: 'Text', text: last.text.slice(0, -1), escaped: last.escaped },
            ];
      if (unmatchedOpenParen(without)) break;
      rest = without;
      trailing.unshift([{ kind: 'Text', text: ')' }]);
    }
    return { rest, trailing };
  })();
  const mid = rest.length > 0 ? [rest] : [];
  return [...mid, ...trailing];
}

function canNlInsideDblBracket(args: Word[]): boolean {
  if (args.length === 0) return true;
  const last = args[args.length - 1];
  if (
    isUnquotedLiteral(last, '&&') ||
    isUnquotedLiteral(last, '||') ||
    isUnquotedLiteral(last, '!') ||
    isUnquotedLiteral(last, '(')
  )
    return true;
  if (
    isUnquotedLiteral(last, '=~') ||
    isUnquotedLiteral(last, '==') ||
    isUnquotedLiteral(last, '=') ||
    isUnquotedLiteral(last, '!=') ||
    isUnquotedLiteral(last, '-e') ||
    isUnquotedLiteral(last, '-a') ||
    isUnquotedLiteral(last, '-f') ||
    isUnquotedLiteral(last, '-d') ||
    isUnquotedLiteral(last, '-r') ||
    isUnquotedLiteral(last, '-w') ||
    isUnquotedLiteral(last, '-x') ||
    isUnquotedLiteral(last, '-s') ||
    isUnquotedLiteral(last, '-z') ||
    isUnquotedLiteral(last, '-n') ||
    isUnquotedLiteral(last, '-L') ||
    isUnquotedLiteral(last, '-h') ||
    isUnquotedLiteral(last, '-v')
  )
    return false;
  if (args.length === 1) return false;
  return true;
}

/** Most recent unquoted `=~` / `==` / `=` / `!=` still open in this `[[`. */
function pendingPatternOp(args: Word[]): '=~' | '==' | null {
  for (let i = args.length - 1; i >= 0; i--) {
    const w = args[i];
    if (isUnquotedLiteral(w, '=~')) return '=~';
    if (
      isUnquotedLiteral(w, '==') ||
      isUnquotedLiteral(w, '=') ||
      isUnquotedLiteral(w, '!=')
    )
      return '==';
    if (isUnquotedLiteral(w, '&&') || isUnquotedLiteral(w, '||')) return null;
  }
  return null;
}

/** Unquoted `(` / `)` net depth in a word (quoted / escaped parens ignored). */
function unquotedParenDelta(w: Word): number {
  let d = 0;
  for (const p of w) {
    if (p.kind !== 'Text' || p.escaped) continue;
    for (const c of p.text) {
      if (c === '(') d++;
      else if (c === ')') d--;
    }
  }
  return d;
}

function startsWithUnquotedOpenParen(w: Word): boolean {
  if (w.length === 0) return false;
  const p = w[0];
  return p.kind === 'Text' && !p.escaped && p.text.startsWith('(');
}

/** `NAME+=` (scalar or array append) — out of scope for C-2. */
function isAppendAssignment(w: Word): boolean {
  let s = '';
  for (const p of w) {
    if (p.kind === 'Text' && !p.escaped) s += p.text;
    else break;
    if (/^[A-Za-z_][A-Za-z0-9_]*\+=/.test(s)) return true;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) return false;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*\+=/.test(s);
}

function cloneWord(w: Word): Word {
  return w.map((p) => {
    if (p.kind === 'Text' || p.kind === 'SingleQuoted') return { ...p };
    if (p.kind === 'DoubleQuoted') return { kind: 'DoubleQuoted' as const, parts: p.parts.slice() };
    return p;
  });
}

/** Strip the opening `(` and closing `)` that wrap an array assignment value. */
function stripArrayParens(words: Word[]): Word[] {
  if (words.length === 0) return [];
  const ws = words.map(cloneWord);
  const first = ws[0];
  if (first.length > 0 && first[0].kind === 'Text' && first[0].text.startsWith('(')) {
    first[0] = { kind: 'Text', text: first[0].text.slice(1), escaped: first[0].escaped };
    if (first[0].text === '') first.shift();
  }
  const last = ws[ws.length - 1];
  for (let i = last.length - 1; i >= 0; i--) {
    const p = last[i];
    if (p.kind === 'Text' && !p.escaped && p.text.endsWith(')')) {
      const trimmed = p.text.slice(0, -1);
      if (trimmed === '') last.splice(i, 1);
      else last[i] = { kind: 'Text', text: trimmed, escaped: p.escaped };
      break;
    }
  }
  return ws.filter((w) => w.length > 0);
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export function parseCommand(input: string): CommandList {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const isListSep = (o?: string) => o === ';' || o === '\n';

  const isAmpWord = (t: Token | undefined): boolean =>
    (!!t && t.type === 'OP' && t.op === '&') ||
    (!!t && t.type === 'WORD' && !!t.parts && isUnquotedLiteral(t.parts, '&'));

  const isCaseFallthrough = (): boolean => {
    const t = peek();
    if (t.type !== 'OP') return false;
    return (t.op === ';' || t.op === ';;') && isAmpWord(tokens[pos + 1]);
  };

  const throwUnexpectedDsemi = (): never => {
    throw new FauxnixParseError("fauxnix: syntax error near unexpected token `;;'");
  };

  const throwCaseFallthrough = (): never => {
    throw new FauxnixParseError(
      'fauxnix: case fallthrough (;& / ;;&) is not supported; use ;; (no fallthrough) or duplicate the body',
    );
  };

  /** Consume `;` / newline / `&&` / `||`. Trailing `&&`/`||` and `;;` fail loud (bash). */
  const consumeListOp = (stops?: Set<string>): ';' | '&&' | '||' | null => {
    const t = peek();
    if (t.type !== 'OP') return null;
    if (t.op === '&') {
      // inside a case arm, `;&` / `;;&` is fallthrough — report that, not background
      if (stops && stops.has(';;')) throwCaseFallthrough();
      throw new FauxnixParseError(BACKGROUND_MSG);
    }
    if (t.op === ';;') {
      if (stops && stops.has(';;')) return null;
      throwUnexpectedDsemi();
    }
    if (!(t.op === '&&' || t.op === '||' || isListSep(t.op))) return null;
    if (t.op === ';') {
      if (stops && stops.has(';;') && isAmpWord(tokens[pos + 1])) return null;
      next();
      if (peek().type === 'OP' && (peek().op === ';' || peek().op === ';;')) {
        throwUnexpectedDsemi();
      }
      return ';';
    }
    if (t.op === '\n') {
      next();
      while (peek().type === 'OP' && peek().op === '\n') next();
      return ';';
    }
    const sep = t.op as '&&' | '||';
    next();
    while (peek().type === 'OP' && peek().op === '\n') next();
    const n = peek();
    const kw = peekKw();
    if (n.type === 'OP' && n.op === ';') {
      throw new FauxnixParseError("fauxnix: syntax error near unexpected token `" + sep + "'");
    }
    if (n.type === 'EOF' || (stops && kw && stops.has(kw))) {
      throw new FauxnixParseError(
        n.type === 'EOF'
          ? 'fauxnix: syntax error: unexpected end of file after `' + sep + "'"
          : "fauxnix: syntax error near unexpected token `" + sep + "'",
      );
    }
    return sep;
  };

  const parseList = (): CommandList => {
    const segments: ListSegment[] = [];
    let op: ';' | '&&' | '||' = ';';
    while (peek().type === 'OP' && isListSep(peek().op)) {
      if (peek().op === ';' && tokens[pos + 1]?.type === 'OP' && (tokens[pos + 1]?.op === ';' || tokens[pos + 1]?.op === ';;')) {
        throwUnexpectedDsemi();
      }
      next();
    }
    while (peek().type !== 'EOF') {
      if (peek().type === 'OP' && peek().op === ';;') throwUnexpectedDsemi();
      const pipeline = parsePipeline();
      segments.push({ pipeline, op });
      const nextOp = consumeListOp();
      if (nextOp === null) {
        if (peek().type === 'OP' && peek().op === ';;') throwUnexpectedDsemi();
        if (peek().type === 'EOF') break;
        throw new FauxnixParseError('fauxnix: unexpected token after pipeline');
      }
      op = nextOp;
    }
    if (segments.length === 0) throw new FauxnixParseError('fauxnix: empty command');
    return { kind: 'CommandList', segments };
  };

  const parsePipeline = (): Pipeline => {
    const commands: ShellCommand[] = [];
    for (;;) {
      const kw = peekKw();
      if (kw === 'if') {
        if (commands.length > 0) {
          throw new FauxnixParseError(IF_IN_PIPELINE_MSG);
        }
        commands.push(parseIf());
      } else if (kw === 'for') {
        if (commands.length > 0) {
          throw new FauxnixParseError(FOR_IN_PIPELINE_MSG);
        }
        commands.push(parseFor());
      } else if (kw === 'while') {
        if (commands.length > 0) {
          throw new FauxnixParseError('fauxnix: while in a pipeline is not supported');
        }
        commands.push(parseWhile());
      } else if (kw === 'until') {
        if (commands.length > 0) {
          throw new FauxnixParseError('fauxnix: until in a pipeline is not supported');
        }
        commands.push(parseUntil());
      } else if (kw === 'case') {
        if (commands.length > 0) {
          throw new FauxnixParseError('fauxnix: case in a pipeline is not supported');
        }
        commands.push(parseCase());
      } else if (kw === 'function') {
        throw new FauxnixParseError(FUNCTION_MSG);
      } else {
        const cmd = parseSimple();
        if (cmd.kind === 'SimpleCommand' && cmd.name && isFunctionDef(cmd)) {
          throw new FauxnixParseError(FUNCTION_MSG);
        }
        commands.push(cmd);
      }
      const t = peek();
      if (t.type === 'OP' && t.op === '|') {
        next();
        continue;
      }
      break;
    }
    return { kind: 'Pipeline', commands };
  };

  const peekKw = (): string | null => {
    const t = peek();
    if (t.type !== 'WORD' || !t.parts) return null;
    const s = wordToString(t.parts);
    if (!isUnquotedLiteral(t.parts, s)) return null;
    if (
      s === 'if' ||
      s === 'then' ||
      s === 'else' ||
      s === 'elif' ||
      s === 'fi' ||
      s === 'for' ||
      s === 'in' ||
      s === 'do' ||
      s === 'done' ||
      s === 'while' ||
      s === 'until' ||
      s === 'case' ||
      s === 'esac' ||
      s === 'function'
    ) {
      return s;
    }
    return null;
  };

  const expectKw = (k: string): void => {
    if (peekKw() !== k) {
      throw new FauxnixParseError('fauxnix: expected `' + k + "'");
    }
    next();
  };

  const parseListUntil = (stops: string[]): CommandList => {
    const stop = new Set(stops);
    const segments: ListSegment[] = [];
    let op: ';' | '&&' | '||' = ';';
    while (peek().type === 'OP' && isListSep(peek().op)) {
      if (peek().op === ';' && tokens[pos + 1]?.type === 'OP' && (tokens[pos + 1]?.op === ';' || tokens[pos + 1]?.op === ';;')) {
        throwUnexpectedDsemi();
      }
      next();
    }
    while (peek().type !== 'EOF') {
      if (stop.has(';;') && isCaseFallthrough()) break;
      const kw = peekKw();
      if (kw && stop.has(kw)) break;
      const stopOp = peek();
      if (stopOp.type === 'OP' && stopOp.op && stop.has(stopOp.op)) break;
      if (stopOp.type === 'OP' && stopOp.op === ';;') throwUnexpectedDsemi();
      const pipeline = parsePipeline();
      segments.push({ pipeline, op });
      if (stop.has(';;') && isCaseFallthrough()) break;
      const nextOp = consumeListOp(stop);
      if (nextOp === null) break;
      op = nextOp;
    }
    if (segments.length === 0) {
      if (stop.has(';;')) return { kind: 'CommandList', segments: [] };
      throw new FauxnixParseError('fauxnix: empty command');
    }
    return { kind: 'CommandList', segments };
  };

  const parseIf = (start: 'if' | 'elif' = 'if'): IfCommand => {
    expectKw(start);
    const test = parseListUntil(['then']);
    expectKw('then');
    const thenL = parseListUntil(['else', 'elif', 'fi']);
    let elseL: CommandList | undefined;
    if (peekKw() === 'elif') {
      // bash `elif` is `else` + nested `if`; the innermost clause eats `fi`.
      elseL = {
        kind: 'CommandList',
        segments: [
          {
            op: ';',
            pipeline: { kind: 'Pipeline', commands: [parseIf('elif')] },
          },
        ],
      };
      return { kind: 'If', test, then: thenL, else: elseL, redirects: [] };
    }
    if (peekKw() === 'else') {
      next();
      elseL = parseListUntil(['fi']);
    }
    expectKw('fi');
    return { kind: 'If', test, then: thenL, else: elseL, redirects: [] };
  };

  const parseFor = (): ForCommand => {
    expectKw('for');
    const nt = peek();
    if (nt.type !== 'WORD' || !nt.parts) {
      throw new FauxnixParseError('fauxnix: `for` expected a name');
    }
    const name = wordToString(nt.parts);
    if (name.startsWith('((')) {
      throw new FauxnixParseError(CSTYLE_FOR_MSG);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !isUnquotedLiteral(nt.parts, name)) {
      throw new FauxnixParseError('fauxnix: `for` name must be an identifier');
    }
    next();
    expectKw('in');
    const words: Word[] = [];
    for (;;) {
      while (peek().type === 'OP' && (peek().op === ';' || peek().op === '\n')) next();
      if (peekKw() === 'do') break;
      const t = peek();
      if (t.type !== 'WORD' || !t.parts) {
        throw new FauxnixParseError("fauxnix: `for` expected `do`");
      }
      words.push(t.parts);
      next();
    }
    expectKw('do');
    const body = parseListUntil(['done']);
    expectKw('done');
    return { kind: 'For', name, words, body, redirects: [] };
  };

  const parseWhile = (): WhileCommand => parseWhileLoop(false);
  const parseUntil = (): WhileCommand => parseWhileLoop(true);

  const parseWhileLoop = (until: boolean): WhileCommand => {
    expectKw(until ? 'until' : 'while');
    const test = parseListUntil(['do']);
    expectKw('do');
    const body = parseListUntil(['done']);
    expectKw('done');
    return { kind: 'While', until, test, body, redirects: [] };
  };
  const skipCaseSeps = (): void => {
    while (peek().type === 'OP' && isListSep(peek().op)) {
      if (peek().op === ';' && isAmpWord(tokens[pos + 1])) break;
      next();
    }
  };

  /** Strip a trailing unquoted `)` that closes a case pattern list. */
  const stripTrailingUnquotedParen = (w: Word): Word | null => {
    if (w.length === 0) return null;
    const last = w[w.length - 1];
    if (last.kind !== 'Text' || last.escaped || !last.text.endsWith(')')) return null;
    const rest = last.text.slice(0, -1);
    if (rest.length === 0) return w.slice(0, -1);
    return [...w.slice(0, -1), { kind: 'Text', text: rest, escaped: last.escaped }];
  };

  const parseCasePatterns = (): Word[] => {
    const patterns: Word[] = [];
    for (;;) {
      while (peek().type === 'OP' && (peek().op === '|' || peek().op === '\n')) next();
      if (peekKw() === 'esac') {
        throw new FauxnixParseError("fauxnix: expected `)'");
      }
      const t = peek();
      if (t.type !== 'WORD' || !t.parts) {
        throw new FauxnixParseError('fauxnix: `case` expected a pattern');
      }
      const stripped = stripTrailingUnquotedParen(t.parts);
      if (stripped !== null) {
        next();
        if (stripped.length > 0) patterns.push(stripped);
        if (patterns.length === 0) {
          throw new FauxnixParseError('fauxnix: `case` expected a pattern');
        }
        return patterns;
      }
      patterns.push(t.parts);
      next();
    }
  };

  const parseCase = (): CaseCommand => {
    expectKw('case');
    skipCaseSeps();
    const wt = peek();
    if (wt.type !== 'WORD' || !wt.parts) {
      throw new FauxnixParseError('fauxnix: `case` expected a word');
    }
    const word = wt.parts;
    next();
    skipCaseSeps();
    expectKw('in');
    const arms: CaseArm[] = [];
    skipCaseSeps();
    while (peek().type !== 'EOF' && peekKw() !== 'esac') {
      if (isCaseFallthrough()) throwCaseFallthrough();
      const patterns = parseCasePatterns();
      const body = parseListUntil(['esac', ';;']);
      if (isCaseFallthrough()) throwCaseFallthrough();
      if (peek().type === 'OP' && peek().op === ';;') {
        next();
        if (isAmpWord(peek())) throwCaseFallthrough();
      }
      arms.push({ patterns, body });
      skipCaseSeps();
    }
    expectKw('esac');
    return { kind: 'Case', word, arms, redirects: [] };
  };

  const parseSimple = (): SimpleCommand => {
    const assignments: Assignment[] = [];
    let redirects: Redirect[] = [];
    let name: Word | null = null;
    const args: Word[] = [];

    for (;;) {
      const t = peek();
      if (t.type === 'EOF') break;

      // possible redirect operator
      // Inside `[[ ... ]]`, && || < > and other redirect-shaped tokens are
      // conditional operators (or just words), not shell redirects/lists.
      // Stop this special case at the first *unquoted* ]].
      if (
        t.type === 'OP' &&
        name !== null &&
        isUnquotedLiteral(name, '[[') &&
        !args.some((w) => isUnquotedLiteral(w, ']]')) &&
        (t.op === '&&' ||
          t.op === '||' ||
          t.op === '|' ||
          t.op === '&' ||
          t.op === '>' ||
          t.op === '<' ||
          t.op === '>>' ||
          t.op === '2>' ||
          t.op === '2>>' ||
          t.op === '&>' ||
          t.op === '&>>' ||
          t.op === '2>&1' ||
          t.op === '1>&2')
      ) {
        next();
        // Glue `|` onto the surrounding words so `=~ ^a|z$`,
        // `=~ (a | b)c`, and `== @(x | y)` stay one operand. A
        // spaced `|` outside an open regex / extglob group is a
        // syntax error (bash). Tight `&` inside an open `=~ (…)`
        // group stays in the regex, not a background job.
        const last = args.length ? args[args.length - 1] : null;
        const lastIsEqTilde = last !== null && isUnquotedLiteral(last, '=~');
        const prevIsEqTilde =
          args.length >= 2 && isUnquotedLiteral(args[args.length - 2], '=~');
        const openRe =
          last !== null &&
          pendingPatternOp(args) === '=~' &&
          unmatchedOpenParen(last);
        const openExt =
          last !== null &&
          pendingPatternOp(args) === '==' &&
          unmatchedExtglob(last);
        const inRe = lastIsEqTilde || prevIsEqTilde || openRe;
        if (t.op === '&') {
          if (!(openRe && last && t.tightLeft)) {
            throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `&'");
          }
          args[args.length - 1] = [...last, { kind: 'Text', text: '&' }];
          const n = peek();
          if (n.type === 'WORD' && n.tightLeft && n.parts) {
            next();
            args[args.length - 1] = [...args[args.length - 1], ...n.parts];
          }
        } else if (t.op === '|' || ((inRe || openExt) && t.tightLeft && t.op === '||')) {
          if (
            t.op === '|' &&
            !lastIsEqTilde &&
            !(prevIsEqTilde && t.tightLeft) &&
            !openRe &&
            !openExt
          ) {
            throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `|'");
          }
          const piece: WordPart[] =
            t.tightLeft || lastIsEqTilde
              ? [{ kind: 'Text', text: t.op! }]
              : [{ kind: 'Text', text: ' ' }, { kind: 'Text', text: t.op! }];
          if (lastIsEqTilde) args.push(piece);
          else args[args.length - 1] = [...args[args.length - 1], ...piece];
          const n = peek();
          if (n.type === 'WORD' && n.tightLeft && n.parts) {
            next();
            args[args.length - 1] = [...args[args.length - 1], ...n.parts];
          }
        } else if (t.op === '&&' || t.op === '||' || t.op === '>' || t.op === '<') {
          if (openRe && last) {
            const piece: WordPart[] = t.tightLeft
              ? [{ kind: 'Text', text: t.op! }]
              : [{ kind: 'Text', text: ' ' }, { kind: 'Text', text: t.op! }];
            args[args.length - 1] = [...last, ...piece];
            const n = peek();
            if (n.type === 'WORD' && n.tightLeft && n.parts) {
              next();
              args[args.length - 1] = [...args[args.length - 1], ...n.parts];
            }
          } else {
            args.push([{ kind: 'Text', text: t.op! }]);
            if (t.op === '&&' || t.op === '||') {
              while (peek().type === 'OP' && peek().op === '\n') next();
            }
          }
        } else {
          throw new FauxnixParseError(
            "fauxnix: [[: syntax error near unexpected token `" + t.op + "'",
          );
        }
        continue;
      }

      if (
        t.type === 'OP' &&
        t.op === '\n' &&
        name !== null &&
        isUnquotedLiteral(name, '[[') &&
        !args.some((w) => isUnquotedLiteral(w, ']]')) &&
        canNlInsideDblBracket(args)
      ) {
        next();
        continue;
      }

      if (t.type === 'OP' && isRedirectOp(t.op!)) {
        const op = t.op!;
        next();
        // fd-dup operators (2>&1, 1>&2) carry their own target
        const target = op === '2>&1' || op === '1>&2' ? '' : readRedirectTarget();
        redirects.push({ op: normalizeRedirect(op), target });
        continue;
      }

      if (t.type === 'OP') break;

      const word = t.parts!;

      // assignment prefix before command name?
      if (name === null && isAppendAssignment(word)) {
        throw new FauxnixParseError(
          'fauxnix: `+=` append is not supported; use `A=(${A[@]} x)` or `A=(x y)` instead',
        );
      }
      if (name === null && isAssignment(word)) {
        next();
        const split = splitAssignment(word);
        if (split) {
          if (startsWithUnquotedOpenParen(split.value)) {
            const elems: Word[] = [split.value];
            let depth = unquotedParenDelta(split.value);
            while (depth > 0 && peek().type === 'WORD' && peek().parts) {
              const nxt = peek().parts!;
              elems.push(nxt);
              depth += unquotedParenDelta(nxt);
              next();
            }
            if (depth > 0) {
              throw new FauxnixParseError(
                'fauxnix: unclosed array assignment; close with `)` or use A=value for a scalar',
              );
            }
            const values = stripArrayParens(elems);
            assignments.push({
              name: split.name,
              value: values.length > 0 ? values[0] : [],
              values,
            });
            continue;
          }
          assignments.push(split);
          continue;
        }
      }

      if (name === null) {
        name = word;
        next();
      } else {
        if (isUnquotedLiteral(name, '[[') && !args.some((a) => isUnquotedLiteral(a, ']]'))) {
          const pending = pendingPatternOp(args);
          const last = args.length ? args[args.length - 1] : null;
          // bash keeps `( x )` / `@(foo|bar baz)` as one =~ / extglob operand
          if (
            last &&
            !isUnquotedLiteral(word, ']]') &&
            !isUnquotedLiteral(word, '&&') &&
            !isUnquotedLiteral(word, '||') &&
            ((pending === '=~' && unmatchedOpenParen(last)) ||
              (pending === '==' && unmatchedExtglob(last)))
          ) {
            const glued: Word = [...last, { kind: 'Text', text: ' ' }, ...word];
            const pieces =
              pending === '=~'
                ? peelTrailingGroupCloses(glued, groupingDepth(args.slice(0, -1)))
                : splitCondParens(glued);
            args.pop();
            for (const sw of pieces) {
              if (sw.length > 0) args.push(sw);
            }
            next();
            continue;
          }
          if (hasBareAmp(word) && !(pending === '=~' && last && unmatchedOpenParen(last))) {
            throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `&'");
          }
          if (pending === '==' && hasBareNonExtglobParen(word)) {
            throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `('");
          }
          const pieces =
            pending === '=~'
              ? peelTrailingGroupCloses(word, groupingDepth(args))
              : splitCondParens(word);
          if (pending !== '=~') {
            for (const sw of pieces) {
              if (
                !isUnquotedLiteral(sw, '(') &&
                !isUnquotedLiteral(sw, ')') &&
                hasBareNonExtglobParen(sw) &&
                !looksLikeArithWord(sw)
              ) {
                throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `('");
              }
            }
          }
          for (const sw of pieces) {
            if (sw.length > 0) args.push(sw);
          }
        } else {
          args.push(word);
        }
        next();
      }
    }

    if (!name) {
      // assignment-only segment (`X=1; cmd`) — no command word
      if (assignments.length > 0) {
        return { kind: 'SimpleCommand', assignments, name: null, args: [], redirects };
      }
      if (peek().type === 'OP' && peek().op === '&') {
        throw new FauxnixParseError(BACKGROUND_MSG);
      }
      throw new FauxnixParseError('fauxnix: expected a command');
    }
    if (isUnquotedLiteral(name, '[[')) {
      const close = args.findIndex((w) => isUnquotedLiteral(w, ']]'));
      if (close < 0) throw new FauxnixParseError("fauxnix: [[: missing `]]'");
      if (close !== args.length - 1) {
        throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token after `]]'");
      }
      if (args.slice(0, close).some((w) => unmatchedExtglob(w))) {
        throw new FauxnixParseError('fauxnix: [[: syntax error in conditional expression');
      }
      for (let i = 0; i < close; i++) {
        if (!isUnquotedLiteral(args[i], '=~') || i + 1 >= close) continue;
        if (regexHasExtraClose(args[i + 1])) {
          throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `)'");
        }
        if (unmatchedOpenParen(args[i + 1])) {
          throw new FauxnixParseError(
            'fauxnix: [[: syntax error in conditional expression: unexpected end of file',
          );
        }
      }
    }
    return { kind: 'SimpleCommand', assignments, name, args, redirects };
  };

  const readRedirectTarget = (): string => {
    const t = next();
    if (t.type !== 'WORD') throw new FauxnixParseError('fauxnix: redirect target expected');
    return wordToStringSafe(t.parts!);
  };

  // ---- helpers on words (joined raw view) ----
  function wordToStringSafe(w: Word): string {
    return w
      .map((p) => {
        switch (p.kind) {
          case 'Text':
          case 'SingleQuoted':
            return p.text;
          case 'DoubleQuoted':
            return p.parts
              .map((q) => (q.kind === 'Text' || q.kind === 'SingleQuoted' ? q.text : ''))
              .join('');
          default:
            return '';
        }
      })
      .join('');
  }

  function isAssignment(w: Word): boolean {
    return splitAssignment(w) !== null;
  }

  /**
   * Split `NAME=value` at the first unquoted '=' — char-level, so single-part
   * words like [Text 'FOO=bar'] split correctly. Returns null when the word
   * is not a valid assignment.
   */
  function splitAssignment(w: Word): Assignment | null {
    // merge adjacent Text parts first — the tokenizer emits per-char parts
    const merged: WordPart[] = [];
    for (const p of w) {
      const last = merged[merged.length - 1];
      if (p.kind === 'Text' && last && last.kind === 'Text') {
        (last as { text: string }).text += p.text;
      } else if (p.kind === 'SingleQuoted' && last && last.kind === 'SingleQuoted') {
        (last as { text: string }).text += p.text;
      } else {
        merged.push({ ...p });
      }
    }
    for (let idx = 0; idx < merged.length; idx++) {
      const p = merged[idx];
      if (p.kind !== 'Text') continue;
      const eq = p.text.indexOf('=');
      if (eq <= 0) continue;
      const name =
        merged
          .slice(0, idx)
          .map((q) => (q.kind === 'Text' || q.kind === 'SingleQuoted' ? q.text : ''))
          .join('') + p.text.slice(0, eq);
      if (!isNameStart(name[0]) || !name.split('').every(isNameChar)) continue;
      const value: Word = [];
      const tail = p.text.slice(eq + 1);
      if (tail) value.push({ kind: 'Text', text: tail });
      value.push(...merged.slice(idx + 1));
      return { name, value };
    }
    return null;
  }

  return parseList();
}

function isFunctionDef(cmd: SimpleCommand): boolean {
  if (!cmd.name) return false;
  const n = wordToString(cmd.name);
  if (!isUnquotedLiteral(cmd.name, n)) return false;
  if (/^[A-Za-z_][A-Za-z0-9_]*\(\)$/.test(n)) return true;
  return cmd.args.length > 0 && isUnquotedLiteral(cmd.args[0], '()');
}

function isRedirectOp(op: string | undefined): boolean {
  if (!op) return false;
  return ['>', '>>', '2>', '2>>', '&>', '&>>', '2>&1', '1>&2', '<'].includes(op);
}

function normalizeRedirect(op: string): RedirectOp {
  const known = ['>', '>>', '2>', '2>>', '&>', '&>>', '2>&1', '1>&2', '<'];
  if (known.includes(op)) return op as RedirectOp;
  throw new FauxnixParseError('fauxnix: unsupported redirect: ' + op);
}
