import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FauxnixParseError, Word, wordToString } from '../ast.js';
import { CommandSpec, Handler, parseWords, psStr } from '../registry.js';
import { argListExpr, exprOfWord, literalOfWord, operandExpr } from '../translator.js';

/* ------------------------------------------------------------------ */
/* Shared PS snippets (same shape as files.ts)                         */
/* ------------------------------------------------------------------ */

const PS_GLOB_FN = [
  'function fx-glob($p) {',
  "  if ($p -notlike '*[*?]*') { return @($p) }",
  '  $m = @(Get-Item -Path $p -ErrorAction SilentlyContinue)',
  '  if ($m.Count -eq 0) { return @($p) }',
  '  return @($m | ForEach-Object { $_.FullName })',
  '}',
].join('\n');

const PS_READTEXT_FN = [
  'function fx-read($p) {',
  '  $b = [IO.File]::ReadAllBytes($p)',
  '  try { return (New-Object System.Text.UTF8Encoding($false, $true)).GetString($b) }',
  '  catch { try { return [System.Text.Encoding]::GetEncoding(936).GetString($b) } catch { return [System.Text.Encoding]::ASCII.GetString($b) } }',
  '}',
].join('\n');

/** Split text into lines, GNU-style (trailing newline makes no extra line). */
const PS_SPLITLINES_FN = [
  'function fx-splitlines($t) {',
  '  $t = $t.Replace([string][char]13 + [string][char]10, [string][char]10).Replace([string][char]13, [string][char]10)',
  "  if ($t -eq '') { return @() }",
  '  if ($t.EndsWith([string][char]10)) { $t = $t.Substring(0, $t.Length - 1) }',
  '  return @($t.Split([char]10))',
  '}',
].join('\n');

/** stdin → flat line array (multi-line items from printf-style stages split). */
const STDIN_LINES = [
  '$fx_in = New-Object System.Collections.Generic.List[string]',
  'foreach ($fx_it in @($input | ForEach-Object { [string]$_ })) { $fx_in.AddRange([string[]]@(fx-splitlines $fx_it)) }',
  '$fx_in = @($fx_in)',
].join('\n');

/** Operand Words → PS array expression of string exprs. */
function psArray(words: Word[], fn: (w: Word) => string = operandExpr): string {
  return argListExpr(words, fn);
}

/** PS boolean literal. */
function pb(v: boolean): string {
  return v ? '$true' : '$false';
}

/**
 * Like psStr but flattens embedded control characters (\n \t \r) into
 * [char]N concatenations — a raw newline inside a PS string literal would be
 * re-indented (and corrupted) by the executor's wrapper.
 */
function psStrFlat(s: string): string {
  const parts: string[] = [];
  let lit = '';
  for (const ch of s) {
    if (ch === '\n' || ch === '\t' || ch === '\r') {
      if (lit !== '') {
        parts.push(psStr(lit));
        lit = '';
      }
      parts.push('[string][char]' + (ch === '\n' ? 10 : ch === '\t' ? 9 : 13));
    } else {
      lit += ch;
    }
  }
  if (lit !== '') parts.push(psStr(lit));
  if (parts.length === 0) return "''";
  return '(' + parts.join(' + ') + ')';
}

/**
 * A text argument (pattern, delimiter, script piece). Unlike operandExpr
 * this NEVER applies path normalization — 'a/b' must stay 'a/b'.
 */
function textExpr(w: Word): string {
  const lit = literalOfWord(w);
  if (lit !== null) return psStr(lit);
  return exprOfWord(w);
}

/** Collect EVERY value of a short option (-kN, -k N) — parseWords keeps only the last. */
function collectShortValues(args: Word[], letter: string): string[] {
  const out: string[] = [];
  let onlyOps = false;
  for (let i = 0; i < args.length; i++) {
    const t = wordToString(args[i]);
    if (t === '--') {
      onlyOps = true;
      continue;
    }
    if (onlyOps) continue;
    if (t === '-' + letter) {
      if (i + 1 < args.length) {
        out.push(wordToString(args[i + 1]));
        i++;
      }
    } else if (t.startsWith('-' + letter) && t.length > 2 && !t.startsWith('--')) {
      out.push(t.slice(2));
    }
  }
  return out;
}

interface LongOptionValue {
  name: string;
  value: string;
}

/** Collect repeated value-taking long options without mistaking short bundles for values. */
function collectLongValues(args: Word[], names: string[]): LongOptionValue[] {
  const out: LongOptionValue[] = [];
  let onlyOps = false;
  for (let i = 0; i < args.length; i++) {
    const t = wordToString(args[i]);
    if (t === '--') {
      onlyOps = true;
      continue;
    }
    if (onlyOps || !t.startsWith('--')) continue;
    const eq = t.indexOf('=');
    const name = eq >= 0 ? t.slice(0, eq) : t;
    if (!names.includes(name)) continue;
    if (eq >= 0) {
      out.push({ name, value: t.slice(eq + 1) });
    } else if (i + 1 < args.length) {
      out.push({ name, value: wordToString(args[i + 1]) });
      i++;
    }
  }
  return out;
}

/**
 * Collect EVERY value of a short option and its long aliases, in argv order.
 * parseWords keeps only the last; grep -e/--regexp must OR-accumulate.
 * Handles -e PAT, -ePAT, -ie PAT (bundled), --regexp PAT, --regexp=PAT.
 */
function collectRepeatOptionValues(args: Word[], short: string, longs: string[]): string[] {
  const out: string[] = [];
  let onlyOps = false;
  for (let i = 0; i < args.length; i++) {
    const t = wordToString(args[i]);
    if (t === '--') {
      onlyOps = true;
      continue;
    }
    if (onlyOps) continue;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq >= 0 ? t.slice(0, eq) : t;
      if (!longs.includes(name)) continue;
      if (eq >= 0) {
        out.push(t.slice(eq + 1));
      } else if (i + 1 < args.length) {
        out.push(wordToString(args[i + 1]));
        i++;
      }
      continue;
    }
    if (!(t.startsWith('-') && t.length > 1 && !/^-?\d/.test(t.slice(1, 2)))) continue;
    const body = t.slice(1);
    for (let c = 0; c < body.length; c++) {
      if (body[c] !== short) continue;
      const rest = body.slice(c + 1);
      if (rest) {
        out.push(rest);
      } else if (i + 1 < args.length) {
        out.push(wordToString(args[i + 1]));
        i++;
      }
      break;
    }
  }
  return out;
}

/** Build the "collect file operands through fx-glob" PS prologue. */
function psCollectSources(
  filesExpr: string,
  cmdErr: (v: string) => string,
  leafOnly: boolean,
): string[] {
  const test = leafOnly
    ? '-not (Test-Path -LiteralPath $fx_g -PathType Leaf)'
    : '-not (Test-Path -LiteralPath $fx_g)';
  return [
    '$fx_srcs = @()',
    '$fx_err = $false',
    'foreach ($fx_o in ' + filesExpr + ') {',
    '  foreach ($fx_g in (fx-glob $fx_o)) {',
    '    if (' + test + ') { ' + cmdErr('$fx_g') + '; $fx_err = $true; continue }',
    '    $fx_srcs += $fx_g',
    '  }',
    '}',
  ];
}

/** Resolve a POSIX-ish literal path for node:fs (sed -f). */
function nodePathOf(p: string): string {
  if (p === '/tmp') return os.tmpdir();
  if (p.startsWith('/tmp/')) return path.join(os.tmpdir(), p.slice(5));
  const m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return m[1].toUpperCase() + ':\\' + m[2].split('/').join('\\');
  return p;
}

/* ------------------------------------------------------------------ */
/* BRE / ERE → .NET regex translation                                  */
/* ------------------------------------------------------------------ */

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  lower: 'a-z',
  upper: 'A-Z',
  alnum: 'A-Za-z0-9',
  space: '\\s',
  blank: ' \\t',
  xdigit: '0-9A-Fa-f',
  punct: '!-/:-@[-`{-~',
  cntrl: '\\x00-\\x1F',
  print: ' -~',
  graph: '!-~',
};

/** Replace [:class:] inside a pattern (only meaningful inside brackets). */
function posixClassFix(re: string): string {
  return re.replace(/\[:([a-z]+):\]/g, (m, name: string) => {
    const rep = POSIX_CLASSES[name];
    if (rep === undefined) return m;
    return rep;
  });
}

