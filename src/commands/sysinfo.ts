import { Word, WordPart, isFullyUnquoted, isUnquotedLiteral, wordToString } from '../ast.js';
import { Handler, lookup, parseWords, psStr, registeredNames } from '../registry.js';
import { exprOfWord, operandExpr, translateSimple } from '../translator.js';
import { handlers as textIoHandlers } from './text-io.js';

/* ------------------------------------------------------------------ */
/* Shared TS helpers                                                   */
/* ------------------------------------------------------------------ */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface AssignSplit {
  name: string;
  value: Word;
}

/**
 * Split a Word into `NAME=rest` at the first literal '='. Returns null when
 * the word contains no '=' (bare name) or is dynamic before the '='.
 */
function splitAssignWord(w: Word): AssignSplit | null {
  const nameParts: WordPart[] = [];
  for (let i = 0; i < w.length; i++) {
    const p = w[i];
    if (p.kind === 'Text' || p.kind === 'SingleQuoted') {
      const eq = p.text.indexOf('=');
      if (eq >= 0) {
        if (eq > 0) nameParts.push({ kind: p.kind, text: p.text.slice(0, eq) } as WordPart);
        const value: Word = [];
        const tail = p.text.slice(eq + 1);
        if (tail !== '') value.push({ kind: p.kind, text: tail } as WordPart);
        value.push(...w.slice(i + 1));
        const name = nameParts.map((x) => (x as { text: string }).text).join('');
        return { name, value };
      }
      nameParts.push(p);
    } else {
      return null;
    }
  }
  return null;
}

/** Text Words -> PS array expression. */
function textArgs(words: Word[]): string {
  if (words.length === 0) return '@()';
  return '@(' + words.map(exprOfWord).join(', ') + ')';
}

/** Drop dash-arguments, return operand words. */
function stripFlags(args: Word[]): Word[] {
  return args.filter((w) => !wordToString(w).startsWith('-'));
}

/** Names of commands registered as fauxnix builtins right now. */
function builtinNames(): string[] {
  return registeredNames().filter((n) => lookup(n) !== undefined);
}

/* Linux signal table (x86). */
const SIGNALS: [string, number][] = [
  ['HUP', 1], ['INT', 2], ['QUIT', 3], ['ILL', 4], ['TRAP', 5], ['ABRT', 6],
  ['BUS', 7], ['FPE', 8], ['KILL', 9], ['USR1', 10], ['SEGV', 11], ['USR2', 12],
  ['PIPE', 13], ['ALRM', 14], ['TERM', 15], ['STKFLT', 16], ['CHLD', 17],
  ['CONT', 18], ['STOP', 19], ['TSTP', 20], ['TTIN', 21], ['TTOU', 22],
  ['URG', 23], ['XCPU', 24], ['XFSZ', 25], ['VTALRM', 26], ['PROF', 27],
  ['WINCH', 28], ['IO', 29], ['PWR', 30], ['SYS', 31],
];
const sigNameToNum = new Map<string, number>(SIGNALS.map(([n, s]) => [n, s]));
const sigNumToName = new Map<number, string>(SIGNALS.map(([n, s]) => [s, n]));

const killInvalidSignal = (spec: string): string =>
  '[Console]::Error.WriteLine(' +
  psStr('bash: kill: ' + spec + ': invalid signal specification') +
  '); $script:fx_exit = 1';

/* ------------------------------------------------------------------ */
/* Shared PS snippets                                                  */
/* ------------------------------------------------------------------ */

/** PS helper: search PATH (+PATHEXT) for an executable. Returns '' if absent. */
const PS_WHICH_FN = [
  'function fx-which($n) {',
  "  foreach ($fx_d in ($env:PATH -split ';')) {",
  "    if ($fx_d -eq '') { continue }",
  '    $fx_c = Join-Path $fx_d $n',
  '    if (Test-Path -LiteralPath $fx_c) { return $fx_c }',
  "    $fx_exts = @(($env:PATHEXT -split ';') + '.exe') | Select-Object -Unique",
  '    foreach ($fx_e in $fx_exts) {',
  '      if (Test-Path -LiteralPath ($fx_c + $fx_e)) { return ($fx_c + $fx_e) }',
  '    }',
  '  }',
  "  return ''",
  '}',
].join('\n');

/** PS helper: month name (English, culture-safe). */
const PS_MON_FN =
  "function fx-mon($m) { return @('Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec')[[int]$m - 1] }";

/* ------------------------------------------------------------------ */
/* cd / pwd                                                            */
/* ------------------------------------------------------------------ */

const cd: Handler = (args) => {
  if (args.length === 0) {
    return [
      'try { Set-Location -LiteralPath $HOME }',
      "catch { [Console]::Error.WriteLine('bash: cd: ' + $_.Exception.Message); $script:fx_exit = 1 }",
    ].join('\n');
  }
  if (args.length > 1) {
    return "[Console]::Error.WriteLine('bash: cd: too many arguments'); $script:fx_exit = 1";
  }
  if (wordToString(args[0]) === '-') {
    return [
      "if (-not $env:FAUXNIX_OLDPWD) { [Console]::Error.WriteLine('bash: cd: OLDPWD not set'); $script:fx_exit = 1 }",
      'else { try { Set-Location -LiteralPath $env:FAUXNIX_OLDPWD } catch { [Console]::Error.WriteLine("bash: cd: " + $env:FAUXNIX_OLDPWD + ": No such file or directory"); $script:fx_exit = 1 } }',
    ].join('\n');
  }
  return [
    '$fx_d = ' + operandExpr(args[0]),
    'if (-not (Test-Path -LiteralPath $fx_d)) { [Console]::Error.WriteLine("bash: cd: " + $fx_d + ": No such file or directory"); $script:fx_exit = 1 }',
    'elseif (-not (Test-Path -LiteralPath $fx_d -PathType Container)) { [Console]::Error.WriteLine("bash: cd: " + $fx_d + ": Not a directory"); $script:fx_exit = 1 }',
    'else { try { Set-Location -LiteralPath $fx_d } catch { [Console]::Error.WriteLine("bash: cd: " + $fx_d + ": No such file or directory"); $script:fx_exit = 1 } }',
  ].join('\n');
};

const pwd: Handler = (args) => {
  void args; // -P accepted; physical == logical for Windows providers
  return "(Get-Location).Path.Replace('\\', '/')";
};

/* ------------------------------------------------------------------ */
/* export / unset / env / printenv                                     */
/* ------------------------------------------------------------------ */

const ENV_LIST_PS =
  "Get-ChildItem Env: | Sort-Object -Property Name | ForEach-Object { $_.Name + '=' + [string]$_.Value }";

const exportCmd: Handler = (args) => {
  if (args.length === 0) return ENV_LIST_PS;
  const sets: AssignSplit[] = [];
  for (const w of args) {
    const t = wordToString(w);
    if (t.startsWith('-')) continue; // -n / -f accepted and ignored
    const sp = splitAssignWord(w);
    if (sp === null) continue; // `export VAR` (bare name) -> no-op success
    if (!NAME_RE.test(sp.name)) {
      return (
        '[Console]::Error.WriteLine(' +
        psStr("bash: export: `" + t + "': not a valid identifier") +
        '); $script:fx_exit = 1'
      );
    }
    sets.push(sp);
  }
  return sets.map((s) => '$env:' + s.name + ' = ' + exprOfWord(s.value)).join('\n');
};

