import {
  Assignment,
  CommandList,
  FauxnixParseError,
  Redirect,
  ShellCommand,
  SimpleCommand,
  IfCommand,
  ForCommand,
  Word,
  WordPart,
  isUnquotedLiteral,
} from './ast.js';
import { parseCommand } from './parser.js';
import { PipelineCtx, lookup, psStr } from './registry.js';

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

/** Map a bash $VAR name to a PowerShell expression (usable inside $(...)). */
export function varExpr(
  name: string,
  index?: string,
  param?: { op: ':-' | ':=' | ':+' | ':?' | '-' | '+' | '?'; word: string },
  length = false,
): string {
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
    default:
      return '$env:' + name;
  }
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
    return varExpr(v.name, v.index, v.param, v.length === true);
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
        out += '$(' + varExpr(p.name, p.index, p.param, p.length === true) + ')';
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
        out += '$(' + varExpr(p.name, p.index, p.param, p.length === true) + ')';
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
      (p.index === '@' || (p.index === '*' && !quoted));
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

/** PS expression of a string[]: `@` words splat, others stay one element. */
export function argListExpr(words: Word[], fn: (w: Word) => string = exprOfWord): string {
  if (words.length === 0) return '@()';
  return (
    '(' +
    words
      .map((w) => {
        const s = splatSpec(w);
        if (!s) return '@(' + fn(w) + ')';
        if (!s.prefix && !s.suffix) return '@(fx-arrload ' + psStr(s.name) + ')';
        return (
          '@($( $fx_sp = @(fx-arrload ' +
          psStr(s.name) +
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
 */
export function translateCmdSub(cmdText: string, keepNl = false): string {
  const list = parseCommand(cmdText);
  if (list.segments.length !== 1) {
    throw new FauxnixParseError(
      'fauxnix: command substitution with ; && || is not supported yet',
    );
  }
  const { defs, call } = translatePipelineBody(list.segments[0].pipeline);
  const inner = defs ? defs + '\n' + call : call;
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
): string {
  // assignment-only segment (`X=1; cmd`): bash semantics are "set for the
  // rest of the shell". Reuse the export code path — persist + env shadow —
  // so empty values (`X=`) and `[[ -v X ]]` behave like bash (documented
  // deviation: shell var vs exported var are indistinguishable here).
  if (cmd.name === null) {
    const exportHandler = lookup('export');
    const words = cmd.assignments.map((a) => [
      { kind: 'Text' as const, text: a.name + '=' },
      ...a.value,
    ]);
    return exportHandler ? exportHandler(words, { position, hasStdin }) : '';
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
          );
    const emptyCmdLines: string[] = [
      '$fx_cw = @(fx-arrload ' + psStr(nameSplat.name) + ')',
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
      '  ' + (hasStdin ? '($input | fx-native $fx_cmd $fx_na)' : 'fx-native $fx_cmd $fx_na'),
      '}',
    );
    body = emptyCmdLines.join('\n');
  } else if (nameLit !== null) {
    const handler = lookup(nameLit);
    if (handler && !(nameLit === '[[' && !isUnquotedLiteral(cmd.name, '[['))) {
      body = handler(cmd.args, { position, hasStdin });
    } else {
      // passthrough: native command (git, node, npm, python, cargo, ...)
      // via fx-native (Win32 command line + Process). `& name @array` on
      // PS 5.1 drops empty argv entries and eats embedded quotes.
      const nameExpr = psStr(nameLit);
      const invoke = 'fx-native ' + nameExpr + ' $fx_na';
      body = [
        '$fx_na = [object[]](' + argListExpr(cmd.args) + ')',
        (hasStdin ? '($input | ' + invoke + ')' : invoke),
      ].join('\n');
    }
  } else {
    // dynamic command name — evaluate it
    const nameExpr = exprOfWord(cmd.name);
    const invoke = 'fx-native (' + nameExpr + ') $fx_na';
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
  for (let i = 0; i < sets.length; i++) {
    const vn = '$fx_ev' + id + '_' + i;
    valVars.push(vn);
    lines.push(vn + ' = ' + exprOfWord(sets[i].value, { preserveCmdSub: true }));
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
function translateListInline(list: CommandList): string {
  const chunks: string[] = [];
  for (const seg of list.segments) {
    const { defs, call } = translatePipelineBody(seg.pipeline);
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

function translateIf(cmd: IfCommand): string {
  // Branch bodies reset fx_exit first: the compound's exit status must come
  // from the taken branch's last command (bash semantics), not leak the test's
  // failure — `if false; then A; else B; fi` exits 0 in bash.
  const lines = [translateListInline(cmd.test), 'if ($script:fx_exit -eq 0) {', '  $script:fx_exit = 0'];
  for (const l of translateListInline(cmd.then).split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('} else {', '  $script:fx_exit = 0');
  if (cmd.else) {
    for (const l of translateListInline(cmd.else).split('\n')) lines.push(l ? '  ' + l : l);
  }
  lines.push('}');
  return lines.join('\n');
}

function translateFor(cmd: ForCommand): string {
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
  for (const l of translateListInline(cmd.body).split('\n')) lines.push(l ? '  ' + l : l);
  lines.push('}');
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

export function translatePipelineBody(p: {
  commands: Array<SimpleCommand | IfCommand | ForCommand>;
}): PipelineParts {
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
    if (c.kind === 'If') bodies.push(translateIf(c));
    else if (c.kind === 'For') bodies.push(translateFor(c));
    else bodies.push(translateSimple(c, position, hasStdin));
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
  /** Spawn-mode wrapScript (CLI/MCP `translate`, one-shot powershell.exe). */
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

export function translateCommandList(list: CommandList): SegmentPlan[] {
  const plans: SegmentPlan[] = [];
  for (const seg of list.segments) {
    const cmds = seg.pipeline.commands;
    const redirects: Redirect[] = [];
    for (const c of cmds) redirects.push(...c.redirects);
    const outputRedirects = cmds.length ? cmds[cmds.length - 1].redirects.slice() : [];
    const stdinRedirects = cmds.length
      ? cmds[0].redirects.filter((r) => r.op === '<')
      : [];
    const { defs, call } = translatePipelineBody(seg.pipeline);
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
  'fx-winargv',
  'fx-native',
] as const;

type WrapHelper = (typeof WRAP_HELPER_ORDER)[number];

const WRAP_HELPER_DEPS: Record<WrapHelper, WrapHelper[]> = {
  'fx-readlines': [],
  'fx-csub': [],
  'fx-svenc': [],
  'fx-svdec': [],
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
  'fx-winargv': [],
  'fx-native': ['fx-winargv'],
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
      '  $fx_s = ($fx_o -join [string][char]10)',
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
    'fx-arrload': [
      'function fx-arrload($n) {',
      '  $n = [string]$n',
      '  foreach ($fx_pair in @($env:FAUXNIX_ARRS -split [string][char]10)) {',
      '    $fx_eq = $fx_pair.IndexOf([char]61)',
      '    if ($fx_eq -lt 1) { continue }',
      '    if ($fx_pair.Substring(0, $fx_eq) -cne $n) { continue }',
      '    $out = @()',
      '    foreach ($el in @($fx_pair.Substring($fx_eq + 1) -split [string][char]30)) { $out += ,(fx-svdec $el) }',
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
      '  $vals = @($vals)',
      '  fx-arrdrop $n',
      '  if ($vals.Count -eq 0) { } else {',
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
    'fx-native': [
      'function fx-native($name, $argv) {',
      '  if ($null -eq $argv) { $argv = @() } else { $argv = [object[]]@($argv) }',
      '  $app = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      '  if ($null -eq $app) {',
      // Dynamic/splat names can resolve to PS echo/cat aliases, not an .exe.
      // Application-first keeps node/git on the Win32 argv path; the call
      // operator is only for names that are not executables.
      '    $cmd = Get-Command -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1',
      '    if ($null -eq $cmd) {',
      "      [Console]::Error.WriteLine('bash: ' + $name + ': command not found')",
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
      // /s strips one outer quote pair from the /c tail; CRT-quote cmd
      // metacharacters so `&`/`|`/`()` do not start a second command.
      "  if ($ext -eq '.cmd' -or $ext -eq '.bat') {",
      '    $comspec = Get-Command -Name cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
      '    if ($null -eq $comspec) {',
      "      [Console]::Error.WriteLine('bash: cmd.exe: command not found')",
      '      $script:fx_exit = 127',
      '      return',
      '    }',
      '    $psi.FileName = $comspec.Source',
      '    $fx_app = fx-winargv $app.Source $true',
      '    $fx_rest = fx-winargv $argv $true',
      "    if ($fx_rest.Length -gt 0) { $fx_tail = $fx_app + ' ' + $fx_rest } else { $fx_tail = $fx_app }",
      '    $psi.Arguments = \'/d /s /c "\' + $fx_tail + \'"\'',
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
      // StreamReader.ReadToEndAsync is .NET 4.5 (PS 5.1). Start readers
      // before writing stdin so a chatty child cannot fill the 64KB pipe.
      "  if ($env:FAUXNIX_NATIVE_ENCODING -eq 'ansi') { $enc = [System.Text.Encoding]::GetEncoding(936) } else { $enc = New-Object System.Text.UTF8Encoding $false }",
      '  $psi.StandardOutputEncoding = $enc',
      '  $psi.StandardErrorEncoding = $enc',
      '  $p = New-Object System.Diagnostics.Process',
      '  $p.StartInfo = $psi',
      '  [void]$p.Start()',
      '  $outTask = $p.StandardOutput.ReadToEndAsync()',
      '  $errTask = $p.StandardError.ReadToEndAsync()',
      '  $ins = @($input)',
      '  if ($ins.Count -gt 0) {',
      '    foreach ($fx_ln in $ins) { $p.StandardInput.WriteLine([string]$fx_ln) }',
      '  }',
      '  $p.StandardInput.Close()',
      '  [void][System.Threading.Tasks.Task]::WaitAll(@($outTask, $errTask))',
      '  [void]$p.WaitForExit()',
      '  $errt = [string]$errTask.Result',
      '  if ($errt.Length -gt 0) { [Console]::Error.Write($errt) }',
      '  $t = [string]$outTask.Result',
      "  $t = $t.Replace(([string][char]13 + [string][char]10), [string][char]10).Replace([string][char]13, [string][char]10)",
      "  if ($t -ne '') {",
      '    $parts = @($t.Split([char]10))',
      "    if ($parts.Count -gt 0 -and $parts[$parts.Count - 1] -eq '') { $parts = $parts[0..($parts.Count - 2)] }",
      '    foreach ($fx_ol in $parts) { $fx_ol }',
      '  }',
      '  $code = [int]$p.ExitCode',
      '  if ($code -gt 0) { $script:fx_exit = $code } elseif ($code -lt 0) { $script:fx_exit = 1 }',
      '  try { $p.Close() } catch {}',
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
 * Loaded once via `powershell.exe -File`. Must never `exit` a successful frame.
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
  # limit 0 = uncapped (file-redirected streams must never be budget-clipped)
  if ($limit -gt 0 -and $use -gt $limit) {
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
    $fx_msOut = New-Object System.IO.MemoryStream
    $fx_msErr = New-Object System.IO.MemoryStream
    $fx_outW = New-Object System.IO.StreamWriter($fx_msOut, $fx_utf8, 1024, $true)
    $fx_errW = New-Object System.IO.StreamWriter($fx_msErr, $fx_utf8, 1024, $true)
    $fx_outW.NewLine = [string][char]13 + [string][char]10
    $fx_errW.NewLine = [string][char]13 + [string][char]10
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
  if ($null -ne $fx_msOut) { $fx_outBytes = $fx_msOut.ToArray() }
  if ($null -ne $fx_msErr) { $fx_errBytes = $fx_msErr.ToArray() }
  if ($fx_v2) {
    $fx_outLimit = 8388608
    $fx_errLimit = 1048576
    if ($null -ne $fx_req.PSObject.Properties['stdoutLimit']) { $fx_outLimit = [int]$fx_req.stdoutLimit }
    if ($null -ne $fx_req.PSObject.Properties['stderrLimit']) { $fx_errLimit = [int]$fx_req.stderrLimit }
    $fx_outSeq = 0
    $fx_errSeq = 0
    $fx_trunc = $false
    if (fx-emit-chunks 'stdout' $fx_id $fx_outBytes $fx_outLimit ([ref]$fx_outSeq)) { $fx_trunc = $true }
    if (fx-emit-chunks 'stderr' $fx_id $fx_errBytes $fx_errLimit ([ref]$fx_errSeq)) { $fx_trunc = $true }
    $fx_nativeErr = [Console]::OpenStandardError()
    $fx_mark = $fx_utf8.GetBytes(('FAUXNIX_ERR_END:' + $fx_id + [char]10))
    $fx_nativeErr.Write($fx_mark, 0, $fx_mark.Length)
    $fx_nativeErr.Flush()
    $fx_end = '{"v":2,"type":"end","id":"' + $fx_id + '","exitCode":' + $fx_code + ',"timedOut":false,"cancelled":false,"truncated":'
    if ($fx_trunc) { $fx_end = $fx_end + 'true}' } else { $fx_end = $fx_end + 'false}' }
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