/** POSIX BRE → .NET regex (best-effort). */
function breToDotNet(re: string): string {
  let out = '';
  let i = 0;
  while (i < re.length) {
    const c = re[i];
    if (c === '\\') {
      const n = re[i + 1];
      if (n === undefined) {
        out += '\\\\';
        i++;
      } else if ('(){}|+?'.includes(n)) {
        out += n;
        i += 2;
      } else {
        out += '\\' + n;
        i += 2;
      }
      continue;
    }
    if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (re[j] === '^') {
        cls += '^';
        j++;
      }
      if (re[j] === ']') {
        cls += ']';
        j++;
      }
      while (j < re.length && re[j] !== ']') {
        cls += re[j];
        j++;
      }
      if (j < re.length) {
        cls += ']';
        j++;
      }
      out += posixClassFix(cls);
      i = j;
      continue;
    }
    if ('()|+?'.includes(c)) {
      out += '\\' + c;
      i++;
      continue;
    }
    if (c === '{' || c === '}') {
      out += '\\' + c;
      i++;
      continue;
    }
    if (c === '*' && i === 0) {
      out += '\\*';
      i++;
      continue;
    }
    if (c === '^') {
      out += i === 0 ? '^' : '\\^';
      i++;
      continue;
    }
    if (c === '$' && i !== re.length - 1) {
      out += '\\$';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** POSIX ERE → .NET regex (close to identity; fix character classes). */
function ereToDotNet(re: string): string {
  return posixClassFix(re);
}

/* ------------------------------------------------------------------ */
/* grep                                                                */
/* ------------------------------------------------------------------ */

const grep: Handler = (args) => {
  const filterOptionNames = ['--include', '--exclude', '--exclude-dir'];
  const filterOptions = collectLongValues(args, filterOptionNames);
  const fileFilterOptions = filterOptions.filter((o) => o.name !== '--exclude-dir');
  const excludeDirGlobs = filterOptions
    .filter((o) => o.name === '--exclude-dir')
    .map((o) => o.value.replace(/[\\/]+$/, ''));

  const { flags, operandWords, values, missingValue } = parseWords(
    args,
    ['A', 'B', 'C', 'm', 'e'],
    [...filterOptionNames, '--max-count', '--regexp'],
  );
  const missingFilterOption = missingValue.find((o) =>
    [...filterOptionNames, '-m', '--max-count', '-e', '--regexp'].includes(o),
  );
  if (missingFilterOption) {
    return (
      '[Console]::Error.WriteLine(' +
      psStr("grep: option '" + missingFilterOption + "' requires an argument") +
      '); $script:fx_exit = 2'
    );
  }
  const maxCountRaw = values.get('-m') ?? values.get('--max-count');
  let maxCount: number | null = null;
  if (maxCountRaw !== undefined) {
    if (!/^\d+$/.test(maxCountRaw)) {
      return (
        '[Console]::Error.WriteLine(' +
        psStr("grep: invalid max count '" + maxCountRaw + "'") +
        '); $script:fx_exit = 2'
      );
    }
    maxCount = parseInt(maxCountRaw, 10);
  }
  const ci = flags.has('i');
  const inv = flags.has('v');
  const num = flags.has('n');
  const cntMode = flags.has('c');
  const listMode = flags.has('l');
  const rec = flags.has('r') || flags.has('R');
  const ere = flags.has('E');
  const fixed = flags.has('F');
  const word = flags.has('w');
  const quiet = flags.has('q');
  const onlyMatch = flags.has('o');
  const suppressFname = flags.has('h');
  const forceFname = flags.has('H');

  const toInt = (s: string | undefined): number => {
    const n = s === undefined ? NaN : parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const ctxA = Math.max(toInt(values.get('-A')), toInt(values.get('-C')));
  const ctxB = Math.max(toInt(values.get('-B')), toInt(values.get('-C')));

  const regexpPats = collectRepeatOptionValues(args, 'e', ['--regexp']);
  if (regexpPats.length === 0 && operandWords.length === 0) {
    return (
      "[Console]::Error.WriteLine('usage: grep [OPTION]... PATTERN [FILE]...'); $script:fx_exit = 2"
    );
  }
  const fileWords = regexpPats.length > 0 ? operandWords : operandWords.slice(1);
  const multiFixed = fixed && regexpPats.length > 1;
  let patExpr = "''";
  if (!multiFixed) {
    if (regexpPats.length > 1) {
      patExpr = psStr(
        regexpPats.map((p) => '(?:' + (ere ? ereToDotNet(p) : breToDotNet(p)) + ')').join('|'),
      );
    } else {
      const patternWord: Word =
        regexpPats.length === 1 ? [{ kind: 'Text', text: regexpPats[0] }] : operandWords[0];
      const patLit = literalOfWord(patternWord);
      if (fixed || patLit === null) {
        patExpr = textExpr(patternWord);
      } else {
        patExpr = psStr(ere ? ereToDotNet(patLit) : breToDotNet(patLit));
      }
    }
  }

  const lines: string[] = [PS_READTEXT_FN, PS_SPLITLINES_FN];

  // --- pattern objects -------------------------------------------------
  if (fixed) {
    if (multiFixed) {
      lines.push(
        '$fx_needles = @(' +
          regexpPats.map((p) => textExpr([{ kind: 'Text', text: p }])).join(', ') +
          ')',
      );
      if (ci) lines.push('$fx_needles_ll = @($fx_needles | ForEach-Object { $_.ToLower() })');
    } else {
      lines.push('$fx_needle = ' + patExpr);
      if (ci) lines.push('$fx_needle_ll = $fx_needle.ToLower()');
    }
  } else {
    lines.push('$fx_pat = ' + patExpr);
    if (word) lines.push("$fx_pat = '(?<!\\w)(?:' + $fx_pat + ')(?!\\w)'");
    lines.push(
      ci
        ? '$fx_re = New-Object System.Text.RegularExpressions.Regex($fx_pat, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)'
        : '$fx_re = New-Object System.Text.RegularExpressions.Regex($fx_pat)',
    );
  }

  // --- fx-gmatch: line test (-v applied once to the combined OR) --------
  lines.push('function fx-gmatch($l) {');
  if (fixed) {
    if (word) {
      if (ci) lines.push('  $lx = $l.ToLower()');
      const hay = ci ? '$lx' : '$l';
      if (multiFixed) {
        const arr = ci ? '$fx_needles_ll' : '$fx_needles';
        lines.push('  foreach ($fx_needle in ' + arr + ') {');
        lines.push('    $p = ' + hay + '.IndexOf($fx_needle)');
        lines.push('    while ($p -ge 0) {');
        lines.push('      $ok = $true');
        lines.push(
          "      if ($p -gt 0) { $c = " + hay + "[$p - 1]; $ok = -not ([char]::IsLetterOrDigit($c) -or $c -eq '_') }",
        );
        lines.push(
          '      if ($ok) { $e = $p + $fx_needle.Length; if ($e -lt ' + hay + '.Length) { $c = ' + hay + "[$e]; $ok = -not ([char]::IsLetterOrDigit($c) -or $c -eq '_') } }",
        );
        lines.push('      if ($ok) { return ' + pb(!inv) + ' }');
        lines.push('      $p = ' + hay + '.IndexOf($fx_needle, $p + 1)');
        lines.push('    }');
        lines.push('  }');
        lines.push('  return ' + pb(inv));
      } else {
        const needle = ci ? '$fx_needle_ll' : '$fx_needle';
        lines.push('  $p = ' + hay + '.IndexOf(' + needle + ')');
        lines.push('  while ($p -ge 0) {');
        lines.push('    $ok = $true');
        lines.push(
          "    if ($p -gt 0) { $c = " + hay + "[$p - 1]; $ok = -not ([char]::IsLetterOrDigit($c) -or $c -eq '_') }",
        );
        lines.push(
          '    if ($ok) { $e = $p + ' + needle + '.Length; if ($e -lt ' + hay + '.Length) { $c = ' + hay + "[$e]; $ok = -not ([char]::IsLetterOrDigit($c) -or $c -eq '_') } }",
        );
        lines.push('    if ($ok) { return ' + pb(!inv) + ' }');
        lines.push('    $p = ' + hay + '.IndexOf(' + needle + ', $p + 1)');
        lines.push('  }');
        lines.push('  return ' + pb(inv));
      }
    } else if (multiFixed) {
      const hay = ci ? '$l.ToLower()' : '$l';
      const arr = ci ? '$fx_needles_ll' : '$fx_needles';
      lines.push('  foreach ($fx_needle in ' + arr + ') {');
      lines.push('    if (' + hay + '.Contains($fx_needle)) { return ' + pb(!inv) + ' }');
      lines.push('  }');
      lines.push('  return ' + pb(inv));
    } else {
      const hay = ci ? '$l.ToLower()' : '$l';
      const needle = ci ? '$fx_needle_ll' : '$fx_needle';
      const hit = hay + '.Contains(' + needle + ')';
      lines.push('  return ' + (inv ? '-not (' + hit + ')' : hit));
    }
  } else {
    const hit = '$fx_re.IsMatch($l)';
    lines.push('  return ' + (inv ? '-not (' + hit + ')' : hit));
  }
  lines.push('}');

  // --- source collection -------------------------------------------------
  if (fileWords.length > 0) {
    lines.push(PS_GLOB_FN);
    lines.push(
      '$fx_fsel = @(' +
        fileFilterOptions
          .map(
            (o) =>
              '[pscustomobject]@{ Keep = ' +
              pb(o.name === '--include') +
              '; Glob = ' +
              psStr(o.value) +
              ' }',
          )
          .join(', ') +
        ')',
      '$fx_excd = @(' + excludeDirGlobs.map((g) => psStr(g)).join(', ') + ')',
      '$fx_srcs = @()',
      '$fx_err = $false',
      '$fx_recd = $false',
    );
    lines.push('function fx-globmatch($fx_name, $fx_glob, $fx_suffix) {');
    lines.push("  $fx_n = ([string]$fx_name).Replace('\\', '/')");
    lines.push("  $fx_p = ([string]$fx_glob).Replace('\\', '/')");
    lines.push('  if ($fx_n -like $fx_p) { return $true }');
    lines.push('  if ($fx_suffix) {');
    lines.push("    $fx_slash = $fx_n.IndexOf('/')");
    lines.push('    while ($fx_slash -ge 0 -and $fx_slash + 1 -lt $fx_n.Length) {');
    lines.push('      $fx_n = $fx_n.Substring($fx_slash + 1)');
    lines.push('      if ($fx_n -like $fx_p) { return $true }');
    lines.push("      $fx_slash = $fx_n.IndexOf('/')");
    lines.push('    }');
    lines.push('  }');
    lines.push('  return $false');
    lines.push('}');
    lines.push('function fx-anyglob($fx_name, $fx_globs, $fx_suffix) {');
    lines.push(
      '  foreach ($fx_glob in $fx_globs) { if (fx-globmatch $fx_name $fx_glob $fx_suffix) { return $true } }',
    );
    lines.push('  return $false');
    lines.push('}');
    lines.push('function fx-filewanted($fx_path, $fx_suffix) {');
    lines.push('  if ($fx_fsel.Count -eq 0) { return $true }');
    lines.push(
      '  $fx_name = if ($fx_suffix) { [string]$fx_path } else { [IO.Path]::GetFileName([string]$fx_path) }',
    );
    lines.push('  $fx_keep = -not [bool]$fx_fsel[0].Keep');
    lines.push(
      '  foreach ($fx_rule in $fx_fsel) { if (fx-globmatch $fx_name $fx_rule.Glob $fx_suffix) { $fx_keep = [bool]$fx_rule.Keep } }',
    );
    lines.push('  return $fx_keep');
    lines.push('}');
    if (rec) {
      lines.push('function fx-walkfiles($fx_root) {');
      lines.push('  $fx_dirs = New-Object System.Collections.Stack');
      lines.push('  $fx_dirs.Push([string]$fx_root)');
      lines.push('  while ($fx_dirs.Count -gt 0) {');
      lines.push('    $fx_cur = [string]$fx_dirs.Pop()');
      lines.push(
        '    foreach ($fx_item in @(Get-ChildItem -LiteralPath $fx_cur -Force -ErrorAction SilentlyContinue)) {',
      );
      lines.push('      if ($fx_item.PSIsContainer) {');
      lines.push(
        '        if (($fx_item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and -not (fx-anyglob $fx_item.Name $fx_excd $false)) { $fx_dirs.Push($fx_item.FullName) }',
      );
      lines.push(
        '      } elseif (fx-filewanted $fx_item.FullName $false) { $fx_item.FullName }',
      );
      lines.push('    }');
      lines.push('  }');
      lines.push('}');
    }
    lines.push('foreach ($fx_o in ' + psArray(fileWords) + ') {');
    lines.push('  foreach ($fx_g in (fx-glob $fx_o)) {');
    lines.push(
      "    if (-not (Test-Path -LiteralPath $fx_g)) { [Console]::Error.WriteLine('grep: ' + $fx_g + ': No such file or directory'); $fx_err = $true; continue }",
    );
    lines.push('    if (Test-Path -LiteralPath $fx_g -PathType Container) {');
    if (rec) {
      lines.push('      $fx_dir = Get-Item -LiteralPath $fx_g');
      lines.push('      if (fx-anyglob $fx_g $fx_excd $true) { continue }');
      lines.push('      $fx_recd = $true');
      lines.push('      $fx_srcs += @(fx-walkfiles $fx_dir.FullName)');
    } else {
      lines.push(
        "      [Console]::Error.WriteLine('grep: ' + $fx_g + ': Is a directory'); $fx_err = $true",
      );
    }
    lines.push('    } elseif (fx-filewanted $fx_g $true) { $fx_srcs += $fx_g }');
    lines.push('  }');
    lines.push('}');
    lines.push('$fx_pre = $false');
    lines.push(
      'if (-not ' +
        pb(suppressFname) +
        ') { if (' +
        pb(forceFname) +
        ' -or $fx_srcs.Count -gt 1 -or $fx_recd) { $fx_pre = $true } }',
    );
  }

  // --- line emit helper (normal / context modes) -------------------------
  lines.push('function fx-emitline($i, $s) {');
  if (num) lines.push("  $s = ([string]($i + 1)) + ':' + $s");
  lines.push("  if ($fx_pre) { $s = $fx_disp + ':' + $s }");
  lines.push('  $s');
  lines.push('}');

  // --- per-source scan body ----------------------------------------------
  const scan: string[] = [];
  if (maxCount !== null) scan.push('$fx_mleft = ' + maxCount);
  if (cntMode) {
    scan.push('$fx_c = 0');
    scan.push('for ($fx_i = 0; $fx_i -lt $fx_ls.Count; $fx_i++) {');
    if (maxCount !== null) scan.push('  if ($fx_mleft -le 0) { break }');
    scan.push(
      '  if (fx-gmatch $fx_ls[$fx_i]) { $fx_c++' +
        (maxCount !== null ? '; $fx_mleft--; if ($fx_mleft -le 0) { break }' : '') +
        ' }',
    );
    scan.push('}');
    scan.push('if ($fx_c -gt 0) { $fx_any = $true }');
    scan.push(
      'if ($fx_pre) { $fx_disp + \':\' + [string]$fx_c } else { [string]$fx_c }',
    );
  } else if (listMode) {
    scan.push('$fx_hit1 = $false');
    scan.push('for ($fx_i = 0; $fx_i -lt $fx_ls.Count; $fx_i++) {');
    if (maxCount !== null) scan.push('  if ($fx_mleft -le 0) { break }');
    scan.push('  if (fx-gmatch $fx_ls[$fx_i]) { $fx_hit1 = $true; break }');
    scan.push('}');
    scan.push('if ($fx_hit1) { $fx_any = $true; $fx_disp }');
  } else if (quiet) {
    scan.push('for ($fx_i = 0; $fx_i -lt $fx_ls.Count; $fx_i++) {');
    if (maxCount !== null) scan.push('  if ($fx_mleft -le 0) { break }');
    scan.push('  if (fx-gmatch $fx_ls[$fx_i]) { $fx_any = $true; break }');
    scan.push('}');
  } else {
    scan.push('$fx_hits = @()');
    scan.push('for ($fx_i = 0; $fx_i -lt $fx_ls.Count; $fx_i++) {');
    if (maxCount !== null) scan.push('  if ($fx_mleft -le 0) { break }');
    scan.push('  $fx_l = $fx_ls[$fx_i]');
    scan.push('  if (fx-gmatch $fx_l) {');
    scan.push('    $fx_any = $true');
    if (maxCount !== null) scan.push('    $fx_mleft--');
    if (onlyMatch && !inv) {
      if (fixed) {
        // GNU -o: emit leftmost-longest matches in input order, not per-needle.
        if (ci) scan.push('    $lx = $fx_l.ToLower()');
        const hay = ci ? '$lx' : '$fx_l';
        const needleArr = multiFixed
          ? ci
            ? '$fx_needles_ll'
            : '$fx_needles'
          : '@(' + (ci ? '$fx_needle_ll' : '$fx_needle') + ')';
        scan.push('    $fx_cands = New-Object System.Collections.Generic.List[object]');
        scan.push('    foreach ($fx_needle in ' + needleArr + ') {');
        scan.push('      if ($fx_needle.Length -lt 1) { continue }');
        scan.push('      $p = ' + hay + '.IndexOf($fx_needle)');
        scan.push('      while ($p -ge 0) {');
        if (word) {
          scan.push('        $ok = $true');
          scan.push(
            "        if ($p -gt 0) { $c = " +
              hay +
              "[$p - 1]; $ok = -not ([char]::IsLetterOrDigit($c) -or $c -eq '_') }",
          );
          scan.push(
            '        if ($ok) { $e = $p + $fx_needle.Length; if ($e -lt ' +
              hay +
              '.Length) { $c = ' +
              hay +
              "[$e]; $ok = -not ([char]::IsLetterOrDigit($c) -or $c -eq '_') } }",
          );
          scan.push(
            '        if ($ok) { [void]$fx_cands.Add([pscustomobject]@{ Start = $p; Len = $fx_needle.Length }) }',
          );
        } else {
          scan.push(
            '        [void]$fx_cands.Add([pscustomobject]@{ Start = $p; Len = $fx_needle.Length })',
          );
        }
        scan.push('        $p = ' + hay + '.IndexOf($fx_needle, $p + 1)');
        scan.push('      }');
        scan.push('    }');
        scan.push('    $fx_end = 0');
        scan.push(
          '    foreach ($fx_c in @($fx_cands | Sort-Object Start, @{ Expression = { $_.Len }; Descending = $true })) {',
        );
        scan.push('      if ($fx_c.Start -ge $fx_end) {');
        scan.push('        fx-emitline $fx_i (' + hay + '.Substring($fx_c.Start, $fx_c.Len))');
        scan.push('        $fx_end = $fx_c.Start + $fx_c.Len');
        scan.push('      }');
        scan.push('    }');
      } else {
        scan.push(
          '    foreach ($fx_m in $fx_re.Matches($fx_l)) { fx-emitline $fx_i $fx_m.Value }',
        );
      }
    } else if (!onlyMatch) {
      scan.push('    $fx_hits += $fx_i');
    }
    if (maxCount !== null) scan.push('    if ($fx_mleft -le 0) { break }');
    scan.push('  }');
    scan.push('}');
    if (!onlyMatch) {
      if (ctxA > 0 || ctxB > 0) {
        scan.push('$fx_show = @()');
        scan.push('foreach ($fx_h in $fx_hits) {');
        scan.push('  $lo = $fx_h - ' + ctxB + '; if ($lo -lt 0) { $lo = 0 }');
        scan.push(
          '  $hi = $fx_h + ' + ctxA + '; if ($hi -gt $fx_ls.Count - 1) { $hi = $fx_ls.Count - 1 }',
        );
        scan.push('  $fx_show += ,@($lo, $hi)');
        scan.push('}');
        scan.push('$g0 = -1; $g1 = -1');
        scan.push('foreach ($w in $fx_show) {');
        scan.push('  if ($g0 -lt 0) { $g0 = $w[0]; $g1 = $w[1] }');
        scan.push('  elseif ($w[0] -le $g1 + 1) { if ($w[1] -gt $g1) { $g1 = $w[1] } }');
        scan.push('  else {');
        scan.push(
          '    for ($fx_j = $g0; $fx_j -le $g1; $fx_j++) { fx-emitline $fx_j $fx_ls[$fx_j] }',
        );
        scan.push("    '--'");
        scan.push('    $g0 = $w[0]; $g1 = $w[1]');
        scan.push('  }');
        scan.push('}');
        scan.push(
          'if ($g0 -ge 0) { for ($fx_j = $g0; $fx_j -le $g1; $fx_j++) { fx-emitline $fx_j $fx_ls[$fx_j] } }',
        );
      } else {
        scan.push('foreach ($fx_h in $fx_hits) { fx-emitline $fx_h $fx_ls[$fx_h] }');
      }
    }
  }

  lines.push('$fx_any = $false');
  if (fileWords.length > 0) {
    lines.push('foreach ($fx_f in $fx_srcs) {');
    lines.push('  $fx_ls = @(fx-splitlines (fx-read $fx_f))');
    lines.push('  $fx_disp = $fx_f');
    for (const l of scan) lines.push('  ' + l);
    lines.push('}');
  } else {
    lines.push('$fx_pre = $false');
    lines.push("$fx_disp = '(standard input)'");
    lines.push(STDIN_LINES);
    lines.push('$fx_ls = $fx_in');
    for (const l of scan) lines.push(l);
  }

  lines.push('if ($fx_any) { $script:fx_exit = 0 } else { $script:fx_exit = 1 }');
  if (!quiet) lines.push('if ($fx_err) { $script:fx_exit = 2 }');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* sed — parsed at translate time, executed as a PS state machine       */
/* ------------------------------------------------------------------ */

type SedAddr =
  | { k: 'line'; n: number }
  | { k: 'last' }
  | { k: 're'; re: string; ci: boolean }
  | { k: 'step'; first: number; step: number };

interface SedCmdBase {
  a1?: SedAddr;
  a2?: SedAddr;
}
interface SedS extends SedCmdBase {
  k: 's';
  re: string;
  repl: string; // .NET substitution syntax
  g: boolean;
  ci: boolean;
  p: boolean;
  nth: number;
}
interface SedY extends SedCmdBase {
  k: 'y';
  set1: string[];
  set2: string[];
}
interface SedQ extends SedCmdBase {
  k: 'q' | 'd' | 'p';
  qn?: number;
}
type SedCmd = SedS | SedY | SedQ;

/** sed s-command RHS → .NET Regex substitution string. */
function sedReplToNet(repl: string, delim: string): string {
  let out = '';
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c === '\\' && i + 1 < repl.length) {
      const n = repl[i + 1];
      if (n === delim) out += delim;
      else if (n === '\\') out += '\\';
      else if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '&') out += '&';
      else if (/[1-9]/.test(n)) out += '$' + n;
      else out += '\\' + n;
      i += 2;
      continue;
    }
    if (c === '&') {
      out += '$&';
      i++;
      continue;
    }
    if (c === '$') {
      out += '$$';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface SedScan {
  s: string;
  i: number;
}

function parseSedAddr(p: SedScan, isEre: boolean): SedAddr | undefined {
  const s = p.s;
  let i = p.i;
  while (i < s.length && s[i] === ' ') i++;
  p.i = i;
  if (i >= s.length) return undefined;
  const c = s[i];
  if (c === '$' && s[i + 1] !== '!') {
    p.i = i + 1;
    return { k: 'last' };
  }
  if (c === '/' || (c === '\\' && s[i + 1] !== undefined && !/[a-zA-Z0-9]/.test(s[i + 1]))) {
    const esc = c === '\\';
    const delim = esc ? s[i + 1] : '/';
    let j = esc ? i + 2 : i + 1;
    let re = '';
    while (j < s.length && s[j] !== delim) {
      if (s[j] === '\\' && j + 1 < s.length) {
        if (s[j + 1] === delim) re += delim;
        else re += s[j] + s[j + 1];
        j += 2;
        continue;
      }
      re += s[j];
      j++;
    }
    if (j >= s.length) {
      throw new FauxnixParseError('fauxnix: sed unterminated regular expression');
    }
    j++;
    let ci = false;
    while (j < s.length && (s[j] === 'I' || s[j] === 'M')) {
      if (s[j] === 'I') ci = true;
      j++;
    }
    p.i = j;
    return { k: 're', re: isEre ? ereToDotNet(re) : breToDotNet(re), ci };
  }
  const dm = s.slice(i).match(/^(\d+)/);
  if (dm) {
    let n = parseInt(dm[1], 10);
    i += dm[1].length;
    if (s[i] === '~') {
      const sm = s.slice(i + 1).match(/^(\d+)/);
      if (!sm || parseInt(sm[1], 10) <= 0) {
        throw new FauxnixParseError('fauxnix: sed invalid step address');
      }
      const step = parseInt(sm[1], 10);
      if (n === 0) n = step;
      p.i = i + 1 + sm[1].length;
      return { k: 'step', first: n, step };
    }
    p.i = i;
    return { k: 'line', n };
  }
  return undefined;
}

const SED_UNSUPPORTED: Record<string, string> = {
  '{': 'sed { } blocks',
  '}': 'sed { } blocks',
  ':': 'sed labels',
  b: 'sed branches (b)',
  t: 'sed branches (t)',
  T: 'sed branches (T)',
  h: 'sed hold space (h)',
  H: 'sed hold space (H)',
  g: 'sed hold space (g)',
  G: 'sed hold space (G)',
  x: 'sed hold space (x)',
  n: 'sed multi-line (n)',
  N: 'sed multi-line (N)',
  P: 'sed multi-line (P)',
  D: 'sed multi-line (D)',
  w: 'sed write-to-file (w)',
  W: 'sed write-to-file (W)',
  r: 'sed read-file (r)',
  R: 'sed read-file (R)',
  a: 'sed append (a\\)',
  i: 'sed insert (i\\)',
  c: 'sed change (c\\)',
  e: 'sed execute (e)',
  F: 'sed filename (F)',
  z: 'sed zap (z)',
  l: 'sed list (l)',
  v: 'sed version (v)',
  L: 'sed line length (L)',
  Q: 'sed quit-two (Q)',
};

function parseSedScript(src: string, isEre: boolean): SedCmd[] {
  const out: SedCmd[] = [];
  const p: SedScan = { s: src, i: 0 };
  const s = src;
  while (p.i < s.length) {
    let i = p.i;
    while (i < s.length && ' \t\r\n;'.includes(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      p.i = i;
      continue;
    }
    p.i = i;
    const a1 = parseSedAddr(p, isEre);
    i = p.i;
    while (i < s.length && s[i] === ' ') i++;
    let a2: SedAddr | undefined;
    if (s[i] === ',') {
      p.i = i + 1;
      a2 = parseSedAddr(p, isEre);
      if (a2 === undefined) {
        throw new FauxnixParseError('fauxnix: sed expected address after ,');
      }
      i = p.i;
      while (i < s.length && s[i] === ' ') i++;
    }
    p.i = i;
    if (p.i >= s.length) throw new FauxnixParseError('fauxnix: sed missing command');
    if (s[p.i] === '!') {
      throw new FauxnixParseError('fauxnix: sed address negation is not supported yet');
    }
    const c = s[p.i];
    if (c === 's') {
      const d = s[p.i + 1];
      if (d === undefined || /[a-zA-Z0-9\\]/.test(d)) {
        throw new FauxnixParseError('fauxnix: sed invalid s command delimiter');
      }
      const readDelim = (): string => {
        let j = p.i;
        let body = '';
        while (j < s.length && s[j] !== d) {
          if (s[j] === '\\' && j + 1 < s.length) {
            if (s[j + 1] === d) body += d;
            else body += s[j] + s[j + 1];
            j += 2;
            continue;
          }
          body += s[j];
          j++;
        }
        if (j >= s.length) throw new FauxnixParseError('fauxnix: sed unterminated s command');
        p.i = j + 1;
        return body;
      };
      p.i = p.i + 2; // past 's' + delimiter
      const re = readDelim();
      const raw = readDelim();
      let g = false;
      let ci = false;
      let pr = false;
      let nth = 1;
      while (p.i < s.length && /[0-9gipImM]/.test(s[p.i])) {
        const f = s[p.i];
        if (f === 'g') g = true;
        else if (f === 'i' || f === 'I') ci = true;
        else if (f === 'p') pr = true;
        else if (/[0-9]/.test(f)) {
          const dm = s.slice(p.i).match(/^(\d+)/)!;
          nth = parseInt(dm[1], 10);
          if (nth === 0) {
            throw new FauxnixParseError('fauxnix: sed s command number flag must be > 0');
          }
          p.i += dm[1].length - 1;
        }
        p.i++;
      }
      out.push({
        k: 's',
        a1,
        a2,
        re: isEre ? ereToDotNet(re) : breToDotNet(re),
        repl: sedReplToNet(raw, d),
        g,
        ci,
        p: pr,
        nth,
      });
      continue;
    }
    if (c === 'y') {
      const d = s[p.i + 1];
      if (d === undefined || /[a-zA-Z0-9\\]/.test(d)) {
        throw new FauxnixParseError('fauxnix: sed invalid y command delimiter');
      }
      p.i = p.i + 2; // past 'y' + delimiter
      const readSet = (): string[] => {
        const set: string[] = [];
        while (p.i < s.length && s[p.i] !== d) {
          if (s[p.i] === '\\' && p.i + 1 < s.length) {
            const n = s[p.i + 1];
            if (n === d) set.push(d);
            else if (n === 'n') set.push('\n');
            else if (n === 't') set.push('\t');
            else if (n === '\\') set.push('\\');
            else set.push(n);
            p.i += 2;
            continue;
          }
          set.push(s[p.i]);
          p.i++;
        }
        if (p.i >= s.length) {
          throw new FauxnixParseError('fauxnix: sed unterminated y command');
        }
        p.i++; // past delimiter
        return set;
      };
      const set1 = readSet();
      const set2 = readSet();
      if (set1.length !== set2.length) {
        throw new FauxnixParseError("fauxnix: sed strings for 'y' command are different lengths");
      }
      out.push({ k: 'y', a1, a2, set1, set2 });
      continue;
    }
    if (c === 'd' || c === 'p' || c === 'q') {
      let j = p.i + 1;
      let qn: number | undefined;
      if (c === 'q') {
        while (j < s.length && s[j] === ' ') j++;
        const dm = s.slice(j).match(/^(\d+)/);
        if (dm) {
          qn = parseInt(dm[1], 10);
          j += dm[1].length;
        }
      }
      p.i = j;
      out.push({ k: c, a1, a2, qn });
      continue;
    }
    const name = SED_UNSUPPORTED[c];
    if (name) throw new FauxnixParseError('fauxnix: ' + name + ' is not supported yet');
    throw new FauxnixParseError("fauxnix: sed command '" + c + "' is not supported yet");
  }
  return out;
}

const sed: Handler = (args) => {
  // custom argv parse: -i takes an ATTACHED suffix; -e/-f take attached or next
  const raw = args.map((w) => wordToString(w));
  let noPrint = false;
  let isEre = false;
  let suffix: string | null = null; // null = not in-place, '' = in-place no backup
  const scripts: string[] = [];
  const operandWords: Word[] = [];
  let i = 0;
  let onlyOps = false;
  while (i < raw.length) {
    const a = raw[i];
    if (!onlyOps && a === '--') {
      onlyOps = true;
    } else if (!onlyOps && a.startsWith('--')) {
      if (a === '--in-place' || a.startsWith('--in-place=')) {
        suffix = a === '--in-place' ? '' : a.slice('--in-place='.length);
      } else if (a === '--regexp-extended') isEre = true;
      else if (a === '--quiet' || a === '--silent') noPrint = true;
    } else if (!onlyOps && a.startsWith('-') && a.length > 1) {
      const body = a.slice(1);
      for (let c = 0; c < body.length; c++) {
        const ch = body[c];
        if (ch === 'n') noPrint = true;
        else if (ch === 'E' || ch === 'r') isEre = true;
        else if (ch === 's' || ch === 'u' || ch === 'z') {
          /* accepted, no-op for us */
        } else if (ch === 'e' || ch === 'f') {
          const rest = body.slice(c + 1);
          let val: string;
          if (rest) {
            val = rest;
          } else if (i + 1 < raw.length) {
            val = raw[i + 1];
            i++;
          } else {
            throw new FauxnixParseError('fauxnix: sed -' + ch + ' requires an argument');
          }
          if (ch === 'f') {
            try {
              val = readFileSync(nodePathOf(val), 'utf8');
            } catch {
              throw new FauxnixParseError("fauxnix: sed can't read script file " + val);
            }
          }
          scripts.push(val);
          break;
        } else if (ch === 'i') {
          suffix = body.slice(c + 1);
          break;
        } else {
          throw new FauxnixParseError('fauxnix: sed -' + ch + ' is not supported yet');
        }
      }
    } else {
      operandWords.push(args[i]);
    }
    i++;
  }

  if (scripts.length === 0 && operandWords.length === 0) {
    return "[Console]::Error.WriteLine('sed: no script was given'); $script:fx_exit = 1";
  }
  let scriptSrc: string;
  if (scripts.length === 0) {
    scriptSrc = wordToString(operandWords[0]);
    operandWords.shift();
  } else {
    scriptSrc = scripts.join('\n');
  }
  const cmds = parseSedScript(scriptSrc, isEre);
  const inPlace = suffix !== null;

  if (inPlace && operandWords.length === 0) {
    return "[Console]::Error.WriteLine('sed: -i may not be used with stdin'); $script:fx_exit = 1";
  }

  const lines: string[] = [PS_READTEXT_FN, PS_SPLITLINES_FN];
  if (operandWords.length > 0) lines.push(PS_GLOB_FN);

  // hoisted regex objects / y-arrays / range flags
  const hoisted: string[] = [];
  const rangeFlags: string[] = [];
  cmds.forEach((cmd, idx) => {
    if (cmd.k === 's') {
      hoisted.push(
        cmd.ci
          ? '$fx_r' + idx + ' = New-Object System.Text.RegularExpressions.Regex(' + psStr(cmd.re) + ', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)'
          : '$fx_r' + idx + ' = New-Object System.Text.RegularExpressions.Regex(' + psStr(cmd.re) + ')',
      );
    } else if (cmd.k === 'y') {
      hoisted.push(
        '$fx_y' + idx + 'a = [char[]](' + cmd.set1.map((ch) => ch.charCodeAt(0)).join(', ') + ')',
      );
      hoisted.push(
        '$fx_y' + idx + 'b = [char[]](' + cmd.set2.map((ch) => ch.charCodeAt(0)).join(', ') + ')',
      );
    }
    if (cmd.a1 && cmd.a2) rangeFlags.push('$fx_rg' + idx + ' = $false');
  });

  // regex objects for regex addresses (deduped)
  const addrVar = new Map<string, string>();
  for (const cmd of cmds) {
    for (const a of [cmd.a1, cmd.a2]) {
      if (a && a.k === 're') {
        const key = a.re + '``' + String(a.ci);
        if (!addrVar.has(key)) {
          const name = '$fx_ar' + addrVar.size;
          addrVar.set(key, name);
          hoisted.push(
            a.ci
              ? name + ' = New-Object System.Text.RegularExpressions.Regex(' + psStr(a.re) + ', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)'
              : name + ' = New-Object System.Text.RegularExpressions.Regex(' + psStr(a.re) + ')',
          );
        }
      }
    }
  }

  const addrTest = (a: SedAddr): string => {
    switch (a.k) {
      case 'line':
        return '($fx_lno -eq ' + a.n + ')';
      case 'last':
        return '($fx_lno -eq $fx_n)';
      case 're':
        return '(' + addrVar.get(a.re + '``' + String(a.ci)) + '.IsMatch($fx_ps))';
      case 'step': {
        const first = a.first === 0 ? a.step : a.first;
        return (
          '($fx_lno -ge ' + first + ' -and (($fx_lno - ' + first + ') % ' + a.step + ') -eq 0)'
        );
      }
    }
  };

  const cmdBlocks: string[] = [];
  cmds.forEach((cmd, idx) => {
    const block: string[] = [];
    if (cmd.a2 && cmd.a1) {
      const bothNum = cmd.a1.k === 'line' && cmd.a2.k === 'line' && cmd.a2.n <= cmd.a1.n;
      if (bothNum) {
        block.push('$fx_sel = ' + addrTest(cmd.a1));
      } else {
        block.push('if ($fx_rg' + idx + ') {');
        block.push('  $fx_sel = $true');
        block.push('  if (' + addrTest(cmd.a2) + ') { $fx_rg' + idx + ' = $false }');
        block.push('} elseif (' + addrTest(cmd.a1) + ') {');
        block.push('  $fx_sel = $true');
        block.push('  $fx_rg' + idx + ' = $true');
        block.push('} else {');
        block.push('  $fx_sel = $false');
        block.push('}');
      }
    } else if (cmd.a1) {
      block.push('$fx_sel = ' + addrTest(cmd.a1));
    } else {
      block.push('$fx_sel = $true');
    }
    block.push('if ($fx_sel) {');
    if (cmd.k === 's') {
      block.push('  $fx_ms = $fx_r' + idx + '.Matches($fx_ps)');
      block.push('  if ($fx_ms.Count -ge 1) {');
      block.push('    $fx_sb = New-Object System.Text.StringBuilder');
      block.push('    $fx_lastp = 0');
      block.push('    $fx_kk = 0');
      block.push('    $fx_did = $false');
      block.push('    foreach ($fx_m in $fx_ms) {');
      block.push('      $fx_kk++');
      if (cmd.nth > 1) block.push('      if ($fx_kk -lt ' + cmd.nth + ') { continue }');
      block.push(
        '      [void]$fx_sb.Append($fx_ps.Substring($fx_lastp, $fx_m.Index - $fx_lastp))',
      );
      block.push('      [void]$fx_sb.Append($fx_m.Result(' + psStrFlat(cmd.repl) + '))');
      block.push('      $fx_lastp = $fx_m.Index + $fx_m.Length');
      block.push('      $fx_did = $true');
      if (!cmd.g) block.push('      break');
      block.push('    }');
      block.push('    [void]$fx_sb.Append($fx_ps.Substring($fx_lastp))');
      block.push('    $fx_ps = $fx_sb.ToString()');
      if (cmd.p) block.push('    if ($fx_did) { $fx_out.Add($fx_ps) }');
      block.push('  }');
    } else if (cmd.k === 'y') {
      block.push('  $fx_sb = New-Object System.Text.StringBuilder');
      block.push('  foreach ($fx_ch in $fx_ps.ToCharArray()) {');
      block.push('    $fx_ix = [array]::IndexOf($fx_y' + idx + 'a, $fx_ch)');
      block.push(
        '    if ($fx_ix -ge 0) { [void]$fx_sb.Append($fx_y' + idx + 'b[$fx_ix]) } else { [void]$fx_sb.Append($fx_ch) }',
      );
      block.push('  }');
      block.push('  $fx_ps = $fx_sb.ToString()');
    } else if (cmd.k === 'd') {
      block.push('  $fx_del = $true');
    } else if (cmd.k === 'p') {
      block.push('  $fx_out.Add($fx_ps)');
    } else {
      block.push('  $fx_stop = $true');
      if (cmd.qn !== undefined) block.push('  $fx_qn = ' + cmd.qn);
    }
    block.push('}');
    cmdBlocks.push(block.join('\n'));
  });

  const loopBody: string[] = [];
  loopBody.push('$fx_lno = $fx_i + 1');
  loopBody.push('$fx_ps = $fx_lines[$fx_i]');
  loopBody.push('$fx_del = $false');
  cmdBlocks.forEach((blk, idx) => {
    const guarded = blk
      .split('\n')
      .map((l) => (l === '' ? l : '  ' + l))
      .join('\n');
    if (idx === 0) {
      loopBody.push(blk);
    } else {
      loopBody.push('if (-not $fx_del -and -not $fx_stop) {');
      loopBody.push(guarded);
      loopBody.push('}');
    }
  });
  loopBody.push('if (-not ' + pb(noPrint) + ' -and -not $fx_del) { $fx_out.Add($fx_ps) }');

  const scanFile: string[] = [];
  scanFile.push('$fx_lines = @(fx-splitlines (fx-read $fx_f))');
  scanFile.push('$fx_n = $fx_lines.Count');
  scanFile.push('$fx_out = New-Object System.Collections.Generic.List[string]');
  scanFile.push('$fx_stop = $false');
  for (const f of rangeFlags) scanFile.push(f);
  scanFile.push('for ($fx_i = 0; $fx_i -lt $fx_n -and -not $fx_stop; $fx_i++) {');
  for (const l of loopBody) scanFile.push('  ' + l);
  scanFile.push('}');
  if (inPlace) {
    scanFile.push(
      "if ($fx_out.Count -gt 0) { $fx_text = ($fx_out -join [string][char]10) + [string][char]10 } else { $fx_text = '' }",
    );
    if (suffix !== '') {
      const sfx = suffix as string;
      scanFile.push(
        'try { Copy-Item -LiteralPath $fx_f -Destination ($fx_f + ' + psStr(sfx) + ') -Force } catch {}',
      );
    }
    scanFile.push(
      '[IO.File]::WriteAllText($fx_f, $fx_text, (New-Object System.Text.UTF8Encoding($false)))',
    );
  } else {
    scanFile.push('foreach ($fx_l in $fx_out) { $fx_l }');
  }

  lines.push(...hoisted);
  lines.push('$fx_qn = 0');

  if (operandWords.length > 0) {
    lines.push(
      ...psCollectSources(
        psArray(operandWords),
        (v) =>
          "[Console]::Error.WriteLine('sed: can''t read ' + " + v + " + ': No such file or directory')",
        true,
      ),
    );
    lines.push('foreach ($fx_f in $fx_srcs) {');
    for (const l of scanFile) lines.push('  ' + l);
    lines.push('}');
  } else {
    lines.push('$fx_err = $false');
    lines.push(STDIN_LINES);
    lines.push('$fx_lines = $fx_in');
    lines.push('$fx_n = $fx_lines.Count');
    lines.push('$fx_out = New-Object System.Collections.Generic.List[string]');
    lines.push('$fx_stop = $false');
    for (const f of rangeFlags) lines.push(f);
    lines.push('for ($fx_i = 0; $fx_i -lt $fx_n -and -not $fx_stop; $fx_i++) {');
    for (const l of loopBody) lines.push('  ' + l);
    lines.push('}');
    lines.push('foreach ($fx_l in $fx_out) { $fx_l }');
  }

  lines.push('$script:fx_exit = $fx_qn');
  lines.push('if ($fx_err) { $script:fx_exit = 2 }');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* awk — mini-interpreter parsed at translate time                     */
/* ------------------------------------------------------------------ */

type AExpr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'var'; name: string }
  | { k: 'field'; idx: number }
  | { k: 'fieldnf' }
  | { k: 'nr' }
  | { k: 'nf' }
  | { k: 'matchre'; re: string; neg: boolean; lhs: AExpr | null }
  | { k: 'bin'; op: string; l: AExpr; r: AExpr }
  | { k: 'un'; op: string; e: AExpr }
  | { k: 'call'; fn: string; args: AExpr[] };

type AStmt =
  | { k: 'print'; args: AExpr[] }
  | { k: 'printf'; fmt: string; args: AExpr[] }
  | { k: 'assign'; name: string; op: string; e: AExpr }
  | { k: 'exit'; code: AExpr | null };

interface AwkItem {
  pat: AExpr | null;
  act: AStmt[] | null; // null = default { print }
}

interface AwkProgram {
  begin: AStmt[];
  items: AwkItem[];
  end: AStmt[];
  vars: Set<string>;
  regexes: string[];
}

const AWK_UNSUPPORTED_FNS = [
  'sin', 'cos', 'atan2', 'sqrt', 'int', 'exp', 'log', 'rand', 'srand',
  'sprintf', 'system', 'index', 'split', 'sub', 'gsub', 'match',
  'and', 'or', 'xor', 'compl', 'lshift', 'rshift', 'fflush', 'getline',
];

class AwkParser {
  private s: string;
  private i: number;
  private vars: Set<string>;
  private regexes: Set<string>;

  constructor(s: string) {
    this.s = s;
    this.i = 0;
    this.vars = new Set();
    this.regexes = new Set();
  }

  private ws(): void {
    while (this.i < this.s.length && ' \t\r\n'.includes(this.s[this.i])) this.i++;
  }

  private wsSemi(): void {
    while (this.i < this.s.length && ' \t\r\n;'.includes(this.s[this.i])) this.i++;
  }

  private atWord(w: string): boolean {
    if (!this.s.startsWith(w, this.i)) return false;
    const after = this.i + w.length;
    if (after < this.s.length && /[A-Za-z0-9_]/.test(this.s[after])) return false;
    return true;
  }

  parse(): AwkProgram {
    const begin: AStmt[] = [];
    const end: AStmt[] = [];
    const items: AwkItem[] = [];
    this.wsSemi();
    while (this.i < this.s.length) {
      if (this.atWord('BEGIN')) {
        this.i += 5;
        begin.push(...this.parseAction());
      } else if (this.atWord('END')) {
        this.i += 3;
        end.push(...this.parseAction());
      } else if (this.s[this.i] === '{') {
        items.push({ pat: null, act: this.parseAction() });
      } else {
        const pat = this.parseExpr();
        this.ws();
        if (this.s[this.i] === ',') {
          throw new FauxnixParseError('fauxnix: awk range patterns are not supported yet');
        }
        if (this.s[this.i] === '{') {
          items.push({ pat, act: this.parseAction() });
        } else {
          items.push({ pat, act: null });
        }
      }
      this.wsSemi();
    }
    return { begin, items, end, vars: this.vars, regexes: [...this.regexes] };
  }

  private parseAction(): AStmt[] {
    this.ws();
    if (this.s[this.i] !== '{') {
      throw new FauxnixParseError('fauxnix: awk expected { to start an action');
    }
    this.i++;
    const stmts: AStmt[] = [];
    this.wsSemi();
    while (this.i < this.s.length && this.s[this.i] !== '}') {
      stmts.push(this.parseStmt());
      this.wsSemi();
    }
    if (this.s[this.i] !== '}') {
      throw new FauxnixParseError('fauxnix: awk unterminated action block');
    }
    this.i++;
    return stmts;
  }

  private parseStmt(): AStmt {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) throw new FauxnixParseError('fauxnix: awk unexpected end of program');
    if (c === '{') {
      throw new FauxnixParseError('fauxnix: awk nested blocks are not supported yet');
    }
    if (this.atWord('print')) {
      this.i += 5;
      this.ws();
      const args: AExpr[] = [];
      if (
        this.i < this.s.length &&
        this.s[this.i] !== '}' &&
        this.s[this.i] !== ';' &&
        this.s[this.i] !== '\n' &&
        this.s[this.i] !== '>'
      ) {
        args.push(this.parseExpr());
        this.ws();
        while (this.s[this.i] === ',') {
          this.i++;
          args.push(this.parseExpr());
          this.ws();
        }
      }
      if (this.s[this.i] === '>' || this.s[this.i] === '|') {
        throw new FauxnixParseError('fauxnix: awk print redirection is not supported yet');
      }
      return { k: 'print', args };
    }
    if (this.atWord('printf')) {
      this.i += 6;
      const fmt = this.parseExpr();
      if (fmt.k !== 'str') {
        throw new FauxnixParseError('fauxnix: awk printf format must be a string literal');
      }
      this.ws();
      const args: AExpr[] = [];
      while (this.s[this.i] === ',') {
        this.i++;
        args.push(this.parseExpr());
        this.ws();
      }
      if (this.s[this.i] === '>' || this.s[this.i] === '|') {
        throw new FauxnixParseError('fauxnix: awk printf redirection is not supported yet');
      }
      return { k: 'printf', fmt: fmt.v, args };
    }
    if (this.atWord('exit')) {
      this.i += 4;
      this.ws();
      let code: AExpr | null = null;
      if (this.i < this.s.length && !'};'.includes(this.s[this.i])) {
        code = this.parseExpr();
      }
      return { k: 'exit', code };
    }
    for (const kw of [
      'if', 'for', 'while', 'do', 'next', 'getline', 'delete',
      'break', 'continue', 'function', 'return',
    ]) {
      if (this.atWord(kw)) {
        throw new FauxnixParseError('fauxnix: awk ' + kw + ' is not supported yet');
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = this.s.slice(this.i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      const name = m[0];
      this.i += m[0].length;
      this.ws();
      const rest = this.s.slice(this.i);
      if (rest.startsWith('[')) {
        throw new FauxnixParseError('fauxnix: awk arrays are not supported yet');
      }
      if (rest.startsWith('(')) {
        throw new FauxnixParseError('fauxnix: awk user functions are not supported yet');
      }
      const opMatch = rest.match(/^(==|\+=|-=|\*=|\/=|%=|=)/);
      if (!opMatch || opMatch[1] === '==') {
        throw new FauxnixParseError(
          'fauxnix: awk bare expression statements are not supported yet',
        );
      }
      const op = opMatch[1];
      this.i += op.length;
      const e = this.parseExpr();
      this.vars.add(name);
      return { k: 'assign', name, op, e };
    }
    throw new FauxnixParseError("fauxnix: awk unexpected character '" + c + "' in program");
  }

  parseExpr(): AExpr {
    return this.parseOr();
  }

  private parseOr(): AExpr {
    let l = this.parseAnd();
    this.ws();
    while (this.s.startsWith('||', this.i)) {
      this.i += 2;
      const r = this.parseAnd();
      l = { k: 'bin', op: '||', l, r };
      this.ws();
    }
    if (this.s[this.i] === '?') {
      throw new FauxnixParseError('fauxnix: awk ?: is not supported yet');
    }
    return l;
  }

  private parseAnd(): AExpr {
    let l = this.parseCmp();
    this.ws();
    while (this.s.startsWith('&&', this.i)) {
      this.i += 2;
      const r = this.parseCmp();
      l = { k: 'bin', op: '&&', l, r };
      this.ws();
    }
    return l;
  }

  private parseCmp(): AExpr {
    const l = this.parseConcat();
    this.ws();
    const two = this.s.slice(this.i, this.i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) {
      this.i += 2;
      const r = this.parseConcat();
      return { k: 'bin', op: two, l, r };
    }
    const c = this.s[this.i];
    if (c === '<' || c === '>') {
      this.i++;
      const r = this.parseConcat();
      return { k: 'bin', op: c, l, r };
    }
    if (two === '!~' || c === '~') {
      const neg = two === '!~';
      this.i += neg ? 2 : 1;
      const rhs = this.parseConcat();
      if (rhs.k !== 'matchre' || rhs.lhs !== null) {
        throw new FauxnixParseError('fauxnix: awk dynamic regex is not supported yet');
      }
      return { k: 'matchre', re: rhs.re, neg, lhs: l };
    }
    return l;
  }

  private parseConcat(): AExpr {
    let l = this.parseAdd();
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (
        c !== undefined &&
        (c === '"' || c === '(' || c === '$' || /[0-9]/.test(c) || /[A-Za-z_]/.test(c))
      ) {
        const r = this.parseAdd();
        l = { k: 'bin', op: 'concat', l, r };
      } else {
        return l;
      }
    }
  }

  private parseAdd(): AExpr {
    let l = this.parseMul();
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === '+' || c === '-') {
        this.i++;
        const r = this.parseMul();
        l = { k: 'bin', op: c, l, r };
      } else {
        return l;
      }
    }
  }

  private parseMul(): AExpr {
    let l = this.parseUnary();
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      if (c === '*' || c === '/' || c === '%') {
        this.i++;
        const r = this.parseUnary();
        l = { k: 'bin', op: c, l, r };
      } else {
        return l;
      }
    }
  }

  private parseUnary(): AExpr {
    this.ws();
    const c = this.s[this.i];
    if (c === '!' && this.s[this.i + 1] !== '=') {
      this.i++;
      return { k: 'un', op: '!', e: this.parseUnary() };
    }
    if (c === '-') {
      this.i++;
      return { k: 'un', op: '-', e: this.parseUnary() };
    }
    if (c === '+') {
      this.i++;
      return { k: 'un', op: '+', e: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AExpr {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) {
      throw new FauxnixParseError('fauxnix: awk unexpected end of expression');
    }
    if (c === '(') {
      this.i++;
      const e = this.parseExpr();
      this.ws();
      if (this.s[this.i] !== ')') {
        throw new FauxnixParseError('fauxnix: awk missing ) in expression');
      }
      this.i++;
      return e;
    }
    if (c === '$') {
      this.i++;
      const n = this.s[this.i];
      if (/[0-9]/.test(n)) {
        const m = this.s.slice(this.i).match(/^\d+/)!;
        this.i += m[0].length;
        return { k: 'field', idx: parseInt(m[0], 10) };
      }
      if (this.s.startsWith('NF', this.i)) {
        this.i += 2;
        return { k: 'fieldnf' };
      }
      throw new FauxnixParseError('fauxnix: awk $(...) fields are not supported yet');
    }
    if (c === '"') {
      let out = '';
      this.i++;
      while (this.i < this.s.length && this.s[this.i] !== '"') {
        if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) {
          const n = this.s[this.i + 1];
          if (n === 'n') out += '\n';
          else if (n === 't') out += '\t';
          else if (n === '\\') out += '\\';
          else if (n === '"') out += '"';
          else out += n;
          this.i += 2;
          continue;
        }
        out += this.s[this.i];
        this.i++;
      }
      if (this.i >= this.s.length) {
        throw new FauxnixParseError('fauxnix: awk unterminated string literal');
      }
      this.i++;
      return { k: 'str', v: out };
    }
    if (c === '/') {
      let re = '';
      this.i++;
      while (this.i < this.s.length && this.s[this.i] !== '/') {
        if (this.s[this.i] === '\\' && this.i + 1 < this.s.length) {
          if (this.s[this.i + 1] === '/') re += '/';
          else re += this.s[this.i] + this.s[this.i + 1];
          this.i += 2;
          continue;
        }
        re += this.s[this.i];
        this.i++;
      }
      if (this.i >= this.s.length) {
        throw new FauxnixParseError('fauxnix: awk unterminated regex literal');
      }
      this.i++;
      this.regexes.add(re);
      return { k: 'matchre', re, neg: false, lhs: null };
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.s[this.i + 1] ?? ''))) {
      const m = this.s.slice(this.i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/)!;
      this.i += m[0].length;
      return { k: 'num', v: parseFloat(m[0]) };
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = this.s.slice(this.i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      const name = m[0];
      this.i += m[0].length;
      if (name === 'NR') return { k: 'nr' };
      if (name === 'NF') return { k: 'nf' };
      if (name === 'length') {
        this.ws();
        if (this.s[this.i] === '(') {
          this.i++;
          this.ws();
          if (this.s[this.i] === ')') {
            this.i++;
            return { k: 'call', fn: 'length', args: [] };
          }
          const a = this.parseExpr();
          this.ws();
          if (this.s[this.i] !== ')') {
            throw new FauxnixParseError('fauxnix: awk missing ) after length(...)');
          }
          this.i++;
          return { k: 'call', fn: 'length', args: [a] };
        }
        return { k: 'call', fn: 'length', args: [] };
      }
      if (name === 'substr' || name === 'tolower' || name === 'toupper') {
        this.ws();
        if (this.s[this.i] !== '(') {
          throw new FauxnixParseError('fauxnix: awk ' + name + ' requires (...)');
        }
        this.i++;
        const args: AExpr[] = [];
        this.ws();
        if (this.s[this.i] !== ')') {
          args.push(this.parseExpr());
          this.ws();
          while (this.s[this.i] === ',') {
            this.i++;
            args.push(this.parseExpr());
            this.ws();
          }
        }
        if (this.s[this.i] !== ')') {
          throw new FauxnixParseError('fauxnix: awk missing ) after ' + name + '(...)');
        }
        this.i++;
        const want = name === 'substr' ? 3 : 1;
        if (args.length > want) {
          throw new FauxnixParseError('fauxnix: awk too many arguments to ' + name);
        }
        return { k: 'call', fn: name, args };
      }
      if (AWK_UNSUPPORTED_FNS.includes(name)) {
        throw new FauxnixParseError('fauxnix: awk ' + name + ' is not supported yet');
      }
      this.vars.add(name);
      return { k: 'var', name };
    }
    throw new FauxnixParseError("fauxnix: awk unexpected character '" + c + "' in expression");
  }
}

interface GExpr {
  ps: string;
  bool: boolean;
}

interface AwkFmtKind {
  conv: string;
  align: string;
  spec: string;
}

function awkFmtToPs(fmt: string): { ps: string; kinds: AwkFmtKind[] } {
  const chunks: string[] = [];
  const kinds: AwkFmtKind[] = [];
  let lit = '';
  const flushLit = () => {
    if (lit !== '') {
      const flat = psStrFlat(lit.replace(/\{/g, '{{').replace(/\}/g, '}}'));
      chunks.push(flat === "''" ? flat : flat);
      lit = '';
    }
  };
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === '%') {
      // %[-][width][.prec]conv — conv in s c d f
      const m = fmt.slice(i).match(/^%([-+0 ]*)(\d+)?(?:\.(\d+))?([sdfc])/);
      if (m) {
        const flags = m[1];
        const width = m[2];
        const prec = m[3];
        const conv = m[4];
        flushLit();
        const idx = kinds.length;
        let spec = '';
        if (conv === 'f') {
          spec = 'F' + (prec === undefined ? '6' : prec);
        } else if (conv === 'd' && prec !== undefined) {
          spec = 'D' + prec; // zero-pad, close to awk %.Nd
        }
        const align =
          width === undefined ? '' : ',' + (flags.includes('-') ? '-' : '') + width;
        chunks.push("'{" + idx + align + (spec === '' ? '' : ':' + spec) + "}'");
        kinds.push({ conv, align, spec });
        i += m[0].length;
        continue;
      }
      const n = fmt[i + 1];
      if (n === '%') {
        lit += '%';
        i += 2;
        continue;
      }
      if (n === undefined) break;
      throw new FauxnixParseError('fauxnix: awk printf %' + n + ' is not supported yet');
    }
    if (c === '\\' && i + 1 < fmt.length) {
      const n = fmt[i + 1];
      const code = n === 'n' ? 10 : n === 't' ? 9 : n === '\\' ? 92 : n === 'r' ? 13 : null;
      if (code === null) {
        lit += n;
      } else {
        flushLit();
        chunks.push('[string][char]' + code);
      }
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\t' || c === '\r') {
      flushLit();
      chunks.push('[string][char]' + (c === '\n' ? 10 : c === '\t' ? 9 : 13));
      i++;
      continue;
    }
    lit += c;
    i++;
  }
  flushLit();
  const ps = chunks.length === 0 ? "''" : '(' + chunks.join(' + ') + ')';
  return { ps, kinds };
}

