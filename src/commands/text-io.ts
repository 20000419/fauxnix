import { Word, wordToString } from '../ast.js';
import { Handler, lookup, parseWords, psStr } from '../registry.js';
import { argListExpr, exprOfWord, operandExpr } from '../translator.js';

/* ------------------------------------------------------------------ */
/* Shared PS snippets (same shape as files.ts / text-filters.ts)       */
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
const STDIN_INLINES = [
  '$fx_in = New-Object System.Collections.Generic.List[string]',
  'foreach ($fx_it in @($input | ForEach-Object { [string]$_ })) { $fx_in.AddRange([string[]]@(fx-splitlines $fx_it)) }',
  '$fx_in = @($fx_in)',
].join('\n');

/** stdin → raw item array (the 1-item rule keeps printf's exact byte tail). */
const STDIN_ITEMS = '$fx_items = @($input | ForEach-Object { [string]$_ })';

/**
 * Reconstruct the upstream byte stream: one item = raw printf-style payload
 * (no synthetic trailing newline); several items = line-oriented upstream
 * (every line was newline-terminated).
 */
const PS_STDINRAW_FN = [
  'function fx-stdinraw($items) {',
  '  if ($items.Count -eq 1) { return [string]$items[0] }',
  '  if ($items.Count -gt 1) { return (($items -join [string][char]10) + [string][char]10) }',
  "  return ''",
  '}',
].join('\n');

