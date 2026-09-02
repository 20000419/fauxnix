import {
  Assignment,
  CommandList,
  FauxnixParseError,
  Redirect,
  ShellCommand,
  SimpleCommand,
  IfCommand,
  ForCommand,
  WhileCommand,
  CaseCommand,
  Word,
  WordPart,
  isUnquotedLiteral,
  wordToString,
} from './ast.js';
import { parseCommand } from './parser.js';
import { PipelineCtx, lookup, psStr } from './registry.js';
import { PYTHON3_WINDOWS_HINT, SH_SCRIPT_WINDOWS_HINT } from './errors.js';

export interface TranslationContext {
  /** `pure` renders a script without consulting command operands on disk. */
  mode: 'execute' | 'pure';
}

export const EXECUTE_TRANSLATION: TranslationContext = Object.freeze({ mode: 'execute' });
export const PURE_TRANSLATION: TranslationContext = Object.freeze({ mode: 'pure' });

export const PURE_SED_FILE_MESSAGE =
  'fauxnix: translate does not read sed script files; use -e with the script text, or run the command to use -f';

/** Match the sed option rules without opening the referenced script file. */
function sedUsesScriptFile(args: Word[]): boolean {
  const raw = args.map((word) => wordToString(word));
  let onlyOperands = false;
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (!onlyOperands && arg === '--') {
      onlyOperands = true;
      continue;
    }
    if (onlyOperands || !arg.startsWith('-') || arg.length === 1 || arg.startsWith('--')) {
      continue;
    }
    const body = arg.slice(1);
    for (let c = 0; c < body.length; c++) {
      const flag = body[c];
      if (flag === 'f') return c < body.length - 1 || i + 1 < raw.length;
      if (flag === 'e') {
        if (c === body.length - 1) i++;
        break;
      }
      if (flag === 'i') break;
      if (!['n', 'E', 'r', 's', 'u', 'z'].includes(flag)) return false;
    }
  }
  return false;
}

function assertPureWord(word: Word): void {
  const visitPart = (part: WordPart): void => {
    if (part.kind === 'CmdSub') {
      assertPureCommandList(parseCommand(part.cmd));
    } else if (part.kind === 'DoubleQuoted' || part.kind === 'Arith') {
      for (const nested of part.parts) visitPart(nested);
    }
  };
  for (const part of word) visitPart(part);
}

function wrappedSimpleCommand(command: SimpleCommand, name: string): SimpleCommand | null {
  const raw = command.args.map((word) => wordToString(word));
  let commandIndex = -1;
  if (name === 'env') {
    for (let i = 0; i < raw.length; ) {
      const arg = raw[i];
      if (arg === '--') {
        commandIndex = i + 1;
        break;
      }
      if (arg === '-i' || arg === '--ignore-environment') return null;
      if (arg === '-u' || arg === '--unset') {
        i += 2;
        continue;
      }
      if (arg.startsWith('-u=') || arg.startsWith('--unset=')) {
        i++;
        continue;
      }
      if (arg.startsWith('-')) {
        i++;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
        i++;
        continue;
      }
      commandIndex = i;
      break;
    }
  } else if (name === 'command') {
    let identify = false;
    let i = 0;
    while (i < raw.length) {
      const arg = raw[i];
      if (arg === '-v' || arg === '-V') {
        identify = true;
        i++;
        continue;
      }
      if (arg === '--') {
        i++;
        break;
      }
      if (arg.startsWith('-')) {
        i++;
        continue;
      }
      break;
    }
    if (identify) return null;
    commandIndex = i;
  } else if (name === 'timeout') {
    let i = 0;
    while (i < raw.length && raw[i].startsWith('-') && raw[i] !== '-' && raw[i] !== '--') i++;
    if (i < raw.length && raw[i] === '--') i++;
    commandIndex = i + 1;
  }
  if (commandIndex < 0 || commandIndex >= command.args.length) return null;
  return {
    kind: 'SimpleCommand',
    assignments: [],
    name: command.args[commandIndex],
    args: command.args.slice(commandIndex + 1),
    redirects: [],
  };
}

function assertPureShellCommand(command: ShellCommand): void {
  if (command.kind === 'SimpleCommand') {
    const name = command.name === null ? null : literalOfWord(command.name);
    if (name === 'sed' && sedUsesScriptFile(command.args)) {
      throw new FauxnixParseError(PURE_SED_FILE_MESSAGE);
    }
    if (command.name) assertPureWord(command.name);
    for (const arg of command.args) assertPureWord(arg);
    for (const assignment of command.assignments) {
      assertPureWord(assignment.value);
      for (const value of assignment.values ?? []) assertPureWord(value);
    }
    if (name === 'env' || name === 'command' || name === 'timeout') {
      const nested = wrappedSimpleCommand(command, name);
      if (nested) assertPureShellCommand(nested);
    }
    return;
  }
  if (command.kind === 'If') {
    assertPureCommandList(command.test);
    assertPureCommandList(command.then);
    if (command.else) assertPureCommandList(command.else);
    return;
  }
  if (command.kind === 'For') {
    for (const word of command.words) assertPureWord(word);
    assertPureCommandList(command.body);
    return;
  }
  if (command.kind === 'While') {
    assertPureCommandList(command.test);
    assertPureCommandList(command.body);
    return;
  }
  assertPureWord(command.word);
  for (const arm of command.arms) {
    for (const pattern of arm.patterns) assertPureWord(pattern);
    assertPureCommandList(arm.body);
  }
}

function assertPureCommandList(list: CommandList): void {
  for (const segment of list.segments) {
    for (const command of segment.pipeline.commands) assertPureShellCommand(command);
  }
}

/* ------------------------------------------------------------------ */
/* Variable mapping                                                    */
/* ------------------------------------------------------------------ */

function paramWordExpr(word: string): string {
  if (word.startsWith('$') && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(word)) {
    return varExpr(word.slice(1));
  }
  return psStr(word);
}

/** `${name:-word}` and friends using case-exact fx-scalar0. */
export function paramExpr(
  name: string,
  op: ':-' | ':=' | ':+' | ':?' | '-' | '+' | '?',
  word: string,
): string {
  const alt = paramWordExpr(word);
  const get = '(fx-scalar0 ' + psStr(name) + ')';
  const empty = '($null -eq $fx_pv -or [string]$fx_pv -eq \'\')';
  const unset = '($null -eq $fx_pv)';
  if (op === ':-') {
    return '$( $fx_pv = ' + get + '; if (' + empty + ') { ' + alt + ' } else { $fx_pv } )';
  }
  if (op === '-') {
    return '$( $fx_pv = ' + get + '; if (' + unset + ') { ' + alt + ' } else { $fx_pv } )';
  }
  if (op === ':+') {
    return '$( $fx_pv = ' + get + '; if (' + empty + ') { \'\' } else { ' + alt + ' } )';
  }
  if (op === '+') {
    return '$( $fx_pv = ' + get + '; if (' + unset + ') { \'\' } else { ' + alt + ' } )';
  }
  const msg = word === '' ? name + ': parameter null or not set' : name + ': ' + word;
  const cond = op === ':?' ? empty : unset;
  return (
    '$( $fx_pv = ' +
    get +
    '; if (' +
    cond +
    ') { [Console]::Error.WriteLine(' +
    psStr('bash: ' + msg) +
    '); $script:fx_exit = 1; \'\' } else { $fx_pv } )'
  );
}

function sliceArgExpr(s: string): string {
  if (s.length > 0 && s[0] === '$') {
    return '(fx-scalar0 ' + psStr(s.slice(1)) + ')';
  }
  return psStr(s);
}

export function varExtraOf(p: WordPart): {
  replace?: { global: boolean; pat: string; repl: string };
  slice?: { offset: string; length?: string };
} | undefined {
  if (p.kind !== 'Var') return undefined;
  if (!p.replace && !p.slice) return undefined;
  const extra: {
    replace?: { global: boolean; pat: string; repl: string };
    slice?: { offset: string; length?: string };
  } = {};
  if (p.replace) extra.replace = p.replace;
  if (p.slice) extra.slice = p.slice;
  return extra;
}

/** Map a bash $VAR name to a PowerShell expression (usable inside $(...)). */
export function varExpr(
  name: string,
  index?: string,
  param?: { op: ':-' | ':=' | ':+' | ':?' | '-' | '+' | '?'; word: string },
  length = false,
  extra?: {
    replace?: { global: boolean; pat: string; repl: string };
    slice?: { offset: string; length?: string };
  },
): string {
  if (extra && extra.replace) {
    const r = extra.replace;
    return (
      '(fx-subst (fx-scalar0 ' +
      psStr(name) +
      ') ' +
      psStr(r.pat) +
      ' ' +
      psStr(r.repl) +
      ' ' +
      (r.global ? '$true' : '$false') +
      ')'
    );
  }
  if (extra && extra.slice) {
    const off = sliceArgExpr(extra.slice.offset);
    const len = extra.slice.length !== undefined ? sliceArgExpr(extra.slice.length) : '$null';
    return '(fx-slice (fx-scalar0 ' + psStr(name) + ') ' + off + ' ' + len + ')';
  }
  if (param) return paramExpr(name, param.op, param.word);
  if (length) {
    if (index === '@' || index === '*') {
      return '@(fx-arrload ' + psStr(name) + ').Count';
    }
    if (index !== undefined) {
      return '([string](fx-subget ' + psStr(name) + ' ' + psStr(index) + ')).Length';
    }
    return (
      '([string]$(if ($null -eq ($fx_pv = fx-scalar0 ' +
      psStr(name) +
      ')) { \'\' } else { $fx_pv })).Length'
    );
  }
  // Indexed reads always go through fx-subget → fx-arrload → fx-scalar0 so
  // ${PWD[0]} keeps the special mapping and ${bash_rematch[0]} stays
  // case-exact (a `$env:name` fallback would alias BASH_REMATCH on Windows).
  if (index !== undefined) {
    return '(fx-subget ' + psStr(name) + ' ' + psStr(index) + ')';
  }
  if (/^[0-9]+$/.test(name)) {
    if (name === '0') {
      return "$(if ($env:FAUXNIX_ARG0) { [string]$env:FAUXNIX_ARG0 } else { 'fauxnix' })";
    }
    return '(fx-posget ' + name + ')';
  }
  switch (name) {
    case 'HOME':
      return '$HOME';
    case 'PWD':
      return '$PWD.Path';
    case 'USER':
    case 'LOGNAME':
      return '$env:USERNAME';
    case 'PATH':
      return '$env:PATH';
    case 'SHELL':
      return "'powershell'";
    case 'TERM':
      return "'xterm-256color'";
    case 'OLDPWD':
      return '$env:FAUXNIX_OLDPWD';
    case '?':
      return '[string]$fx_prev';
    case '$':
      return '[string]$PID';
    case 'HOSTNAME':
      return '$env:COMPUTERNAME';
    case '#':
      return '@(fx-posload).Count';
    case '@':
    case '*':
      return '((@(fx-posload) -join (fx-ifs1)))';
    default:
      return '$env:' + name;
  }
}

/** `$?` `$$` `$0`–`$n` `$#` `$@` `$*` — not ordinary `$env:` names. */
export function isSpecialShellVar(name: string): boolean {
  return (
    name === '?' ||
    name === '$' ||
    name === '#' ||
    name === '@' ||
    name === '*' ||
    /^[0-9]+$/.test(name)
  );
}

/* ------------------------------------------------------------------ */
/* Word → PowerShell expression                                        */
/* ------------------------------------------------------------------ */

/** Escape text destined for the inside of a PS double-quoted string. */
export function escapeDq(s: string): string {
  return s
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
    .replace(/\r/g, '`r')
    .replace(/\n/g, '`n');
}

/** Normalize a literal POSIX-ish path to its Windows equivalent. */
export function normalizeLiteralPath(s: string): string {
  if (s === '/dev/null') return 'NUL';
  if (s === '/tmp') return '$env:TEMP';
  if (s.startsWith('/tmp/')) {
    const rest = s.slice(5).split('/').join('\\');
    return '$env:TEMP' + '\\' + rest;
  }
  // Git-Bash drive mounts: /d/foo → d:\foo
  const m = s.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) {
    const drive = m[1].toUpperCase();
    const tail = m[2].split('/').join('\\');
    return drive + ':\\' + tail;
  }
  const onlyDrive = s.match(/^\/([a-zA-Z])\/?$/);
  if (onlyDrive) return onlyDrive[1].toUpperCase() + ':\\';
  return s;
}