const awk: Handler = (args) => {
  const { values, operandWords } = parseWords(args, ['F', 'v']);

  // -v may repeat; collect all of them
  const vvars: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i++) {
    const t = wordToString(args[i]);
    if (t === '-v' && i + 1 < args.length) {
      const nv = wordToString(args[i + 1]);
      const eq = nv.indexOf('=');
      if (eq > 0) vvars.push([nv.slice(0, eq), nv.slice(eq + 1)]);
      i++;
    } else if (t.startsWith('-v') && t.length > 2) {
      const nv = t.slice(2);
      const eq = nv.indexOf('=');
      if (eq > 0) vvars.push([nv.slice(0, eq), nv.slice(eq + 1)]);
    }
  }

  if (operandWords.length === 0) {
    return (
      "[Console]::Error.WriteLine('usage: awk [POSIX or GNU style options] -f progfile [--] file ...'); $script:fx_exit = 2"
    );
  }
  const progWord = operandWords[0];
  const progLit = literalOfWord(progWord);
  if (progLit === null) {
    throw new FauxnixParseError('fauxnix: awk program must be a literal string');
  }
  const fileWords = operandWords.slice(1);
  const prog = new AwkParser(progLit).parse();

  // FS mode
  const fsRaw = values.get('-F') ?? ' ';
  let fsMode: 'ws' | 'char' | 'regex' = 'ws';
  let fsChar = 32;
  let fsRe = '';
  {
    let fs = fsRaw;
    if (fs === '\\t') fs = '\t';
    else if (fs === '\\n') fs = '\n';
    if (fs === ' ') fsMode = 'ws';
    else if (fs.length === 1) {
      fsMode = 'char';
      fsChar = fs.charCodeAt(0);
    } else {
      fsMode = 'regex';
      fsRe = fs;
    }
  }

  const regexVar = new Map<string, string>();
  const hoistedRegex: string[] = [];
  prog.regexes.forEach((re) => {
    const name = '$fx_ar' + regexVar.size;
    regexVar.set(re, name);
    hoistedRegex.push(
      name + ' = New-Object System.Text.RegularExpressions.Regex(' + psStr(ereToDotNet(re)) + ')',
    );
  });

  const gen = (e: AExpr): GExpr => {
    switch (e.k) {
      case 'num':
        return { ps: '([double]' + e.v + ')', bool: false };
      case 'str':
        return { ps: psStrFlat(e.v), bool: false };
      case 'var':
        return { ps: '$fxv_' + e.name, bool: false };
      case 'nr':
        return { ps: '$fx_nr', bool: false };
      case 'nf':
        return { ps: '$fx_nf', bool: false };
      case 'field':
        return e.idx === 0
          ? { ps: '$fx_line', bool: false }
          : { ps: '(fx-fld ' + e.idx + ')', bool: false };
      case 'fieldnf':
        return { ps: '(fx-fld $fx_nf)', bool: false };
      case 'matchre': {
        const v = regexVar.get(e.re)!;
        const target = e.lhs === null ? '$fx_line' : '(fx-str ' + gen(e.lhs).ps + ')';
        const test = v + '.IsMatch(' + target + ')';
        return { ps: e.neg ? '(-not (' + test + '))' : '(' + test + ')', bool: true };
      }
      case 'un': {
        const g = gen(e.e);
        if (e.op === '!') {
          return g.bool
            ? { ps: '(-not ' + g.ps + ')', bool: true }
            : { ps: '(-not (fx-true ' + g.ps + '))', bool: true };
        }
        if (e.op === '-') return { ps: '(-(fx-num ' + g.ps + '))', bool: false };
        return { ps: '(fx-num ' + g.ps + ')', bool: false };
      }
      case 'call': {
        if (e.fn === 'length') {
          const t = e.args.length === 0 ? '$fx_line' : '(fx-str ' + gen(e.args[0]).ps + ')';
          return { ps: '(' + t + ').Length', bool: false };
        }
        if (e.fn === 'tolower' || e.fn === 'toupper') {
          const t = '(fx-str ' + gen(e.args[0]).ps + ')';
          const m = e.fn === 'tolower' ? 'ToLower' : 'ToUpper';
          return { ps: '(' + t + ').' + m + '()', bool: false };
        }
        const s = '(fx-str ' + gen(e.args[0]).ps + ')';
        const a = e.args.length > 1 ? '(fx-num ' + gen(e.args[1]).ps + ')' : '([double]1)';
        const b =
          e.args.length > 2 ? '(fx-num ' + gen(e.args[2]).ps + ')' : '([double]9999999)';
        return { ps: '(fx-substr ' + s + ' ' + a + ' ' + b + ')', bool: false };
      }
      case 'bin': {
        if (e.op === 'concat') {
          return {
            ps: '((fx-str ' + gen(e.l).ps + ') + (fx-str ' + gen(e.r).ps + '))',
            bool: false,
          };
        }
        if (['<', '<=', '>', '>=', '==', '!='].includes(e.op)) {
          const map: Record<string, string> = {
            '<': 'lt',
            '<=': 'le',
            '>': 'gt',
            '>=': 'ge',
            '==': 'eq',
            '!=': 'ne',
          };
          return {
            ps: '(fx-cmp ' + gen(e.l).ps + ' ' + gen(e.r).ps + " '" + map[e.op] + "')",
            bool: true,
          };
        }
        if (e.op === '&&' || e.op === '||') {
          const gl = gen(e.l);
          const gr = gen(e.r);
          const lt = gl.bool ? gl.ps : '(fx-true ' + gl.ps + ')';
          const rt = gr.bool ? gr.ps : '(fx-true ' + gr.ps + ')';
          return {
            ps: '(' + lt + ' ' + (e.op === '&&' ? '-and' : '-or') + ' ' + rt + ')',
            bool: true,
          };
        }
        return {
          ps: '((fx-num ' + gen(e.l).ps + ') ' + e.op + ' (fx-num ' + gen(e.r).ps + '))',
          bool: false,
        };
      }
    }
  };

  const truth = (e: AExpr): string => {
    const g = gen(e);
    return g.bool ? g.ps : '(fx-true ' + g.ps + ')';
  };

  const genStmts = (stmts: AStmt[], inLoop: boolean): string[] => {
    const out: string[] = [];
    for (const st of stmts) {
      if (st.k === 'print') {
        if (st.args.length === 0) {
          out.push('$fx_line');
        } else {
          out.push('(' + st.args.map((a) => '(fx-str ' + gen(a).ps + ')').join(" + ' ' + ") + ')');
        }
      } else if (st.k === 'printf') {
        const f = awkFmtToPs(st.fmt);
        const argExprs = f.kinds.map((kind, idx) => {
          const arg = st.args[idx];
          const raw = gen(arg ?? { k: 'num', v: 0 }).ps;
          if (kind.conv === 'd') return '([string][math]::Truncate((fx-num ' + raw + ')))';
          if (kind.conv === 'f') return '(fx-num ' + raw + ')';
          if (kind.conv === 'c') {
            // awk: numeric arg → char code, string arg → first char
            if (arg !== undefined && arg.k === 'num') return '[string][char]' + Math.trunc(arg.v);
            return '(fx-firstchar ' + raw + ')';
          }
          return '(fx-str ' + raw + ')';
        });
        const argList = argExprs.length ? ' ' + argExprs.join(', ') : '';
        out.push('(' + f.ps + ' -f' + argList + ')');
      } else if (st.k === 'assign') {
        const rhs = gen(st.e).ps;
        if (st.op === '=') {
          out.push('$fxv_' + st.name + ' = ' + rhs);
        } else {
          const arith = st.op.slice(0, 1);
          out.push(
            '$fxv_' + st.name + ' = (fx-num $fxv_' + st.name + ') ' + arith + ' (fx-num ' + rhs + ')',
          );
        }
      } else {
        const code = st.code ? '([int](fx-num ' + gen(st.code).ps + '))' : '0';
        out.push('$script:fx_exit = ' + code);
        out.push('$fx_exitq = $true');
        if (inLoop) out.push('break');
      }
    }
    return out;
  };

  const lines: string[] = [PS_READTEXT_FN, PS_SPLITLINES_FN];
  if (fileWords.length > 0) lines.push(PS_GLOB_FN);

  lines.push(
    'function fx-num($v) {',
    '  if ($v -is [double]) { return $v }',
    '  if ($v -is [int] -or $v -is [long]) { return [double]$v }',
    '  if ($null -eq $v) { return [double]0 }',
    '  $s = [string]$v',
    "  if ($s -match '^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$') { return [double]$s }",
    '  return [double]0',
    '}',
    'function fx-fnum($v) {',
    '  if ($v -eq [math]::Floor($v) -and [math]::Abs($v) -lt 1e15) { return ([string][long]$v) }',
    "  return ('{0:G6}' -f $v)",
    '}',
    'function fx-str($v) {',
    '  if ($v -is [double]) { return (fx-fnum $v) }',
    "  if ($null -eq $v) { return '' }",
    '  return [string]$v',
    '}',
    'function fx-true($v) {',
    '  if ($v -is [double] -or $v -is [int]) { return ($v -ne 0) }',
    '  if ($null -eq $v) { return $false }',
    '  $s = [string]$v',
    "  if ($s -eq '' -or $s -eq '0') { return $false }",
    '  return $true',
    '}',
    'function fx-cmp($a, $b, $op) {',
    '  $ad = $null',
    '  $bd = $null',
    '  if ($a -is [double] -or $a -is [int]) { $ad = [double]$a }',
    "  elseif ($a -match '^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$') { $ad = [double]$a }",
    '  if ($b -is [double] -or $b -is [int]) { $bd = [double]$b }',
    "  elseif ($b -match '^[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?$') { $bd = [double]$b }",
    '  $r = 0',
    '  if ($null -ne $ad -and $null -ne $bd) {',
    '    if ($ad -lt $bd) { $r = -1 } elseif ($ad -gt $bd) { $r = 1 }',
    '  } else {',
    '    $r = [string]::CompareOrdinal((fx-str $a), (fx-str $b))',
    '  }',
    "  if ($op -eq 'lt') { return ($r -lt 0) }",
    "  if ($op -eq 'le') { return ($r -le 0) }",
    "  if ($op -eq 'gt') { return ($r -gt 0) }",
    "  if ($op -eq 'ge') { return ($r -ge 0) }",
    "  if ($op -eq 'eq') { return ($r -eq 0) }",
    '  return ($r -ne 0)',
    '}',
    'function fx-fld($n) {',
    '  if ($n -ge 1 -and $n -le $fx_flds.Count) { return [string]$fx_flds[$n - 1] }',
    "  return ''",
    '}',
    'function fx-substr($s, $a, $b) {',
    '  $t = [string]$s',
    '  $st = [int]$a - 1',
    '  if ($st -lt 0) { $b = $b + $st; $st = 0 }',
    "  if ($b -lt 1 -or $st -ge $t.Length) { return '' }",
    '  $len = [math]::Min([int]$b, $t.Length - $st)',
    '  return $t.Substring($st, $len)',
    '}',
    'function fx-firstchar($v) {',
    '  $t = [string]$v',
    '  if ($t.Length -ge 1) { return ([string]$t[0]) }',
    "  return ''",
    '}',
  );

  lines.push(...hoistedRegex);

  for (const v of prog.vars) lines.push('$fxv_' + v + ' = $null');
  for (const [n, v] of vvars) {
    lines.push(
      '$fxv_' + n + ' = ' + (/^-?(\d+\.?\d*|\.\d+)$/.test(v) ? '[double]' + v : psStr(v)),
    );
  }

  lines.push('$fx_exitq = $false');
  if (prog.begin.length > 0) lines.push(...genStmts(prog.begin, false));

  lines.push('$fx_nr = 0');
  if (fileWords.length > 0) {
    lines.push(
      ...psCollectSources(
        psArray(fileWords),
        (v) =>
          "[Console]::Error.WriteLine('awk: fatal: cannot open file ' + [string][char]96 + " +
          v +
          " + [string][char]39 + ' for reading (No such file or directory)')",
        true,
      ),
    );
    lines.push('$fx_lines = @()');
    lines.push('foreach ($fx_f in $fx_srcs) { $fx_lines += fx-splitlines (fx-read $fx_f) }');
  } else {
    lines.push('$fx_err = $false');
    lines.push(STDIN_LINES);
    lines.push('$fx_lines = $fx_in');
  }

  const mainLoop: string[] = [];
  if (fsMode === 'ws') {
    mainLoop.push("if ($fx_line -eq '') { $fx_flds = @(); $fx_nf = 0 }");
    mainLoop.push('else {');
    mainLoop.push("  $fx_t = $fx_line.Trim(' ', [char]9)");
    mainLoop.push("  if ($fx_t -eq '') { $fx_flds = @(); $fx_nf = 0 }");
    mainLoop.push("  else { $fx_flds = @($fx_t -split '[ \\t]+'); $fx_nf = $fx_flds.Count }");
    mainLoop.push('}');
  } else if (fsMode === 'char') {
    mainLoop.push("if ($fx_line -eq '') { $fx_flds = @(); $fx_nf = 0 }");
    mainLoop.push(
      'else { $fx_flds = @($fx_line.Split([char]' + fsChar + ')); $fx_nf = $fx_flds.Count }',
    );
  } else {
    mainLoop.push("if ($fx_line -eq '') { $fx_flds = @(); $fx_nf = 0 }");
    mainLoop.push(
      'else { $fx_flds = @($fx_line -split ' + psStr(fsRe) + '); $fx_nf = $fx_flds.Count }',
    );
  }
  for (const item of prog.items) {
    const stmts = genStmts(item.act ?? [{ k: 'print', args: [] }], true);
    if (item.pat === null) {
      for (const st of stmts) mainLoop.push(st);
    } else {
      mainLoop.push('if (' + truth(item.pat) + ') {');
      for (const st of stmts) mainLoop.push('  ' + st);
      mainLoop.push('}');
    }
  }

  lines.push('if (-not $fx_exitq) {');
  lines.push('foreach ($fx_line in $fx_lines) {');
  lines.push('  $fx_nr++');
  for (const l of mainLoop) lines.push('  ' + l);
  lines.push('}');
  lines.push('}');

  if (prog.end.length > 0) lines.push(...genStmts(prog.end, false));

  lines.push('if ($fx_err) { $script:fx_exit = 2 }');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* sort                                                                */
