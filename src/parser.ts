import {
  Assignment,
  CommandList,
  FauxnixParseError,
  ListSegment,
  Pipeline,
  Redirect,
  RedirectOp,
  SimpleCommand,
  Word,
  WordPart,
  isUnquotedLiteral,
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
  '&&', '||', '>>', '<<', '2>&1', '1>&2', '2>', '&>>', '&>', '>', '<', '|', ';',
] as const;

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
      throw new FauxnixParseError(
        'fauxnix: backticks are not supported. Use $(...) command substitution instead.',
      );
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

/** Parse $VAR, ${VAR}, $(cmd substitution). Returns null when not a valid dollar construct. */
function readDollar(input: string, i: number): { part: WordPart; next: number } | null {
  const n = input.length;
  if (input[i] !== '$') return null;
  let j = i + 1;
  if (j >= n) return null;

  // ${...}
  if (input[j] === '{') {
    const end = input.indexOf('}', j);
    if (end === -1) throw new FauxnixParseError('fauxnix: unclosed ${');
    const name = input.slice(j + 1, end);
    if (!isNameStart(name[0]) || !name.split('').every(isNameChar)) {
      // ${VAR:-default} etc. — unsupported, kept as raw text
      return { part: { kind: 'Text', text: input.slice(i, end + 1) }, next: end + 1 };
    }
    return { part: { kind: 'Var', name }, next: end + 1 };
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

  // special: $? $$ $0-$9 — kept as symbolic Var; the translator maps them
  if ('?$_'.includes(input[j]) || /[0-9]/.test(input[j])) {
    return { part: { kind: 'Var', name: input[j] }, next: j + 1 };
  }
  return null;
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

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export function parseCommand(input: string): CommandList {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parseList = (): CommandList => {
    const segments: ListSegment[] = [];
    let op: ';' | '&&' | '||' = ';';
    const isListSep = (o?: string) => o === ';' || o === '\n';
    while (peek().type === 'OP' && isListSep(peek().op)) next();
    while (peek().type !== 'EOF') {
      const pipeline = parsePipeline();
      segments.push({ pipeline, op });
      const t = peek();
      if (t.type === 'OP' && (t.op === '&&' || t.op === '||' || isListSep(t.op))) {
        op = t.op === '\n' ? ';' : (t.op as '&&' | '||' | ';');
        next();
        while (peek().type === 'OP' && isListSep(peek().op)) next();
      } else if (t.type === 'EOF') {
        break;
      } else {
        throw new FauxnixParseError('fauxnix: unexpected token after pipeline');
      }
    }
    if (segments.length === 0) throw new FauxnixParseError('fauxnix: empty command');
    return { kind: 'CommandList', segments };
  };

  const parsePipeline = (): Pipeline => {
    const commands: SimpleCommand[] = [];
    for (;;) {
      commands.push(parseSimple());
      const t = peek();
      if (t.type === 'OP' && t.op === '|') {
        next();
        continue;
      }
      break;
    }
    return { kind: 'Pipeline', commands };
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
        // Glue a *tight* `|` onto the surrounding words so `=~ ^a|z$`
        // and `== @(foo|bar)` stay one operand. A spaced `|`, or `|`
        // outside a regex / extglob, is a syntax error (bash).
        const lastIsEqTilde =
          args.length >= 1 && isUnquotedLiteral(args[args.length - 1], '=~');
        const prevIsEqTilde =
          args.length >= 2 && isUnquotedLiteral(args[args.length - 2], '=~');
        const inRe = lastIsEqTilde || prevIsEqTilde;
        const inExt =
          !!t.tightLeft &&
          args.length >= 1 &&
          unmatchedExtglob(args[args.length - 1]) &&
          pendingPatternOp(args) === '==';
        if (t.op === '|' || ((inRe || inExt) && t.tightLeft && t.op === '||')) {
          if (
            t.op === '|' &&
            !lastIsEqTilde &&
            !(prevIsEqTilde && t.tightLeft) &&
            !inExt
          ) {
            throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `|'");
          }
          const piece: WordPart = { kind: 'Text', text: t.op! };
          if (lastIsEqTilde) args.push([piece]);
          else args[args.length - 1] = [...args[args.length - 1], piece];
          const n = peek();
          if (n.type === 'WORD' && n.tightLeft && n.parts) {
            next();
            args[args.length - 1] = [...args[args.length - 1], ...n.parts];
          }
        } else {
          args.push([{ kind: 'Text', text: t.op! }]);
          // `[[ a &&\n b ]]` — newline after &&/|| is whitespace, not `;`
          if (t.op === '&&' || t.op === '||') {
            while (peek().type === 'OP' && peek().op === '\n') next();
          }
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
      if (name === null && isAssignment(word)) {
        next();
        const split = splitAssignment(word);
        if (split) {
          assignments.push(split);
          continue;
        }
      }

      if (name === null) {
        name = word;
        next();
      } else {
        if (isUnquotedLiteral(name, '[[') && !args.some((a) => isUnquotedLiteral(a, ']]'))) {
          if (pendingPatternOp(args) === '==' && hasBareNonExtglobParen(word)) {
            throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token `('");
          }
          const pieces =
            pendingPatternOp(args) === '=~'
              ? peelTrailingGroupCloses(word, groupingDepth(args))
              : splitCondParens(word);
          for (const sw of pieces) {
            if (sw.length > 0) args.push(sw);
          }
        } else {
          args.push(word);
        }
        next();
      }
    }

    if (!name) throw new FauxnixParseError('fauxnix: expected a command');
    if (isUnquotedLiteral(name, '[[')) {
      const close = args.findIndex((w) => isUnquotedLiteral(w, ']]'));
      if (close < 0) throw new FauxnixParseError("fauxnix: [[: missing `]]'");
      if (close !== args.length - 1) {
        throw new FauxnixParseError("fauxnix: [[: syntax error near unexpected token after `]]'");
      }
      if (args.slice(0, close).some((w) => unmatchedExtglob(w))) {
        throw new FauxnixParseError('fauxnix: [[: syntax error in conditional expression');
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

function isRedirectOp(op: string | undefined): boolean {
  if (!op) return false;
  return ['>', '>>', '2>', '2>>', '&>', '&>>', '2>&1', '1>&2', '<'].includes(op);
}

function normalizeRedirect(op: string): RedirectOp {
  const known = ['>', '>>', '2>', '2>>', '&>', '&>>', '2>&1', '1>&2', '<'];
  if (known.includes(op)) return op as RedirectOp;
  throw new FauxnixParseError('fauxnix: unsupported redirect: ' + op);
}