/**
 * Convert a normalized literal path (see normalizeLiteralPath) into a valid
 * PowerShell string *expression*. Paths that normalize to `$env:TEMP...`
 * must NOT go through single-quoting — the variable has to stay expandable.
 */
export function pathExpr(s: string): string {
  const prefix = '$env:TEMP';
  if (s === prefix) return prefix;
  if (s.startsWith(prefix + '\\')) {
    return '(' + prefix + ' + ' + psStr(s.slice(prefix.length)) + ')';
  }
  return psStr(s);
}

/**
 * Convert a Word to a PowerShell string expression.
 * Literal words become single-quoted strings; dynamic ones become
 * double-quoted strings with $(...) interpolation.
 */
export function exprOfWord(w: Word, opts?: { preserveCmdSub?: boolean }): string {
  // tilde expansion (unquoted leading ~)
  const expanded: WordPart[] = [];
  if (w.length > 0 && w[0].kind === 'Text' && w[0].text.startsWith('~')) {
    expanded.push({ kind: 'Var', name: 'HOME' });
    const rest = w[0].text.slice(1);
    if (rest) expanded.push({ kind: 'Text', text: rest });
    expanded.push(...w.slice(1));
  } else {
    expanded.push(...w);
  }

  // single bare variable → bare expression
  if (expanded.length === 1 && expanded[0].kind === 'Var') {
    const v = expanded[0];
    return varExpr(v.name, v.index, v.param, v.length === true, varExtraOf(v));
  }
  // Bare `$(...)` must not sit inside a PS expandable string: the
  // substitution body contains `"` / `$_` that would break interpolation.
  if (expanded.length === 1 && expanded[0].kind === 'CmdSub') {
    return '$(' + translateCmdSub(expanded[0].cmd, opts?.preserveCmdSub === true) + ')';
  }
  if (expanded.length === 1 && expanded[0].kind === 'Arith') {
    return arithExpr(expanded[0].parts);
  }

  const literal = expanded.every((p) => p.kind === 'Text' || p.kind === 'SingleQuoted');
  if (literal) {
    const text = expanded.map((p) => (p as { text: string }).text).join('');
    return pathExpr(normalizeLiteralPath(text));
  }

  // dynamic — build a PS double-quoted string with interpolation
  let out = '"';
  const emitPart = (p: WordPart, quoted: boolean) => {
    switch (p.kind) {
      case 'Text':
        out += escapeDq(p.text);
        break;
      case 'SingleQuoted':
        out += escapeDq(p.text);
        break;
      case 'DoubleQuoted':
        for (const q of p.parts) emitPart(q, true);
        break;
      case 'Var':
        out += '$(' + varExpr(p.name, p.index, p.param, p.length === true, varExtraOf(p)) + ')';
        break;
      case 'CmdSub':
        out += '$(' + translateCmdSub(p.cmd, quoted || opts?.preserveCmdSub === true) + ')';
        break;
      case 'Arith':
        out += arithExpr(p.parts);
        break;
    }
  };
  for (const p of expanded) emitPart(p, false);
  out += '"';
  return out;
}

let arithHelperPreamble = '';

/** Registered by sysinfo so wrapScript can emit fx-arith without a circular import. */
export function setArithHelperPreamble(s: string): void {
  arithHelperPreamble = s;
}

function injectArithHelpers(body: string): string {
  if (!arithHelperPreamble) return body;
  if (!/\bfx-arith\b/.test(body)) return body;
  if (/function\s+fx-arith\b/.test(body)) return body;
  return arithHelperPreamble + '\n' + body;
}

/** PowerShell expression: evaluate `$((…))` via fx-arith; errors are loud, expansion empty. */
export function arithExpr(parts: WordPart[]): string {
  const src = arithSourceExpr(parts);
  return (
    '$(try { [string](fx-arith (' +
    src +
    ')) } catch { [Console]::Error.WriteLine((\'bash: \' + [string](' +
    src +
    ') + \': integer expression expected\')); $script:fx_exit = 1; \'\' })'
  );
}

function arithSourceExpr(parts: WordPart[]): string {
  if (parts.length === 0) return "''";
  if (parts.every((p) => p.kind === 'Text')) {
    return psStr(parts.map((p) => p.text).join(''));
  }
  let out = '"';
  const emit = (p: WordPart) => {
    switch (p.kind) {
      case 'Text':
      case 'SingleQuoted':
        out += escapeDq(p.text);
        break;
      case 'DoubleQuoted':
        for (const q of p.parts) emit(q);
        break;
      case 'Var':
        out += '$(' + varExpr(p.name, p.index, p.param, p.length === true, varExtraOf(p)) + ')';
        break;
      case 'CmdSub':
        out += '$(' + translateCmdSub(p.cmd, true) + ')';
        break;
      case 'Arith':
        out += arithExpr(p.parts);
        break;
    }
  };
  for (const p of parts) emit(p);
  out += '"';
  return out;
}

/** Literal text of a word when it contains no interpolation, else null. */
export function literalOfWord(w: Word): string | null {
  if (!w.every((p) => p.kind === 'Text' || p.kind === 'SingleQuoted')) return null;
  const text = w.map((p) => (p as { text: string }).text).join('');
  if (w.length > 0 && w[0].kind === 'Text' && w[0].text.startsWith('~')) return null; // needs $HOME
  return text;
}

/**
 * Argument expression for an operand (file path-ish).
 * Literal paths get POSIX-ish normalization (/dev/null, /tmp, /d/...).
 */
export function operandExpr(w: Word): string {
  const lit = literalOfWord(w);
  if (lit !== null) return pathExpr(normalizeLiteralPath(lit));
  return exprOfWord(w);
}

/** Flatten quotes but remember whether a part sat inside `"..."`. */
function wordPartsForSplat(w: Word): { part: WordPart; quoted: boolean }[] {
  const out: { part: WordPart; quoted: boolean }[] = [];
  const walk = (parts: WordPart[], quoted: boolean) => {
    for (const p of parts) {
      if (p.kind === 'DoubleQuoted') walk(p.parts, true);
      else out.push({ part: p, quoted });
    }
  };
  walk(w, false);
  return out;
}

/**
 * `${name[@]}` / `"pre${name[@]}post"` — one argv per element.
 * Unquoted `${name[*]}` also splats (bash); quoted `"${name[*]}"` stays one join.
 * `$@` / unquoted `$*` splat like `${arr[@]}`; quoted `"$@"` still splats.
 */
export function splatSpec(w: Word): { name: string; prefix: string; suffix: string } | null {
  const parts = wordPartsForSplat(w);
  let name: string | null = null;
  let prefix = '';
  let suffix = '';
  let seen = false;
  for (const { part: p, quoted } of parts) {
    const splat =
      p.kind === 'Var' &&
      !p.length &&
      (p.name === '@' ||
        (p.name === '*' && !quoted) ||
        p.index === '@' ||
        (p.index === '*' && !quoted));
    if (splat) {
      if (seen) return null;
      seen = true;
      name = p.name;
      continue;
    }
    if (p.kind !== 'Text' && p.kind !== 'SingleQuoted') return null;
    if (seen) suffix += p.text;
    else prefix += p.text;
  }
  return name ? { name, prefix, suffix } : null;
}

/** Load the splat source: positionals (`@`/`*`) vs named arrays. */
function splatLoadCall(name: string): string {
  if (name === '@' || name === '*') return 'fx-posload';
  return 'fx-arrload ' + psStr(name);
}

/** PS expression of a string[]: `@` words splat, others stay one element. */
export function argListExpr(words: Word[], fn: (w: Word) => string = exprOfWord): string {
  if (words.length === 0) return '@()';
  return (
    '(' +
    words
      .map((w) => {
        const s = splatSpec(w);
        if (!s) return '@(' + fn(w) + ')';
        if (!s.prefix && !s.suffix) return '@(' + splatLoadCall(s.name) + ')';
        return (
          '@($( $fx_sp = @(' +
          splatLoadCall(s.name) +
          '); if ($fx_sp.Count -eq 0) { $fx_sp = @(' +
          psStr(s.prefix + s.suffix) +
          ') } else { $fx_sp[0] = ' +
          psStr(s.prefix) +
          ' + $fx_sp[0]; $fx_sp[$fx_sp.Count-1] = $fx_sp[$fx_sp.Count-1] + ' +
          psStr(s.suffix) +
          ' }; $fx_sp ))'
        );
      })
      .join(' + ') +
    ')'
  );
}

/* ------------------------------------------------------------------ */
/* Command substitution                                                */
/* ------------------------------------------------------------------ */

/**
 * Translate the inside of $(...).
 * `keepNl`: quoted words and assignments keep interior newlines (bash).
 * Unquoted command words join non-empty lines with a space (IFS
 * word-split approximation). Handlers often emit one string object, so
 * a bare `$(…)` interpolation would keep those newlines.
 * Lists (`;` `&&` `||`) reuse translateListInline inside the fx-csub
 * scriptblock so the newline contract is unchanged.
 */
export function translateCmdSub(
  cmdText: string,
  keepNl = false,
  translation: TranslationContext = EXECUTE_TRANSLATION,
): string {
  const inner = translateListInline(parseCommand(cmdText), translation);
  const collected = '(fx-csub { ' + inner + ' })';
  if (keepNl) return collected;
  return (
    '((' +
    collected +
    " -split [string][char]10 | Where-Object { $_ -ne '' }) -join ' ')"
  );
}

/* ------------------------------------------------------------------ */
/* Simple command translation                                          */
/* ------------------------------------------------------------------ */

function indentBlock(s: string): string {
  return s
    .split('\n')
    .map((l) => (l ? '  ' + l : l))
    .join('\n');
}