/* ------------------------------------------------------------------ */

interface SortKeySpec {
  from: number;
  to: number;
  n: boolean;
  r: boolean;
  b: boolean;
  f: boolean;
}

function parseSortKeySpec(spec: string, g: { n: boolean; b: boolean; f: boolean }): SortKeySpec {
  const parts = spec.split(',');
  if (parts.length > 2) {
    throw new FauxnixParseError('fauxnix: sort -k ' + spec + ' is not supported yet');
  }
  const parsePart = (p: string): { f: number; mods: string } => {
    const m = p.match(/^(\d+)(?:\.(\d+))?([nrbf]*)$/);
    if (!m) throw new FauxnixParseError('fauxnix: sort -k ' + spec + ' is not supported yet');
    if (m[2] !== undefined) {
      throw new FauxnixParseError('fauxnix: sort -k character positions are not supported yet');
    }
    return { f: parseInt(m[1], 10), mods: m[3] };
  };
  const a = parsePart(parts[0]);
  const bb = parts.length === 2 ? parsePart(parts[1]) : { f: 2147483647, mods: '' };
  if (parts.length === 2 && bb.f < a.f) {
    throw new FauxnixParseError('fauxnix: sort -k ' + spec + ' is not supported yet');
  }
  return {
    from: a.f,
    to: bb.f,
    n: a.mods.includes('n') || bb.mods.includes('n') || g.n,
    r: a.mods.includes('r') || bb.mods.includes('r'),
    b: a.mods.includes('b') || bb.mods.includes('b') || g.b,
    f: a.mods.includes('f') || bb.mods.includes('f') || g.f,
  };
}