/** Interpret \n \t \r \\ escapes (echo -e, printf %b). */
const PS_UNESQ_FN = [
  'function fx-unesq($s) {',
  '  $sb = New-Object System.Text.StringBuilder',
  '  $i = 0',
  '  while ($i -lt $s.Length) {',
  "    if ($s[$i] -eq '\\' -and $i + 1 -lt $s.Length) {",
  '      $c = $s[$i + 1]',
  "      if ($c -eq 'n') { [void]$sb.Append([char]10); $i += 2; continue }",
  "      if ($c -eq 't') { [void]$sb.Append([char]9); $i += 2; continue }",
  "      if ($c -eq 'r') { [void]$sb.Append([char]13); $i += 2; continue }",
  "      if ($c -eq '\\') { [void]$sb.Append('\\'); $i += 2; continue }",
  '    }',
  '    [void]$sb.Append($s[$i]); $i++',
  '  }',
  '  $sb.ToString()',
  '}',
].join('\n');

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
const PS_WRITE_FN = [
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
function fxTermLine(position: 'first' | 'middle' | 'last'): string {
  return (
    "$fx_term = (($MyInvocation.MyCommand.Name -eq '') -or " +
    (position === 'last' ? '$true' : '$false') +
    ')'
  );
}

/** PS boolean literal. */
function pb(v: boolean): string {
  return v ? '$true' : '$false';
}

/** GNU-style stderr line + exit flag, message given as a PS expression. */
function psErrExpr(msgExpr: string, code = '1'): string {
  return '[Console]::Error.WriteLine(' + msgExpr + '); $script:fx_exit = ' + code;
}

/** `cmd: <g>: message` as a PS expression (single-quoted concat style). */
function sErr(cmd: string, g: string, msg: string): string {
  return "'" + cmd + ": ' + " + g + " + ': " + msg + "'";
}

/** `cmd: lead '<g>': message` as a PS expression (double-quoted style). */
function qErr(cmd: string, g: string, msg: string, lead = 'cannot open '): string {
  return (
    '"' + cmd + ': ' + lead + "'" + '" + ' + g + ' + "' + "'" + ': ' + msg + '"'
  );
}

/** Operand Words → PS array expression of string exprs. */
function psArray(words: Word[], fn: (w: Word) => string = operandExpr): string {
  return argListExpr(words, fn);
}

/**
 * Collect file operands through fx-glob into `$fx_srcs`. A literal `-`
 * operand is passed through as a stdin marker. Missing files / directories
 * emit the given GNU-style error and continue processing (exit flag set).
 * When there are no operands and stdinDefault is set, `$fx_srcs` starts as
 * the stdin marker (GNU: read standard input).
 * Missing-file errors quote the operand as the user typed it ($fx_d) —
 * GNU prints the argument text, not a resolved Windows path.
 */
function psCollectFiles(
  operandWords: Word[],
  missErr: (g: string) => string,
  dirErr: ((g: string) => string) | null,
  stdinDefault = true,
): string[] {
  const out: string[] = [
    operandWords.length === 0 && stdinDefault ? "$fx_srcs = @('-')" : '$fx_srcs = @()',
    operandWords.length === 0 && stdinDefault ? '$fx_names = @($null)' : '$fx_names = @()',
  ];
  for (const w of operandWords) {
    if (wordToString(w) === '-') {
      out.push("$fx_srcs += '-'", "$fx_names += '-'");
      continue;
    }
    const lit = w.every((p) => p.kind === 'Text' || p.kind === 'SingleQuoted')
      ? w.map((p) => (p as { text: string }).text).join('')
      : null;
    out.push('foreach ($fx_d in ' + argListExpr([w], lit !== null ? operandExpr : exprOfWord) + ') {');
    out.push('foreach ($fx_g in (fx-glob $fx_d)) {');
    if (dirErr) {
      const dis = lit !== null && /[*?]/.test(lit) ? '$fx_g' : '$fx_d';
      out.push(
        '  if (Test-Path -LiteralPath $fx_g -PathType Container) { ' +
          psErrExpr(dirErr(dis)) +
          '; continue }',
      );
    }
    out.push(
      '  if (-not (Test-Path -LiteralPath $fx_g -PathType Leaf)) { ' +
        psErrExpr(missErr('$fx_d')) +
        '; continue }',
    );
    out.push('  $fx_srcs += $fx_g');
    // glob operands display their expansion; plain operands the text as typed
    out.push(
      '  ' +
        (lit !== null && /[*?]/.test(lit)
          ? '$fx_names += $fx_g'
          : '$fx_names += $fx_d'),
    );
    out.push('}', '}');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* echo                                                                */
/* ------------------------------------------------------------------ */

const echo: Handler = (args, ctx) => {
  // GNU echo: options only before the first operand
  let noNewline = false;
  let esc = false;
  let i = 0;
  while (i < args.length) {
    const t = wordToString(args[i]);
    if (t === '-n') noNewline = true;
    else if (t === '-e') esc = true;
    else if (t === '-E') esc = false;
    else if (/^-[neE]{2,}$/.test(t)) {
      if (t.includes('n')) noNewline = true;
      if (t.includes('e')) esc = true;
      if (t.includes('E')) esc = false;
    } else break;
    i++;
  }
  const rest = args.slice(i);
  return [
    PS_UNESQ_FN,
    PS_WRITE_FN,
    fxTermLine(ctx.position),
    '$fx_parts = ' + psArray(rest, exprOfWord),
    "$fx_s = $fx_parts -join ' '",
    ...(esc ? ['$fx_s = fx-unesq $fx_s'] : []),
    noNewline
      ? 'fx-write $fx_s $fx_term'
      : 'fx-write ($fx_s + [string][char]10) $fx_term',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* printf — runtime formatter (GNU repeat-until-consumed semantics)    */
/* ------------------------------------------------------------------ */

const PS_PRINTF_FNS = [
  PS_UNESQ_FN,
  'function fx-pf-int($s) {',
  '  $t = [string]$s',
  "  if ($t -match '^[+-]?0[xX][0-9a-fA-F]+$') { return [double][Convert]::ToUInt64($t, 16) }",
  "  if ($t -match '^[+-]?[0-9]+') { return [double]::Parse($Matches[0], [System.Globalization.CultureInfo]::InvariantCulture) }",
  '  return [double]0',
  '}',
  'function fx-pf-float($s) {',
  '  $t = [string]$s',
  "  if ($t -match '^[+-]?0[xX][0-9a-fA-F]+$') { return [double][Convert]::ToUInt64($t, 16) }",
  "  if ($t -match '^[+-]?([0-9]*\\.[0-9]+|[0-9]+\\.?)([eE][+-]?[0-9]+)?') { try { return [double]::Parse($Matches[0], [System.Globalization.CultureInfo]::InvariantCulture) } catch { return [double]0 } }",
  '  return [double]0',
  '}',
  'function fx-pf-pad($s, $w, $left, $zero) {',
  '  if ($w -le 0 -or $s.Length -ge $w) { return $s }',
  "  $pc = ' '",
  "  if ($zero) { $pc = '0' }",
  "  if ($zero -and $s.Length -gt 0 -and $s[0] -eq '-') {",
  "    return '-' + $s.Substring(1).PadLeft($w - 1, $pc)",
  '  }',
  '  if ($left) { return $s.PadRight($w, $pc) }',
  '  return $s.PadLeft($w, $pc)',
  '}',
  'function fx-printf($fmt, $av) {',
  '  $sb = New-Object System.Text.StringBuilder',
  '  $n = $av.Count',
  '  $ai = 0',
  '  while ($true) {',
  '    $i = 0',
  '    $used = $false',
  '    while ($i -lt $fmt.Length) {',
  "      $c = $fmt[$i]",
  "      if ($c -eq '%') {",
  '        $j = $i + 1',
  '        $left = $false; $zero = $false; $plus = $false',
  "        while ($j -lt $fmt.Length -and @('-','0','+',' ') -contains [string]$fmt[$j]) {",
  "          if ($fmt[$j] -eq '-') { $left = $true }",
  "          if ($fmt[$j] -eq '0') { $zero = $true }",
  "          if ($fmt[$j] -eq '+') { $plus = $true }",
  '          $j++',
  '        }',
  '        $w = 0',
  "        while ($j -lt $fmt.Length -and $fmt[$j] -ge '0' -and $fmt[$j] -le '9') { $w = $w * 10 + ([int]$fmt[$j] - 48); $j++ }",
  '        $p = -1',
  "        if ($j -lt $fmt.Length -and $fmt[$j] -eq '.') {",
  '          $j++; $p = 0',
  "          while ($j -lt $fmt.Length -and $fmt[$j] -ge '0' -and $fmt[$j] -le '9') { $p = $p * 10 + ([int]$fmt[$j] - 48); $j++ }",
  '        }',
  "        $conv = [char]0",
  '        if ($j -lt $fmt.Length) { $conv = $fmt[$j] }',
  "        if ($conv -ceq '%') {",
  "          [void]$sb.Append('%')",
  '          $i = $j + 1',
  '          continue',
  '        }',
  "        if (@('s','b','c','d','i','f','x','X') -ccontains [string]$conv) {",
  "          $a = ''",
  '          if ($ai -lt $n) { $a = [string]$av[$ai]; $ai++; $used = $true }',
  "          if ($conv -ceq 's') {",
  '            $s = $a',
  '            if ($p -ge 0 -and $s.Length -gt $p) { $s = $s.Substring(0, $p) }',
  '            $s = fx-pf-pad $s $w $left $false',
  '            [void]$sb.Append($s)',
  "          } elseif ($conv -ceq 'b') {",
  '            $s = fx-unesq $a',
  '            if ($p -ge 0 -and $s.Length -gt $p) { $s = $s.Substring(0, $p) }',
  '            $s = fx-pf-pad $s $w $left $false',
  '            [void]$sb.Append($s)',
  "          } elseif ($conv -ceq 'c') {",
  "            $s = ''",
  '            if ($a.Length -gt 0) { $s = [string]$a[0] }',
  '            $s = fx-pf-pad $s $w $left $false',
  '            [void]$sb.Append($s)',
  "          } elseif ($conv -ceq 'd' -or $conv -ceq 'i') {",
  '            $v = fx-pf-int $a',
  '            $s = [string][long]$v',
  "            if ($p -ge 1 -and $s.TrimStart('-').Length -lt $p) {",
  "              $neg = $s.StartsWith('-')",
  "              $digits = $s.TrimStart('-')",
  "              $digits = $digits.PadLeft($p, '0')",
  "              if ($neg) { $s = '-' + $digits } else { $s = $digits }",
  '            }',
  "            if ($plus -and -not $s.StartsWith('-')) { $s = '+' + $s }",
  '            $s = fx-pf-pad $s $w $left $zero',
  '            [void]$sb.Append($s)',
  "          } elseif ($conv -ceq 'x' -or $conv -ceq 'X') {",
  '            $v = [long](fx-pf-int $a)',
  '            if ($v -lt 0) { $v = $v -band 0xFFFFFFFFFFFFFFF }',
  '            $s = [Convert]::ToString($v, 16)',
  "            if ($conv -ceq 'X') { $s = $s.ToUpper() }",
  "            if ($p -ge 1 -and $s.Length -lt $p) { $s = $s.PadLeft($p, '0') }",
  '            $s = fx-pf-pad $s $w $left $zero',
  '            [void]$sb.Append($s)',
  '          } else {',
  '            $v = fx-pf-float $a',
  '            $pp = 6',
  '            if ($p -ge 0) { $pp = $p }',
  "            $s = $v.ToString('F' + $pp, [System.Globalization.CultureInfo]::InvariantCulture)",
  "            if ($plus -and -not $s.StartsWith('-')) { $s = '+' + $s }",
  '            $s = fx-pf-pad $s $w $left $zero',
  '            [void]$sb.Append($s)',
  '          }',
  '          $i = $j + 1',
  '          continue',
  '        }',
  '        # unknown directive: emit literally (GNU errors; we stay lenient)',
  "        [void]$sb.Append('%')",
  '        $i = $i + 1',
  '        continue',
  '      }',
  "      if ($c -eq '\\' -and $i + 1 -lt $fmt.Length) {",
  '        $e = $fmt[$i + 1]',
  "        if ($e -eq 'n') { [void]$sb.Append([char]10); $i += 2; continue }",
  "        if ($e -eq 't') { [void]$sb.Append([char]9); $i += 2; continue }",
  "        if ($e -eq 'r') { [void]$sb.Append([char]13); $i += 2; continue }",
  "        if ($e -eq '\\') { [void]$sb.Append('\\'); $i += 2; continue }",
  '      }',
  '      [void]$sb.Append($c)',
  '      $i++',
  '    }',
  '    if ($ai -ge $n) { break }',
  '    if (-not $used) { break }',
  '  }',
  '  $sb.ToString()',
  '}',
].join('\n');

const printf: Handler = (args, ctx) => {
  // no options; skip a single leading `--` separator
  const ops: Word[] = [];
  for (const w of args) {
    if (ops.length === 0 && wordToString(w) === '--') continue;
    ops.push(w);
  }
  if (ops.length === 0) {
    return psErrExpr(psStr('printf: usage: printf format [arguments]'), '2');
  }
  return [
    PS_PRINTF_FNS,
    PS_WRITE_FN,
    fxTermLine(ctx.position),
    '$fx_fmt = ' + exprOfWord(ops[0]),
    '$fx_av = ' + psArray(ops.slice(1), exprOfWord),
    'fx-write (fx-printf $fx_fmt $fx_av) $fx_term',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* cat                                                                 */
/* ------------------------------------------------------------------ */

const cat: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const numberAll = flags.has('n');
  const numberNonBlank = flags.has('b');
  const squeeze = flags.has('s');
  const showEnds = flags.has('E') || flags.has('A');
  const showTabs = flags.has('T') || flags.has('A');
  // GNU: -b overrides -n (nonblank numbering wins)
  const mode = numberNonBlank ? 'nonblank' : numberAll ? 'all' : 'none';

  return [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    PS_SPLITLINES_FN,
    STDIN_INLINES,
    ...psCollectFiles(
      operandWords,
      (g) => sErr('cat', g, 'No such file or directory'),
      (g) => sErr('cat', g, 'Is a directory'),
    ),
    '$fx_no = 1',
    '$fx_blank = $false',
    'foreach ($fx_g in $fx_srcs) {',
    "  if ($fx_g -eq '-') { $fx_ls = @($fx_in) }",
    '  else { $fx_ls = @(fx-splitlines (fx-read $fx_g)) }',
    '  for ($fx_i = 0; $fx_i -lt $fx_ls.Count; $fx_i++) {',
    '    $fx_l = $fx_ls[$fx_i]',
    '    if (' + pb(squeeze) + ') {',
    "      if ($fx_l -eq '') {",
    '        if ($fx_blank) { continue }',
    '        $fx_blank = $true',
    '      } else { $fx_blank = $false }',
    '    }',
    '    $fx_o = $fx_l',
    '    if (' + pb(showTabs) + ") { $fx_o = $fx_o.Replace([string][char]9, '^I') }",
    "    if ('" + mode + "' -eq 'all') {",
    "      $fx_o = ('{0,6}' -f $fx_no) + [string][char]9 + $fx_o; $fx_no++",
    "    } elseif ('" + mode + "' -eq 'nonblank' -and $fx_l -ne '') {",
    "      $fx_o = ('{0,6}' -f $fx_no) + [string][char]9 + $fx_o; $fx_no++",
    '    }',
    '    if (' + pb(showEnds) + ") { $fx_o = $fx_o + '$' }",
    '    $fx_o',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* head                                                                */
/* ------------------------------------------------------------------ */

const head: Handler = (args, ctx) => {
  // option scan (legacy `head -N` supported; -n/-c take values, incl. negative)
  let nLines: string | null = null;
  let nBytes: string | null = null;
  const operandWords: Word[] = [];
  let quiet = false;
  let verbose = false;
  {
    let i = 0;
    let onlyOps = false;
    while (i < args.length) {
      const t = wordToString(args[i]);
      if (onlyOps) {
        operandWords.push(args[i]);
        i++;
        continue;
      }
      if (t === '--') {
        onlyOps = true;
        i++;
        continue;
      }
      if (t.startsWith('--')) {
        i++;
        continue;
      }
      let m: RegExpMatchArray | null;
      if (t === '-n' || t === '-c') {
        const val = i + 1 < args.length ? wordToString(args[i + 1]) : null;
        if (val === null) {
          return psErrExpr(psStr('head: option requires an argument -- ' + t.slice(1)));
        }
        if (t === '-c') nBytes = val;
        else nLines = val;
        i += 2;
        continue;
      }
      if ((m = t.match(/^-[nc](.+)$/)) !== null) {
        if (t[1] === 'c') nBytes = m[1];
        else nLines = m[1];
        i++;
        continue;
      }
      if ((m = t.match(/^-(\d+)$/)) !== null) {
        nLines = m[1];
        i++;
        continue;
      }
      if (t.startsWith('-') && t.length > 1) {
        for (const ch of t.slice(1)) {
          if (ch === 'q') quiet = true;
          else if (ch === 'v') verbose = true;
        }
        i++;
        continue;
      }
      operandWords.push(args[i]);
      i++;
    }
  }
  const bytesMode = nBytes !== null;
  const countLit = bytesMode ? nBytes! : nLines !== null ? nLines : '10';

  const lines: string[] = [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    PS_SPLITLINES_FN,
    PS_WRITE_FN,
    fxTermLine(ctx.position),
  ];
  if (bytesMode) lines.push(STDIN_ITEMS, PS_STDINRAW_FN);
  else lines.push(STDIN_INLINES);
  lines.push(
    ...psCollectFiles(
      operandWords,
      (g) => qErr('head', g, 'No such file or directory'),
      (g) => qErr('head', g, 'Is a directory', 'error reading '),
    ),
    '$fx_count = [int](' + countLit + ')',
    '$fx_hdr = ((($fx_srcs.Count -gt 1) -and ' + pb(!quiet) + ') -or ' + pb(verbose) + ')',
    '$fx_first = $true',
  );
  if (bytesMode) {
    lines.push(
      '$fx_out = New-Object System.Text.StringBuilder',
      'for ($fx_k = 0; $fx_k -lt $fx_srcs.Count; $fx_k++) {',
      '  $fx_g = $fx_srcs[$fx_k]',
      "  if ($fx_g -eq '-') { $fx_txt = (fx-stdinraw $fx_items); $fx_disp = 'standard input' }",
      '  else { $fx_txt = fx-read $fx_g; $fx_disp = $fx_names[$fx_k] }',
      '  if ($fx_hdr) {',
      '    if (-not $fx_first) { [void]$fx_out.Append([string][char]10) }',
      "    [void]$fx_out.Append('==> ' + $fx_disp + ' <==' + [string][char]10)",
      '  }',
      '  $fx_first = $false',
      '  $fx_len = [math]::Min($fx_count, $fx_txt.Length)',
      '  if ($fx_len -lt 0) { $fx_len = 0 }',
      '  if ($fx_len -gt 0) { [void]$fx_out.Append($fx_txt.Substring(0, $fx_len)) }',
      '}',
      'fx-write $fx_out.ToString() $fx_term',
    );
  } else {
    lines.push(
      'for ($fx_k = 0; $fx_k -lt $fx_srcs.Count; $fx_k++) {',
      '  $fx_g = $fx_srcs[$fx_k]',
      "  if ($fx_g -eq '-') { $fx_ls = @($fx_in); $fx_disp = 'standard input' }",
      '  else { $fx_ls = @(fx-splitlines (fx-read $fx_g)); $fx_disp = $fx_names[$fx_k] }',
      '  if ($fx_hdr) {',
      "    if (-not $fx_first) { '' }",
      "    '==> ' + $fx_disp + ' <=='",
      '  }',
      '  $fx_first = $false',
      '  $fx_lim = $fx_ls.Count',
      '  if ($fx_count -lt 0) { $fx_lim = $fx_ls.Count + $fx_count }',
      '  elseif ($fx_lim -gt $fx_count) { $fx_lim = $fx_count }',
      '  if ($fx_lim -lt 0) { $fx_lim = 0 }',
      '  for ($fx_i = 0; $fx_i -lt $fx_lim; $fx_i++) { $fx_ls[$fx_i] }',
      '}',
    );
  }
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* tail                                                                */
/* ------------------------------------------------------------------ */

const tail: Handler = (args, ctx) => {
  const pre = parseWords(args);
  if (pre.flags.has('f') || pre.flags.has('F')) {
    return psErrExpr(psStr('tail: -f is not supported by fauxnix (no persistent tty)'));
  }
  // option scan (legacy `tail -N` / `tail +N` supported; -n/-c take values,
  // including `+N` = "from line N")
  let nLines: string | null = null;
  let fromLine: string | null = null;
  let nBytes: string | null = null;
  const operandWords: Word[] = [];
  let quiet = false;
  let verbose = false;
  {
    let i = 0;
    let onlyOps = false;
    while (i < args.length) {
      const t = wordToString(args[i]);
      if (onlyOps) {
        operandWords.push(args[i]);
        i++;
        continue;
      }
      if (t === '--') {
        onlyOps = true;
        i++;
        continue;
      }
      if (t.startsWith('--')) {
        i++;
        continue;
      }
      let m: RegExpMatchArray | null;
      if (t === '-n' || t === '-c') {
        const val = i + 1 < args.length ? wordToString(args[i + 1]) : null;
        if (val === null) {
          return psErrExpr(psStr('tail: option requires an argument -- ' + t.slice(1)));
        }
        if (t === '-c') nBytes = val;
        else if (val.startsWith('+')) fromLine = val.slice(1);
        else nLines = val.replace(/^-/, ''); // -n -N ≡ -n N (last N)
        i += 2;
        continue;
      }
      if ((m = t.match(/^-[nc](.*)$/)) !== null) {
        const val = m[1];
        if (t[1] === 'c') nBytes = val;
        else if (val.startsWith('+')) fromLine = val.slice(1);
        else nLines = val.replace(/^-/, '');
        i++;
        continue;
      }
      if ((m = t.match(/^-(\d+)$/)) !== null) {
        nLines = m[1];
        i++;
        continue;
      }
      if ((m = t.match(/^\+(\d+)$/)) !== null) {
        fromLine = m[1];
        i++;
        continue;
      }
      if (t.startsWith('-') && t.length > 1) {
        for (const ch of t.slice(1)) {
          if (ch === 'q') quiet = true;
          else if (ch === 'v') verbose = true;
        }
        i++;
        continue;
      }
      operandWords.push(args[i]);
      i++;
    }
  }
  const bytesMode = nBytes !== null;
  const countLit = bytesMode
    ? nBytes!
    : fromLine !== null
      ? fromLine
      : nLines !== null
        ? nLines
        : '10';

  const lines: string[] = [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    PS_SPLITLINES_FN,
    PS_WRITE_FN,
    fxTermLine(ctx.position),
  ];
  if (bytesMode) lines.push(STDIN_ITEMS, PS_STDINRAW_FN);
  else lines.push(STDIN_INLINES);
  lines.push(
    ...psCollectFiles(
      operandWords,
      (g) => qErr('tail', g, 'No such file or directory'),
      (g) => qErr('tail', g, 'Is a directory', 'error reading '),
    ),
    '$fx_count = [int](' + countLit + ')',
    '$fx_from = ' + pb(fromLine !== null && !bytesMode),
    '$fx_hdr = ((($fx_srcs.Count -gt 1) -and ' + pb(!quiet) + ') -or ' + pb(verbose) + ')',
    '$fx_first = $true',
  );
  if (bytesMode) {
    lines.push(
      '$fx_out = New-Object System.Text.StringBuilder',
      'for ($fx_k = 0; $fx_k -lt $fx_srcs.Count; $fx_k++) {',
      '  $fx_g = $fx_srcs[$fx_k]',
      "  if ($fx_g -eq '-') { $fx_txt = (fx-stdinraw $fx_items); $fx_disp = 'standard input' }",
      '  else { $fx_txt = fx-read $fx_g; $fx_disp = $fx_names[$fx_k] }',
      '  if ($fx_hdr) {',
      '    if (-not $fx_first) { [void]$fx_out.Append([string][char]10) }',
      "    [void]$fx_out.Append('==> ' + $fx_disp + ' <==' + [string][char]10)",
      '  }',
      '  $fx_first = $false',
      '  $fx_st = $fx_txt.Length - $fx_count',
      '  if ($fx_st -lt 0) { $fx_st = 0 }',
      '  if ($fx_st -lt $fx_txt.Length) { [void]$fx_out.Append($fx_txt.Substring($fx_st)) }',
      '}',
      'fx-write $fx_out.ToString() $fx_term',
    );
  } else {
    lines.push(
      'for ($fx_k = 0; $fx_k -lt $fx_srcs.Count; $fx_k++) {',
      '  $fx_g = $fx_srcs[$fx_k]',
      "  if ($fx_g -eq '-') { $fx_ls = @($fx_in); $fx_disp = 'standard input' }",
      '  else { $fx_ls = @(fx-splitlines (fx-read $fx_g)); $fx_disp = $fx_names[$fx_k] }',
      '  if ($fx_hdr) {',
      "    if (-not $fx_first) { '' }",
      "    '==> ' + $fx_disp + ' <=='",
      '  }',
      '  $fx_first = $false',
      '  if ($fx_from) {',
      '    $fx_st = $fx_count - 1',
      '    if ($fx_st -lt 0) { $fx_st = 0 }',
      '  } else {',
      '    $fx_st = $fx_ls.Count - $fx_count',
      '    if ($fx_st -lt 0) { $fx_st = 0 }',
      '  }',
      '  for ($fx_i = $fx_st; $fx_i -lt $fx_ls.Count; $fx_i++) { $fx_ls[$fx_i] }',
      '}',
    );
  }
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* wc                                                                  */
/* ------------------------------------------------------------------ */

const wc: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const wantL = flags.has('l');
  const wantW = flags.has('w');
  const wantC = flags.has('c');
  const wantM = flags.has('m');
  const anyFlag = wantL || wantW || wantC || wantM;
  const pl = wantL || !anyFlag;
  const pw = wantW || !anyFlag;
  const pc = wantC || !anyFlag;
  const pm = wantM;
  // GNU: stdin (implicit or `-`) prints the classic 7-wide columns; real
  // file operands use dynamic widths; `-` displays the name '-'.
  const fromFiles = operandWords.some((w) => wordToString(w) !== '-');

  return [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    PS_SPLITLINES_FN,
    STDIN_ITEMS,
    PS_STDINRAW_FN,
    ...psCollectFiles(
      operandWords,
      (g) => sErr('wc', g, 'No such file or directory'),
      (g) => sErr('wc', g, 'Is a directory'),
    ),
    'function fx-wdcount($ls) {',
    '  $t = 0',
    '  foreach ($fx_l in $ls) {',
    '    $fx_x = $fx_l.Trim()',
    "    if ($fx_x -ne '') { $t += @($fx_x -split '\\s+').Count }",
    '  }',
    '  return $t',
    '}',
    'function fx-digits($n) { return ([string]$n).Length }',
    '$fx_rows = @()',
    'for ($fx_k = 0; $fx_k -lt $fx_srcs.Count; $fx_k++) {',
    '  $fx_g = $fx_srcs[$fx_k]',
    "  if ($fx_g -eq '-') {",
    '    # stdin — single raw item keeps a printf-style tail exact for bytes,',
    '    # but the LINE count treats the last line as terminated (bash mental',
    '    # model: `find | wc -l` counts result rows)',
    '    $fx_txt = fx-stdinraw $fx_items',
    "    $fx_nl = [regex]::Matches($fx_txt, '\\n').Count",
    "    if ($fx_txt -ne '' -and -not $fx_txt.EndsWith([string][char]10)) { $fx_nl = $fx_nl + 1 }",
    '    $fx_ww = fx-wdcount @(fx-splitlines $fx_txt)',
    '    $fx_bc = [System.Text.Encoding]::UTF8.GetByteCount($fx_txt)',
    "    $fx_rows += ,@($fx_nl, $fx_ww, $fx_bc, $fx_txt.Length, $fx_names[$fx_k])",
    '  } else {',
    '    $fx_txt = fx-read $fx_g',
    '    $fx_txt2 = $fx_txt.Replace([string][char]13 + [string][char]10, [string][char]10)',
    "    $fx_nl = [regex]::Matches($fx_txt2, '\\n').Count",
    '    $fx_bytes = [IO.File]::ReadAllBytes($fx_g).Length',
    '    $fx_ww = fx-wdcount @(fx-splitlines $fx_txt)',
    '    $fx_rows += ,@($fx_nl, $fx_ww, $fx_bytes, $fx_txt.Length, $fx_names[$fx_k])',
    '  }',
    '}',
    '$fx_tot = @(0, 0, 0, 0)',
    'foreach ($fx_r in $fx_rows) {',
    '  $fx_tot[0] += $fx_r[0]; $fx_tot[1] += $fx_r[1]; $fx_tot[2] += $fx_r[2]; $fx_tot[3] += $fx_r[3]',
    '}',
    '$fx_showtotal = ($fx_rows.Count -gt 1)',
    // column width = max digits over every printed count; stdin keeps the classic 7
    '$fx_wd = 1',
    ...(fromFiles ? [] : ['$fx_wd = 7']),
    'foreach ($fx_r in $fx_rows) {',
    '  if (' + pb(pl) + ' -and (fx-digits $fx_r[0]) -gt $fx_wd) { $fx_wd = fx-digits $fx_r[0] }',
    '  if (' + pb(pw) + ' -and (fx-digits $fx_r[1]) -gt $fx_wd) { $fx_wd = fx-digits $fx_r[1] }',
    '  if (' + pb(pc) + ' -and (fx-digits $fx_r[2]) -gt $fx_wd) { $fx_wd = fx-digits $fx_r[2] }',
    '  if (' + pb(pm) + ' -and (fx-digits $fx_r[3]) -gt $fx_wd) { $fx_wd = fx-digits $fx_r[3] }',
    '}',
    'if ($fx_showtotal) {',
    '  if (' + pb(pl) + ' -and (fx-digits $fx_tot[0]) -gt $fx_wd) { $fx_wd = fx-digits $fx_tot[0] }',
    '  if (' + pb(pw) + ' -and (fx-digits $fx_tot[1]) -gt $fx_wd) { $fx_wd = fx-digits $fx_tot[1] }',
    '  if (' + pb(pc) + ' -and (fx-digits $fx_tot[2]) -gt $fx_wd) { $fx_wd = fx-digits $fx_tot[2] }',
    '  if (' + pb(pm) + ' -and (fx-digits $fx_tot[3]) -gt $fx_wd) { $fx_wd = fx-digits $fx_tot[3] }',
    '}',
    'function fx-wcline($r, $name) {',
    '  $fx_f = @()',
    '  if (' + pb(pl) + ') { $fx_f += [string]$r[0] }',
    '  if (' + pb(pw) + ') { $fx_f += [string]$r[1] }',
    '  if (' + pb(pm) + ') { $fx_f += [string]$r[3] }',
    '  if (' + pb(pc) + ') { $fx_f += [string]$r[2] }',
    '  if ($fx_f.Count -eq 1) { $fx_line = $fx_f[0] }',
    "  else { $fx_f = @($fx_f | ForEach-Object { $_.PadLeft($fx_wd) }); $fx_line = ($fx_f -join ' ') }",
    "  if ($null -ne $name) { $fx_line = $fx_line + ' ' + $name }",
    '  $fx_line',
    '}',
    'foreach ($fx_r in $fx_rows) { fx-wcline $fx_r $fx_r[4] }',
    "if ($fx_showtotal) { fx-wcline $fx_tot 'total' }",
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* tee                                                                 */
/* ------------------------------------------------------------------ */

const tee: Handler = (args, ctx) => {
  const { flags, operandWords } = parseWords(args);
  const append = flags.has('a') || flags.has('append');
  return [
    PS_WRITE_FN,
    fxTermLine(ctx.position),
    STDIN_ITEMS,
    PS_STDINRAW_FN,
    '$fx_files = ' + psArray(operandWords),
    '$fx_s = fx-stdinraw $fx_items',
    'foreach ($fx_f in $fx_files) {',
    '  try {',
    '    if (' + pb(append) + ') {',
    '      [IO.File]::AppendAllText($fx_f, $fx_s, (New-Object System.Text.UTF8Encoding($false)))',
    '    } else {',
    '      [IO.File]::WriteAllText($fx_f, $fx_s, (New-Object System.Text.UTF8Encoding($false)))',
    '    }',
    '  } catch { ' + psErrExpr(sErr('tee', '$fx_f', 'No such file or directory')) + ' }',
    '}',
    'fx-write $fx_s $fx_term',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* nl                                                                  */
/* ------------------------------------------------------------------ */

const nl: Handler = (args) => {
  const { values, operandWords } = parseWords(args, ['b']);
  const bodyMode = values.get('-b') ?? 't';
  if (bodyMode !== 'a' && bodyMode !== 'n' && bodyMode !== 't') {
    return psErrExpr(psStr("nl: invalid body numbering mode: '" + bodyMode + "'"));
  }
  return [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    PS_SPLITLINES_FN,
    STDIN_INLINES,
    ...psCollectFiles(
      operandWords,
      (g) => sErr('nl', g, 'No such file or directory'),
      (g) => sErr('nl', g, 'Is a directory'),
    ),
    '$fx_no = 1',
    "$fx_pad = ' '.PadLeft(7)",
    'foreach ($fx_g in $fx_srcs) {',
    "  if ($fx_g -eq '-') { $fx_ls = @($fx_in) }",
    '  else { $fx_ls = @(fx-splitlines (fx-read $fx_g)) }',
    '  for ($fx_i = 0; $fx_i -lt $fx_ls.Count; $fx_i++) {',
    '    $fx_l = $fx_ls[$fx_i]',
    "    if ('" + bodyMode + "' -eq 'a' -or ('" + bodyMode + "' -eq 't' -and $fx_l -ne '')) {",
    "      ('{0,6}' -f $fx_no) + [string][char]9 + $fx_l",
    '      $fx_no++',
    '    } else {',
    '      $fx_pad + $fx_l',
    '    }',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* tac                                                                 */
/* ------------------------------------------------------------------ */

const tac: Handler = (args) => {
  const { operandWords } = parseWords(args);
  return [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    PS_SPLITLINES_FN,
    STDIN_INLINES,
    ...psCollectFiles(
      operandWords,
      (g) => qErr('tac', g, 'No such file or directory', 'failed to open '),
      (g) => sErr('tac', g, 'read error: Is a directory'),
    ),
    '$fx_all = @()',
    'foreach ($fx_g in $fx_srcs) {',
    "  if ($fx_g -eq '-') { $fx_all += @($fx_in) }",
    '  else { $fx_all += @(fx-splitlines (fx-read $fx_g)) }',
    '}',
    'for ($fx_i = $fx_all.Count - 1; $fx_i -ge 0; $fx_i--) { $fx_all[$fx_i] }',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* md5sum / sha1sum / sha256sum                                        */
/* ------------------------------------------------------------------ */

function hashSum(cmd: string, createExpr: string, hexLen: number, algoName: string): Handler {
  const hashFn = [
    'function fx-hash($b) {',
    '  $h = ' + createExpr + '.ComputeHash($b)',
    "  return (($h | ForEach-Object { $_.ToString('x2') }) -join '')",
    '}',
  ].join('\n');

  return (args) => {
    const { flags, longs, operandWords } = parseWords(args);
    const check = flags.has('c') || longs.has('--check');

    if (check) {
      const chk = operandWords.length ? operandExpr(operandWords[0]) : "''";
      return [
        PS_READTEXT_FN,
        PS_SPLITLINES_FN,
        hashFn,
        'function fx-path($p) {',
        "  if ($p -eq '/dev/null') { return 'NUL' }",
        "  if ($p -eq '/tmp') { return $env:TEMP }",
        "  if ($p.StartsWith('/tmp/')) { return ($env:TEMP + '\\' + ($p.Substring(5) -replace '/', '\\')) }",
        "  if ($p -match '^/([a-zA-Z])/(.+)$') { return ($Matches[1].ToUpper() + ':\\' + ($Matches[2] -replace '/', '\\')) }",
        "  if ($p -match '^/([a-zA-Z])$') { return ($Matches[1].ToUpper() + ':\\') }",
        '  return $p',
        '}',
        '$fx_chk = ' + chk,
        "if ($fx_chk -eq '') { " + psErrExpr(psStr(cmd + ': missing operand')) + ' }',
        'elseif (-not (Test-Path -LiteralPath $fx_chk -PathType Leaf)) {',
        '  ' + psErrExpr(sErr(cmd, '$fx_chk', 'No such file or directory')),
        '}',
        'else {',
        '  $fx_bad = 0',
        '  $fx_openfail = 0',
        '  $fx_parsed = 0',
        '  foreach ($fx_l in @(fx-splitlines (fx-read $fx_chk))) {',
        "    if ($fx_l -match '^([0-9a-fA-F]{" + hexLen + '})(  | \\*)(.*)$' + "') {",
        '      $fx_want = $Matches[1].ToLower()',
        '      $fx_name = $Matches[3]',
        '      $fx_target = fx-path $fx_name',
        '      $fx_parsed++',
        '      if (-not (Test-Path -LiteralPath $fx_target -PathType Leaf)) {',
        '        ' + psErrExpr(sErr(cmd, '$fx_name', 'No such file or directory')),
        "        $fx_name + ': FAILED open or read'",
        '        $fx_openfail++',
        '        continue',
        '      }',
      '      try { $fx_got = fx-hash ([IO.File]::ReadAllBytes($fx_target)) }',
      "      catch { $fx_got = '' }",
      '      if ($fx_got -eq $fx_want) {',
      "        $fx_name + ': OK'",
      '      } else {',
      "        $fx_name + ': FAILED'",
      '        $fx_bad++',
      '      }',
      '    }',
      '  }',
      '  if ($fx_parsed -eq 0) {',
      '    ' + psErrExpr(sErr(cmd, '$fx_chk', 'no properly formatted ' + algoName + ' checksum lines found')),
      '  }',
      '  if ($fx_bad -gt 0) {',
      "    $fx_sfx = 's'; if ($fx_bad -eq 1) { $fx_sfx = '' }",
      '    [Console]::Error.WriteLine(' +
        psStr(cmd + ': WARNING: ') +
        " + $fx_bad + ' computed checksum' + $fx_sfx + ' did NOT match')",
      '  }',
      '  if ($fx_openfail -gt 0) {',
      "    $fx_sfx2 = 's'; if ($fx_openfail -eq 1) { $fx_sfx2 = '' }",
      '    [Console]::Error.WriteLine(' +
        psStr(cmd + ': WARNING: ') +
        " + $fx_openfail + ' listed file' + $fx_sfx2 + ' could not be read')",
      '  }',
      '  if ($fx_bad -gt 0 -or $fx_openfail -gt 0) { $script:fx_exit = 1 }',
      '}',
      ].join('\n');
    }

    return [
      PS_GLOB_FN,
      PS_STDINRAW_FN,
      STDIN_ITEMS,
      hashFn,
      ...psCollectFiles(
        operandWords,
        (g) => sErr(cmd, g, 'No such file or directory'),
        (g) => sErr(cmd, g, 'Is a directory'),
      ),
      'for ($fx_k = 0; $fx_k -lt $fx_srcs.Count; $fx_k++) {',
      '  $fx_g = $fx_srcs[$fx_k]',
      "  if ($fx_g -eq '-') { $fx_b = [System.Text.Encoding]::UTF8.GetBytes((fx-stdinraw $fx_items)); $fx_disp = '-' }",
      '  else { $fx_b = [IO.File]::ReadAllBytes($fx_g); $fx_disp = $fx_names[$fx_k] }',
      "  (fx-hash $fx_b) + '  ' + $fx_disp",
      '}',
    ].join('\n');
  };
}

const md5sum = hashSum('md5sum', '[System.Security.Cryptography.MD5]::Create()', 32, 'MD5');
const sha1sum = hashSum('sha1sum', '[System.Security.Cryptography.SHA1]::Create()', 40, 'SHA1');
const sha256sum = hashSum(
  'sha256sum',
  '[System.Security.Cryptography.SHA256]::Create()',
  64,
  'SHA256',
);

/* ------------------------------------------------------------------ */
/* base64                                                              */
/* ------------------------------------------------------------------ */

const base64: Handler = (args, ctx) => {
  const { flags, longs, values, operandWords } = parseWords(args, ['w'], ['--wrap']);
  const decode = flags.has('d') || longs.has('--decode');
  let wrap = 76;
  const wv = values.get('-w') ?? values.get('--wrap');
  if (wv !== undefined && /^\d+$/.test(wv)) wrap = parseInt(wv, 10);

  const pre = [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    STDIN_ITEMS,
    PS_STDINRAW_FN,
    PS_WRITE_FN,
    fxTermLine(ctx.position),
    ...psCollectFiles(
      operandWords,
      (g) => sErr('base64', g, 'No such file or directory'),
      null,
      false,
    ),
  ];

  if (decode) {
    return [
      ...pre,
      "$fx_enc = ''",
      'if ($fx_srcs.Count -gt 0) { $fx_enc = fx-read $fx_srcs[0] }',
      'else { $fx_enc = fx-stdinraw $fx_items }',
      'try {',
      "  $fx_b = [Convert]::FromBase64String(($fx_enc -replace '[\\s\\r\\n]+', ''))",
      '} catch { ' + psErrExpr(psStr('base64: invalid input')) + "; $fx_b = $null }",
      'if ($null -ne $fx_b) {',
      '  fx-write ([System.Text.Encoding]::UTF8.GetString($fx_b)) $fx_term',
      '}',
    ].join('\n');
  }

  return [
    ...pre,
    'if (' + pb(wrap > 0) + ') {',
    '  if ($fx_srcs.Count -gt 0) { $fx_b = [IO.File]::ReadAllBytes($fx_srcs[0]) }',
    '  else { $fx_b = [System.Text.Encoding]::UTF8.GetBytes((fx-stdinraw $fx_items)) }',
    '  $fx_s = [Convert]::ToBase64String($fx_b)',
    '  $fx_i = 0',
    '  while ($fx_i -lt $fx_s.Length) {',
    '    $fx_len = [math]::Min(' + wrap + ", $fx_s.Length - $fx_i)",
    '    $fx_s.Substring($fx_i, $fx_len)',
    '    $fx_i += ' + wrap,
    '  }',
    '} else {',
    '  if ($fx_srcs.Count -gt 0) { $fx_b = [IO.File]::ReadAllBytes($fx_srcs[0]) }',
    '  else { $fx_b = [System.Text.Encoding]::UTF8.GetBytes((fx-stdinraw $fx_items)) }',
    '  fx-write ([Convert]::ToBase64String($fx_b)) $fx_term',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* seq                                                                 */
/* ------------------------------------------------------------------ */

const seq: Handler = (args, ctx) => {
  const { flags, values, operandWords } = parseWords(args, ['s']);
  const eq = flags.has('w');
  const sepExpr = values.has('-s') ? psStr(values.get('-s')!) : '[string][char]10';

  return [
    PS_WRITE_FN,
    fxTermLine(ctx.position),
    'function fx-tod($s) {',
    '  try { return [double]::Parse([string]$s, [System.Globalization.CultureInfo]::InvariantCulture) }',
    '  catch { return [double]0 }',
    '}',
    'function fx-dec($s) {',
    "  if ([string]$s -match '^[+-]?[0-9]*\\.([0-9]+)') { return $Matches[1].Length }",
    '  return 0',
    '}',
    '$fx_nums = ' + argListExpr(operandWords),
    "if ($fx_nums.Count -eq 0) { " +
      psErrExpr(psStr('seq: missing operand')) +
      ' }',
    "elseif ($fx_nums.Count -gt 3) { " +
      psErrExpr(psStr('seq: extra operand ') + ' + $fx_nums[3]') +
      ' }',
    'else {',
    "  $fx_a = [string]$(if ($fx_nums.Count -ge 2) { $fx_nums[0] } else { '1' })",
    "  $fx_b = [string]$(if ($fx_nums.Count -eq 3) { $fx_nums[1] } else { '1' })",
    '  $fx_c = [string]$(if ($fx_nums.Count -eq 3) { $fx_nums[2] } else { $fx_nums[$fx_nums.Count - 1] })',
    '$fx_first = fx-tod $fx_a',
    '$fx_inc = fx-tod $fx_b',
    '$fx_last = fx-tod $fx_c',
    'if ($fx_inc -eq 0) { ' + psErrExpr(psStr('seq: invalid Zero increment value: ') + ' + $fx_b') + ' }',
    'else {',
    '  $fx_p = 0',
    '  foreach ($fx_o in @($fx_a, $fx_b, $fx_c)) { $fx_d = fx-dec $fx_o; if ($fx_d -gt $fx_p) { $fx_p = $fx_d } }',
    '  $fx_buf = New-Object System.Collections.Generic.List[string]',
    '  $fx_i = 0',
    '  while ($fx_i -lt 1000000) {',
    '    $v = $fx_first + $fx_i * $fx_inc',
    '    if ($fx_inc -ge 0 -and $v -gt $fx_last + 0.0000001) { break }',
    '    if ($fx_inc -lt 0 -and $v -lt $fx_last - 0.0000001) { break }',
    "    $fx_buf.Add($v.ToString('F' + $fx_p, [System.Globalization.CultureInfo]::InvariantCulture))",
    '    $fx_i++',
    '  }',
    '  $fx_strs = @($fx_buf)',
    '  if (' + pb(eq) + ') {',
    '    $fx_wn = 1',
    '    if ($fx_strs.Count -gt 0) {',
    "      $fx_l0 = $fx_strs[0].TrimStart('-').Length",
    "      $fx_l1 = $fx_strs[$fx_strs.Count - 1].TrimStart('-').Length",
    '      $fx_wn = [math]::Max($fx_l0, $fx_l1)',
    '    }',
    "    $fx_strs = @($fx_strs | ForEach-Object { if ($_.StartsWith('-')) { '-' + $_.Substring(1).PadLeft($fx_wn, '0') } else { $_.PadLeft($fx_wn, '0') } })",
    '  }',
    '  if ($fx_strs.Count -eq 0) { }',
    '  else { fx-write (($fx_strs -join (' + sepExpr + ')) + [string][char]10) $fx_term }',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* yes                                                                 */
/* ------------------------------------------------------------------ */

const yes: Handler = (args) => {
  return [
    '$fx_parts = ' + psArray(args, exprOfWord),
    "if ($fx_parts.Count -eq 0) { $fx_parts = @('y') }",
    "$fx_s = $fx_parts -join ' '",
    '# CAPPED: real `yes` repeats forever, but PS 5.1 pipelines cannot send a',
    '# stop signal upstream (no SIGPIPE), so `yes | head -3` would hang. 65536',
    '# lines is far beyond what any consumer keeps.',
    '$fx_i = 0',
    'while ($fx_i -lt 65536) {',
    '  $fx_s',
    '  $fx_i++',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* xargs                                                               */
/* ------------------------------------------------------------------ */

const XARGS_BUILTIN_MSG =
  'fauxnix: xargs currently passes arguments to native commands (git, node, npm, python, cargo...); ' +
  'for built-ins like grep use direct invocation with globs or grep -r';

const xargs: Handler = (args) => {
  // custom parse: options only until the first non-option word (the command)
  let chunkN: number | null = null;
  let repl: string | null = null;
  let noRunIfEmpty = false;
  let trace = false;
  const target: Word[] = [];
  let i = 0;
  let seenCmd = false;
  while (i < args.length) {
    const t = wordToString(args[i]);
    if (!seenCmd && t === '--') {
      i++;
      seenCmd = true;
      continue;
    }
    if (!seenCmd && t.startsWith('--')) {
      if (t === '--no-run-if-empty') noRunIfEmpty = true;
      i++;
      continue;
    }
    if (!seenCmd && t.startsWith('-') && t.length > 1 && !/^-/.test(t.slice(1, 2))) {
      const body = t.slice(1);
      for (let c = 0; c < body.length; c++) {
        const ch = body[c];
        if (ch === 'r') noRunIfEmpty = true;
        else if (ch === 't') trace = true;
        else if (ch === 'n' || ch === 'I' || ch === 'L') {
          const restv = body.slice(c + 1);
          let val: string;
          if (restv) val = restv;
          else if (i + 1 < args.length) {
            val = wordToString(args[i + 1]);
            i++;
          } else {
            return psErrExpr(psStr('xargs: option requires an argument -- ' + ch));
          }
          if (ch === 'n' || ch === 'L') chunkN = parseInt(val, 10);
          else repl = val;
          break;
        }
      }
      i++;
      continue;
    }
    seenCmd = true;
    target.push(args[i]);
    i++;
  }

  // no command → GNU runs /bin/echo with the collected args
  if (target.length === 0) {
    const skipLine = noRunIfEmpty
      ? "if ($fx_args.Count -gt 0) { ($fx_args -join ' ') }"
      : "($fx_args -join ' ')";
    return [
      PS_SPLITLINES_FN,
      STDIN_INLINES,
      "$fx_args = @($fx_in | Where-Object { $_ -ne '' })",
      skipLine,
    ].join('\n');
  }

  // fauxnix built-ins cannot be invoked natively (they are PS code, not exes)
  const firstLit =
    target[0].every((p) => p.kind === 'Text' || p.kind === 'SingleQuoted')
      ? target[0].map((p) => (p as { text: string }).text).join('')
      : null;
  if (firstLit !== null && lookup(firstLit) !== undefined) {
    return psErrExpr(psStr(XARGS_BUILTIN_MSG));
  }

  const n = chunkN !== null && Number.isFinite(chunkN) && chunkN > 0 ? chunkN : 0;
  const replExpr = repl !== null ? psStr(repl) : null;

  const invoke = [
    '    if (' +
      pb(trace) +
      ") { [Console]::Error.WriteLine(((@($fx_cmd) + @($fx_argv)) -join ' ')) }",
    '    & $fx_cmd @fx_argv',
    '    if ($LASTEXITCODE -ne 0 -and $script:fx_exit -eq 0) { $script:fx_exit = $LASTEXITCODE }',
  ];

  let dispatch: string[];
  const guard = '  if (' + pb(noRunIfEmpty) + ' -and $fx_args.Count -eq 0) { }' + '\n' + '  else {';
  if (replExpr !== null) {
    // -I REPL: one invocation per line, REPL substituted inside the args
    dispatch = [
      guard,
      '  foreach ($fx_l in $fx_args) {',
      '    $fx_argv = @()',
      '    $fx_hit = $false',
      '    foreach ($fx_a in $fx_base) {',
      '      if ($fx_a.Contains(' + replExpr + ')) {',
      '        $fx_hit = $true',
      '        $fx_argv += $fx_a.Replace(' + replExpr + ', $fx_l)',
      '      } else { $fx_argv += $fx_a }',
      '    }',
      '    if (-not $fx_hit) { $fx_argv += $fx_l }',
      ...invoke,
      '  }',
      '  }',
    ];
  } else if (n > 0) {
    // -n N: N arguments per invocation
    dispatch = [
      guard,
      '  $fx_i = 0',
      '  $fx_ran = $false',
      '  while ($fx_i -lt $fx_args.Count) {',
      '    $fx_argv = @($fx_base)',
      '    $fx_j = 0',
      '    while ($fx_j -lt ' + n + ' -and $fx_i -lt $fx_args.Count) {',
      '      $fx_argv += $fx_args[$fx_i]',
      '      $fx_i++; $fx_j++',
      '    }',
      '    $fx_ran = $true',
      ...invoke,
      '  }',
      '  if (-not $fx_ran) {',
      '    $fx_argv = @($fx_base)',
      '    ' + invoke[0],
      '    ' + invoke[1],
      '    ' + invoke[2],
      '  }',
      '  }',
    ];
  } else {
    dispatch = [
      guard,
      '  $fx_argv = @($fx_base) + @($fx_args)',
      ...invoke,
      '  }',
    ];
  }

  return [
    PS_SPLITLINES_FN,
    STDIN_INLINES,
    '$fx_tg = ' + argListExpr(target, exprOfWord),
    "if ($fx_tg.Count -eq 0) { $fx_cmd = ''; $fx_base = @() } else { $fx_cmd = [string]$fx_tg[0]; $fx_base = $(if ($fx_tg.Count -gt 1) { @($fx_tg[1..($fx_tg.Count - 1)]) } else { @() }) }",
    "$fx_args = @($fx_in | Where-Object { $_ -ne '' })",
    ...dispatch,
  ].join('\n');
};

/* ------------------------------------------------------------------ */

export const handlers: Record<string, Handler> = {
  echo,
  printf,
  cat,
  head,
  tail,
  wc,
  tee,
  nl,
  tac,
  md5sum,
  sha1sum,
  sha256sum,
  base64,
  seq,
  yes,
  xargs,
};