export function translateSimple(
  cmd: SimpleCommand,
  position: PipelineCtx['position'],
  hasStdin: boolean,
  translation: TranslationContext = EXECUTE_TRANSLATION,
): string {
  const nativeTerm =
    "(-not $script:fx_csub -and (($MyInvocation.MyCommand.Name -eq '') -or " +
    (position === 'last' ? '$true' : '$false') +
    '))';
  // assignment-only segment (`X=1; cmd`): bash semantics are "set for the
  // rest of the shell". Reuse the export code path — persist + env shadow —
  // so empty values (`X=`) and `[[ -v X ]]` behave like bash (documented
  // deviation: shell var vs exported var are indistinguishable here).
  if (cmd.name === null) {
    const exportHandler = lookup('export');
    const chunks: string[] = [];
    for (const a of cmd.assignments) {
      if (a.values) {
        chunks.push(
          'fx-arrput ' +
            psStr(a.name) +
            ' ' +
            argListExpr(a.values, (w) => exprOfWord(w, { preserveCmdSub: true })),
        );
      } else {
        const words = [[{ kind: 'Text' as const, text: a.name + '=' }, ...a.value]];
        if (exportHandler) {
          chunks.push(exportHandler(words, { position, hasStdin, translationMode: translation.mode }));
        }
      }
    }
    return chunks.join('\n');
  }

  const nameLit = literalOfWord(cmd.name);
  const nameSplat = splatSpec(cmd.name);

  let body: string;
  if (nameSplat) {
    const hasAffix = !!(nameSplat.prefix || nameSplat.suffix);
    const promoted =
      cmd.args.length === 0
        ? ''
        : translateSimple(
            {
              kind: 'SimpleCommand',
              assignments: [],
              name: cmd.args[0],
              args: cmd.args.slice(1),
              redirects: cmd.redirects,
            },
            position,
            hasStdin,
            translation,
          );
    const emptyCmdLines: string[] = [
      '$fx_cw = @(' + splatLoadCall(nameSplat.name) + ')',
    ];
    if (hasAffix) {
      emptyCmdLines.push(
        'if ($fx_cw.Count -eq 0) { $fx_cw = @(' +
          psStr(nameSplat.prefix + nameSplat.suffix) +
          ') } else { $fx_cw[0] = ' +
          psStr(nameSplat.prefix) +
          ' + $fx_cw[0]; $fx_cw[$fx_cw.Count-1] = $fx_cw[$fx_cw.Count-1] + ' +
          psStr(nameSplat.suffix) +
          ' }',
      );
    }
    emptyCmdLines.push(
      'if ($fx_cw.Count -eq 0) {',
      // No words left → bash null command (exit 0). Remaining words are
      // known at compile time, so reuse translateSimple (handlers, not `&`).
      promoted ? indentBlock(promoted) : '  ',
      '} else {',
      '  $fx_na = [object[]](' + argListExpr(cmd.args) + ')',
      '  $fx_cmd = [string]$fx_cw[0]',
      '  if ($fx_cw.Count -gt 1) { $fx_na = [object[]](@($fx_cw[1..($fx_cw.Count - 1)]) + $fx_na) }',
      '  ' +
        (hasStdin
          ? '($input | fx-native $fx_cmd $fx_na ' + nativeTerm + ')'
          : 'fx-native $fx_cmd $fx_na ' + nativeTerm),
      '}',
    );
    body = emptyCmdLines.join('\n');
  } else if (nameLit !== null) {
    const handler = lookup(nameLit);
    if (handler && !(nameLit === '[[' && !isUnquotedLiteral(cmd.name, '[['))) {
      body = handler(cmd.args, { position, hasStdin, translationMode: translation.mode });
    } else {
      // passthrough: native command (git, node, npm, python, cargo, ...)
      // via fx-native (Win32 command line + Process). `& name @array` on
      // PS 5.1 drops empty argv entries and eats embedded quotes.
      const nameExpr = psStr(nameLit);
      const invoke = 'fx-native ' + nameExpr + ' $fx_na ' + nativeTerm;
      body = [
        '$fx_na = [object[]](' + argListExpr(cmd.args) + ')',
        (hasStdin ? '($input | ' + invoke + ')' : invoke),
      ].join('\n');
    }
  } else {
    // dynamic command name — evaluate it
    const nameExpr = exprOfWord(cmd.name);
    const invoke = 'fx-native (' + nameExpr + ') $fx_na ' + nativeTerm;
    body = [
      '$fx_na = [object[]](' + argListExpr(cmd.args) + ')',
      (hasStdin ? '($input | ' + invoke + ')' : invoke),
    ].join('\n');
  }

  // `VAR=value cmd` is command-scoped. Values are captured in the
  // current environment, then applied, then restored — including when
  // the command throws — so they never leak into later list segments
  // or the persisted MCP session. `VAR=x export VAR` keeps VAR (bash).
  if (cmd.assignments.length > 0) {
    const persistNames = new Set<string>();
    const persistWords: Word[] = [];
    if (nameLit === 'export') {
      for (const w of cmd.args) {
        const lit = literalExportName(w);
        if (lit === '') continue; // flag
        if (lit) persistNames.add(lit);
        else persistWords.push(w);
      }
    }
    body = wrapTempEnv(cmd.assignments, body, { persistNames, persistWords });
  }
  return body;
}

/** Literal `NAME` / `NAME=...` from an export argument. `''` = flag. */
function literalExportName(w: Word): string | null | '' {
  if (w.length === 0) return null;
  let s = '';
  for (const p of w) {
    if (p.kind !== 'Text' && p.kind !== 'SingleQuoted') return null;
    const eq = p.text.indexOf('=');
    if (eq >= 0) {
      const name = s + p.text.slice(0, eq);
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
    }
    s += p.text;
  }
  if (s.startsWith('-')) return '';
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : null;
}

let tempEnvSeq = 0;

/** PS expr: encode a string so SETVALS records can stay newline-delimited. */
export function encodeSetValExpr(srcExpr: string): string {
  return (
    '([string](' +
    srcExpr +
    ')).Replace([string][char]92, ([string][char]92 + [string][char]92)).Replace([string][char]13, ([string][char]92 + [char]114)).Replace([string][char]10, ([string][char]92 + [char]110))'
  );
}

/**
 * Apply env assignments (and optional unsets) only for `body`, then restore.
 * All assignment *values* are evaluated before any name is mutated.
 * `persistWords` are evaluated after the prefix is applied (so
 * `export "$NAME"` sees the current env) and those names are not restored.
 */