const sort: Handler = (args) => {
  const { flags, longs, values, operandWords } = parseWords(args, ['t', 'k'], []);
  const globalR = flags.has('r') || longs.has('--reverse');
  const globalN = flags.has('n') || longs.has('--numeric-sort');
  const uniqMode = flags.has('u') || longs.has('--unique');
  const globalF = flags.has('f') || longs.has('--ignore-case');
  const globalB = flags.has('b') || longs.has('--ignore-leading-blanks');

  let sepChar = -1; // -1 = whitespace mode
  const t = values.get('-t');
  if (t !== undefined) {
    let tv = t;
    if (tv === '\\t') tv = '\t';
    if (tv.length !== 1) {
      throw new FauxnixParseError('fauxnix: sort multi-character tab is not supported yet');
    }
    sepChar = tv.charCodeAt(0);
  }

  const specs: SortKeySpec[] = [];
  for (const k of collectShortValues(args, 'k')) {
    specs.push(parseSortKeySpec(k, { n: globalN, b: globalB, f: globalF }));
  }

  const lines: string[] = [PS_READTEXT_FN, PS_SPLITLINES_FN, PS_GLOB_FN];
  lines.push(
    ...psCollectSources(
      psArray(operandWords),
      (v) =>
        "[Console]::Error.WriteLine('sort: cannot read: ' + " + v + " + ': No such file or directory')",
      false,
    ),
  );
  if (operandWords.length > 0) {
    lines.push('$fx_lines = @()');
    lines.push('foreach ($fx_f in $fx_srcs) { $fx_lines += fx-splitlines (fx-read $fx_f) }');
  } else {
    lines.push(STDIN_LINES);
    lines.push('$fx_lines = $fx_in');
  }

  const fastPath = specs.length === 0 && !globalN && !globalB;
  if (fastPath) {
    const comparer = globalF ? 'OrdinalIgnoreCase' : 'Ordinal';
    lines.push('$fx_arr = [string[]]$fx_lines');
    lines.push('[array]::Sort($fx_arr, [System.StringComparer]::' + comparer + ')');
    if (globalR) lines.push('[array]::Reverse($fx_arr)');
    if (uniqMode) {
      lines.push('$fx_res = New-Object System.Collections.Generic.List[string]');
      lines.push('if ($fx_arr.Count -gt 0) { $fx_res.Add($fx_arr[0]) }');
      lines.push('for ($fx_i = 1; $fx_i -lt $fx_arr.Count; $fx_i++) {');
      lines.push(
        '  if (-not [System.StringComparer]::' +
          comparer +
          '.Equals($fx_arr[$fx_i - 1], $fx_arr[$fx_i])) { $fx_res.Add($fx_arr[$fx_i]) }',
      );
      lines.push('}');
      lines.push('$fx_arr = $fx_res.ToArray()');
    }
    lines.push('foreach ($fx_l in $fx_arr) { $fx_l }');
  } else {
    const sepSplit =
      sepChar >= 0
        ? '$fs = $line.Split([char]' + sepChar + ')'
        : "$t = $line.Trim(' ', [char]9); if ($t -eq '') { $fs = @() } else { $fs = @($t -split '[ \\t]+') }";
    const joiner = sepChar >= 0 ? '[string][char]' + sepChar : "' '";
    lines.push(
      'function fx-keyof($line, $from, $to) {',
      '  ' + sepSplit,
      "  if ($fs.Count -lt $from) { return '' }",
      '  $e2 = $to; if ($e2 -gt $fs.Count) { $e2 = $fs.Count }',
      '  return ($fs[($from - 1)..($e2 - 1)] -join ' + joiner + ')',
      '}',
      'function fx-numkey($s) {',
      "  if ($s -match '^[ \\t]*[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?') { return [double]($Matches[0].Trim()) }",
      '  return [double]0',
      '}',
    );

    const cmpBody = (lastResort: boolean): string[] => {
      const body: string[] = [];
      const allSpecs: SortKeySpec[] =
        specs.length > 0
          ? specs
          : [{ from: 1, to: 2147483647, n: globalN, r: false, b: globalB, f: globalF }];
      for (const spec of allSpecs) {
        const flip = spec.r !== globalR; // XOR
        let ka = '(fx-keyof $x ' + spec.from + ' ' + spec.to + ')';
        let kb = '(fx-keyof $y ' + spec.from + ' ' + spec.to + ')';
        if (spec.b) {
          const trimChars = sepChar >= 0 ? '[char]' + sepChar : "' ', [char]9";
          ka = '(' + ka + ').TrimStart(' + trimChars + ')';
          kb = '(' + kb + ').TrimStart(' + trimChars + ')';
        }
        if (spec.n) {
          ka = '(fx-numkey ' + ka + ')';
          kb = '(fx-numkey ' + kb + ')';
          body.push('  $ka = ' + ka);
          body.push('  $kb = ' + kb);
          if (flip) {
            body.push('  if ($ka -lt $kb) { return 1 }');
            body.push('  if ($ka -gt $kb) { return -1 }');
          } else {
            body.push('  if ($ka -lt $kb) { return -1 }');
            body.push('  if ($ka -gt $kb) { return 1 }');
          }
        } else {
          if (spec.f) {
            ka = '(' + ka + ').ToLower()';
            kb = '(' + kb + ').ToLower()';
          }
          body.push('  $ka = ' + ka);
          body.push('  $kb = ' + kb);
          body.push('  $r = [string]::CompareOrdinal($ka, $kb)');
          if (flip) body.push('  if ($r -ne 0) { return (-$r) }');
          else body.push('  if ($r -ne 0) { return $r }');
        }
      }
      body.push(
        lastResort
          ? globalR
            ? '  return (-[string]::CompareOrdinal($x, $y))'
            : '  return [string]::CompareOrdinal($x, $y)'
          : '  return 0',
      );
      return body;
    };

    lines.push('function fx-cmp2($x, $y) {', ...cmpBody(true), '}');
    if (uniqMode) {
      lines.push('function fx-ucmp($x, $y) {', ...cmpBody(false), '}');
      lines.push(
        'function fx-msortu($a) {',
        '  if ($a.Count -le 1) { return @($a) }',
        '  $mid = [int]($a.Count / 2)',
        '  $l = @(fx-msortu @($a[0..($mid - 1)]))',
        '  $r = @(fx-msortu @($a[$mid..($a.Count - 1)]))',
        '  $o = New-Object System.Collections.Generic.List[string]',
        '  $i = 0; $j = 0',
        '  while ($i -lt $l.Count -and $j -lt $r.Count) {',
        '    if ((fx-ucmp $l[$i] $r[$j]) -le 0) { [void]$o.Add($l[$i]); $i++ } else { [void]$o.Add($r[$j]); $j++ }',
        '  }',
        '  while ($i -lt $l.Count) { [void]$o.Add($l[$i]); $i++ }',
        '  while ($j -lt $r.Count) { [void]$o.Add($r[$j]); $j++ }',
        '  return $o.ToArray()',
        '}',
      );
    }

    lines.push(
      'function fx-msort($a) {',
      '  if ($a.Count -le 1) { return @($a) }',
      '  $mid = [int]($a.Count / 2)',
      '  $l = @(fx-msort @($a[0..($mid - 1)]))',
      '  $r = @(fx-msort @($a[$mid..($a.Count - 1)]))',
      '  $o = New-Object System.Collections.Generic.List[string]',
      '  $i = 0; $j = 0',
      '  while ($i -lt $l.Count -and $j -lt $r.Count) {',
      '    if ((fx-cmp2 $l[$i] $r[$j]) -le 0) { [void]$o.Add($l[$i]); $i++ } else { [void]$o.Add($r[$j]); $j++ }',
      '  }',
      '  while ($i -lt $l.Count) { [void]$o.Add($l[$i]); $i++ }',
      '  while ($j -lt $r.Count) { [void]$o.Add($r[$j]); $j++ }',
      '  return $o.ToArray()',
      '}',
      '$fx_arr = @(fx-msort @($fx_lines))',
    );
    if (uniqMode) {
      // GNU: -u disables the last-resort comparison — sort by keys only, stable
      lines.push('$fx_arr2 = @()');
      lines.push('foreach ($fx_l in $fx_lines) { $fx_arr2 += [string]$fx_l }');
      lines.push('$fx_arr = @(fx-msortu @($fx_arr2))');
      lines.push('$fx_res = New-Object System.Collections.Generic.List[string]');
      lines.push('if ($fx_arr.Count -gt 0) { $fx_res.Add($fx_arr[0]) }');
      lines.push('for ($fx_i = 1; $fx_i -lt $fx_arr.Count; $fx_i++) {');
      lines.push(
        '  if ((fx-ucmp $fx_arr[$fx_i - 1] $fx_arr[$fx_i]) -ne 0) { $fx_res.Add($fx_arr[$fx_i]) }',
      );
      lines.push('}');
      lines.push('$fx_arr = $fx_res.ToArray()');
    }
    lines.push('foreach ($fx_l in $fx_arr) { $fx_l }');
  }

  lines.push('$script:fx_exit = 0');
  lines.push('if ($fx_err) { $script:fx_exit = 2 }');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* uniq                                                                */
/* ------------------------------------------------------------------ */

const uniq: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const count = flags.has('c');
  const dupOnly = flags.has('d');
  const uniqOnly = flags.has('u');
  const ignoreCase = flags.has('i');
  const inFile = operandWords.length > 0 ? operandWords[0] : null;
  const outFile = operandWords.length > 1 ? operandWords[1] : null;

  const lines: string[] = [PS_READTEXT_FN, PS_SPLITLINES_FN];
  if (inFile !== null) {
    lines.push(PS_GLOB_FN);
    lines.push(
      ...psCollectSources(
        '@(' + operandExpr(inFile) + ')',
        (v) => "[Console]::Error.WriteLine('uniq: ' + " + v + " + ': No such file or directory')",
        false,
      ),
    );
    lines.push('if ($fx_srcs.Count -gt 0) { $fx_lines = @(fx-splitlines (fx-read $fx_srcs[0])) }');
    lines.push('else { $fx_lines = @() }');
  } else {
    lines.push('$fx_err = $false');
    lines.push(STDIN_LINES);
    lines.push('$fx_lines = $fx_in');
  }

  lines.push('function fx-ueq($a, $b) {');
  if (ignoreCase) {
    lines.push('  return (([string]$a).ToLower() -ceq ([string]$b).ToLower())');
  } else {
    lines.push('  return (([string]$a) -ceq ([string]$b))');
  }
  lines.push('}');
  lines.push('function fx-uemit($l, $c) {');
  if (dupOnly) {
    lines.push('  if ($c -gt 1) { $fx_res.Add($l) }');
  } else if (uniqOnly) {
    lines.push('  if ($c -eq 1) { $fx_res.Add($l) }');
  } else if (count) {
    lines.push("  $fx_res.Add(('{0,7} {1}' -f $c, $l))");
  } else {
    lines.push('  $fx_res.Add($l)');
  }
  lines.push('}');
  lines.push('$fx_res = New-Object System.Collections.Generic.List[string]');
  lines.push('$fx_prev = $null');
  lines.push('$fx_cnt = 0');
  lines.push('foreach ($fx_l in $fx_lines) {');
  lines.push('  if ($null -eq $fx_prev) { $fx_prev = [string]$fx_l; $fx_cnt = 1; continue }');
  lines.push('  if (fx-ueq $fx_prev $fx_l) { $fx_cnt++ }');
  lines.push('  else { fx-uemit $fx_prev $fx_cnt; $fx_prev = [string]$fx_l; $fx_cnt = 1 }');
  lines.push('}');
  lines.push('if ($null -ne $fx_prev) { fx-uemit $fx_prev $fx_cnt }');
  if (outFile !== null) {
    lines.push(
      '[IO.File]::WriteAllText(' +
        operandExpr(outFile) +
        ", ($fx_res -join [string][char]10) + [string][char]10, (New-Object System.Text.UTF8Encoding($false)))",
    );
  } else {
    lines.push('foreach ($fx_l in $fx_res) { $fx_l }');
  }
  lines.push('$script:fx_exit = 0');
  lines.push('if ($fx_err) { $script:fx_exit = 1 }');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* cut                                                                 */
/* ------------------------------------------------------------------ */

interface CutRange {
  from: number;
  to: number; // 2147483647 = open-ended
}

function parseCutList(list: string): CutRange[] {
  const ranges: CutRange[] = [];
  for (const part of list.split(',')) {
    const m = part.match(/^(\d+)(-(\d*)?)?$/);
    if (!m) throw new FauxnixParseError('fauxnix: cut invalid list "' + list + '"');
    const from = parseInt(m[1], 10);
    if (m[2] === undefined) ranges.push({ from, to: from });
    else if (m[2] === '-') ranges.push({ from, to: 2147483647 });
    else {
      const to = parseInt(m[3], 10);
      if (to < from) {
        throw new FauxnixParseError('fauxnix: cut invalid range in list "' + list + '"');
      }
      ranges.push({ from, to });
    }
  }
  return ranges;
}

const cut: Handler = (args) => {
  const { flags, longs, values, operandWords } = parseWords(args, ['d', 'f', 'c', 'b'], []);
  const complement = longs.has('--complement');
  const charsMode = flags.has('c') || flags.has('b');
  const fieldsMode = flags.has('f');
  const suppress = flags.has('s');

  if (charsMode && fieldsMode) {
    throw new FauxnixParseError('fauxnix: cut only one type of list may be specified');
  }
  if (!charsMode && !fieldsMode) {
    throw new FauxnixParseError(
      'fauxnix: cut you must specify a list of bytes, characters, or fields',
    );
  }
  const list = values.get('-c') ?? values.get('-b') ?? values.get('-f');
  if (list === undefined) throw new FauxnixParseError('fauxnix: cut requires a list');
  const ranges = parseCutList(list);

  let delimCode = 9; // tab
  const d = values.get('-d');
  if (d !== undefined) {
    let dv = d;
    if (dv === '\\t') dv = '\t';
    else if (dv === '\\n') dv = '\n';
    if (dv.length !== 1) {
      throw new FauxnixParseError('fauxnix: cut the delimiter must be a single character');
    }
    delimCode = dv.charCodeAt(0);
  }

  const inTest = ranges
    .map((r) => '($p -ge ' + r.from + ' -and $p -le ' + r.to + ')')
    .join(' -or ');
  const testExpr = complement ? '(-not (' + inTest + '))' : '(' + inTest + ')';

  const lines: string[] = [PS_READTEXT_FN, PS_SPLITLINES_FN, PS_GLOB_FN];
  lines.push(
    ...psCollectSources(
      psArray(operandWords),
      (v) => "[Console]::Error.WriteLine('cut: ' + " + v + " + ': No such file or directory')",
      false,
    ),
  );
  if (operandWords.length > 0) {
    lines.push('$fx_lines = @()');
    lines.push('foreach ($fx_f in $fx_srcs) { $fx_lines += fx-splitlines (fx-read $fx_f) }');
  } else {
    lines.push(STDIN_LINES);
    lines.push('$fx_lines = $fx_in');
  }

  if (charsMode) {
    lines.push('foreach ($fx_l in $fx_lines) {');
    lines.push('  $fx_cs = $fx_l.ToCharArray()');
    lines.push('  $fx_sb = New-Object System.Text.StringBuilder');
    lines.push('  for ($fx_k = 0; $fx_k -lt $fx_cs.Count; $fx_k++) {');
    lines.push('    $p = $fx_k + 1');
    lines.push('    if ' + testExpr + ' { [void]$fx_sb.Append($fx_cs[$fx_k]) }');
    lines.push('  }');
    lines.push('  $fx_sb.ToString()');
    lines.push('}');
  } else {
    lines.push('foreach ($fx_l in $fx_lines) {');
    lines.push('  if (-not $fx_l.Contains([string][char]' + delimCode + ')) {');
    if (!suppress) lines.push('    $fx_l');
    lines.push('  } else {');
    lines.push('    $fx_fs = $fx_l.Split([char]' + delimCode + ')');
    lines.push('    $fx_sel = @()');
    lines.push('    for ($p = 1; $p -le $fx_fs.Count; $p++) {');
    lines.push('      if ' + testExpr + ' { $fx_sel += $fx_fs[$p - 1] }');
    lines.push('    }');
    lines.push('    ($fx_sel -join [string][char]' + delimCode + ')');
    lines.push('  }');
    lines.push('}');
  }

  lines.push('$script:fx_exit = 0');
  lines.push('if ($fx_err) { $script:fx_exit = 1 }');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* tr                                                                  */
/* ------------------------------------------------------------------ */

function trClassCodes(name: string): number[] {
  const seq = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let c = a; c <= b; c++) out.push(c);
    return out;
  };
  switch (name) {
    case 'upper':
      return seq(65, 90);
    case 'lower':
      return seq(97, 122);
    case 'digit':
      return seq(48, 57);
    case 'alpha':
      return [...seq(65, 90), ...seq(97, 122)];
    case 'alnum':
      return [...seq(48, 57), ...seq(65, 90), ...seq(97, 122)];
    case 'space':
      return [32, 9, 10, 13, 12, 11];
    case 'blank':
      return [32, 9];
    case 'punct':
      return [...seq(33, 47), ...seq(58, 64), ...seq(91, 96), ...seq(123, 126)];
    case 'xdigit':
      return [...seq(48, 57), ...seq(65, 70), ...seq(97, 102)];
    case 'cntrl':
      return [...seq(0, 31), 127];
    case 'print':
      return seq(32, 126);
    case 'graph':
      return seq(33, 126);
    default:
      throw new FauxnixParseError("fauxnix: tr invalid character class '[:" + name + ":]'");
  }
}