const unset: Handler = (args) => {
  const names = stripFlags(args);
  if (names.length === 0) return '';
  return [
    '$fx_ns = ' + textArgs(names),
    'foreach ($fx_n in $fx_ns) {',
    "  if ($fx_n -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { [Console]::Error.WriteLine(\"bash: unset: '\" + $fx_n + \"': not a valid identifier\"); $script:fx_exit = 1; continue }",
    "  Remove-Item -LiteralPath ('Env:\\' + $fx_n) -ErrorAction SilentlyContinue",
    '}',
  ].join('\n');
};

const env: Handler = (args, ctx) => {
  const raw = args.map(wordToString);
  const sets: AssignSplit[] = [];
  const unsets: string[] = [];
  let i = 0;
  let cmdIdx = -1;
  while (i < raw.length) {
    const t = raw[i];
    if (t === '--') {
      cmdIdx = i + 1;
      break;
    }
    if (t === '-i' || t === '--ignore-environment') {
      i++; // best-effort: the flag is accepted and ignored
      continue;
    }
    if (t === '-u' || t === '--unset') {
      if (i + 1 < raw.length) unsets.push(raw[i + 1]);
      i += 2;
      continue;
    }
    if (t.startsWith('-u=') || t.startsWith('--unset=')) {
      unsets.push(t.slice(t.indexOf('=') + 1));
      i++;
      continue;
    }
    if (t.startsWith('-')) {
      i++; // unknown flags ignored
      continue;
    }
    const sp = splitAssignWord(args[i]);
    if (sp !== null && NAME_RE.test(sp.name)) {
      sets.push(sp);
      i++;
      continue;
    }
    cmdIdx = i;
    break;
  }
  const lines: string[] = [];
  for (const u of unsets) {
    lines.push("Remove-Item -LiteralPath ('Env:\\' + " + psStr(u) + ') -ErrorAction SilentlyContinue');
  }
  for (const s of sets) lines.push('$env:' + s.name + ' = ' + exprOfWord(s.value));
  if (cmdIdx >= 0 && cmdIdx < args.length) {
    const cmdWords = args.slice(cmdIdx);
    lines.push(
      translateSimple(
        { kind: 'SimpleCommand', assignments: [], name: cmdWords[0], args: cmdWords.slice(1), redirects: [] },
        ctx.position,
        ctx.hasStdin,
      ),
    );
  } else {
    lines.push(ENV_LIST_PS);
  }
  return lines.join('\n');
};