export function wrapTempEnv(
  sets: Assignment[],
  body: string,
  extra?: { unsets?: string[]; persistNames?: Set<string>; persistWords?: Word[] },
): string {
  const unsets = extra?.unsets ?? [];
  const persistNames = extra?.persistNames ?? new Set<string>();
  const persistWords = extra?.persistWords;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const s of sets) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      names.push(s.name);
    }
  }
  for (const u of unsets) {
    if (!seen.has(u)) {
      seen.add(u);
      names.push(u);
    }
  }
  if (names.length === 0) return body;
  const assigned = new Set(sets.map((s) => s.name));

  const id = tempEnvSeq++;
  const save = '$fx_es' + id;
  const arrSave = '$fx_ar' + id;
  const keep = persistWords && persistWords.length > 0 ? '$fx_ek' + id : '';
  const lines: string[] = [
    save + ' = @{}',
    arrSave + ' = @{}',
    '$fx_sv0' + id + ' = $env:FAUXNIX_SETVARS',
    '$fx_uv0' + id + ' = $env:FAUXNIX_UNSETVARS',
    '$fx_xv0' + id + ' = $env:FAUXNIX_SETVALS',
  ];
  for (const n of names) {
    const p = psStr('Env:\\' + n);
    lines.push(
      save +
        '[' +
        psStr(n) +
        '] = $(if (Test-Path -LiteralPath ' +
        p +
        ') { [string](Get-Item -LiteralPath ' +
        p +
        ').Value } else { $null })',
    );
    lines.push(arrSave + '[' + psStr(n) + '] = (fx-arrpackget ' + psStr(n) + ')');
  }
  const valVars: string[] = [];
  const valIsArr: boolean[] = [];
  for (let i = 0; i < sets.length; i++) {
    const vn = '$fx_ev' + id + '_' + i;
    valVars.push(vn);
    if (sets[i].values) {
      valIsArr.push(true);
      lines.push(
        vn +
          ' = ' +
          argListExpr(sets[i].values!, (w) => exprOfWord(w, { preserveCmdSub: true })),
      );
    } else {
      valIsArr.push(false);
      lines.push(vn + ' = ' + exprOfWord(sets[i].value, { preserveCmdSub: true }));
    }
  }
  lines.push('try {');
  for (const u of unsets) {
    const uq = u.replace(/'/g, "''");
    lines.push(
      '  Remove-Item -LiteralPath ' + psStr('Env:\\' + u) + ' -ErrorAction SilentlyContinue',
    );
    lines.push('  fx-arrdrop ' + psStr(u));
    // `env -u NAME` must hide NAME from fx-envget / fx-isset for the
    // wrapped body. Removing Env:\NAME is not enough: an earlier
    // `export NAME=x` still lives in SETVARS/SETVALS, and special
    // names (PATH, HOME, …) have hardcoded fallbacks.
    lines.push(
      "  $env:FAUXNIX_SETVARS = (@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        uq +
        "' }) -join ';')",
    );
    lines.push(
      "  $env:FAUXNIX_UNSETVARS = ((@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        uq +
        "' }) + '" +
        uq +
        "') -join ';')",
    );
    lines.push(
      '  $fx_sm = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne \'' +
        uq +
        '\') { $fx_sm += $fx_pair } }; $env:FAUXNIX_SETVALS = ($fx_sm -join [string][char]10)',
    );
  }
  for (let i = 0; i < sets.length; i++) {
    const n = sets[i].name;
    const nq = n.replace(/'/g, "''");
    if (valIsArr[i]) {
      lines.push('  fx-arrput ' + psStr(n) + ' ' + valVars[i]);
      continue;
    }
    lines.push('  $env:' + n + ' = ' + valVars[i]);
    lines.push('  fx-arrdrop ' + psStr(n));
    lines.push(
      "  $env:FAUXNIX_SETVARS = ((@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        nq +
        "' }) + '" +
        nq +
        "') -join ';')",
    );
    lines.push(
      "  $env:FAUXNIX_UNSETVARS = (@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        nq +
        "' }) -join ';')",
    );
    lines.push(
      '  $fx_sm = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne \'' +
        nq +
        '\') { $fx_sm += $fx_pair } }; $fx_sm += (\'' +
        nq +
        "' + [string][char]61 + " +
        encodeSetValExpr(valVars[i]) +
        '); $env:FAUXNIX_SETVALS = ($fx_sm -join [string][char]10)',
    );
  }
  if (keep) {
    lines.push('  ' + keep + ' = @{}');
    for (const w of persistWords!) {
      const ev = '$fx_en' + id + '_' + lines.length;
      lines.push('  ' + ev + ' = [string](' + exprOfWord(w) + ')');
      lines.push(
        '  if (' +
          ev +
          " -notmatch '^-') { $fx_nm = if (" +
          ev +
          ".Contains([string][char]61)) { " +
          ev +
          '.Substring(0, ' +
          ev +
          ".IndexOf([string][char]61)) } else { " +
          ev +
          " }; if ($fx_nm -match '^[A-Za-z_][A-Za-z0-9_]*$') { " +
          keep +
          '[$fx_nm] = $true } }',
      );
    }
  }
  for (const l of body.split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('} finally {');
  lines.push('  $env:FAUXNIX_SETVARS = $fx_sv0' + id);
  lines.push('  $env:FAUXNIX_UNSETVARS = $fx_uv0' + id);
  lines.push('  $env:FAUXNIX_SETVALS = $fx_xv0' + id);
  for (const n of names) {
    if (persistNames.has(n)) continue;
    const p = psStr('Env:\\' + n);
    if (keep) {
      lines.push('  $fx_skip = if (' + keep + '[' + psStr(n) + ']) { $true } else { $false }');
      lines.push(
        '  if (-not $fx_skip) { if ($null -eq ' +
          save +
          '[' +
          psStr(n) +
          ']) { Remove-Item -LiteralPath ' +
          p +
          ' -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ' +
          p +
          ' -Value ' +
          save +
          '[' +
          psStr(n) +
          '] } }',
      );
    } else {
      lines.push(
        '  if ($null -eq ' +
          save +
          '[' +
          psStr(n) +
          ']) { Remove-Item -LiteralPath ' +
          p +
          ' -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ' +
          p +
          ' -Value ' +
          save +
          '[' +
          psStr(n) +
          '] }',
      );
    }
    const restoreArr = 'fx-arrpackset ' + psStr(n) + ' ' + arrSave + '[' + psStr(n) + ']';
    if (keep) {
      lines.push('  if (-not $fx_skip) { ' + restoreArr + ' }');
    } else {
      lines.push('  ' + restoreArr);
    }
  }
  for (const n of persistNames) {
    const nq = n.replace(/'/g, "''");
    const ep = psStr('Env:\\' + n);
    // Bare `export UNSET` only marks the name for export; it must stay
    // unset (`[[ -v UNSET ]]` is false). Persist a record only when the
    // prefix assigned the name (including empty) or it already exists.
    const cond = assigned.has(n) ? '$true' : '(Test-Path -LiteralPath ' + ep + ')';
    lines.push('  if (' + cond + ') {');
    lines.push(
      "    $env:FAUXNIX_SETVARS = ((@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        nq +
        "' }) + '" +
        nq +
        "') -join ';')",
    );
    lines.push(
      "    $env:FAUXNIX_UNSETVARS = (@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        nq +
        "' }) -join ';')",
    );
    lines.push(
      '    $fx_pv = $(if (Test-Path -LiteralPath ' +
        ep +
        ') { [string](Get-Item -LiteralPath ' +
        ep +
        ").Value } else { '' })",
    );
    lines.push(
      '    $fx_sm = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne \'' +
        nq +
        '\') { $fx_sm += $fx_pair } }; $fx_sm += (\'' +
        nq +
        "' + [string][char]61 + " +
        encodeSetValExpr('$fx_pv') +
        '); $env:FAUXNIX_SETVALS = ($fx_sm -join [string][char]10)',
    );
    lines.push('  }');
  }
  if (keep) {
    const had =
      '@(' +
      [...assigned].map((n) => "'" + n.replace(/'/g, "''") + "'").join(',') +
      ')';
    lines.push('  foreach ($fx_pn in @(' + keep + '.Keys)) {');
    lines.push(
      '    if (-not ((Test-Path -LiteralPath (\'Env:\\\' + $fx_pn)) -or (' +
        had +
        ' -ccontains $fx_pn))) { continue }',
    );
    lines.push(
      "    $env:FAUXNIX_SETVARS = ((@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne $fx_pn }) + $fx_pn) -join ';')",
    );
    lines.push(
      "    $env:FAUXNIX_UNSETVARS = (@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne $fx_pn }) -join ';')",
    );
    lines.push(
      "    $fx_pv = $(if (Test-Path -LiteralPath ('Env:\\' + $fx_pn)) { [string](Get-Item -LiteralPath ('Env:\\' + $fx_pn)).Value } else { '' })",
    );
    lines.push(
      '    $fx_sm = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne $fx_pn) { $fx_sm += $fx_pair } }; $fx_sm += ($fx_pn + [string][char]61 + ' +
        encodeSetValExpr('$fx_pv') +
        '); $env:FAUXNIX_SETVALS = ($fx_sm -join [string][char]10)',
    );
    lines.push('  }');
  }
  lines.push('}');
  return lines.join('\n');
}

/** Unique suffix for generated stage functions (nested pipelines included). */
let stageSeq = 0;

/** Unique suffix for generated pipeline wrappers and their local status arrays. */
let pipelineSeq = 0;

export interface PipelineParts {
  /** Generated function definitions (empty for single commands). */
  defs: string;
  /** The pipeline invocation itself. */
  call: string;
}

/**
 * Pipeline body. A lone command runs as a plain script-block expression;
 * multi-command pipelines become generated functions chained with `|`
 * (PS 5.1 forbids parenthesized expressions as non-first pipeline elements).
 */
function translateListInline(
  list: CommandList,
  translation: TranslationContext = EXECUTE_TRANSLATION,
): string {
  const chunks: string[] = [];
  for (const seg of list.segments) {
    const { defs, call } = translatePipelineBody(seg.pipeline, translation);
    const body = (defs ? defs + '\n' : '') + call;
    if (seg.op === '&&') {
      chunks.push('if ($script:fx_exit -eq 0) {\n' + body + '\n}');
    } else if (seg.op === '||') {
      chunks.push('if ($script:fx_exit -ne 0) {\n' + body + '\n}');
    } else {
      chunks.push(body);
    }
  }
  return chunks.join('\n');
}

function translateIf(cmd: IfCommand, translation: TranslationContext): string {
  // Branch bodies reset fx_exit first: the compound's exit status must come
  // from the taken branch's last command (bash semantics), not leak the test's
  // failure — `if false; then A; else B; fi` exits 0 in bash.
  const lines = [translateListInline(cmd.test, translation), 'if ($script:fx_exit -eq 0) {', '  $script:fx_exit = 0'];
  for (const l of translateListInline(cmd.then, translation).split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('} else {', '  $script:fx_exit = 0');
  if (cmd.else) {
    for (const l of translateListInline(cmd.else, translation).split('\n')) lines.push(l ? '  ' + l : l);
  }
  lines.push('}');
  return lines.join('\n');
}

function translateCase(cmd: CaseCommand, translation: TranslationContext): string {
  const lines = ['$script:fx_exit = 0', '$fx_cw = ' + exprOfWord(cmd.word)];
  for (let i = 0; i < cmd.arms.length; i++) {
    const arm = cmd.arms[i];
    const pats = arm.patterns.map((w) => exprOfWord(w)).join(',');
    const head = i === 0 ? 'if' : 'elseif';
    lines.push(head + ' (fx-casematch $fx_cw @(' + pats + ')) {');
    const body = translateListInline(arm.body, translation);
    if (body) {
      for (const l of body.split('\n')) lines.push(l ? '  ' + l : l);
    }
    lines.push('}');
  }
  return lines.join('\n');
}

function translateFor(cmd: ForCommand, translation: TranslationContext): string {
  const n = cmd.name.replace(/'/g, "''");
  const lines = [
    '$fx_for = ' + argListExpr(cmd.words),
    'foreach ($fx_it in @($fx_for)) {',
    "  Set-Item -LiteralPath ('Env:\\' + '" + n + "') -Value ([string]$fx_it)",
    "  $env:FAUXNIX_SETVARS = ((@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
      n +
      "' }) + '" +
      n +
      "') -join ';')",
    "  $env:FAUXNIX_UNSETVARS = (@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
      n +
      "' }) -join ';')",
    '  fx-arrdrop ' + psStr(cmd.name),
    "  $fx_sv = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne '" +
      n +
      "') { $fx_sv += $fx_pair } }",
    "  $fx_sv += ('" +
      n +
      "' + [string][char]61 + (fx-svenc ([string]$fx_it))); $env:FAUXNIX_SETVALS = ($fx_sv -join [string][char]10)",
  ];
  for (const l of translateListInline(cmd.body, translation).split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('}');
  return lines.join('\n');
}

function translateWhile(cmd: WhileCommand, translation: TranslationContext): string {
  // Bash: last executed body owns status; a test that ends the loop does not.
  // Never-entered loops (`while false; do …; done`, `until true; do …; done`)
  // exit 0. Save the body status and restore it on the failing test.
  const fail = cmd.until ? '$script:fx_exit -eq 0' : '$script:fx_exit -ne 0';
  const lines = ['$fx_wst = 0', 'do {'];
  for (const l of translateListInline(cmd.test, translation).split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('  if (' + fail + ') { $script:fx_exit = $fx_wst; break }');
  lines.push('  $script:fx_exit = 0');
  for (const l of translateListInline(cmd.body, translation).split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('  $fx_wst = $script:fx_exit');
  lines.push('} while ($true)');
  return lines.join('\n');
}

function stdinTarget(c: ShellCommand): string | null {
  let t: string | null = null;
  for (const r of c.redirects) {
    if (r.op === '<') t = r.target;
  }
  return t;
}

function stdinReadExpr(target: string): string {
  const n = normalizeLiteralPath(target);
  if (n === 'NUL') return '@()';
  return '@(fx-readlines ' + pathExpr(n) + ')';
}

/** `>` `>>` `&>` `&>>` — Node last-stage apply cannot honor these on earlier stages. */
function isStdoutFileRedirect(op: Redirect['op']): boolean {
  return op === '>' || op === '>>' || op === '&>' || op === '&>>';
}

const NONLAST_STDOUT_REDIRECT_MSG =
  'fauxnix: stdout redirect on a non-last pipeline stage is not supported yet; write the file in a previous list segment (cmd >f; cat f) or wait for per-stage fds (#157)';
const NONLAST_STDERR_FILE_REDIRECT_MSG =
  'fauxnix: stderr redirect ({op}) on a non-last pipeline stage is not supported yet; spool the stage first (cmd >out {op}err; cat out | next) or wait for per-stage fds (#157)';

function nonLastFdRedirectMessage(op: Redirect['op']): string | null {
  if (isStdoutFileRedirect(op)) return NONLAST_STDOUT_REDIRECT_MSG;
  if (op === '2>' || op === '2>>') {
    return NONLAST_STDERR_FILE_REDIRECT_MSG.replaceAll('{op}', op);
  }
  if (op === '2>&1') {
    return 'fauxnix: 2>&1 on a non-last pipeline stage is not supported yet; spool the merged output first (cmd >out 2>&1; cat out | next) or wait for per-stage fds (#157)';
  }
  if (op === '1>&2') {
    return 'fauxnix: 1>&2 on a non-last pipeline stage is not supported yet; run the stage separately (cmd 1>&2; next </dev/null) or wait for per-stage fds (#157)';
  }
  return null;
}

function rejectNonLastFdRedirects(commands: ShellCommand[]): void {
  if (commands.length < 2) return;
  for (let i = 0; i < commands.length - 1; i++) {
    for (const redirect of commands[i].redirects) {
      const message = nonLastFdRedirectMessage(redirect.op);
      if (message) throw new FauxnixParseError(message);
    }
  }
}

export function translatePipelineBody(p: {
  commands: Array<SimpleCommand | IfCommand | ForCommand | WhileCommand | CaseCommand>;
}, translation: TranslationContext = EXECUTE_TRANSLATION): PipelineParts {
  if (translation.mode === 'pure') {
    for (const command of p.commands) assertPureShellCommand(command);
  }
  // Last-stage output fds are applied by Node. On an earlier stage they would
  // be prepared but not owned by that stage, so output would still reach the
  // wrong destination. Fail loud until routed in-stage fds land (#157).
  rejectNonLastFdRedirects(p.commands);
  // Every pipeline stage needs its own status slot. Handlers deliberately use
  // `$script:fx_exit` because their helper functions run in child scopes; in a
  // pipeline that shared flag lets an earlier failure leak into a successful
  // last stage. Reserve the wrapper id before translating bodies so nested
  // command substitutions cannot reuse it.
  const pipelineId = p.commands.length > 1 ? pipelineSeq++ : -1;
  const bodies: string[] = [];
  for (let i = 0; i < p.commands.length; i++) {
    const c = p.commands[i];
    const hasStdin = i > 0 || c.redirects.some((r) => r.op === '<');
    const position: PipelineCtx['position'] =
      i === 0 ? 'first' : i === p.commands.length - 1 ? 'last' : 'middle';
    if (c.kind === 'If') bodies.push(translateIf(c, translation));
    else if (c.kind === 'For') bodies.push(translateFor(c, translation));
    else if (c.kind === 'While') bodies.push(translateWhile(c, translation));
    else if (c.kind === 'Case') bodies.push(translateCase(c, translation));
    else bodies.push(translateSimple(c, position, hasStdin, translation));
  }

  if (bodies.length === 1) {
    return { defs: '', call: '(& {\n' + bodies[0] + '\n})' };
  }

  const names: string[] = [];
  const defs: string[] = [];
  const statusVar = '$fx_pipe_status' + pipelineId;
  for (let i = 0; i < bodies.length; i++) {
    const name = '__fx_s' + stageSeq++;
    names.push(name);
    const isolatedBody = bodies[i].split('$script:fx_exit').join(statusVar + '[' + i + ']');
    const indented = isolatedBody
      .split('\n')
      .map((l) => (l ? '  ' + l : l))
      .join('\n');
    defs.push('function ' + name + ' {\n' + indented + '\n}');
  }
  const pipelineName = '__fx_p' + pipelineId;
  const statuses = bodies.map(() => '0').join(', ');
  const stageStdin = p.commands.map((c) => stdinTarget(c));
  const middleStdin = stageStdin.some((t, i) => i > 0 && t !== null);
  let pipelineInner: string;
  if (middleStdin) {
    // A non-first `< file` replaces the pipe as that stage's stdin. Run
    // earlier stages anyway (they may have side effects) but do not feed
    // their stream into the redirected stage.
    const seq: string[] = ['    $fx_cur = @($input)'];
    for (let i = 0; i < names.length; i++) {
      if (stageStdin[i] && i > 0) seq.push('    $fx_cur = ' + stdinReadExpr(stageStdin[i]!));
      if (i === names.length - 1) seq.push('    $fx_cur | ' + names[i]);
      else seq.push('    $fx_cur = @($fx_cur | ' + names[i] + ')');
    }
    pipelineInner = seq.join('\n');
  } else {
    pipelineInner =
      '    $input | ' + names.join(' | ');
  }
  defs.push(
    [
      'function ' + pipelineName + ' {',
      '  ' + statusVar + ' = @(' + statuses + ')',
      '  try {',
      // The wrapper forwards redirect input to stage zero. With no input,
      // PowerShell still invokes a regular function once, which preserves the
      // existing no-stdin pipeline behavior on Windows PowerShell 5.1.
      pipelineInner,
      '  } finally {',
      // Bash defaults to pipefail off: only the last stage controls the list
      // status used by a following && / || segment.
      '    $script:fx_exit = [int]' + statusVar + '[' + (bodies.length - 1) + ']',
      '  }',
      '}',
    ].join('\n'),
  );
  return { defs: defs.join('\n'), call: pipelineName };
}

/* ------------------------------------------------------------------ */
/* Full translation with executor wrapper                              */
/* ------------------------------------------------------------------ */

export interface SegmentPlan {
  op: ';' | '&&' | '||';
  /** Spawn-mode wrapScript (`translate` output for a one-shot PowerShell process). */
  script: string;
  /** Pipeline body before wrapScript — executor host mode re-wraps this. */
  body: string;
  /** Every stage's redirects, in source order — executor prep (open/fail). */
  redirects: Redirect[];
  /** Last-stage redirects — captured stdout/stderr apply / >/dev/null. */
  outputRedirects: Redirect[];
  /** First-stage `<` only — FAUXNIX_STDIN_FILE feed. */
  stdinRedirects: Redirect[];
}

export function translateCommandList(
  list: CommandList,
  translation: TranslationContext = EXECUTE_TRANSLATION,
): SegmentPlan[] {
  const plans: SegmentPlan[] = [];
  for (const seg of list.segments) {
    const cmds = seg.pipeline.commands;
    const redirects: Redirect[] = [];
    for (const c of cmds) redirects.push(...c.redirects);
    const outputRedirects = cmds.length ? cmds[cmds.length - 1].redirects.slice() : [];
    const stdinRedirects = cmds.length
      ? cmds[0].redirects.filter((r) => r.op === '<')
      : [];
    const { defs, call } = translatePipelineBody(seg.pipeline, translation);
    let body = defs ? defs + '\n' + call : call;
    // First-stage `< file` feeds stage zero via FAUXNIX_STDIN_FILE.
    // Later-stage `<` is owned inside the pipeline body, not this wrapper.
    if (stdinRedirects.length) {
      // `& { ... }` (no parens) so the scriptblock can be a non-first
      // pipeline element receiving the fed lines.
      const pipeCall = call.startsWith('(& {') ? call.slice(1, -1) : call;
      body =
        (defs ? defs + '\n' : '') +
        'if ($env:FAUXNIX_STDIN_FILE) { fx-readlines $env:FAUXNIX_STDIN_FILE | ' +
        pipeCall +
        ' } else { ' +
        call +
        ' }';
    }
    plans.push({
      op: seg.op,
      script: wrapScript(body),
      body,
      redirects,
      outputRedirects,
      stdinRedirects,
    });
  }
  return plans;
}

const WRAP_HELPER_ORDER = [
  'fx-readlines',
  'fx-csub',
  'fx-svenc',
  'fx-svdec',
  'fx-posload',
  'fx-posset',
  'fx-posget',
  'fx-posshift',
  'fx-arrload',
  'fx-scalar0',
  'fx-ifs1',
  'fx-arrdrop',
  'fx-arrhas',
  'fx-arrpackget',
  'fx-arrpackset',
  'fx-arrput',
  'fx-arrclr',
  'fx-subget',
  'fx-casematch',
  'fx-subst',
  'fx-slice',
  'fx-winargv',
  'fx-cmdargv',
  'fx-native',
] as const;

type WrapHelper = (typeof WRAP_HELPER_ORDER)[number];

const WRAP_HELPER_DEPS: Record<WrapHelper, WrapHelper[]> = {
  'fx-readlines': [],
  'fx-csub': [],
  'fx-svenc': [],
  'fx-svdec': [],
  'fx-posload': ['fx-svdec'],
  'fx-posset': ['fx-svenc'],
  'fx-posget': ['fx-posload'],
  'fx-posshift': ['fx-posload', 'fx-posset'],
  'fx-arrload': ['fx-scalar0', 'fx-svdec'],
  'fx-scalar0': ['fx-svdec'],
  'fx-ifs1': ['fx-scalar0'],
  'fx-arrdrop': [],
  'fx-arrhas': [],
  'fx-arrpackget': [],
  'fx-arrpackset': ['fx-arrdrop'],
  'fx-arrput': ['fx-arrdrop', 'fx-svenc'],
  'fx-arrclr': ['fx-arrdrop'],
  'fx-subget': ['fx-arrload', 'fx-ifs1'],
  'fx-casematch': [],
  'fx-subst': [],
  'fx-slice': [],
  'fx-winargv': [],
  'fx-cmdargv': ['fx-winargv'],
  'fx-native': ['fx-cmdargv'],
};

/** Helpers the body calls that wrapScript still has to emit (not already defined there). */
function wrapHelpersNeeded(body: string): Set<WrapHelper> {
  const defined = new Set<string>();
  const defRe = /function\s+(fx-[A-Za-z0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(body))) defined.add(m[1]);
  const seeds: WrapHelper[] = [];
  const callRe = /\b(fx-[A-Za-z0-9]+)\b/g;
  while ((m = callRe.exec(body))) {
    const n = m[1];
    if (!defined.has(n) && n in WRAP_HELPER_DEPS) seeds.push(n as WrapHelper);
  }
  const needed = new Set<WrapHelper>();
  const stack = seeds.slice();
  while (stack.length) {
    const n = stack.pop()!;
    if (needed.has(n) || defined.has(n)) continue;
    needed.add(n);
    for (const d of WRAP_HELPER_DEPS[n]) stack.push(d);
  }
  return needed;
}

export type WrapMode = 'spawn' | 'host';

export interface WrapScriptOptions {
  /** spawn (default): one-shot process, `exit` at the end. host: no `exit`, no helper re-emit. */
  mode?: WrapMode;
}

function wrapEncodingPreamble(): string[] {
  return [
    '$ErrorActionPreference = "Continue"',
    "$ProgressPreference = 'SilentlyContinue'",
    // single console-encoding knob in PS 5.1: ansi mode decodes GBK-native
    // admin tools correctly, utf8 mode decodes UTF-8-native dev tools
    // (see encoding.ts — file reads sniff per file and are always right)
    "if ($env:FAUXNIX_NATIVE_ENCODING -eq 'ansi') {",
    "  try { [Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936) } catch {}",
    '} else {',
    '  try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    '  try { chcp 65001 > $null } catch {}',
    '}',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
  ];
}

function wrapCwdPreamble(): string[] {
  return [
    '$script:fx_exit = 0',
    '$fx_prev = 0',
    'if ($env:FAUXNIX_PREV_EXIT) { try { $fx_prev = [int]$env:FAUXNIX_PREV_EXIT } catch { $fx_prev = 0 } }',
    'if ($env:FAUXNIX_CWD) { try { Set-Location -LiteralPath $env:FAUXNIX_CWD } catch {} }',
    // capture AFTER the session cwd is applied — OLDPWD must refer to the
    // shell's previous directory, not the host process' startup directory
    '$fx_oldcwd = (Get-Location).ProviderPath',
    // .NET APIs (ReadAllBytes & friends) resolve relative paths against the
    // process working directory, NOT the PS location — keep them in sync.
    'try { [Environment]::CurrentDirectory = (Get-Location).ProviderPath } catch {}',
  ];
}

function wrapBodyAndPersist(body: string, exitProcess: boolean): string[] {
  const lines = [
    'try {',
    ...body.split('\n').map((l) => '  ' + l),
    '} catch [System.Management.Automation.CommandNotFoundException] {',
    "  [Console]::Error.WriteLine('bash: ' + $_.Exception.TargetName + ': command not found')",
    '  $script:fx_exit = 127',
    '} catch {',
    '  [Console]::Error.WriteLine(($_.Exception.Message).Split("`n")[0])',
    '  $script:fx_exit = 1',
    '}',
    '# persist session cwd and environment for the next segment',
    'try { [IO.File]::WriteAllText($env:FAUXNIX_CWD_FILE, (Get-Location).Path) } catch {}',
    'if ((Get-Location).Path -ne $fx_oldcwd) { $env:FAUXNIX_OLDPWD = $fx_oldcwd }',
    'try {',
    '  $envObj = @{}',
    '  Get-ChildItem Env: | ForEach-Object { $envObj[$_.Name] = $_.Value }',
    '  [IO.File]::WriteAllText($env:FAUXNIX_ENV_FILE, (ConvertTo-Json $envObj -Compress))',
    '} catch {}',
  ];
  if (exitProcess) lines.push('exit $script:fx_exit');
  return lines;
}

/**
 * Wrap a pipeline body with the Fauxnix executor contract:
 * UTF-8 everywhere, bash-style exit codes, cwd/env persistence channels.
 * Spawn mode emits only the fx- helpers the body actually calls. Host mode
 * assumes the resident process already loaded the catalog and must not `exit`.
 */
export function wrapScript(body: string, opts: WrapScriptOptions = {}): string {
  const mode = opts.mode ?? 'spawn';
  body = injectArithHelpers(body);
  const needed = mode === 'host' ? new Set<WrapHelper>() : wrapHelpersNeeded(body);
  const lines =
    mode === 'host'
      ? wrapCwdPreamble()
      : [...wrapEncodingPreamble(), ...wrapCwdPreamble()];
  const helpers: Record<WrapHelper, string[]> = {
    'fx-readlines': [
      'function fx-readlines($p) {',
      '  $b = [IO.File]::ReadAllBytes($p)',
      '  $t = $null',
      '  try { $t = (New-Object System.Text.UTF8Encoding($false, $true)).GetString($b) } catch {}',
      "  if ($null -eq $t) { try { $t = [System.Text.Encoding]::GetEncoding(936).GetString($b) } catch { $t = [System.Text.Encoding]::ASCII.GetString($b) } }",
      '  $t = $t -replace "`r`n", "`n"',
      '  $t = $t -replace "`r", "`n"',
      '  $parts = @($t.Split("`n"))',
      "  if ($parts.Count -eq 1 -and $parts[0] -eq '') { return @() }",
      "  if ($parts[$parts.Count - 1] -eq '') { $parts = $parts[0..($parts.Count - 2)] }",
      '  return $parts',
      '}',
    ],
    'fx-csub': [
      'function fx-csub([scriptblock]$b) {',
      '  $fx_prevcs = $script:fx_csub',
      '  $script:fx_csub = $true',
      '  try { $fx_o = @(& $b | ForEach-Object { [string]$_ }) }',
      '  finally { $script:fx_csub = $fx_prevcs }',
      // Line items (no trailing NL) get a NL between them. Chunks that
      // already end in NL concatenate, so $(echo a; echo b) is a\nb.
      "  $fx_s = ''",
      '  foreach ($fx_x in $fx_o) {',
      '    $fx_t = [string]$fx_x',
      '    if ($fx_s.Length -gt 0 -and $fx_s[$fx_s.Length - 1] -ne [char]10) {',
      '      $fx_s += [string][char]10',
      '    }',
      '    $fx_s += $fx_t',
      '  }',
      '  while ($fx_s.Length -gt 0 -and $fx_s[$fx_s.Length - 1] -eq [char]10) {',
      '    $fx_s = $fx_s.Substring(0, $fx_s.Length - 1)',
      '  }',
      '  return $fx_s',
      '}',
    ],
    'fx-svenc': [
      'function fx-svenc($s) {',
      '  return ([string]$s).Replace([string][char]92, ([string][char]92 + [string][char]92)).Replace([string][char]13, ([string][char]92 + [char]114)).Replace([string][char]10, ([string][char]92 + [char]110))',
      '}',
    ],
    'fx-svdec': [
      'function fx-svdec($s) {',
      '  $s = [string]$s',
      '  $sb = New-Object System.Text.StringBuilder',
      '  $i = 0',
      '  while ($i -lt $s.Length) {',
      '    $c = $s[$i]',
      '    if ($c -eq [char]92 -and ($i + 1) -lt $s.Length) {',
      '      $n2 = $s[$i + 1]',
      '      if ($n2 -eq [char]110) { [void]$sb.Append([char]10); $i += 2; continue }',
      '      if ($n2 -eq [char]114) { [void]$sb.Append([char]13); $i += 2; continue }',
      '      if ($n2 -eq [char]92) { [void]$sb.Append([char]92); $i += 2; continue }',
      '    }',
      '    [void]$sb.Append($c)',
      '    $i++',
      '  }',
      '  return [string]$sb',
      '}',
    ],
    'fx-posload': [
      'function fx-posload {',
      '  if ($null -eq $env:FAUXNIX_POS -or [string]$env:FAUXNIX_POS -eq \'\') { return @() }',
      '  $out = @()',
      '  foreach ($el in @($env:FAUXNIX_POS -split [string][char]30)) { $out += ,(fx-svdec $el) }',
      '  return $out',
      '}',
    ],
    'fx-posset': [
      'function fx-posset($vals) {',
      '  if ($null -eq $vals) { $vals = @() }',
      '  $vals = @($vals)',
      '  if ($vals.Count -eq 0) { $env:FAUXNIX_POS = \'\'; return }',
      '  $encs = @(); foreach ($v in $vals) { $encs += (fx-svenc $v) }',
      '  $env:FAUXNIX_POS = ($encs -join [string][char]30)',
      '}',
    ],
    'fx-posget': [
      'function fx-posget($i) {',
      '  $arr = @(fx-posload)',
      '  $n = 0',
      '  if (-not [int]::TryParse([string]$i, [ref]$n)) { return \'\' }',
      '  if ($n -lt 1 -or $n -gt $arr.Count) { return \'\' }',
      '  return [string]$arr[$n - 1]',
      '}',
    ],
    'fx-posshift': [
      'function fx-posshift($n) {',
      '  $arr = @(fx-posload)',
      '  $i = 1',
      '  if ($null -ne $n -and [string]$n -ne \'\') {',
      '    $parsed = 0',
      '    if (-not [int]::TryParse([string]$n, [ref]$parsed)) {',
      '      [Console]::Error.WriteLine(\'bash: shift: \' + [string]$n + \': numeric argument required\')',
      '      $script:fx_exit = 1',
      '      return',
      '    }',
      '    $i = $parsed',
      '  }',
      '  if ($i -lt 0 -or $i -gt $arr.Count) { $script:fx_exit = 1; return }',
      '  if ($i -eq 0) { return }',
      '  if ($i -eq $arr.Count) { fx-posset @(); return }',
      '  $new = @($arr[$i..($arr.Count - 1)])',
      '  fx-posset $new',
      '}',
    ],
    'fx-arrload': [
      'function fx-arrload($n) {',
      '  $n = [string]$n',
      '  foreach ($fx_pair in @($env:FAUXNIX_ARRS -split [string][char]10)) {',
      '    $fx_eq = $fx_pair.IndexOf([char]61)',
      '    if ($fx_eq -lt 1) { continue }',
      '    if ($fx_pair.Substring(0, $fx_eq) -cne $n) { continue }',
      '    $pay = $fx_pair.Substring($fx_eq + 1)',
      '    if ($pay -eq [string][char]1) { return @() }',
      '    $out = @()',
      '    foreach ($el in @($pay -split [string][char]30)) { $out += ,(fx-svdec $el) }',
      '    return $out',
      '  }',
      '  $s0 = fx-scalar0 $n',
      '  if ($null -eq $s0) { return @() }',
      '  return @([string]$s0)',
      '}',
    ],
    'fx-scalar0': [
      'function fx-scalar0($n) {',
      '  $n = [string]$n',
      "  if (@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ceq $n }).Count -gt 0) { return $null }",
      '  foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) {',
      '    $fx_eq = $fx_pair.IndexOf([char]61)',
      '    if ($fx_eq -lt 1) { continue }',
      '    if ($fx_pair.Substring(0, $fx_eq) -ceq $n) { return (fx-svdec $fx_pair.Substring($fx_eq + 1)) }',
      '  }',
      "  if ($n -ceq 'HOME') { return [string]$HOME }",
      "  if ($n -ceq 'PWD') { return [string]$PWD.Path }",
      "  if ($n -ceq 'USER' -or $n -ceq 'LOGNAME') { return [string]$env:USERNAME }",
      "  if ($n -ceq 'PATH') { return [string]$env:PATH }",
      "  if ($n -ceq 'SHELL') { return 'powershell' }",
      "  if ($n -ceq 'TERM') { return 'xterm-256color' }",
      "  if ($n -ceq 'OLDPWD') { return $(if ($env:FAUXNIX_OLDPWD) { [string]$env:FAUXNIX_OLDPWD } else { $null }) }",
      "  if ($n -ceq 'HOSTNAME') { return [string]$env:COMPUTERNAME }",
      '  $ev = Get-ChildItem Env: | Where-Object { $_.Name -ceq $n } | Select-Object -First 1',
      '  if ($ev) { return [string]$ev.Value }',
      '  return $null',
      '}',
    ],
    'fx-ifs1': [
      'function fx-ifs1 {',
      "  $s = fx-scalar0 'IFS'",
      "  if ($null -eq $s) { return ' ' }",
      "  if ([string]$s -eq '') { return '' }",
      '  return [string]$s[0]',
      '}',
    ],
    'fx-arrdrop': [
      'function fx-arrdrop($n) {',
      '  $n = [string]$n',
      '  $fx_sm = @()',
      '  foreach ($fx_pair in @($env:FAUXNIX_ARRS -split [string][char]10)) {',
      '    $fx_eq = $fx_pair.IndexOf([char]61)',
      '    if ($fx_eq -lt 1) { continue }',
      '    if ($fx_pair.Substring(0, $fx_eq) -cne $n) { $fx_sm += $fx_pair }',
      '  }',
      '  $env:FAUXNIX_ARRS = ($fx_sm -join [string][char]10)',
      '}',
    ],
    'fx-arrhas': [
      'function fx-arrhas($n) {',
      '  $n = [string]$n',
      '  foreach ($fx_pair in @($env:FAUXNIX_ARRS -split [string][char]10)) {',
      '    $fx_eq = $fx_pair.IndexOf([char]61)',
      '    if ($fx_eq -lt 1) { continue }',
      '    if ($fx_pair.Substring(0, $fx_eq) -ceq $n) { return $true }',
      '  }',
      '  return $false',
      '}',
    ],
    'fx-arrpackget': [
      'function fx-arrpackget($n) {',
      '  $n = [string]$n',
      '  foreach ($fx_pair in @($env:FAUXNIX_ARRS -split [string][char]10)) {',
      '    $fx_eq = $fx_pair.IndexOf([char]61)',
      '    if ($fx_eq -lt 1) { continue }',
      '    if ($fx_pair.Substring(0, $fx_eq) -ceq $n) { return $fx_pair.Substring($fx_eq + 1) }',
      '  }',
      '  return $null',
      '}',
    ],
    'fx-arrpackset': [
      'function fx-arrpackset($n, $pay) {',
      '  fx-arrdrop $n',
      '  if ($null -eq $pay) { return }',
      "  $env:FAUXNIX_ARRS = ((@($env:FAUXNIX_ARRS -split [string][char]10 | Where-Object { $_ -ne '' }) + ([string]$n + [string][char]61 + [string]$pay)) -join [string][char]10)",
      '}',
    ],
    'fx-arrput': [
      'function fx-arrput($n, $vals) {',
      '  $n = [string]$n',
      '  if ($null -eq $vals) { $vals = @() } else { $vals = @($vals) }',
      '  fx-arrdrop $n',
      '  if ($vals.Count -eq 0) {',
      // SOH payload: empty array, distinct from scalar '' and from A=('')
      "    $env:FAUXNIX_ARRS = ((@($env:FAUXNIX_ARRS -split [string][char]10 | Where-Object { $_ -ne '' }) + ($n + [string][char]61 + [string][char]1)) -join [string][char]10)",
      '  } else {',
      '    $encs = @(); foreach ($v in $vals) { $encs += (fx-svenc $v) }',
      "    $env:FAUXNIX_ARRS = ((@($env:FAUXNIX_ARRS -split [string][char]10 | Where-Object { $_ -ne '' }) + ($n + [string][char]61 + ($encs -join [string][char]30))) -join [string][char]10)",
      '  }',
      "  $fx_0 = $(if ($vals.Count -gt 0) { [string]$vals[0] } else { '' })",
      '  Set-Item -LiteralPath (\'Env:\\\' + $n) -Value $fx_0',
      "  $env:FAUXNIX_SETVARS = ((@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne $n }) + $n) -join ';')",
      "  $env:FAUXNIX_UNSETVARS = (@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne $n }) -join ';')",
      '  $fx_sv = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne $n) { $fx_sv += $fx_pair } }',
      "  $fx_sv += ($n + [string][char]61 + (fx-svenc $fx_0)); $env:FAUXNIX_SETVALS = ($fx_sv -join [string][char]10)",
      '}',
    ],
    'fx-arrclr': [
      'function fx-arrclr($n) {',
      '  $n = [string]$n',
      '  fx-arrdrop $n',
      "  Remove-Item -LiteralPath ('Env:\\' + $n) -ErrorAction SilentlyContinue",
      "  $env:FAUXNIX_SETVARS = (@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne $n }) -join ';')",
      "  $env:FAUXNIX_UNSETVARS = ((@($env:FAUXNIX_UNSETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne $n }) + $n) -join ';')",
      '  $fx_sv = @(); foreach ($fx_pair in @($env:FAUXNIX_SETVALS -split [string][char]10)) { $fx_eq = $fx_pair.IndexOf([char]61); if ($fx_eq -lt 1) { continue }; if ($fx_pair.Substring(0, $fx_eq) -cne $n) { $fx_sv += $fx_pair } }; $env:FAUXNIX_SETVALS = ($fx_sv -join [string][char]10)',
      '}',
    ],
    'fx-subget': [
      'function fx-subget($n, $ix) {',
      '  $arr = @(fx-arrload $n)',
      '  $ix = [string]$ix',
      // argv-level `@` is expanded by argListExpr; this is the scalar/quoted-* join.
      "  if ($ix -eq '*') { return ($arr -join (fx-ifs1)) }",
      "  if ($ix -eq '@') { return ($arr -join (fx-ifs1)) }",
      '  $i = 0',
      '  if (-not [int]::TryParse($ix, [ref]$i)) { return \'\' }',
      "  if ($i -lt 0 -or $i -ge $arr.Count) { return '' }",
      '  return [string]$arr[$i]',
      '}',
    ],
    'fx-casematch': [
      'function fx-casematch($w, $pats) {',
      '  $w = [string]$w',
      '  foreach ($p in @($pats)) {',
      '    $pat = [string]$p',
      '    try {',
      '      $wp = [WildcardPattern]::new($pat, [System.Management.Automation.WildcardOptions]::None)',
      '      if ($wp.IsMatch($w)) { return $true }',
      '    } catch {}',
      '  }',
      '  return $false',
      '}',
    ],
    'fx-subst': [
      'function fx-subst($s, $pat, $repl, $all) {',
      '  if ($null -eq $s) { return \'\' }',
      '  $s = [string]$s',
      '  $pat = [string]$pat',
      '  $repl = [string]$repl',
      '  if ($pat -eq \'\') { return $s }',
      '  $glob = $false',
      '  foreach ($fx_c in $pat.ToCharArray()) {',
      '    if ($fx_c -eq [char]42 -or $fx_c -eq [char]63) { $glob = $true; break }',
      '  }',
      '  if (-not $glob) {',
      '    if ($all) { return $s.Replace($pat, $repl) }',
      '    $i = $s.IndexOf($pat)',
      '    if ($i -lt 0) { return $s }',
      '    return $s.Substring(0, $i) + $repl + $s.Substring($i + $pat.Length)',
      '  }',
      '  $sb = New-Object System.Text.StringBuilder',
      '  foreach ($fx_c in $pat.ToCharArray()) {',
      '    if ($fx_c -eq [char]42) { [void]$sb.Append(\'.*\'); continue }',
      '    if ($fx_c -eq [char]63) { [void]$sb.Append(\'.\'); continue }',
      '    [void]$sb.Append([regex]::Escape([string]$fx_c))',
      '  }',
      '  $rx = New-Object System.Text.RegularExpressions.Regex($sb.ToString(), [System.Text.RegularExpressions.RegexOptions]::Singleline)',
      '  $fx_rep = $repl.Replace([string][char]36, ([string][char]36 + [string][char]36))',
      '  if ($all) { return $rx.Replace($s, $fx_rep) }',
      '  return $rx.Replace($s, $fx_rep, 1)',
      '}',
    ],
    'fx-slice': [
      'function fx-slice($s, $off, $len) {',
      '  if ($null -eq $s) { return \'\' }',
      '  $s = [string]$s',
      '  $n = $s.Length',
      '  $o = 0',
      '  if (-not [int]::TryParse([string]$off, [ref]$o)) { return \'\' }',
      '  if ($o -lt 0) { $o = $n + $o }',
      '  if ($o -lt 0 -or $o -ge $n) { return \'\' }',
      '  if ($null -eq $len -or [string]$len -eq \'\') { return $s.Substring($o) }',
      '  $l = 0',
      '  if (-not [int]::TryParse([string]$len, [ref]$l)) { return \'\' }',
      '  if ($l -lt 0) {',
      '    $fx_end = $n + $l',
      '    if ($fx_end -lt $o) { return \'\' }',
      '    $l = $fx_end - $o',
      '  }',
      '  if ($l -le 0) { return \'\' }',
      '  if (($o + $l) -gt $n) { $l = $n - $o }',
      '  return $s.Substring($o, $l)',
      '}',
    ],
    'fx-winargv': [
      'function fx-winargv($argv, $cmdmeta) {',
      // Empty [object[]] unwraps to $null on PS 5.1; @($null) is one empty arg.
      // $cmdmeta: also quote & | () <> ^ so cmd.exe /c does not split the tail.
      '  if ($null -eq $argv) { $argv = @() }',
      '  $parts = New-Object System.Collections.Generic.List[string]',
      '  foreach ($a in @($argv)) {',
      '    $s = [string]$a',
      '    if ($s.Length -eq 0) { $parts.Add(\'""\'); continue }',
      '    $need = $false',
      '    foreach ($ch in $s.ToCharArray()) {',
      "      if ($ch -eq ' ' -or $ch -eq ([char]9) -or $ch -eq [char]34) { $need = $true; break }",
      "      if ($cmdmeta -and ($ch -eq '&' -or $ch -eq '|' -or $ch -eq '(' -or $ch -eq ')' -or $ch -eq '<' -or $ch -eq '>' -or $ch -eq '^')) { $need = $true; break }",
      '    }',
      '    if (-not $need) { $parts.Add($s); continue }',
      '    $sb = New-Object System.Text.StringBuilder',
      '    [void]$sb.Append([char]34)',
      '    $bs = 0',
      '    foreach ($ch in $s.ToCharArray()) {',
      '      if ($ch -eq [char]92) { $bs++ }',
      '      elseif ($ch -eq [char]34) {',
      '        [void]$sb.Append(([string][char]92) * (2 * $bs + 1))',
      '        [void]$sb.Append([char]34)',
      '        $bs = 0',
      '      } else {',
      '        if ($bs -gt 0) { [void]$sb.Append(([string][char]92) * $bs); $bs = 0 }',
      '        [void]$sb.Append($ch)',
      '      }',
      '    }',
      '    if ($bs -gt 0) { [void]$sb.Append(([string][char]92) * (2 * $bs)) }',
      '    [void]$sb.Append([char]34)',
      '    $parts.Add($sb.ToString())',
      '  }',
      "  return (($parts.ToArray()) -join ' ')",
      '}',
    ],
    'fx-cmdargv': [
      'function fx-cmdargv($argv) {',
      // cmd.exe performs percent expansion even inside quotes, and embedded
      // quotes can reopen its metacharacter grammar. CR/LF/NUL cannot be
      // represented as one batch argument. Reject those values instead of
      // silently handing a different argv to the shim.
      '  if ($null -eq $argv) { $argv = @() }',
      '  foreach ($a in @($argv)) {',
      '    $s = [string]$a',
      "    if ($s.IndexOf('%') -ge 0) { throw \"fauxnix: cannot pass '%' to a .cmd/.bat file without changing the argument; invoke the underlying executable directly\" }",
      '    if ($s.IndexOf([char]34) -ge 0) { throw \'fauxnix: cannot pass a double quote to a .cmd/.bat file without changing the argument; invoke the underlying executable directly\' }',
      '    if ($s.IndexOf([char]13) -ge 0 -or $s.IndexOf([char]10) -ge 0) { throw \'fauxnix: cannot pass a line break to a .cmd/.bat file as one argument; invoke the underlying executable directly\' }',
      '    if ($s.IndexOf([char]0) -ge 0) { throw \'fauxnix: cannot pass NUL to a .cmd/.bat file as one argument; invoke the underlying executable directly\' }',
      '  }',
      '  return (fx-winargv $argv $true)',
      '}',
    ],
    'fx-native': [
      "if (-not ('FauxnixTextPump' -as [type])) {",
      "  Add-Type -TypeDefinition @'",
      'using System;',
      'using System.IO;',
      'using System.Text;',
      'using System.Threading.Tasks;',
      'public static class FauxnixTextPump {',
      '  public static async Task CopyAsync(TextReader reader, TextWriter writer) {',
      '    var buffer = new char[4096];',
      '    int read;',
      '    while ((read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0) {',
      '      await writer.WriteAsync(buffer, 0, read).ConfigureAwait(false);',
      '    }',
      '    await writer.FlushAsync().ConfigureAwait(false);',
      '  }',
      '  public static async Task CopyFileAsync(TextReader reader, string path) {',
      '    using (var writer = new StreamWriter(path, false, new UTF8Encoding(false))) {',
      '      await CopyAsync(reader, writer).ConfigureAwait(false);',
      '    }',
      '  }',
      '}',
      "'@",
      '}',
      'function fx-native($name, $argv, $term) {',
      '  if ($null -eq $argv) { $argv = @() } else { $argv = [object[]]@($argv) }',
      '  $app = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      '  if ($null -eq $app) {',
      // Dynamic/splat names can resolve to PS echo/cat aliases, not an .exe.
      // Application-first keeps node/git on the Win32 argv path; the call
      // operator is only for names that are not executables.
      '    $cmd = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1',
      '    if ($null -eq $cmd) {',
      "      $fx_nf = 'bash: ' + $name + ': command not found'",
      "      $fx_n = [string]$name",
      // Hint only — never alias python3→python (wrong interpreter).
      "      if ($fx_n -eq 'python3' -or $fx_n -eq 'python3.exe') { $fx_nf += '" +
        PYTHON3_WINDOWS_HINT +
        "' }",
      "      elseif ($fx_n -like '*.sh') { $fx_nf += '" + SH_SCRIPT_WINDOWS_HINT + "' }",
      '      [Console]::Error.WriteLine($fx_nf)',
      '      $script:fx_exit = 127',
      '      return',
      '    }',
      '    $ins = @($input)',
      '    $global:LASTEXITCODE = 0',
      '    if ($ins.Count -gt 0) { $ins | & $name @argv } else { & $name @argv }',
      '    if ($LASTEXITCODE -gt 0) { $script:fx_exit = $LASTEXITCODE }',
      '    return',
      '  }',
      '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
      '  $ext = [IO.Path]::GetExtension([string]$app.Source)',
      // CreateProcess cannot launch .cmd/.bat with UseShellExecute=false (npm.cmd).
      // /s strips one outer quote pair from the /c tail. Build only the
      // subset of batch argv that cmd.exe can pass through unchanged.
      "  if ($ext -eq '.cmd' -or $ext -eq '.bat') {",
      '    $comspec = Get-Command -Name cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      '    if ($null -eq $comspec) {',
      "      [Console]::Error.WriteLine('bash: cmd.exe: command not found')",
      '      $script:fx_exit = 127',
      '      return',
      '    }',
      '    $psi.FileName = $comspec.Source',
      '    try {',
      '      $fx_app = fx-cmdargv $app.Source',
      '      $fx_rest = fx-cmdargv $argv',
      '    } catch {',
      // Let the common wrapper report the validation error and stop the
      // current pipeline. Returning here would let xargs mask the failure.
      '      throw $_.Exception',
      '    }',
      "    if ($fx_rest.Length -gt 0) { $fx_tail = $fx_app + ' ' + $fx_rest } else { $fx_tail = $fx_app }",
      '    $psi.Arguments = \'/d /s /v:off /c "\' + $fx_tail + \'"\'',
      '  } else {',
      '    $psi.FileName = $app.Source',
      '    $psi.Arguments = fx-winargv $argv',
      '  }',
      '  $psi.UseShellExecute = $false',
      '  $psi.RedirectStandardInput = $true',
      '  $psi.RedirectStandardOutput = $true',
      '  $psi.RedirectStandardError = $true',
      '  $psi.CreateNoWindow = $true',
      '  $psi.WorkingDirectory = [Environment]::CurrentDirectory',
      // Drain both child pipes concurrently into disk-backed spools before
      // replaying them. This prevents either 64KB OS pipe from blocking the
      // child and avoids retaining the complete output in a .NET string.
      "  if ($env:FAUXNIX_NATIVE_ENCODING -eq 'ansi') { $enc = [System.Text.Encoding]::GetEncoding(936) } else { $enc = New-Object System.Text.UTF8Encoding $false }",
      '  $psi.StandardOutputEncoding = $enc',
      '  $psi.StandardErrorEncoding = $enc',
      '  $p = New-Object System.Diagnostics.Process',
      '  $p.StartInfo = $psi',
      '  $fx_no = $null',
      '  $fx_spoolUtf8 = New-Object System.Text.UTF8Encoding $false',
      '  try {',
      '    if (-not $term) {',
      "      if ($env:FAUXNIX_NATIVE_SPOOL_DIR) { $fx_no = Join-Path $env:FAUXNIX_NATIVE_SPOOL_DIR (([guid]::NewGuid().ToString('N')) + '.out') }",
      '      else { $fx_no = [IO.Path]::GetTempFileName() }',
      '    }',
      '    [void]$p.Start()',
      '    if ($term) { $outTask = [FauxnixTextPump]::CopyAsync($p.StandardOutput, [Console]::Out) }',
      '    else { $outTask = [FauxnixTextPump]::CopyFileAsync($p.StandardOutput, $fx_no) }',
      '    $errTask = [FauxnixTextPump]::CopyAsync($p.StandardError, [Console]::Error)',
      '    foreach ($fx_ln in $input) { $p.StandardInput.WriteLine([string]$fx_ln) }',
      '    $p.StandardInput.Close()',
      '    [void][System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask))',
      '    [void]$p.WaitForExit()',
      '    if (-not $term) {',
      '      $fx_or = New-Object System.IO.StreamReader($fx_no, $fx_spoolUtf8)',
      '      try { while (($fx_line = $fx_or.ReadLine()) -ne $null) { $fx_line } }',
      '      finally { $fx_or.Dispose() }',
      '    }',
      '    $code = [int]$p.ExitCode',
      '    if ($code -gt 0) { $script:fx_exit = $code } elseif ($code -lt 0) { $script:fx_exit = 1 }',
      '  } finally {',
      '    try { $p.Close() } catch {}',
      '    if ($null -ne $fx_no) { Remove-Item -LiteralPath $fx_no -Force -ErrorAction SilentlyContinue }',
      '  }',
      '}',
    ],
  };
  cachedWrapHelpers = helpers;
  for (const name of WRAP_HELPER_ORDER) {
    if (needed.has(name)) lines.push(...helpers[name]);
  }
  lines.push(...wrapBodyAndPersist(body, mode === 'spawn'));
  return lines.join('\n');
}

let cachedWrapHelpers: Record<WrapHelper, string[]> | null = null;

function wrapHelperCatalog(): Record<WrapHelper, string[]> {
  if (!cachedWrapHelpers) wrapScript('');
  return cachedWrapHelpers!;
}

/**
 * Resident-host bootstrap: encoding + full fx-* catalog + JSON-line RPC loop.
 * Loaded once via the selected PowerShell's `-File`. Must never `exit` a successful frame.
 */
export function hostBootstrapScript(): string {
  const helpers = wrapHelperCatalog();
  const helperLines: string[] = [];
  for (const name of WRAP_HELPER_ORDER) helperLines.push(...helpers[name]);
  return [
    ...wrapEncodingPreamble(),
    '$script:fx_exit = 0',
    ...helperLines,
    HOST_RPC_LOOP,
  ].join('\n');
}

/** Raw UTF-8 JSON lines on stdin/stdout; command streams captured per frame. */
const HOST_RPC_LOOP = `
if (-not ('FauxnixBoundedStream' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
public sealed class FauxnixBoundedStream : Stream {
  private readonly MemoryStream inner;
  private readonly long limit;
  private readonly long storageLimit;
  private long totalWritten;
  public bool Truncated { get; private set; }
  public FauxnixBoundedStream(long limit) {
    this.limit = Math.Max(0, limit);
    this.storageLimit = this.limit + 3;
    this.inner = new MemoryStream((int)Math.Min(this.storageLimit, 65536));
  }
  public byte[] ToArray() { return inner.ToArray(); }
  public override bool CanRead { get { return false; } }
  public override bool CanSeek { get { return false; } }
  public override bool CanWrite { get { return true; } }
  public override long Length { get { return inner.Length; } }
  public override long Position { get { return inner.Position; } set { throw new NotSupportedException(); } }
  public override void Flush() { }
  public override int Read(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
  public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
  public override void SetLength(long value) { throw new NotSupportedException(); }
  public override void Write(byte[] buffer, int offset, int count) {
    long remaining = Math.Max(0, storageLimit - inner.Length);
    int keep = (int)Math.Min((long)count, remaining);
    if (keep > 0) inner.Write(buffer, offset, keep);
    totalWritten += count;
    if (totalWritten > limit) Truncated = true;
  }
  public override void WriteByte(byte value) {
    if (inner.Length < storageLimit) inner.WriteByte(value);
    totalWritten++;
    if (totalWritten > limit) Truncated = true;
  }
}
'@
}
$fx_utf8 = New-Object System.Text.UTF8Encoding $false
$fx_in = [Console]::OpenStandardInput()
$fx_out = [Console]::OpenStandardOutput()
$fx_reader = New-Object System.IO.StreamReader($fx_in, $fx_utf8, $true, 8192, $true)
$fx_proto = New-Object System.IO.StreamWriter($fx_out, $fx_utf8, 8192, $true)
$fx_proto.NewLine = [string][char]10
$fx_proto.AutoFlush = $true
$fx_proto.WriteLine('{"v":2,"type":"ready","capabilities":{"cancel":false,"maxChunkBytes":65536,"stderrMarker":true}}')
function fx-b64([byte[]]$bytes, $off, $len) {
  if ($len -le 0) { return '' }
  $slice = New-Object byte[] $len
  [Array]::Copy($bytes, $off, $slice, 0, $len)
  return [Convert]::ToBase64String($slice)
}
function fx-emit-chunks($type, $id, [byte[]]$bytes, $limit, [ref]$seq) {
  $n = 0
  if ($null -ne $bytes) { $n = $bytes.Length }
  $use = $n
  $trunc = $false
  # limit -1 = uncapped; zero is a real empty caller budget
  if ($limit -ge 0 -and $use -gt $limit) {
    $use = $limit
    $trunc = $true
    # back the cut off to a valid UTF-8 boundary — a split codepoint makes
    # Node's decoder reject the whole buffer and fall back to GBK mojibake
    $i = $use - 1
    $back = 0
    while ($back -lt 3 -and $i -ge 0 -and (($bytes[$i] -band 0xC0) -eq 0x80)) { $i = $i - 1; $back = $back + 1 }
    if ($i -ge 0) {
      $lead = $bytes[$i]
      $seqlen = 1
      if (($lead -band 0xE0) -eq 0xC0) { $seqlen = 2 } elseif (($lead -band 0xF0) -eq 0xE0) { $seqlen = 3 } elseif (($lead -band 0xF8) -eq 0xF0) { $seqlen = 4 }
      if (($i + $seqlen) -gt $use) { $use = $i }
    }
  }
  $off = 0
  while ($off -lt $use) {
    $len = $use - $off
    if ($len -gt 65536) { $len = 65536 }
    $b64 = fx-b64 $bytes $off $len
    $fx_proto.WriteLine('{"v":2,"type":"' + $type + '","id":"' + $id + '","seq":' + $seq.Value + ',"dataB64":"' + $b64 + '"}')
    $seq.Value = $seq.Value + 1
    $off += $len
  }
  return $trunc
}
function fx-new-capture($mode, $limit, $spoolPath) {
  if ([string]$mode -eq 'discard') { return [System.IO.Stream]::Null }
  if ([string]$mode -eq 'spool') {
    return (New-Object System.IO.FileStream([string]$spoolPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read))
  }
  return (New-Object FauxnixBoundedStream ([Math]::Max(0, [long]$limit)))
}
function fx-capture-bytes($stream) {
  if ($stream -is [FauxnixBoundedStream]) { return $stream.ToArray() }
  if ($stream -is [System.IO.MemoryStream]) { return $stream.ToArray() }
  return (New-Object byte[] 0)
}
while ($true) {
  $fx_line = $fx_reader.ReadLine()
  if ($null -eq $fx_line) { break }
  if ($fx_line -eq '') { continue }
  $fx_id = ''
  $fx_req = $null
  $fx_msOut = $null
  $fx_msErr = $null
  $fx_outW = $null
  $fx_errW = $null
  $fx_oldOut = [Console]::Out
  $fx_oldErr = [Console]::Error
  try {
    $fx_req = $fx_line | ConvertFrom-Json
    $fx_id = [string]$fx_req.id
    if ($fx_req.env) {
      foreach ($fx_p in $fx_req.env.PSObject.Properties) {
        $fx_en = [string]$fx_p.Name
        $fx_ev = [string]$fx_p.Value
        if ($fx_ev -eq '') {
          Remove-Item -LiteralPath ('Env:\\' + $fx_en) -ErrorAction SilentlyContinue
        } else {
          Set-Item -LiteralPath ('Env:\\' + $fx_en) -Value $fx_ev
        }
      }
    }
    $fx_script = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$fx_req.scriptB64))
    $fx_outLimit = 8388608
    $fx_errLimit = 1048576
    if ($null -ne $fx_req.PSObject.Properties['stdoutLimit']) { $fx_outLimit = [int]$fx_req.stdoutLimit }
    if ($null -ne $fx_req.PSObject.Properties['stderrLimit']) { $fx_errLimit = [int]$fx_req.stderrLimit }
    $fx_outMode = 'capture'
    $fx_errMode = 'capture'
    $fx_outSpool = ''
    $fx_errSpool = ''
    if ($null -ne $fx_req.PSObject.Properties['stdoutMode']) { $fx_outMode = [string]$fx_req.stdoutMode }
    if ($null -ne $fx_req.PSObject.Properties['stderrMode']) { $fx_errMode = [string]$fx_req.stderrMode }
    if ($null -ne $fx_req.PSObject.Properties['stdoutSpoolPath']) { $fx_outSpool = [string]$fx_req.stdoutSpoolPath }
    if ($null -ne $fx_req.PSObject.Properties['stderrSpoolPath']) { $fx_errSpool = [string]$fx_req.stderrSpoolPath }
    $fx_msOut = fx-new-capture $fx_outMode $fx_outLimit $fx_outSpool
    $fx_msErr = fx-new-capture $fx_errMode $fx_errLimit $fx_errSpool
    $fx_outW = New-Object System.IO.StreamWriter($fx_msOut, $fx_utf8, 1024, $true)
    $fx_errW = New-Object System.IO.StreamWriter($fx_msErr, $fx_utf8, 1024, $true)
    $fx_outW.NewLine = [string][char]10
    $fx_errW.NewLine = [string][char]10
    $fx_outW.AutoFlush = $true
    $fx_errW.AutoFlush = $true
    [Console]::SetOut($fx_outW)
    [Console]::SetError($fx_errW)
    $script:fx_exit = 0
    $fx_sb = [scriptblock]::Create($fx_script)
    & $fx_sb | ForEach-Object { [Console]::Out.WriteLine([string]$_) }
  } catch [System.Management.Automation.CommandNotFoundException] {
    [Console]::Error.WriteLine('bash: ' + $_.Exception.TargetName + ': command not found')
    $script:fx_exit = 127
  } catch {
    [Console]::Error.WriteLine(($_.Exception.Message).Split([string][char]10)[0])
    $script:fx_exit = 1
  } finally {
    try { if ($null -ne $fx_outW) { $fx_outW.Flush() } } catch {}
    try { if ($null -ne $fx_errW) { $fx_errW.Flush() } } catch {}
    try { [Console]::SetOut($fx_oldOut) } catch {}
    try { [Console]::SetError($fx_oldErr) } catch {}
  }
  $fx_code = 0
  try { $fx_code = [int]$script:fx_exit } catch { $fx_code = 1 }
  $fx_v2 = $false
  if ($null -ne $fx_req -and $null -ne $fx_req.PSObject.Properties['v']) {
    if ([int]$fx_req.v -eq 2) { $fx_v2 = $true }
  }
  $fx_outBytes = New-Object byte[] 0
  $fx_errBytes = New-Object byte[] 0
  if ($null -ne $fx_msOut) { $fx_outBytes = fx-capture-bytes $fx_msOut }
  if ($null -ne $fx_msErr) { $fx_errBytes = fx-capture-bytes $fx_msErr }
  try { if ($null -ne $fx_outW) { $fx_outW.Dispose() } } catch {}
  try { if ($null -ne $fx_errW) { $fx_errW.Dispose() } } catch {}
  try { if ($null -ne $fx_msOut -and $fx_msOut -ne [System.IO.Stream]::Null) { $fx_msOut.Dispose() } } catch {}
  try { if ($null -ne $fx_msErr -and $fx_msErr -ne [System.IO.Stream]::Null) { $fx_msErr.Dispose() } } catch {}
  if ($fx_v2) {
    $fx_outSeq = 0
    $fx_errSeq = 0
    $fx_outTrunc = $false
    $fx_errTrunc = $false
    if ($fx_msOut -is [FauxnixBoundedStream] -and $fx_msOut.Truncated) { $fx_outTrunc = $true }
    if ($fx_msErr -is [FauxnixBoundedStream] -and $fx_msErr.Truncated) { $fx_errTrunc = $true }
    $fx_outEmitLimit = $(if ($fx_outMode -eq 'capture') { $fx_outLimit } else { -1 })
    $fx_errEmitLimit = $(if ($fx_errMode -eq 'capture') { $fx_errLimit } else { -1 })
    if (fx-emit-chunks 'stdout' $fx_id $fx_outBytes $fx_outEmitLimit ([ref]$fx_outSeq)) { $fx_outTrunc = $true }
    if (fx-emit-chunks 'stderr' $fx_id $fx_errBytes $fx_errEmitLimit ([ref]$fx_errSeq)) { $fx_errTrunc = $true }
    $fx_nativeErr = [Console]::OpenStandardError()
    $fx_mark = $fx_utf8.GetBytes(('FAUXNIX_ERR_END:' + $fx_id + [char]10))
    $fx_nativeErr.Write($fx_mark, 0, $fx_mark.Length)
    $fx_nativeErr.Flush()
    $fx_trunc = $fx_outTrunc -or $fx_errTrunc
    $fx_end = '{"v":2,"type":"end","id":"' + $fx_id + '","exitCode":' + $fx_code + ',"timedOut":false,"cancelled":false,"truncated":' + ([string]$fx_trunc).ToLowerInvariant() + ',"stdoutTruncated":' + ([string]$fx_outTrunc).ToLowerInvariant() + ',"stderrTruncated":' + ([string]$fx_errTrunc).ToLowerInvariant() + '}'
    $fx_proto.WriteLine($fx_end)
  } else {
    $fx_outB64 = ''
    $fx_errB64 = ''
    if ($fx_outBytes.Length -gt 0) { $fx_outB64 = [Convert]::ToBase64String($fx_outBytes) }
    if ($fx_errBytes.Length -gt 0) { $fx_errB64 = [Convert]::ToBase64String($fx_errBytes) }
    $fx_res = @{ id = $fx_id; stdoutB64 = $fx_outB64; stderrB64 = $fx_errB64; exitCode = $fx_code }
    try {
      $fx_json = $fx_res | ConvertTo-Json -Compress
    } catch {
      $fx_msg = 'fauxnix: host result exceeded ConvertTo-Json MaxJsonLength (~2MB)'
      $fx_res = @{ id = $fx_id; stdoutB64 = ''; stderrB64 = [Convert]::ToBase64String($fx_utf8.GetBytes($fx_msg)); exitCode = 1 }
      $fx_json = $fx_res | ConvertTo-Json -Compress
    }
    $fx_proto.WriteLine($fx_json)
  }
}
`.trim();