function expandTrSet(set: string): number[] {
  const codes: number[] = [];
  let i = 0;
  while (i < set.length) {
    if (set.startsWith('[:', i)) {
      const end = set.indexOf(':]', i + 2);
      if (end < 0) throw new FauxnixParseError('fauxnix: tr unterminated character class');
      codes.push(...trClassCodes(set.slice(i + 2, end)));
      i = end + 2;
      continue;
    }
    if (set[i] === '\\' && i + 1 < set.length) {
      const c = set[i + 1];
      const m: Record<string, number> = {
        n: 10, t: 9, r: 13, f: 12, v: 11, '\\': 92, a: 7, b: 8,
      };
      codes.push(m[c] ?? c.charCodeAt(0));
      i += 2;
      continue;
    }
    if (i + 2 < set.length && set[i + 1] === '-') {
      const a = set.charCodeAt(i);
      const b = set.charCodeAt(i + 2);
      if (b < a) {
        throw new FauxnixParseError(
          "fauxnix: tr range-endpoints of '" + set.slice(i, i + 3) + "' are in reverse collating sequence order",
        );
      }
      for (let c = a; c <= b; c++) codes.push(c);
      i += 3;
      continue;
    }
    codes.push(set.charCodeAt(i));
    i++;
  }
  return codes;
}