const printenv: Handler = (args) => {
  const names = stripFlags(args);
  if (names.length === 0) return ENV_LIST_PS;
  return [
    '$fx_ns = ' + textArgs(names),
    'foreach ($fx_n in $fx_ns) {',
    '  $fx_v = [Environment]::GetEnvironmentVariable($fx_n)',
    '  if ($null -eq $fx_v) { $script:fx_exit = 1 } else { $fx_v }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* ps                                                                  */
/* ------------------------------------------------------------------ */

const ps: Handler = (args) => {
  const raw = args.map(wordToString);
  const { flags, operandWords } = parseWords(args);
  const full =
    operandWords.some((w) => wordToString(w) === 'aux') ||
    (flags.has('e') && flags.has('f')) ||
    raw.includes('-ef');

  if (full) {
    return [
      PS_MON_FN,
      '$fx_now = Get-Date',
      '$fx_os = Get-CimInstance Win32_OperatingSystem',
      '$fx_totPhys = [long]$fx_os.TotalVisibleMemorySize * 1024',
      "'{0,-8} {1,5} {2,4:0.0} {3,4:0.0} {4,9} {5,6} {6,-8} {7,-4} {8,6} {9,9} {10}' -f 'USER','PID','%CPU','%MEM','VSZ','RSS','TTY','STAT','START','TIME','COMMAND'",
      '$fx_ps = @(Get-CimInstance Win32_Process | Sort-Object ProcessId)',
      'foreach ($fx_p in $fx_ps) {',
      // NOTE: Win32_Process.GetOwner() costs ~0.3s PER PROCESS via WMI on
      // typical Windows boxes, which makes the table useless — USER stays '?'
      // (the documented fallback) instead of hanging for minutes.
      "  $fx_u = '?'",
      '  $fx_cpu = 0.0',
      '  $fx_el = $fx_now - $fx_p.CreationDate',
      '  if ($fx_el.TotalSeconds -gt 0) { $fx_cpu = 100.0 * (([long]$fx_p.KernelModeTime + [long]$fx_p.UserModeTime) / 10000000.0) / $fx_el.TotalSeconds / [Environment]::ProcessorCount }',
      '  $fx_mem = 0.0',
      '  if ($fx_totPhys -gt 0) { $fx_mem = 100.0 * [long]$fx_p.WorkingSetSize / $fx_totPhys }',
      '  $fx_vs = 0; try { $fx_vs = [math]::Round([long]$fx_p.VirtualSize / 1KB) } catch {}',
      '  $fx_rs = [math]::Round([long]$fx_p.WorkingSetSize / 1KB)',
      "  $fx_st = $fx_p.CreationDate.ToString('HH:mm')",
      "  if ($fx_p.CreationDate.Date -ne $fx_now.Date) { $fx_st = (fx-mon $fx_p.CreationDate.Month) + ' ' + ('{0,2}' -f $fx_p.CreationDate.Day) }",
      "  $fx_tm = '{0:d}:{1:d2}:{2:d2}' -f [int]$fx_el.TotalHours, $fx_el.Minutes, $fx_el.Seconds",
      '  $fx_cmd = [string]$fx_p.CommandLine',
      "  if ($fx_cmd -eq '') { $fx_cmd = [string]$fx_p.Name }",
      "  '{0,-8} {1,5} {2,4:0.0} {3,4:0.0} {4,9} {5,6} {6,-8} {7,-4} {8,6} {9,9} {10}' -f $fx_u, $fx_p.ProcessId, $fx_cpu, $fx_mem, $fx_vs, $fx_rs, '?', 'S', $fx_st, $fx_tm, $fx_cmd",
      '}',
    ].join('\n');
  }

  return [
    "'  PID TTY          TIME CMD'",
    '$fx_ps = @(Get-CimInstance Win32_Process | Sort-Object ProcessId)',
    'foreach ($fx_p in $fx_ps) {',
    '  $fx_ct = [timespan]::FromSeconds(([long]$fx_p.KernelModeTime + [long]$fx_p.UserModeTime) / 10000000.0)',
    "  '{0,5} {1,-13}{2,8} {3}' -f $fx_p.ProcessId, '-', ('{0:d2}:{1:d2}:{2:d2}' -f [int]$fx_ct.TotalHours, $fx_ct.Minutes, $fx_ct.Seconds), (([string]$fx_p.Name) -replace '\\.exe$', '')",
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* kill / pkill / pgrep                                                */
/* ------------------------------------------------------------------ */

const kill: Handler = (args) => {
  const raw = args.map(wordToString);
  let i = 0;
  let listMode = false;
  let sig = 'TERM';
  while (i < raw.length) {
    const t = raw[i];
    if (t === '--') {
      i++;
      break;
    }
    if (t === '-l' || t === '--list') {
      listMode = true;
      i++;
      continue;
    }
    if (t === '-s' || t === '--signal') {
      const v0 = (raw[i + 1] ?? '').replace(/^SIG/i, '').toUpperCase();
      let ok = false;
      if (/^\d+$/.test(v0)) {
        const n = parseInt(v0, 10);
        if (sigNumToName.has(n)) {
          sig = sigNumToName.get(n)!;
          ok = true;
        }
      } else if (sigNameToNum.has(v0)) {
        sig = v0;
        ok = true;
      }
      if (!ok) return killInvalidSignal(raw[i + 1] ?? '');
      i += 2;
      continue;
    }
    const ms = t.match(/^-(\d+)$/);
    if (ms) {
      const n = parseInt(ms[1], 10);
      if (!sigNumToName.has(n)) return killInvalidSignal(ms[1]);
      sig = sigNumToName.get(n)!;
      i++;
      continue;
    }
    const mn = t.match(/^-(?:SIG)?([A-Za-z][A-Za-z0-9]*)$/);
    if (mn) {
      const s = mn[1].toUpperCase();
      if (sigNameToNum.has(s)) {
        sig = s;
        i++;
        continue;
      }
    }
    break;
  }
  const rest = args.slice(i);

  if (listMode) {
    if (rest.length === 0) {
      const row1 = SIGNALS.slice(0, 16).map(([n]) => n).join(' ');
      const row2 = SIGNALS.slice(16).map(([n]) => n).join(' ');
      return psStr(row1) + '\n' + psStr(row2);
    }
    const lines: string[] = [];
    for (const w of rest) {
      const t = wordToString(w);
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (!sigNumToName.has(n)) return killInvalidSignal(t);
        lines.push(psStr(sigNumToName.get(n)!));
      } else {
        const s = t.replace(/^SIG/i, '').toUpperCase();
        if (!sigNameToNum.has(s)) return killInvalidSignal(t);
        lines.push(psStr(String(sigNameToNum.get(s))));
      }
    }
    return lines.join('\n');
  }

  if (rest.length === 0) {
    return (
      '[Console]::Error.WriteLine(' +
      psStr('bash: kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]') +
      '); $script:fx_exit = 2'
    );
  }

  // Windows cannot deliver SIGTERM to console processes — taskkill without
  // /F only works for GUI apps with a message pump. Both paths force-
  // terminate; -9/-KILL additionally takes down the process tree.
  const force = sig === 'KILL';
  const taskArgs = force ? "@('/PID', $fx_p, '/T', '/F')" : "@('/PID', $fx_p, '/F')";
  return [
    '$fx_pids = ' + textArgs(rest),
    'foreach ($fx_p in $fx_pids) {',
    "  if ($fx_p -notmatch '^[0-9]+$') { [Console]::Error.WriteLine('bash: kill: ' + $fx_p + ': arguments must be process or job IDs'); $script:fx_exit = 1; continue }",
    '  $fx_r = Start-Process -FilePath taskkill.exe -ArgumentList ' + taskArgs + ' -WindowStyle Hidden -Wait -PassThru',
    '  if ($fx_r.ExitCode -ne 0) { [Console]::Error.WriteLine("bash: kill: (" + $fx_p + ") - No such process"); $script:fx_exit = 1 }',
    '}',
  ].join('\n');
};

function pkillImpl(args: Word[], doKill: boolean): string {
  const raw = args.map(wordToString);
  let full = false;
  let force = false;
  let pat: Word | null = null;
  for (let k = 0; k < args.length; k++) {
    const t = raw[k];
    if (t === '--') {
      if (k + 1 < args.length) pat = args[k + 1];
      break;
    }
    if (t === '-f' || t === '--full' || t === '--list-full') {
      full = true;
      continue;
    }
    if (/^-\d+$/.test(t)) {
      if (parseInt(t.slice(1), 10) === 9) force = true;
      continue;
    }
    if (/^-(SIG)?KILL$/i.test(t)) {
      force = true;
      continue;
    }
    if (/^-(SIG)?[A-Za-z0-9]+$/.test(t)) continue; // other signals -> graceful
    if (t.startsWith('-')) continue;
    pat = args[k];
    break;
  }
  if (pat === null) {
    const cmd = doKill ? 'pkill' : 'pgrep';
    return (
      '[Console]::Error.WriteLine(' +
      psStr('usage: ' + cmd + ' [-f] [-signal] pattern') +
      '); $script:fx_exit = 2'
    );
  }
  const taskArgs = force
    ? "@('/PID', [string]$fx_p.ProcessId, '/T', '/F')"
    : "@('/PID', [string]$fx_p.ProcessId, '/F')";
  return [
    '$fx_pat = ' + exprOfWord(pat),
    '$fx_ps = @(Get-CimInstance Win32_Process | Sort-Object ProcessId)',
    // never kill our own ancestor chain (the agent invoking fauxnix)
    '$fx_mine = @()',
    '$fx_cur = $PID',
    'while ($fx_cur) {',
    '  $fx_mine += $fx_cur',
    '  $fx_pp = 0',
    '  foreach ($fx_x in $fx_ps) { if ($fx_x.ProcessId -eq $fx_cur) { $fx_pp = $fx_x.ParentProcessId; break } }',
    "  if ($fx_pp -and $fx_pp -ne 0 -and ($fx_mine -notcontains $fx_pp)) { $fx_cur = $fx_pp } else { $fx_cur = $null }",
    '}',
    '$fx_hits = @()',
    'foreach ($fx_p in $fx_ps) {',
    full ? "  $fx_s = [string]$fx_p.CommandLine" : "  $fx_s = ([string]$fx_p.Name) -replace '\\.exe$', ''",
    '  $fx_m = $false',
    '  try { $fx_m = [regex]::IsMatch($fx_s, $fx_pat) } catch {}',
    // agent-safety guards (stronger than GNU pkill): never match the host
    // shell wrappers (`bash -c "<user command>"` carries the pattern text in
    // argv) nor fauxnix's own -EncodedCommand runner processes.
    "  $fx_wrap = ((@('bash.exe','sh.exe','cmd.exe') -contains [string]$fx_p.Name) -and (([string]$fx_p.CommandLine) -match ' -c '))",
    "  $fx_self = ((@('powershell.exe','pwsh.exe') -contains [string]$fx_p.Name) -and (([string]$fx_p.CommandLine) -match '-EncodedCommand'))",
    '  if ($fx_m -and -not $fx_wrap -and -not $fx_self -and ($fx_mine -notcontains $fx_p.ProcessId)) { $fx_hits += ,$fx_p }',
    '}',    'foreach ($fx_p in $fx_hits) {',
    doKill
      ? '  $fx_r = Start-Process -FilePath taskkill.exe -ArgumentList ' + taskArgs + ' -WindowStyle Hidden -Wait -PassThru'
      : '  [string]$fx_p.ProcessId',
    doKill
      ? '  if ($fx_r.ExitCode -ne 0) { [Console]::Error.WriteLine("pkill: (" + $fx_p.ProcessId + ") - No such process"); $script:fx_exit = 1 }'
      : '',
    '}',
    'if ($fx_hits.Count -eq 0) { $script:fx_exit = 1 }',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

const pkill: Handler = (args) => pkillImpl(args, true);
const pgrep: Handler = (args) => pkillImpl(args, false);

/* ------------------------------------------------------------------ */
/* sleep                                                               */
/* ------------------------------------------------------------------ */

const sleep: Handler = (args) => {
  const ws = stripFlags(args);
  if (ws.length === 0) {
    return "[Console]::Error.WriteLine('sleep: missing operand'); $script:fx_exit = 1";
  }
  return [
    '$fx_t = 0.0',
    '$fx_as = ' + textArgs(ws),
    'foreach ($fx_a in $fx_as) {',
    "  if ($fx_a -notmatch '^[0-9]*\\.?[0-9]+[smhd]?$') { [Console]::Error.WriteLine(\"sleep: invalid time interval '\" + $fx_a + \"'\"); $script:fx_exit = 1; continue }",
    "  $fx_u = 's'",
    "  if ($fx_a -match '[smhd]$') { $fx_u = $fx_a.Substring($fx_a.Length - 1); $fx_a = $fx_a.Substring(0, $fx_a.Length - 1) }",
    '  $fx_v = [double]$fx_a',
    "  if ($fx_u -eq 'm') { $fx_v = $fx_v * 60 } elseif ($fx_u -eq 'h') { $fx_v = $fx_v * 3600 } elseif ($fx_u -eq 'd') { $fx_v = $fx_v * 86400 }",
    '  $fx_t += $fx_v',
    '}',
    'if ($script:fx_exit -eq 0) { Start-Sleep -Seconds $fx_t }',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* which / type                                                        */
/* ------------------------------------------------------------------ */

const which: Handler = (args) => {
  const ws = stripFlags(args);
  if (ws.length === 0) return '';
  return [
    PS_WHICH_FN,
    '$fx_b = @(' + builtinNames().map(psStr).join(', ') + ')',
    '$fx_ns = ' + textArgs(ws),
    'foreach ($fx_n in $fx_ns) {',
    "  if ($fx_b -contains $fx_n) { '/usr/bin/' + $fx_n }",
    "  elseif ((fx-which $fx_n) -eq '') { [Console]::Error.WriteLine('which: no ' + $fx_n + ' in (' + $env:PATH + ')'); $script:fx_exit = 1 }",
    '  else { fx-which $fx_n }',
    '}',
  ].join('\n');
};

const type: Handler = (args) => {
  const ws = stripFlags(args);
  if (ws.length === 0) return '';
  return [
    PS_WHICH_FN,
    '$fx_b = @(' + builtinNames().map(psStr).join(', ') + ')',
    '$fx_ns = ' + textArgs(ws),
    'foreach ($fx_n in $fx_ns) {',
    "  if ($fx_b -contains $fx_n) { $fx_n + ' is /usr/bin/' + $fx_n }",
    '  else {',
    '    $fx_w = fx-which $fx_n',
    "    if ($fx_w -eq '') { [Console]::Error.WriteLine('bash: type: ' + $fx_n + ': not found'); $script:fx_exit = 1 }",
    "    else { $fx_n + ' is ' + $fx_w.Replace('\\', '/') }",
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* whoami / id / groups                                                */
/* ------------------------------------------------------------------ */

const whoami: Handler = () => '$env:USERNAME.ToLower()';

const id: Handler = (args) => {
  const { flags } = parseWords(args);
  const wantNum = flags.has('u') || flags.has('g') || flags.has('G');
  const wantName = flags.has('n');
  const uidPs = [
    '$fx_sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    "$fx_ch = $fx_sid.Split('-')",
    '$fx_uid = [int]([long]($fx_ch[$fx_ch.Count - 1]) % 60000) + 1000',
  ];
  if (wantNum) {
    return [...uidPs, wantName ? '$env:USERNAME' : '[string]$fx_uid'].join('\n');
  }
  return [
    ...uidPs,
    "'uid=' + $fx_uid + '(' + $env:USERNAME + ') gid=' + $fx_uid + '(' + $env:USERNAME + ') groups=' + $fx_uid + '(' + $env:USERNAME + ')'",
  ].join('\n');
};

const groups: Handler = () => {
  return [
    '$fx_id = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$fx_gs = @()',
    'foreach ($fx_g in $fx_id.Groups) {',
    '  try { $fx_gs += ,$fx_g.Translate([System.Security.Principal.NTAccount]).Value } catch {}',
    '}',
    "if ($fx_gs.Count -eq 0) { $fx_gs = @('None') }",
    '$fx_names = @()',
    'foreach ($fx_g in $fx_gs) {',
    '  $fx_x = $fx_g',
    "  $fx_parts = $fx_g -split '\\\\'",
    '  if ($fx_parts.Count -gt 1) { $fx_x = $fx_parts[$fx_parts.Count - 1] }',
    '  $fx_names += $fx_x',
    '}',
    "$env:USERNAME + ' : ' + ($fx_names -join ' ')",
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* date                                                                */
/* ------------------------------------------------------------------ */

const DATE_FNS = [
  PS_MON_FN,
  "function fx-monf($m) { return @('January','February','March','April','May','June','July','August','September','October','November','December')[[int]$m - 1] }",
  "function fx-dow($d) { return @('Mon','Tue','Wed','Thu','Fri','Sat','Sun')[(([int]$d.DayOfWeek) + 6) % 7] }",
  "function fx-dowf($d) { return @('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')[(([int]$d.DayOfWeek) + 6) % 7] }",
  'function fx-tz($d) {',
  '  $fx_tzi = [TimeZoneInfo]::Local',
  '  $fx_n = $fx_tzi.StandardName',
  '  if ($d.IsDaylightSavingTime()) { $fx_n = $fx_tzi.DaylightName }',
  "  if ($fx_n -match 'Coordinated') { return 'UTC' }",
  '  $fx_ok = $true',
  '  foreach ($fx_c in $fx_n.ToCharArray()) { if ([int]$fx_c -gt 127 -or [int]$fx_c -lt 33) { $fx_ok = $false; break } }',
  "  if (-not $fx_ok -or $fx_n.Trim() -eq '') {",
  '    $fx_o = $fx_tzi.GetUtcOffset($d)',
  "    $fx_s = '+'; if ($fx_o.TotalMinutes -lt 0) { $fx_s = '-' }",
  '    $fx_m = [math]::Abs([int]$fx_o.TotalMinutes)',
  "    $fx_r = $fx_s + ('{0:d2}' -f [int]($fx_m / 60))",
    "    if (($fx_m % 60) -ne 0) { $fx_r = $fx_r + ('{0:d2}' -f ($fx_m % 60)) }",
    '    return $fx_r',
    '  }',
    '  $fx_a = \'\'',
    "  foreach ($fx_w in ($fx_n -split '\\s+')) { if ($fx_w.Length -gt 0) { $fx_a += $fx_w.Substring(0, 1) } }",
    '  return $fx_a.ToUpper()',
    '}',
    'function fx-datefmt($f, $d, $z) {',
    '  $fx_o = \'\'',
    '  for ($fx_i = 0; $fx_i -lt $f.Length; $fx_i++) {',
    '    $fx_c = [string]$f[$fx_i]',
    "    if ($fx_c -ne '%') { $fx_o += $fx_c; continue }",
    "    if ($fx_i + 1 -ge $f.Length) { $fx_o += '%'; break }",
    '    $fx_t = [string]$f[$fx_i + 1]; $fx_i++',
    '    switch -CaseSensitive ($fx_t) {',
    "      'Y' { $fx_o += ('{0:d4}' -f $d.Year) }",
    "      'm' { $fx_o += ('{0:d2}' -f $d.Month) }",
    "      'd' { $fx_o += ('{0:d2}' -f $d.Day) }",
    "      'H' { $fx_o += ('{0:d2}' -f $d.Hour) }",
    "      'M' { $fx_o += ('{0:d2}' -f $d.Minute) }",
    "      'S' { $fx_o += ('{0:d2}' -f $d.Second) }",
    "      'y' { $fx_o += ('{0:d2}' -f ($d.Year % 100)) }",
    "      'j' { $fx_o += ('{0:d3}' -f $d.DayOfYear) }",
    "      's' { $fx_o += [string][long](($d.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds) }",
    "      'F' { $fx_o += (('{0:d4}' -f $d.Year) + '-' + ('{0:d2}' -f $d.Month) + '-' + ('{0:d2}' -f $d.Day)) }",
    "      'T' { $fx_o += (('{0:d2}' -f $d.Hour) + ':' + ('{0:d2}' -f $d.Minute) + ':' + ('{0:d2}' -f $d.Second)) }",
    "      'Z' { $fx_o += $z }",
    "      'a' { $fx_o += (fx-dow $d) }",
    "      'A' { $fx_o += (fx-dowf $d) }",
    "      'b' { $fx_o += (fx-mon $d.Month) }",
    "      'B' { $fx_o += (fx-monf $d.Month) }",
    "      'p' { if ($d.Hour -lt 12) { $fx_o += 'AM' } else { $fx_o += 'PM' } }",
    "      'I' { $fx_o += ('{0:d2}' -f ((($d.Hour + 11) % 12) + 1)) }",
    "      'u' { $fx_o += [string](((([int]$d.DayOfWeek) + 6) % 7) + 1) }",
    "      'w' { $fx_o += [string][int]$d.DayOfWeek }",
    "      'e' { $fx_o += ('{0,2}' -f $d.Day) }",
    "      'D' { $fx_o += (('{0:d2}' -f $d.Month) + '/' + ('{0:d2}' -f $d.Day) + '/' + ('{0:d2}' -f ($d.Year % 100))) }",
    "      '%' { $fx_o += '%' }",
    "      default { $fx_o += ('%' + $fx_t) }",
    '    }',
    '  }',
    '  return $fx_o',
    '}',
].join('\n');

const date: Handler = (args) => {
  const { flags, operandWords } = parseWords(args, ['d']);
  const utc = flags.has('u');
  // find the -d value as a Word (so dynamic values stay PS expressions)
  const raw = args.map(wordToString);
  let dWord: Word | null = null;
  for (let k = 0; k < raw.length; k++) {
    if (raw[k] === '-d' || raw[k] === '--date') {
      dWord = args[k + 1] ?? null;
      break;
    }
  }
  const fmtWord = operandWords.find((w) => wordToString(w).startsWith('+'));

  const lines: string[] = [DATE_FNS];
  lines.push('$fx_d = ' + (utc ? '[DateTime]::UtcNow' : 'Get-Date'));
  lines.push('$fx_ok = $true');
  if (dWord !== null) {
    lines.push('$fx_ds = ' + exprOfWord(dWord));
    lines.push("if ($fx_ds -like '@*') {");
    lines.push(
      "  try { $fx_n = [long]($fx_ds.Substring(1)); $fx_d = ([datetime]'1970-01-01').AddSeconds($fx_n)" +
        (utc ? ' }' : '.ToLocalTime() }'),
    );
    lines.push('  catch { $fx_ok = $false }');
    lines.push('} else { $fx_ok = $false }');
    lines.push(
      '  if (-not $fx_ok) { [Console]::Error.WriteLine("date: invalid date \'" + $fx_ds + "\'"); $script:fx_exit = 1 }',
    );
  }
  lines.push('if ($fx_ok) {');
  lines.push('  $fx_z = ' + (utc ? "'UTC'" : '(fx-tz $fx_d)'));
  if (fmtWord) {
    lines.push('  $fx_f = ' + exprOfWord(fmtWord));
    lines.push('  fx-datefmt ($fx_f.Substring(1)) $fx_d $fx_z');
  } else {
    lines.push("  fx-datefmt '%a %b %e %H:%M:%S %Z %Y' $fx_d $fx_z");
  }
  lines.push('}');
  return lines.join('\n');
};

/* ------------------------------------------------------------------ */
/* uname / hostname / uptime / free / nproc                            */
/* ------------------------------------------------------------------ */

const ARCH_PS = "($(if ($env:PROCESSOR_ARCHITECTURE -like 'ARM*') { 'ARM64' } else { 'x86_64' }))";

const uname: Handler = (args) => {
  const { flags } = parseWords(args);
  if (flags.has('a')) {
    return (
      "('Linux ' + $env:COMPUTERNAME + ' 6.8.0-fauxnix #1 SMP PREEMPT_DYNAMIC ' + " +
      ARCH_PS +
      " + ' GNU/Linux')"
    );
  }
  const parts: string[] = [];
  if (flags.has('s') || flags.size === 0) parts.push("'Linux'");
  if (flags.has('n')) parts.push('$env:COMPUTERNAME');
  if (flags.has('r')) parts.push("'6.8.0-fauxnix'");
  if (flags.has('v')) parts.push("'#1 SMP PREEMPT_DYNAMIC'");
  if (flags.has('m') || flags.has('p')) parts.push(ARCH_PS);
  if (flags.has('o')) parts.push("'GNU/Linux'");
  if (parts.length === 0) parts.push("'Linux'");
  return '(@(' + parts.join(', ') + ") -join ' ')";
};

const hostname: Handler = () => '$env:COMPUTERNAME';

const uptime: Handler = () => {
  return [
    '$fx_now = Get-Date',
    '$fx_os = Get-CimInstance Win32_OperatingSystem',
    '$fx_el = $fx_now - $fx_os.LastBootUpTime',
    "$fx_up = '{0} min' -f [int][math]::Floor($fx_el.TotalMinutes)",
    "if ($fx_el.TotalHours -ge 1) { $fx_up = '{0:d}:{1:d2}' -f $fx_el.Hours, $fx_el.Minutes }",
    "if ($fx_el.Days -ge 2) { $fx_up = ('{0} days, ' -f $fx_el.Days) + ('{0:d}:{1:d2}' -f $fx_el.Hours, $fx_el.Minutes) }",
    "elseif ($fx_el.Days -eq 1) { $fx_up = '1 day, ' + ('{0:d}:{1:d2}' -f $fx_el.Hours, $fx_el.Minutes) }",
    "'{0} up {1},  0 users,  load average: 0.00, 0.00, 0.00' -f $fx_now.ToString('HH:mm:ss'), $fx_up",
  ].join('\n');
};

const free: Handler = (args) => {
  const { flags } = parseWords(args);
  const unit = flags.has('h') ? 'h' : flags.has('g') ? 'g' : flags.has('m') ? 'm' : 'k';
  // value converter for KB-based memory values
  let conv: (v: string) => string;
  if (unit === 'k') conv = (v) => '[string]' + v;
  else if (unit === 'm') conv = (v) => '[string][math]::Round(' + v + ' / 1KB)';
  else if (unit === 'g') conv = (v) => '[string][math]::Round(' + v + ' / 1MB)';
  else conv = (v) => '(fx-fh ' + v + ')';
  // value converter for MB-based swap values
  let convS: (v: string) => string;
  if (unit === 'k') convS = (v) => '[string](' + v + ' * 1KB)';
  else if (unit === 'm') convS = (v) => '[string]' + v;
  else if (unit === 'g') convS = (v) => '[string][math]::Round(' + v + ' / 1KB)';
  else convS = (v) => '(fx-fh (' + v + ' * 1KB))';

  const lines: string[] = [];
  if (unit === 'h') {
    lines.push(
      'function fx-fh($kb) {',
      "  if ($kb -ge 1MB) { return ('{0:0.#}Gi' -f ($kb / 1MB)) }",
      "  if ($kb -ge 1KB) { return ('{0:0.#}Mi' -f ($kb / 1KB)) }",
      "  if ($kb -le 0) { return '0B' }",
      "  return ('{0:0.#}Ki' -f $kb)",
      '}',
    );
  }
  lines.push(
    '$fx_os = Get-CimInstance Win32_OperatingSystem',
    '$fx_tk = [long]$fx_os.TotalVisibleMemorySize',
    '$fx_fk = [long]$fx_os.FreePhysicalMemory',
    '$fx_uk = $fx_tk - $fx_fk',
    '$fx_st = 0',
    '$fx_su = 0',
    'foreach ($fx_p in @(Get-CimInstance Win32_PageFileUsage)) { $fx_st += [long]$fx_p.AllocatedBaseSize; $fx_su += [long]$fx_p.CurrentUsage }',
    "'{0,-8}{1,13}{2,13}{3,13}{4,13}{5,13}{6,13}' -f '', 'total', 'used', 'free', 'shared', 'buff/cache', 'available'",
    "'{0,-8}{1,13}{2,13}{3,13}{4,13}{5,13}{6,13}' -f 'Mem:', " +
      conv('$fx_tk') +
      ', ' +
      conv('$fx_uk') +
      ', ' +
      conv('$fx_fk') +
      ", '0', '0', " +
      conv('$fx_fk'),
    "('{0,-8}{1,13}{2,13}{3,13}' -f 'Swap:', " +
      convS('$fx_st') +
      ', ' +
      convS('$fx_su') +
      ', ' +
      convS('($fx_st - $fx_su)') +
      ").TrimEnd()",
  );
  return lines.join('\n');
};

const nproc: Handler = () => '[string][Environment]::ProcessorCount';

/* ------------------------------------------------------------------ */
/* clear / true / false / :                                            */
/* ------------------------------------------------------------------ */

const clear: Handler = () => "([char]27 + '[2J' + [char]27 + '[H')";

const trueCmd: Handler = () => '';

const falseCmd: Handler = () => '$script:fx_exit = 1';

const colon: Handler = () => '';

/* ------------------------------------------------------------------ */
/* test / [                                                            */
/* ------------------------------------------------------------------ */

const TEST_UNARY = new Set(['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n']);
const TEST_BINARY = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
const TEST_BINARY_KSH = new Set([...TEST_BINARY, '=~', '>', '<']);

const FX_TN_FN = [
  'function fx-tn($a, $b, $op) {',
  "  if ($a -notmatch '^[+-]?[0-9]+$') { [Console]::Error.WriteLine('bash: [: ' + [string]$a + ': integer expression expected'); $script:fx_exit = 2; return $false }",
  "  if ($b -notmatch '^[+-]?[0-9]+$') { [Console]::Error.WriteLine('bash: [: ' + [string]$b + ': integer expression expected'); $script:fx_exit = 2; return $false }",
  '  $fx_x = [long]$a; $fx_y = [long]$b',
  '  switch ($op) {',
  "    '-eq' { return ($fx_x -eq $fx_y) }",
  "    '-ne' { return ($fx_x -ne $fx_y) }",
  "    '-lt' { return ($fx_x -lt $fx_y) }",
  "    '-le' { return ($fx_x -le $fx_y) }",
  "    '-gt' { return ($fx_x -gt $fx_y) }",
  "    '-ge' { return ($fx_x -ge $fx_y) }",
  '  }',
  '  return $false',
  '}',
].join('\n');

interface TestParse {
  expr: string | null;
  error: string | null;
}

function strNe(e: string): string {
  return "([string](" + e + ") -ne '')";
}

function testUnaryExpr(op: string, w: Word): string {
  switch (op) {
    case '-e':
    case '-r':
    case '-w':
    case '-x':
      return '(Test-Path -LiteralPath ' + operandExpr(w) + ')';
    case '-f':
      return '(Test-Path -LiteralPath ' + operandExpr(w) + ' -PathType Leaf)';
    case '-d':
      return '(Test-Path -LiteralPath ' + operandExpr(w) + ' -PathType Container)';
    case '-s':
      return (
        '((Test-Path -LiteralPath ' +
        operandExpr(w) +
        ' -PathType Leaf) -and ((Get-Item -LiteralPath ' +
        operandExpr(w) +
        ' -Force).Length -gt 0))'
      );
    case '-z':
      return "([string](" + exprOfWord(w) + ") -eq '')";
    case '-n':
    default:
      return strNe(exprOfWord(w));
  }
}

const FX_RE_FN = [
  'function fx-re($a, $b) {',
  '  try { return [regex]::IsMatch([string]$a, [string]$b) }',
  "  catch { [Console]::Error.WriteLine('bash: [[: invalid regular expression'); $script:fx_exit = 2; return $false }",
  '}',
].join('\n');

/** Build a regex pattern, escaping quoted portions (bash `[[ =~ ]]`). */
function regexOperandExpr(w: Word): string {
  if (w.length === 0) return "''";
  const bits: string[] = [];
  for (const p of w) {
    if (p.kind === 'SingleQuoted') {
      bits.push('[regex]::Escape(' + psStr(p.text) + ')');
    } else if (p.kind === 'DoubleQuoted') {
      bits.push('[regex]::Escape([string](' + exprOfWord([p]) + '))');
    } else if (p.kind === 'Text') {
      bits.push(psStr(p.text));
    } else {
      bits.push('[string](' + exprOfWord([p]) + ')');
    }
  }
  return bits.length === 1 ? bits[0] : '(' + bits.join(' + ') + ')';
}

function testBinaryExpr(l: Word, op: string, r: Word, allowKsh: boolean): string {
  const le = '[string](' + exprOfWord(l) + ')';
  const re = '[string](' + exprOfWord(r) + ')';
  if (op === '=~') return '(fx-re (' + le + ') (' + regexOperandExpr(r) + '))';
  if (op === '>' || op === '<') {
    const cmp =
      '[string]::Compare(' + le + ', ' + re + ', [System.StringComparison]::Ordinal)';
    return '((' + cmp + ') ' + (op === '>' ? '-gt' : '-lt') + ' 0)';
  }
  if (op === '=' || op === '==') {
    if (allowKsh && isFullyUnquoted(r)) return '((' + le + ') -clike (' + re + '))';
    return '(' + le + ' -ceq ' + re + ')';
  }
  if (op === '!=') {
    if (allowKsh && isFullyUnquoted(r)) return '((' + le + ') -cnotlike (' + re + '))';
    return '(' + le + ' -cne ' + re + ')';
  }
  return '(fx-tn (' + le + ') (' + re + ') ' + psStr(op) + ')';
}

function parseTestOr(ws: Word[], st: { i: number }, allowRe: boolean): TestParse {
  const r = parseTestAnd(ws, st, allowRe);
  if (r.error) return r;
  let expr = r.expr!;
  while (
    st.i < ws.length &&
    (wordToString(ws[st.i]) === '-o' || (allowRe && wordToString(ws[st.i]) === '||'))
  ) {
    st.i++;
    const rr = parseTestAnd(ws, st, allowRe);
    if (rr.error) return rr;
    expr = '(' + expr + ') -or (' + rr.expr + ')';
  }
  return { expr, error: null };
}

function parseTestAnd(ws: Word[], st: { i: number }, allowRe: boolean): TestParse {
  const r = parseTestNot(ws, st, allowRe);
  if (r.error) return r;
  let expr = r.expr!;
  while (
    st.i < ws.length &&
    (wordToString(ws[st.i]) === '-a' || (allowRe && wordToString(ws[st.i]) === '&&'))
  ) {
    st.i++;
    const rr = parseTestNot(ws, st, allowRe);
    if (rr.error) return rr;
    expr = '(' + expr + ') -and (' + rr.expr + ')';
  }
  return { expr, error: null };
}

function parseTestNot(ws: Word[], st: { i: number }, allowRe: boolean): TestParse {
  const t = st.i < ws.length ? wordToString(ws[st.i]) : null;
  if (t === '!' && st.i + 1 < ws.length) {
    st.i++;
    const r = parseTestNot(ws, st, allowRe);
    if (r.error) return r;
    return { expr: '(-not (' + r.expr + '))', error: null };
  }
  return parseTestAtom(ws, st, allowRe);
}

function parseTestAtom(ws: Word[], st: { i: number }, allowRe: boolean): TestParse {
  if (st.i >= ws.length) return { expr: null, error: 'too many arguments' };
  const t = wordToString(ws[st.i]);
  if (st.i === ws.length - 1) {
    // single remaining word: bash test treats any non-null string as true
    const e = exprOfWord(ws[st.i]);
    st.i++;
    return { expr: strNe(e), error: null };
  }
  if (TEST_UNARY.has(t)) {
    const w = ws[st.i + 1];
    st.i += 2;
    return { expr: testUnaryExpr(t, w), error: null };
  }
  const nt = wordToString(ws[st.i + 1]);
  const binaries = allowRe ? TEST_BINARY_KSH : TEST_BINARY;
  if (binaries.has(nt)) {
    if (st.i + 2 < ws.length) {
      const expr = testBinaryExpr(ws[st.i], nt, ws[st.i + 2], allowRe);
      st.i += 3;
      return { expr, error: null };
    }
    return { expr: null, error: 'OP:' + nt };
  }
  const e = exprOfWord(ws[st.i]);
  st.i++;
  return { expr: strNe(e), error: null };
}

function buildTest(ws: Word[], label: string, allowRe = false): string {
  if (ws.length === 0) return '$script:fx_exit = 1';
  const st = { i: 0 };
  const res = parseTestOr(ws, st, allowRe);
  let err: string | null = null;
  if (res.error) {
    err = res.error.startsWith('OP:')
      ? 'bash: ' + label + ': ' + res.error.slice(3) + ': binary operator expected'
      : 'bash: ' + label + ': ' + res.error;
  } else if (st.i < ws.length) {
    err = 'bash: ' + label + ': too many arguments';
  }
  if (err !== null) {
    return '[Console]::Error.WriteLine(' + psStr(err) + '); $script:fx_exit = 2';
  }
  const helpers = [FX_TN_FN];
  if (allowRe && res.expr && res.expr.indexOf('fx-re') >= 0) helpers.push(FX_RE_FN);
  return [
    ...helpers,
    '$fx_tr = ' + res.expr,
    'if ($script:fx_exit -eq 2) { }',
    'elseif (-not $fx_tr) { $script:fx_exit = 1 }',
  ].join('\n');
}

const test: Handler = (args) => buildTest(args, 'test');

const bracket: Handler = (args) => {
  if (args.length === 0 || !isUnquotedLiteral(args[args.length - 1], ']')) {
    return '[Console]::Error.WriteLine(' + psStr("bash: [: missing `]'") + '); $script:fx_exit = 2';
  }
  return buildTest(args.slice(0, -1), '[');
};

const dblBracket: Handler = (args) => {
  if (args.length === 0 || !isUnquotedLiteral(args[args.length - 1], ']]')) {
    return '[Console]::Error.WriteLine(' + psStr("bash: [[: missing `]]'") + '); $script:fx_exit = 2';
  }
  return buildTest(args.slice(0, -1), '[[', true);
};

/* ------------------------------------------------------------------ */
/* pushd / popd / dirs                                                 */
/* ------------------------------------------------------------------ */

/**
 * The directory stack lives in $env:FAUXNIX_DIRSTACK (entries BELOW the
 * current directory, ';'-joined) so it persists across fauxnix invocations
 * through the executor's env channel.
 */
const DIRS_STACK_PS = [
  '$fx_st = @()',
  "if ($env:FAUXNIX_DIRSTACK) { $fx_st = @($env:FAUXNIX_DIRSTACK -split ';' | Where-Object { $_ -ne '' }) }",
].join('\n');

const DIRS_PRINT_PS = [
  '$fx_l = @((Get-Location).Path)',
  'foreach ($fx_s in $fx_st) { $fx_l += $fx_s }',
  "($fx_l -join ' ').Replace('\\', '/')",
].join('\n');

const dirs: Handler = () => {
  return [DIRS_STACK_PS, DIRS_PRINT_PS].join('\n');
};

const pushd: Handler = (args) => {
  const operands = stripFlags(args);
  if (operands.length === 0) {
    // bash bare pushd: swap the top two entries
    return [
      DIRS_STACK_PS,
      "if ($fx_st.Count -eq 0) { [Console]::Error.WriteLine('bash: pushd: no other directory'); $script:fx_exit = 1 }",
      'else {',
      '  $fx_old = (Get-Location).Path',
      '  try { Set-Location -LiteralPath $fx_st[0] } catch { [Console]::Error.WriteLine("bash: pushd: " + $fx_st[0] + ": No such file or directory"); $script:fx_exit = 1 }',
      '  $fx_new = @($fx_old) + @($fx_st | Select-Object -Skip 1)',
      "  $env:FAUXNIX_DIRSTACK = ($fx_new -join ';')",
      '  if ($script:fx_exit -eq 0) { $fx_st = $fx_new; ' + DIRS_PRINT_PS + ' }',
      '}',
    ].join('\n');
  }
  if (operands.length > 1) {
    return "[Console]::Error.WriteLine('bash: pushd: too many arguments'); $script:fx_exit = 1";
  }
  return [
    DIRS_STACK_PS,
    '$fx_d = ' + operandExpr(operands[0]),
    'if (-not (Test-Path -LiteralPath $fx_d -PathType Container)) { [Console]::Error.WriteLine("bash: pushd: " + $fx_d + ": No such file or directory"); $script:fx_exit = 1 }',
    'else {',
    '  $fx_old = (Get-Location).Path',
    '  try { Set-Location -LiteralPath $fx_d } catch { [Console]::Error.WriteLine("bash: pushd: " + $fx_d + ": No such file or directory"); $script:fx_exit = 1 }',
    '  $fx_new = @($fx_old) + @($fx_st)',
    "  $env:FAUXNIX_DIRSTACK = ($fx_new -join ';')",
    '  if ($script:fx_exit -eq 0) { $fx_st = $fx_new; ' + DIRS_PRINT_PS + ' }',
    '}',
  ].join('\n');
};

const popd: Handler = () => {
  return [
    DIRS_STACK_PS,
    "if ($fx_st.Count -eq 0) { [Console]::Error.WriteLine('bash: popd: directory stack empty'); $script:fx_exit = 1 }",
    'else {',
    '  $fx_t = $fx_st[0]',
    '  $fx_rest = @($fx_st | Select-Object -Skip 1)',
    '  if (-not (Test-Path -LiteralPath $fx_t -PathType Container)) { [Console]::Error.WriteLine("bash: popd: " + $fx_t + ": No such file or directory"); $script:fx_exit = 1 }',
    '  else {',
    '    try { Set-Location -LiteralPath $fx_t } catch { [Console]::Error.WriteLine("bash: popd: " + $fx_t + ": No such file or directory"); $script:fx_exit = 1 }',
    "    $env:FAUXNIX_DIRSTACK = ($fx_rest -join ';')",
    '    if ($script:fx_exit -eq 0) { $fx_st = $fx_rest; ' + DIRS_PRINT_PS + ' }',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* sudo / timeout / man / history / less / more                        */
/* ------------------------------------------------------------------ */

const sudo: Handler = () => {
  return (
    '[Console]::Error.WriteLine(' +
    psStr(
      'sudo: fauxnix cannot elevate privileges; run your agent from an elevated shell if the operation needs it',
    ) +
    '); $script:fx_exit = 1'
  );
};

const timeout: Handler = (args, ctx) => {
  let i = 0;
  const raw = args.map(wordToString);
  while (i < raw.length && raw[i].startsWith('-') && raw[i] !== '-' && raw[i] !== '--') i++;
  if (i < raw.length && raw[i] === '--') i++;
  if (i >= args.length) {
    return "[Console]::Error.WriteLine('timeout: missing operand'); $script:fx_exit = 125";
  }
  const nWord = args[i];
  const cmdWords = args.slice(i + 1);
  if (cmdWords.length === 0) {
    return "[Console]::Error.WriteLine('timeout: missing operand'); $script:fx_exit = 125";
  }
  // NOTE: stdin is not forwarded into the job — documented limitation.
  const inner = translateSimple(
    { kind: 'SimpleCommand', assignments: [], name: cmdWords[0], args: cmdWords.slice(1), redirects: [] },
    ctx.position,
    false,
  );
  const innerLines = inner.split('\n').map((l) => (l ? '    ' + l : l));
  return [
    '$fx_tn = ' + exprOfWord(nWord),
    "if ($fx_tn -notmatch '^[0-9]*\\.?[0-9]+[smhd]?$') { [Console]::Error.WriteLine(\"timeout: invalid time interval '\" + $fx_tn + \"'\"); $script:fx_exit = 125 }",
    'else {',
    "  $fx_secs = [double]($fx_tn -replace '[smhd]$', '')",
    "  if ($fx_tn -match 'm$') { $fx_secs = $fx_secs * 60 } elseif ($fx_tn -match 'h$') { $fx_secs = $fx_secs * 3600 } elseif ($fx_tn -match 'd$') { $fx_secs = $fx_secs * 86400 }",
    '  $fx_sb = {',
    '    $script:fx_exit = 0',
    ...innerLines,
    "    '__FAUXNIX_EXIT__:' + [string]$script:fx_exit",
    '  }',
    '  $fx_j = Start-Job -ScriptBlock $fx_sb',
    '  $fx_deadline = (Get-Date).AddSeconds($fx_secs)',
    '  $fx_done = $false',
    '  while ((Get-Date) -lt $fx_deadline) {',
    "    if ((Get-Job -Id $fx_j.Id).State -ne 'Running') { $fx_done = $true; break }",
    '    Start-Sleep -Milliseconds 100',
    '  }',
    '  if (-not $fx_done) {',
    '    Stop-Job $fx_j',
    "    [Console]::Error.WriteLine('timeout: fauxnix timed out after ' + $fx_tn + 's')",
    '    $script:fx_exit = 124',
    '  } else {',
    '    $fx_out = @(Receive-Job $fx_j)',
    '    foreach ($fx_e in @($fx_j.ChildJobs[0].Error | ForEach-Object { [string]$_ })) { [Console]::Error.WriteLine($fx_e) }',
    '    if ($fx_out.Count -gt 0) {',
    '      $fx_last = [string]$fx_out[$fx_out.Count - 1]',
    "      if ($fx_last -like '__FAUXNIX_EXIT__:*') {",
    '        for ($fx_k = 0; $fx_k -lt ($fx_out.Count - 1); $fx_k++) { [string]$fx_out[$fx_k] }',
    "        $fx_c = 0",
    "        $fx_cv = $fx_last -replace '^__FAUXNIX_EXIT__:', ''",
    "        try { $fx_c = [int]$fx_cv } catch { $fx_c = 1 }",
    '        $script:fx_exit = $fx_c',
    '      } else {',
    '        foreach ($fx_o in $fx_out) { [string]$fx_o }',
    '      }',
    '    }',
    '  }',
    "  Remove-Job $fx_j -Force -ErrorAction SilentlyContinue",
    '}',
  ].join('\n');
};

const man: Handler = (args) => {
  const w = stripFlags(args)[0];
  if (!w) {
    return "[Console]::Error.WriteLine('What manual page do you want?'); $script:fx_exit = 2";
  }
  return [
    '$fx_m = ' + exprOfWord(w),
    "[Console]::Error.WriteLine('No manual entry for ' + $fx_m)",
    '[Console]::Error.WriteLine(\'(fauxnix: try "\' + $fx_m + \' --help" or "\' + $fx_m + \' -h")\')',
    '$script:fx_exit = 1',
  ].join('\n');
};

const history: Handler = () => '';

/** less/more: paging is impossible for agents — behave exactly like cat. */
const less: Handler = (args, ctx) => {
  const files = stripFlags(args);
  const cat = textIoHandlers['cat'];
  if (!cat) return '';
  return cat(files, ctx);
};

/* ------------------------------------------------------------------ */
/* source / . / eval / exit / alias / set                              */
/* ------------------------------------------------------------------ */

const source: Handler = () => {
  return (
    '[Console]::Error.WriteLine(' +
    psStr(
      'fauxnix: source/. requires a persistent shell; fauxnix persists cwd and env across calls but not shell functions',
    ) +
    '); $script:fx_exit = 1'
  );
};

const evalCmd: Handler = () => {
  return (
    "[Console]::Error.WriteLine('fauxnix: eval is not supported; pass the command itself'); $script:fx_exit = 1"
  );
};

const exitCmd: Handler = (args) => {
  const w = args[0];
  if (!w) return '$script:fx_exit = 0';
  const lit = wordToString(w);
  if (/^-?\d+$/.test(lit)) {
    let n = parseInt(lit, 10) % 256;
    if (n < 0) n += 256;
    return '$script:fx_exit = ' + n;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(lit)) {
    // static non-numeric literal
    return (
      '[Console]::Error.WriteLine(' +
      psStr('bash: exit: ' + lit + ': numeric argument required') +
      '); $script:fx_exit = 2'
    );
  }
  return [
    '$fx_e = ' + exprOfWord(w),
    "if ($fx_e -notmatch '^-?[0-9]+$') { [Console]::Error.WriteLine('bash: exit: ' + $fx_e + ': numeric argument required'); $script:fx_exit = 2 }",
    'else { $fx_n = [int]$fx_e % 256; if ($fx_n -lt 0) { $fx_n += 256 }; $script:fx_exit = $fx_n }',
  ].join('\n');
};

const alias: Handler = (args) => {
  const has = args.some((w) => {
    const t = wordToString(w);
    return t !== '' && !t.startsWith('-');
  });
  if (!has) return '';
  return "[Console]::Error.WriteLine('fauxnix: alias is not supported'); $script:fx_exit = 1";
};

const set: Handler = () => ''; // silently ignore (`set -e`, `set --` ... no-op)

/* ------------------------------------------------------------------ */

export const handlers: Record<string, Handler> = {
  cd,
  pwd,
  export: exportCmd,
  unset,
  env,
  printenv,
  ps,
  kill,
  pkill,
  pgrep,
  sleep,
  which,
  type,
  whoami,
  id,
  groups,
  date,
  uname,
  hostname,
  uptime,
  free,
  nproc,
  clear,
  true: trueCmd,
  false: falseCmd,
  test,
  '[': bracket,
  '[[': dblBracket,
  ':': colon,
  pushd,
  popd,
  dirs,
  sudo,
  timeout,
  man,
  history,
  less,
  more: less,
  source,
  '.': source,
  eval: evalCmd,
  exit: exitCmd,
  alias,
  set,
};