const tr: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const del = flags.has('d');
  const squeeze = flags.has('s');
  if (operandWords.length === 0) {
    throw new FauxnixParseError('fauxnix: tr missing operand');
  }
  const set1 = expandTrSet(wordToString(operandWords[0]));
  let set2: number[] = [];
  if (operandWords.length > 1) {
    set2 = expandTrSet(wordToString(operandWords[1]));
  } else if (!del && !squeeze) {
    throw new FauxnixParseError(
      "fauxnix: tr missing operand after '" + wordToString(operandWords[0]) + "'",
    );
  }

  // squeeze applies to SET2 chars when translating or deleting, else SET1
  const sqSet = squeeze ? (operandWords.length > 1 ? set2 : set1) : [];
  const mapPairs: Array<[number, number]> = [];
  if (!del && set2.length > 0) {
    for (let i = 0; i < set1.length; i++) {
      mapPairs.push([set1[i], set2[Math.min(i, set2.length - 1)]]);
    }
  }

  const lines: string[] = [PS_SPLITLINES_FN];
  lines.push('$fx_dl = @{}');
  if (del) {
    lines.push('foreach ($c in [char[]](' + set1.join(', ') + ')) { $fx_dl[[int]$c] = $true }');
  }
  lines.push('$fx_map = @{}');
  for (const [a, b] of mapPairs) {
    lines.push('$fx_map[' + a + '] = [char]' + b);
  }
  lines.push('$fx_sq = @{}');
  if (squeeze) {
    lines.push('foreach ($c in [char[]](' + sqSet.join(', ') + ')) { $fx_sq[[int]$c] = $true }');
  }

  lines.push(STDIN_LINES);
  lines.push('foreach ($fx_line in $fx_in) {');
  lines.push('  $fx_sb = New-Object System.Text.StringBuilder');
  lines.push('  $fx_prev = -1');
  lines.push('  foreach ($fx_ch in $fx_line.ToCharArray()) {');
  lines.push('    $fx_o = [int]$fx_ch');
  if (del) lines.push('    if ($fx_dl.ContainsKey($fx_o)) { continue }');
  if (!del && set2.length > 0) {
    lines.push('    if ($fx_map.ContainsKey($fx_o)) { $fx_o = [int]$fx_map[$fx_o] }');
  }
  if (squeeze) {
    lines.push('    if ($fx_sq.ContainsKey($fx_o) -and $fx_o -eq $fx_prev) { continue }');
  }
  lines.push('    [void]$fx_sb.Append([char]$fx_o)');
  lines.push('    $fx_prev = $fx_o');
  lines.push('  }');
  lines.push('  $fx_sb.ToString()');
  lines.push('}');
  lines.push('$script:fx_exit = 0');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */

export const specs: CommandSpec[] = [
  {
    names: ['grep'],
    options: [
      { short: 'i', support: 'implemented' },
      { short: 'v', support: 'implemented' },
      { short: 'n', support: 'implemented' },
      { short: 'c', support: 'implemented' },
      { short: 'l', support: 'implemented' },
      { short: 'r', support: 'implemented' },
      { short: 'R', support: 'implemented' },
      { short: 'E', support: 'implemented' },
      { short: 'F', support: 'implemented' },
      { short: 'w', support: 'implemented' },
      { short: 'q', support: 'implemented' },
      { short: 'o', support: 'implemented' },
      { short: 'h', support: 'implemented' },
      { short: 'H', support: 'implemented' },
      { short: 'A', takesValue: true, support: 'implemented' },
      { short: 'B', takesValue: true, support: 'implemented' },
      { short: 'C', takesValue: true, support: 'implemented' },
      { short: 'm', long: '--max-count', takesValue: true, support: 'implemented' },
      { short: 'e', long: '--regexp', takesValue: true, support: 'implemented' },
      { long: '--include', takesValue: true, support: 'implemented' },
      { long: '--exclude', takesValue: true, support: 'implemented' },
      { long: '--exclude-dir', takesValue: true, support: 'implemented' },
    ],
    effects: ['read'],
    platform: 'windows-ps51',
    dispatch: 'translated',
    usageExit: 2,
    handler: grep,
  },
];

export const handlers: Record<string, Handler> = {
  egrep: (args, ctx) => grep([[{ kind: 'Text', text: '-E' }], ...args], ctx), // egrep = grep -E
  sed,
  awk,
  sort,
  uniq,
  cut,
  tr,
};
