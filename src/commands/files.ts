import { Word, wordToString } from '../ast.js';
import { Handler, parseWords, psStr } from '../registry.js';
import { exprOfWord, operandExpr } from '../translator.js';

/* ------------------------------------------------------------------ */
/* Shared PS snippets                                                  */
/* ------------------------------------------------------------------ */

/**
 * Glob resolution emitted into handlers: bash expands globs before the
 * command runs; PowerShell must do it explicitly. Unmatched globs stay
 * literal (bash behavior → downstream "No such file or directory").
 */
const PS_GLOB_FN = [
  'function fx-glob($p) {',
  "  if ($p -notlike '*[*?]*') { return @($p) }",
  '  $m = @(Get-Item -Path $p -ErrorAction SilentlyContinue)',
  '  if ($m.Count -eq 0) { return @($p) }',
  '  return @($m | ForEach-Object { $_.FullName })',
  '}',
].join('\n');

/** PS helper: read a file as text, UTF-8 first then GBK fallback. */
const PS_READTEXT_FN = [
  'function fx-read($p) {',
  '  $b = [IO.File]::ReadAllBytes($p)',
  '  try { return (New-Object System.Text.UTF8Encoding($false, $true)).GetString($b) }',
  '  catch { try { return [System.Text.Encoding]::GetEncoding(936).GetString($b) } catch { return [System.Text.Encoding]::ASCII.GetString($b) } }',
  '}',
].join('\n');

/** PS helper: GNU-style mtime string (MMM d HH:mm, or MMM d YYYY when old). */
const PS_FTIME_FN = [
  'function fx-time($d) {',
  "  if ($null -eq $d) { return 'Jan  1 00:00' }",
  "  $m = @{1='Jan';2='Feb';3='Mar';4='Apr';5='May';6='Jun';7='Jul';8='Aug';9='Sep';10='Oct';11='Nov';12='Dec'}[[int]$d.Month]",
  "  $day = '{0,2}' -f $d.Day",
  '  $old = (((Get-Date) - $d).TotalDays -gt 182) -or (((Get-Date) - $d).TotalDays -lt -182)',
  "  if ($old) { return ($m + ' ' + $day + ' ' + $d.Year) }",
  "  return ($m + ' ' + $day + ' ' + $d.ToString('HH:mm'))",
  '}',
].join('\n');

/** PS helper: human-readable size (GNU style: 1.5K, 2.3M...). */
const PS_HSIZE_FN = [
  'function fx-hsize($n) {',
  "  $u = 'B'; if ($n -ge 1GB) { $n = [math]::Round($n / 1GB, 1); $u = 'G' } elseif ($n -ge 1MB) { $n = [math]::Round($n / 1MB, 1); $u = 'M' } elseif ($n -ge 1KB) { $n = [math]::Round($n / 1KB, 1); $u = 'K' }",
  "  return ('{0}{1}' -f $n, $u)",
  '}',
].join('\n');

/** Operand Words → PS array expression of string exprs. */
function psArray(words: Word[], fn: (w: Word) => string = operandExpr): string {
  if (words.length === 0) return '@()';
  return '@(' + words.map(fn).join(', ') + ')';
}

/* ------------------------------------------------------------------ */
/* ls                                                                  */
/* ------------------------------------------------------------------ */

const ls: Handler = (args) => {
  const { flags, longs, operandWords } = parseWords(args);
  const long = flags.has('l') || longs.has('--format=long') || longs.has('--long');
  const all = flags.has('a') || longs.has('--all');
  const almost = flags.has('A') || longs.has('--almost-all');
  const dirOnly = flags.has('d') || longs.has('--directory');
  const human = flags.has('h') || longs.has('--human-readable');
  const classify = flags.has('F') || flags.has('p') || longs.has('--classify');
  const sortByTime = flags.has('t');
  const sortBySize = flags.has('S');
  const reverse = flags.has('r');
  const targets = operandWords.length ? operandWords.map((w) => operandExpr(w)) : ["'.'"];

  return [
    PS_GLOB_FN,
    PS_FTIME_FN,
    'function fx-mode($it) {',
    "  $t = '-'; if ($it.PSIsContainer) { $t = 'd' } elseif ($it.LinkType) { $t = 'l' }",
    "  if ($it.PSIsContainer) { return ($t + 'rwxr-xr-x') }",
    "  $ro = $it.Attributes.ToString().Contains('ReadOnly')",
    '  $ex = $false',
    "  if (-not $it.PSIsContainer) { $ex = @('.exe','.bat','.cmd','.ps1','.com','.msi','.sh','.py') -contains $it.Extension.ToLower() }",
    "  if ($ro) { return ($t + 'r--r--r--') }",
    "  if ($ex) { return ($t + 'rwxr-xr-x') }",
    "  return ($t + 'rw-r--r--')",
    '}',
    'function fx-name($it) {',
    '  $n = $it.Name',
    '  if (' + (classify ? '$true' : '$false') + ') {',
    "    if ($it.PSIsContainer) { $n = $n + '/' } elseif (@('.exe','.bat','.cmd','.com','.msi','.ps1') -contains $it.Extension.ToLower()) { $n = $n + '*' } elseif ($it.LinkType) { $n = $n + '@' }",
    '  }',
    '  return $n',
    '}',
    '$fx_targets = @(' + targets.join(', ') + ')',
    '$fx_all = @()',
    'foreach ($fx_t in $fx_targets) {',
    '  foreach ($fx_g in (fx-glob $fx_t)) {',
    '    if (-not (Test-Path -LiteralPath $fx_g)) {',
    '      [Console]::Error.WriteLine("ls: cannot access \'" + $fx_t + "\': No such file or directory"); $script:fx_exit = 2; continue',
    '    }',
    '    $fx_all += ,(Get-Item -LiteralPath $fx_g -Force)',
    '  }',
    '}',
    '$fx_show = @()',
    'if (' + (dirOnly ? '$true' : '$false') + ') { $fx_show = $fx_all }',
    'else {',
    '  foreach ($fx_it in $fx_all) {',
    '    if ($fx_it.PSIsContainer) {',
    '      $fx_show += @(Get-ChildItem -LiteralPath $fx_it.FullName -Force:' + (all || almost ? '$true' : '$false') + ')',
    '    } else { $fx_show += ,$fx_it }',
    '  }',
    '}',
    'if (' + (sortByTime ? '$true' : '$false') + ') { $fx_show = @($fx_show | Sort-Object -Property LastWriteTime -Descending) }',
    'elseif (' + (sortBySize ? '$true' : '$false') + ') { $fx_show = @($fx_show | Sort-Object -Property Length -Descending) }',
    'else { $fx_show = @($fx_show | Sort-Object -Property Name) }',
    'if (' + (reverse ? '$true' : '$false') + ') { [array]::Reverse($fx_show) }',
    'foreach ($fx_it in $fx_show) {',
    '  if (' + (long ? '$true' : '$false') + ') {',
    '    $fx_size = 4096',
    '    if (-not $fx_it.PSIsContainer) { try { $fx_size = $fx_it.Length } catch { $fx_size = 0 } }',
    '    if (' + (human ? '$true' : '$false') + ') { $fx_s = fx-hsize $fx_size } else { $fx_s = [string]$fx_size }',
    "    '{0} 1 {1} {2} {3,13} {4} {5}' -f (fx-mode $fx_it), $env:USERNAME, $env:USERNAME, $fx_s, (fx-time $fx_it.LastWriteTime), (fx-name $fx_it)",
    '  } else {',
    '    fx-name $fx_it',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* cp / mv / rm                                                        */
/* ------------------------------------------------------------------ */

const cp: Handler = (args) => {
  const { flags, longs, operandWords } = parseWords(args);
  const recurse = flags.has('r') || flags.has('R') || longs.has('--recursive');
  const verbose = flags.has('v') || longs.has('--verbose');
  const srcs = psArray(operandWords.slice(0, -1));
  const dst = operandWords.length >= 2 ? operandExpr(operandWords[operandWords.length - 1]) : "''";
  return [
    PS_GLOB_FN,
    '$fx_srcs = ' + srcs,
    '$fx_dst = ' + dst,
    "if ($fx_srcs.Count -eq 0) { [Console]::Error.WriteLine('cp: missing file operand'); $script:fx_exit = 1 }",
    "elseif ($fx_dst -eq '') { [Console]::Error.WriteLine('cp: missing destination file operand'); $script:fx_exit = 1 }",
    'else {',
    '  foreach ($fx_s in $fx_srcs) {',
    '    foreach ($fx_g in (fx-glob $fx_s)) {',
    '      if (-not (Test-Path -LiteralPath $fx_g)) { [Console]::Error.WriteLine("cp: cannot stat \'" + $fx_g + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '      $fx_isdir = (Test-Path -LiteralPath $fx_g -PathType Container)',
    '      if ($fx_isdir -and ' + (recurse ? '$false' : '$true') + ') { [Console]::Error.WriteLine("cp: -r not specified; omitting directory \'" + $fx_g + "\'"); $script:fx_exit = 1; continue }',
    '      $fx_target = $fx_dst',
    '      if (Test-Path -LiteralPath $fx_dst -PathType Container) { $fx_target = Join-Path $fx_dst (Split-Path $fx_g -Leaf) }',
    '      try {',
    '        Copy-Item -LiteralPath $fx_g -Destination $fx_target -Recurse:' + (recurse ? '$true' : '$false') + ' -Force',
    '        if (' + (verbose ? '$true' : '$false') + ') { [Console]::Error.WriteLine("\'" + $fx_g + "\' -> \'" + $fx_target + "\'") }',
    '      } catch { [Console]::Error.WriteLine("cp: cannot copy \'" + $fx_g + "\': " + $_.Exception.Message); $script:fx_exit = 1 }',
    '    }',
    '  }',
    '}',
  ].join('\n');
};

const mv: Handler = (args) => {
  const { flags, longs, operandWords } = parseWords(args);
  const verbose = flags.has('v') || longs.has('--verbose');
  const srcs = psArray(operandWords.slice(0, -1));
  const dst = operandWords.length >= 2 ? operandExpr(operandWords[operandWords.length - 1]) : "''";
  return [
    PS_GLOB_FN,
    '$fx_srcs = ' + srcs,
    '$fx_dst = ' + dst,
    "if ($fx_srcs.Count -eq 0) { [Console]::Error.WriteLine('mv: missing file operand'); $script:fx_exit = 1 }",
    "elseif ($fx_dst -eq '') { [Console]::Error.WriteLine('mv: missing destination file operand'); $script:fx_exit = 1 }",
    'elseif ($fx_srcs.Count -gt 1 -and -not (Test-Path -LiteralPath $fx_dst -PathType Container)) { [Console]::Error.WriteLine("mv: target \'" + $fx_dst + "\' is not a directory"); $script:fx_exit = 1 }',
    'else {',
    '  foreach ($fx_s in $fx_srcs) {',
    '    foreach ($fx_g in (fx-glob $fx_s)) {',
    '      if (-not (Test-Path -LiteralPath $fx_g)) { [Console]::Error.WriteLine("mv: cannot stat \'" + $fx_g + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '      $fx_target = $fx_dst',
    '      if (Test-Path -LiteralPath $fx_dst -PathType Container) { $fx_target = Join-Path $fx_dst (Split-Path $fx_g -Leaf) }',
    '      try {',
    '        if (Test-Path -LiteralPath $fx_target) { Remove-Item -LiteralPath $fx_target -Recurse -Force }',
    '        Move-Item -LiteralPath $fx_g -Destination $fx_target -Force',
    '        if (' + (verbose ? '$true' : '$false') + ') { [Console]::Error.WriteLine("renamed \'" + $fx_g + "\' -> \'" + $fx_target + "\'") }',
    '      } catch { [Console]::Error.WriteLine("mv: cannot move \'" + $fx_g + "\': " + $_.Exception.Message); $script:fx_exit = 1 }',
    '    }',
    '  }',
    '}',
  ].join('\n');
};

const rm: Handler = (args) => {
  const { flags, longs, operandWords } = parseWords(args);
  const recurse = flags.has('r') || flags.has('R') || longs.has('--recursive');
  const force = flags.has('f') || longs.has('--force');
  const verbose = flags.has('v');
  return [
    PS_GLOB_FN,
    '$fx_files = ' + psArray(operandWords),
    'if ($fx_files.Count -eq 0 -and ' + (force ? '$false' : '$true') + ') { [Console]::Error.WriteLine(\'rm: missing operand\'); $script:fx_exit = 1 }',
    'foreach ($fx_f in $fx_files) {',
    '  foreach ($fx_g in (fx-glob $fx_f)) {',
    '    if (-not (Test-Path -LiteralPath $fx_g)) {',
    '      if (' + (force ? '$false' : '$true') + ') { [Console]::Error.WriteLine("rm: cannot remove \'" + $fx_g + "\': No such file or directory"); $script:fx_exit = 1 }',
    '      continue',
    '    }',
    '    $fx_isdir = (Test-Path -LiteralPath $fx_g -PathType Container)',
    '    if ($fx_isdir -and ' + (recurse ? '$false' : '$true') + ') { [Console]::Error.WriteLine("rm: cannot remove \'" + $fx_g + "\': Is a directory"); $script:fx_exit = 1; continue }',
    '    try {',
    '      Remove-Item -LiteralPath $fx_g -Recurse:' + (recurse ? '$true' : '$false') + ' -Force',
    '      if (' + (verbose ? '$true' : '$false') + ') { [Console]::Error.WriteLine("removed \'" + $fx_g + "\'") }',
    '    } catch { [Console]::Error.WriteLine("rm: cannot remove \'" + $fx_g + "\': Permission denied"); $script:fx_exit = 1 }',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* mkdir / rmdir / touch / mktemp                                      */
/* ------------------------------------------------------------------ */

const mkdir: Handler = (args) => {
  const { flags, longs, operandWords } = parseWords(args);
  const parents = flags.has('p') || longs.has('--parents');
  const verbose = flags.has('v');
  return [
    '$fx_dirs = ' + psArray(operandWords),
    "if ($fx_dirs.Count -eq 0) { [Console]::Error.WriteLine('mkdir: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_d in $fx_dirs) {',
    '  if (Test-Path -LiteralPath $fx_d) {',
    '    if (' + (parents ? '$false' : '$true') + ') { [Console]::Error.WriteLine("mkdir: cannot create directory \'" + $fx_d + "\': File exists"); $script:fx_exit = 1 }',
    '    continue',
    '  }',
    '  try {',
    '    New-Item -ItemType Directory -Path $fx_d -Force:' + (parents ? '$true' : '$false') + ' | Out-Null',
    '    if (' + (verbose ? '$true' : '$false') + ') { [Console]::Error.WriteLine("mkdir: created directory \'" + $fx_d + "\'") }',
    '  } catch { [Console]::Error.WriteLine("mkdir: cannot create directory \'" + $fx_d + "\': " + $_.Exception.Message); $script:fx_exit = 1 }',
    '}',
  ].join('\n');
};

const rmdir: Handler = (args) => {
  const { operandWords } = parseWords(args);
  return [
    '$fx_dirs = ' + psArray(operandWords),
    "if ($fx_dirs.Count -eq 0) { [Console]::Error.WriteLine('rmdir: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_d in $fx_dirs) {',
    '  if (-not (Test-Path -LiteralPath $fx_d -PathType Container)) { [Console]::Error.WriteLine("rmdir: failed to remove \'" + $fx_d + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '  if ((Get-ChildItem -LiteralPath $fx_d -Force).Count -gt 0) { [Console]::Error.WriteLine("rmdir: failed to remove \'" + $fx_d + "\': Directory not empty"); $script:fx_exit = 1; continue }',
    '  try { Remove-Item -LiteralPath $fx_d -Force } catch { [Console]::Error.WriteLine("rmdir: failed to remove \'" + $fx_d + "\': " + $_.Exception.Message); $script:fx_exit = 1 }',
    '}',
  ].join('\n');
};

const touch: Handler = (args) => {
  const { operandWords } = parseWords(args);
  return [
    '$fx_files = ' + psArray(operandWords),
    "if ($fx_files.Count -eq 0) { [Console]::Error.WriteLine('touch: missing file operand'); $script:fx_exit = 1 }",
    'foreach ($fx_f in $fx_files) {',
    '  if (Test-Path -LiteralPath $fx_f) {',
    '    try { (Get-Item -LiteralPath $fx_f).LastWriteTime = Get-Date } catch { [Console]::Error.WriteLine("touch: cannot touch \'" + $fx_f + "\': Permission denied"); $script:fx_exit = 1 }',
    '  } else {',
    '    try { New-Item -ItemType File -Path $fx_f | Out-Null }',
    '    catch { [Console]::Error.WriteLine("touch: cannot touch \'" + $fx_f + "\': No such file or directory"); $script:fx_exit = 1 }',
    '  }',
    '}',
  ].join('\n');
};

const mktemp: Handler = (args) => {
  const { flags } = parseWords(args);
  const dir = flags.has('d');
  return [
    'try {',
    '  if (' + (dir ? '$true' : '$false') + ') {',
    "    $fx_p = Join-Path $env:TEMP ('fauxnix-' + ([IO.Path]::GetRandomFileName() -replace '\\.', ''))",
    '    New-Item -ItemType Directory -Path $fx_p | Out-Null',
    '  } else {',
    '    $fx_p = [IO.Path]::GetTempFileName()',
    '  }',
    '  $fx_p',
    "} catch { [Console]::Error.WriteLine('mktemp: failed to create file: ' + $_.Exception.Message); $script:fx_exit = 1 }",
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* ln / readlink / realpath                                            */
/* ------------------------------------------------------------------ */

const ln: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const sym = flags.has('s');
  const src = operandWords.length >= 2 ? operandExpr(operandWords[0]) : "''";
  const dst = operandWords.length >= 2 ? operandExpr(operandWords[1]) : "''";
  const kind = sym ? 'SymbolicLink' : 'HardLink';
  const label = sym ? 'symbolic link' : 'hard link';
  return [
    '$fx_src = ' + src,
    '$fx_dst = ' + dst,
    "if ($fx_src -eq '' -or $fx_dst -eq '') { [Console]::Error.WriteLine('ln: missing file operand'); $script:fx_exit = 1 }",
    'else {',
    '  if (Test-Path -LiteralPath $fx_dst -PathType Container) { $fx_dst = Join-Path $fx_dst (Split-Path $fx_src -Leaf) }',
    '  try { New-Item -ItemType ' + kind + ' -Path $fx_dst -Target $fx_src | Out-Null }',
    '  catch { [Console]::Error.WriteLine("ln: failed to create ' + label + ' \'" + $fx_dst + "\': " + $_.Exception.Message); $script:fx_exit = 1 }',
    '}',
  ].join('\n');
};

const readlink: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const canon = flags.has('f');
  return [
    '$fx_p = ' + (operandWords.length ? operandExpr(operandWords[0]) : "''"),
    "if ($fx_p -eq '') { [Console]::Error.WriteLine('readlink: missing operand'); $script:fx_exit = 1 }",
    'elseif (-not (Test-Path -LiteralPath $fx_p)) { [Console]::Error.WriteLine("readlink: " + $fx_p + ": No such file or directory"); $script:fx_exit = 1 }',
    'else {',
    '  if (' + (canon ? '$true' : '$false') + ') { (Resolve-Path -LiteralPath $fx_p).ProviderPath }',
    '  else {',
    '    $fx_it = Get-Item -LiteralPath $fx_p -Force',
    '    if ($fx_it.LinkType) { $fx_it.Target }',
    '    else { $script:fx_exit = 1 }',
    '  }',
    '}',
  ].join('\n');
};

const realpath: Handler = (args) => {
  const { operandWords } = parseWords(args);
  return [
    '$fx_ps = ' + psArray(operandWords),
    "if ($fx_ps.Count -eq 0) { [Console]::Error.WriteLine('realpath: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_p in $fx_ps) {',
    '  if (-not (Test-Path -LiteralPath $fx_p)) { [Console]::Error.WriteLine("realpath: " + $fx_p + ": No such file or directory"); $script:fx_exit = 1; continue }',
    '  (Resolve-Path -LiteralPath $fx_p).ProviderPath',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* basename / dirname                                                  */
/* ------------------------------------------------------------------ */

const basename: Handler = (args) => {
  if (args.length === 2) {
    return [
      '$fx_p = ' + exprOfWord(args[0]),
      '$fx_sfx = ' + exprOfWord(args[1]),
      "$fx_n = [IO.Path]::GetFileName(($fx_p.TrimEnd('/')).TrimEnd('\\'))",
      "if ($fx_n -eq '') { $fx_n = '/' }",
      "if ($fx_sfx -ne '' -and $fx_n.EndsWith($fx_sfx) -and ($fx_n.Length -gt $fx_sfx.Length)) { $fx_n = $fx_n.Substring(0, $fx_n.Length - $fx_sfx.Length) }",
      '$fx_n',
    ].join('\n');
  }
  return [
    '$fx_ps = @(' + args.map(exprOfWord).join(', ') + ')',
    "if ($fx_ps.Count -eq 0) { [Console]::Error.WriteLine('basename: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_p in $fx_ps) {',
    "  $fx_n = [IO.Path]::GetFileName(($fx_p.TrimEnd('/')).TrimEnd('\\'))",
    "  if ($fx_n -eq '') { $fx_n = '/' }",
    '  $fx_n',
    '}',
  ].join('\n');
};

const dirname: Handler = (args) => {
  return [
    '$fx_ps = @(' + args.map(exprOfWord).join(', ') + ')',
    "if ($fx_ps.Count -eq 0) { [Console]::Error.WriteLine('dirname: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_p in $fx_ps) {',
    "  $fx_n = ($fx_p.TrimEnd('/')).TrimEnd('\\')",
    "  $fx_i = [math]::Max($fx_n.LastIndexOf('/'), $fx_n.LastIndexOf('\\'))",
    "  if ($fx_i -lt 0) { '.' }",
    '  elseif ($fx_i -eq 0) { $fx_n.Substring(0, 1) }',
    "  else { $fx_n.Substring(0, $fx_i).Replace('\\', '/') }",
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* stat / file                                                         */
/* ------------------------------------------------------------------ */

const stat: Handler = (args) => {
  const { longs, values, operandWords } = parseWords(args, ['c'], ['--format', '--printf']);
  const fmt = values.get('-c') ?? values.get('--format') ?? values.get('--printf') ?? null;
  return [
    PS_FTIME_FN,
    PS_GLOB_FN,
    '$fx_files = ' + psArray(operandWords),
    "if ($fx_files.Count -eq 0) { [Console]::Error.WriteLine('stat: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_f in $fx_files) {',
    '  foreach ($fx_g in (fx-glob $fx_f)) {',
    '    if (-not (Test-Path -LiteralPath $fx_g)) { [Console]::Error.WriteLine("stat: cannot statx \'" + $fx_g + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '    $fx_it = Get-Item -LiteralPath $fx_g -Force',
    '    $fx_size = 0; if (-not $fx_it.PSIsContainer) { try { $fx_size = $fx_it.Length } catch {} }',
    "    $fx_ft = 'regular file'; if ($fx_it.PSIsContainer) { $fx_ft = 'directory' } elseif ($fx_it.LinkType) { $fx_ft = 'symbolic link' }",
    "    $fx_ro = $fx_it.Attributes.ToString().Contains('ReadOnly')",
    "    $fx_mode = '0664'; if ($fx_it.PSIsContainer) { $fx_mode = '0775' } elseif ($fx_ro) { $fx_mode = '0444' }",
    "    $fx_epoch = [int](($fx_it.LastWriteTime.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds)",
    '    if (' + (fmt ? '$true' : '$false') + ') {',
    '      $fx_o = ' + psStr(fmt ?? ''),
    "      $fx_o = $fx_o.Replace('%s', [string]$fx_size).Replace('%n', $fx_g).Replace('%F', $fx_ft).Replace('%a', $fx_mode).Replace('%Y', [string]$fx_epoch).Replace('%y', $fx_it.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')).Replace('%%', '%')",
    '      $fx_o',
    '    } else {',
    '      "  File: " + $fx_g',
    '      ("  Size: {0}`tBlocks: {1}`tIO Block: 4096  {2}" -f $fx_size, [math]::Ceiling($fx_size / 512), $fx_ft)',
    '      "Device: 8h/8d`tInode: 0`tLinks: 1"',
    '      ("Access: ({0})  Uid: {1}   Gid: {1}" -f $fx_mode, $env:USERNAME)',
    "      (\"Modify: {0}.000000000 +0000\" -f $fx_it.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))",
    '    }',
    '  }',
    '}',
  ].join('\n');
};

const file: Handler = (args) => {
  const { operandWords } = parseWords(args);
  return [
    PS_GLOB_FN,
    PS_READTEXT_FN,
    '$fx_files = ' + psArray(operandWords),
    "if ($fx_files.Count -eq 0) { [Console]::Error.WriteLine('file: missing operand'); $script:fx_exit = 1 }",
    'foreach ($fx_f in $fx_files) {',
    '  foreach ($fx_g in (fx-glob $fx_f)) {',
    '    if (-not (Test-Path -LiteralPath $fx_g)) { [Console]::Error.WriteLine($fx_g + ": cannot open (No such file or directory)"); $script:fx_exit = 1; continue }',
    '    $fx_it = Get-Item -LiteralPath $fx_g -Force',
    '    if ($fx_it.PSIsContainer) { "$fx_g: directory"; continue }',
    '    if ($fx_it.LinkType) { "$fx_g: symbolic link to " + $fx_it.Target; continue }',
    '    $fx_ext = $fx_it.Extension.ToLower()',
    '    if (@(\'.exe\', \'.dll\', \'.sys\') -contains $fx_ext) { "$fx_g: PE32+ executable (console) Intel 80386, for MS Windows"; continue }',
    '    $fx_bytes = [IO.File]::ReadAllBytes($fx_g)',
    '    if ($fx_bytes.Length -eq 0) { "$fx_g: empty"; continue }',
    '    $fx_nul = $false',
    '    $fx_lim = [math]::Min(8192, $fx_bytes.Length)',
    '    for ($fx_i = 0; $fx_i -lt $fx_lim; $fx_i++) { if ($fx_bytes[$fx_i] -eq 0) { $fx_nul = $true; break } }',
    '    if ($fx_nul) { "$fx_g: data"; continue }',
    '    $fx_txt = fx-read $fx_g',
    '    if ($fx_txt.StartsWith(\'#!/\')) { "$fx_g: " + $fx_txt.Split("`n")[0].Trim() + " a /bin/sh script text executable" }',
    '    else {',
    '      $fx_nonascii = $false',
    '      foreach ($fx_c in $fx_txt.ToCharArray()) { if ([int]$fx_c -gt 127) { $fx_nonascii = $true; break } }',
    '      if ($fx_nonascii) { "$fx_g: UTF-8 Unicode text" } else { "$fx_g: ASCII text" }',
    '    }',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* du / df                                                             */
/* ------------------------------------------------------------------ */

const du: Handler = (args) => {
  const { flags, longs, operandWords } = parseWords(args, [], ['--max-depth']);
  const sum = flags.has('s') || longs.has('--summarize');
  const human = flags.has('h') || longs.has('--human-readable');
  const targets = operandWords.length ? operandWords.map((w) => operandExpr(w)) : ["'.'"];
  return [
    PS_HSIZE_FN,
    'function fx-size($p) {',
    '  $t = 0',
    '  Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object { $t += $_.Length }',
    '  return [math]::Ceiling($t / 1KB)',
    '}',
    '$fx_ts = @(' + targets.join(', ') + ')',
    'foreach ($fx_t in $fx_ts) {',
    '  if (-not (Test-Path -LiteralPath $fx_t)) { [Console]::Error.WriteLine("du: cannot access \'" + $fx_t + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '  if (' + (sum ? '$true' : '$false') + ') {',
    '    $fx_kb = fx-size $fx_t',
    '    if (' + (human ? '$true' : '$false') + ') { "{0}`t{1}" -f (fx-hsize ($fx_kb * 1KB)), $fx_t } else { "{0}`t{1}" -f $fx_kb, $fx_t }',
    '  } else {',
    '    $fx_root = (Get-Item -LiteralPath $fx_t -Force).FullName',
    '    foreach ($fx_d in @(Get-ChildItem -LiteralPath $fx_t -Recurse -Force -Directory -ErrorAction SilentlyContinue)) {',
    '      $fx_kb = fx-size $fx_d.FullName',
    "      $fx_rel = './' + $fx_d.FullName.Substring($fx_root.Length).TrimStart('\\').Replace('\\', '/')",
    '      if (' + (human ? '$true' : '$false') + ') { "{0}`t{1}" -f (fx-hsize ($fx_kb * 1KB)), $fx_rel } else { "{0}`t{1}" -f $fx_kb, $fx_rel }',
    '    }',
    '    $fx_kb = fx-size $fx_t',
    '    if (' + (human ? '$true' : '$false') + ') { "{0}`t{1}" -f (fx-hsize ($fx_kb * 1KB)), $fx_t } else { "{0}`t{1}" -f $fx_kb, $fx_t }',
    '  }',
    '}',
  ].join('\n');
};

const df: Handler = (args) => {
  const { flags } = parseWords(args);
  const human = flags.has('h') || flags.has('H');
  return [
    PS_HSIZE_FN,
    '"Filesystem      Size  Used Avail Use% Mounted on"',
    'foreach ($fx_d in (Get-PSDrive -PSProvider FileSystem)) {',
    '  if ($null -eq $fx_d.Free) { continue }',
    '  $fx_used = $fx_d.Used; $fx_free = $fx_d.Free; $fx_tot = $fx_used + $fx_free',
    '  if ($fx_tot -eq 0) { continue }',
    '  $fx_pct = [int](100 * $fx_used / $fx_tot)',
    '  if (' + (human ? '$true' : '$false') + ') {',
    '    "{0,-15} {1,4} {2,4} {3,4} {4,3}% {5}" -f ($fx_d.Name + \':\'), (fx-hsize $fx_tot), (fx-hsize $fx_used), (fx-hsize $fx_free), $fx_pct, $fx_d.Root',
    '  } else {',
    '    "{0,-15} {1,8:d} {2,8:d} {3,8:d} {4,3}% {5}" -f ($fx_d.Name + \':\'), [math]::Floor($fx_tot / 1KB), [math]::Floor($fx_used / 1KB), [math]::Floor($fx_free / 1KB), $fx_pct, $fx_d.Root',
    '  }',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* find                                                                */
/* ------------------------------------------------------------------ */

const find: Handler = (args) => {
  const raw = args.map((w) => wordToString(w));
  let pathEnd = 0;
  while (
    pathEnd < raw.length &&
    !raw[pathEnd].startsWith('-') &&
    !['(', ')', '!', '-a', '-o'].includes(raw[pathEnd])
  ) {
    pathEnd++;
  }
  const pathWords = args.slice(0, pathEnd);
  const preds = raw.slice(pathEnd);

  if (preds.includes('-exec') || preds.includes('-execdir')) {
    return (
      '[Console]::Error.WriteLine(' +
      psStr('find: -exec is not supported by fauxnix; pipe into the command instead (e.g. `find . -name "*.log" | xargs rm`)') +
      '); $script:fx_exit = 1'
    );
  }

  const namePat = extractValue(preds, ['-name']);
  const inamePat = extractValue(preds, ['-iname']);
  const typeV = extractValue(preds, ['-type']);
  const maxDepthS = extractValue(preds, ['-maxdepth']);
  const minDepthS = extractValue(preds, ['-mindepth']);
  const sizeExpr = extractValue(preds, ['-size']);
  const mtimeExpr = extractValue(preds, ['-mtime']);
  const wantDelete = preds.includes('-delete');
  const paths = pathWords.length ? pathWords.map((w) => operandExpr(w)) : ["'.'"];

  const conditions: string[] = [];
  if (namePat !== null) conditions.push("($fx_i.Name -like '" + likeOf(namePat) + "')");
  if (inamePat !== null)
    conditions.push("($fx_i.Name.ToLower() -like '" + likeOf(inamePat).toLowerCase() + "')");
  if (typeV === 'f') conditions.push('(-not $fx_i.PSIsContainer)');
  if (typeV === 'd') conditions.push('($fx_i.PSIsContainer)');
  if (typeV === 'l') conditions.push('([bool]$fx_i.LinkType)');
  const cond = conditions.length ? conditions.join(' -and ') : '$true';

  const sizeCond = sizeOf(sizeExpr);
  const mtimeCond = mtimeOf(mtimeExpr);

  return [
    '$fx_paths = @(' + paths.join(', ') + ')',
    'foreach ($fx_p in $fx_paths) {',
    '  if (-not (Test-Path -LiteralPath $fx_p)) { [Console]::Error.WriteLine("find: \'" + $fx_p + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '  $fx_root = (Get-Item -LiteralPath $fx_p -Force).FullName',
    '  $fx_all = @(Get-Item -LiteralPath $fx_p -Force)',
    '  $fx_all += @(Get-ChildItem -LiteralPath $fx_p -Recurse -Force -ErrorAction SilentlyContinue)',
    '  foreach ($fx_i in $fx_all) {',
    "    $fx_rel = $fx_i.FullName.Substring($fx_root.Length).TrimStart('\\').Replace('\\', '/')",
    "    if ($fx_rel -eq '') { $fx_disp = $fx_p } else { $fx_disp = ($fx_p.TrimEnd('/') + '/' + $fx_rel) }",
    '    $fx_depth = 0; foreach ($fx_c in $fx_rel.ToCharArray()) { if ($fx_c -eq \'/\') { $fx_depth++ } }',
    '    if ($fx_depth -lt ' + (minDepthS && /^\d+$/.test(minDepthS) ? minDepthS : '0') + ') { continue }',
    maxDepthS && /^\d+$/.test(maxDepthS) ? '    if ($fx_depth -gt ' + maxDepthS + ') { continue }' : '',
    '    if (-not (' + cond + ')) { continue }',
    sizeCond ? '    $fx_sz = 0; if (-not $fx_i.PSIsContainer) { try { $fx_sz = $fx_i.Length } catch {} }' : '',
    sizeCond ? '    if (-not (' + sizeCond + ')) { continue }' : '',
    mtimeCond ? '    if (-not (' + mtimeCond + ')) { continue }' : '',
    '    if (' + (wantDelete ? '$true' : '$false') + ') {',
    '      try { Remove-Item -LiteralPath $fx_i.FullName -Recurse -Force -ErrorAction SilentlyContinue } catch {}',
    '    } else {',
    '      $fx_disp',
    '    }',
    '  }',
    '}',
  ]
    .filter((l) => l !== '')
    .join('\n');
};

function extractValue(preds: string[], names: string[]): string | null {
  for (const n of names) {
    const i = preds.indexOf(n);
    if (i >= 0 && i + 1 < preds.length) return preds[i + 1];
  }
  return null;
}

/** fnmatch glob → PowerShell -like pattern (same semantics for * and ?). */
function likeOf(glob: string): string {
  return glob.replace(/'/g, "''");
}

function sizeOf(expr: string | null): string | null {
  if (expr === null) return null;
  const m = expr.match(/^([+-]?)(\d+)([kMG]?|c)?$/);
  if (!m) return null;
  const sign = m[1];
  const n = parseInt(m[2], 10);
  const unit = m[3] ?? '';
  let bytes: number;
  if (unit === 'c') bytes = n;
  else if (unit === 'k') bytes = n * 1024;
  else if (unit === 'M') bytes = n * 1024 * 1024;
  else if (unit === 'G') bytes = n * 1024 * 1024 * 1024;
  else bytes = n * 512; // find default unit: 512-byte blocks
  if (sign === '+') return '$fx_sz -ge ' + bytes;
  if (sign === '-') return '$fx_sz -le ' + bytes;
  return '$fx_sz -eq ' + bytes;
}

function mtimeOf(expr: string | null): string | null {
  if (expr === null) return null;
  const m = expr.match(/^([+-]?)(\d+)$/);
  if (!m) return null;
  const sign = m[1];
  const days = m[2];
  if (sign === '+') return '(((Get-Date) - $fx_i.LastWriteTime).TotalDays -ge ' + days + ')';
  if (sign === '-') return '(((Get-Date) - $fx_i.LastWriteTime).TotalDays -le ' + days + ')';
  return '([math]::Floor(((Get-Date) - $fx_i.LastWriteTime).TotalDays) -eq ' + days + ')';
}

/* ------------------------------------------------------------------ */
/* chmod / chown                                                       */
/* ------------------------------------------------------------------ */

const chmod: Handler = (args) => {
  const { operandWords } = parseWords(args);
  if (operandWords.length < 2) {
    return '[Console]::Error.WriteLine(\'chmod: missing operand\'); $script:fx_exit = 1';
  }
  const mode = wordToString(operandWords[0]);
  const m = mode.match(/^([0-7]{3,4})$/);
  const readOnly = m ? (parseInt(m[1].slice(-3)[0], 8) & 2) === 0 : null;
  return [
    '$fx_files = ' + psArray(operandWords.slice(1)),
    'foreach ($fx_f in $fx_files) {',
    '  if (-not (Test-Path -LiteralPath $fx_f)) { [Console]::Error.WriteLine("chmod: cannot access \'" + $fx_f + "\': No such file or directory"); $script:fx_exit = 1; continue }',
    '  try {',
    '    $fx_it = Get-Item -LiteralPath $fx_f -Force',
    '    if (' + (readOnly === null ? '$false' : String(readOnly)) + ') { $fx_it.Attributes = $fx_it.Attributes -bor [IO.FileAttributes]::ReadOnly }',
    '    elseif (' + (readOnly === null ? '$false' : String(!readOnly)) + ') { $fx_it.Attributes = $fx_it.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) }',
    '    # symbolic modes (+x, u+w ...): Windows has no exec bit — accepted as a no-op',
    '  } catch { [Console]::Error.WriteLine("chmod: changing permissions of \'" + $fx_f + "\': " + $_.Exception.Message); $script:fx_exit = 1 }',
    '}',
  ].join('\n');
};

const chown: Handler = () => {
  // Ownership is not a shell-level concept on Windows — succeed silently
  // (same behavior as Git Bash's chown shim).
  return '';
};

/* ------------------------------------------------------------------ */
/* diff — LCS-based, GNU normal format (+ -q, -u)                      */
/* ------------------------------------------------------------------ */

const diff: Handler = (args) => {
  const { flags, operandWords } = parseWords(args);
  const unified = flags.has('u') || flags.has('U');
  const brief = flags.has('q') || flags.has('brief');
  void unified;
  const a = operandWords.length > 0 ? operandExpr(operandWords[0]) : "''";
  const b = operandWords.length > 1 ? operandExpr(operandWords[1]) : "''";
  return [
    PS_READTEXT_FN,
    'function fx-dr($x, $y) { if ($x -eq $y) { return [string]$x } else { return ([string]$x) + \',\' + ([string]$y) } }',
    '$fx_a = ' + a,
    '$fx_b = ' + b,
    "if ($fx_a -eq '' -or $fx_b -eq '') { [Console]::Error.WriteLine('diff: missing operand'); $script:fx_exit = 2 }",
    'elseif (-not (Test-Path -LiteralPath $fx_a)) { [Console]::Error.WriteLine("diff: " + $fx_a + ": No such file or directory"); $script:fx_exit = 2 }',
    'elseif (-not (Test-Path -LiteralPath $fx_b)) { [Console]::Error.WriteLine("diff: " + $fx_b + ": No such file or directory"); $script:fx_exit = 2 }',
    'else {',
    '  $fx_la = @((fx-read $fx_a) -split "`r?`n")',
    "  if ($fx_la.Count -eq 1 -and $fx_la[0] -eq '') { $fx_la = @() }",
    '  $fx_lb = @((fx-read $fx_b) -split "`r?`n")',
    "  if ($fx_lb.Count -eq 1 -and $fx_lb[0] -eq '') { $fx_lb = @() }",
    '  $fx_same = ($fx_la.Count -eq $fx_lb.Count)',
    '  if ($fx_same) { for ($fx_i = 0; $fx_i -lt $fx_la.Count; $fx_i++) { if ($fx_la[$fx_i] -ne $fx_lb[$fx_i]) { $fx_same = $false; break } } }',
    '  if ($fx_same) { }',
    '  elseif (' + (brief ? '$true' : '$false') + ') { "Files " + $fx_a + " and " + $fx_b + " differ"; $script:fx_exit = 1 }',
    '  elseif ($fx_la.Count -gt 4000 -or $fx_lb.Count -gt 4000) { "Files " + $fx_a + " and " + $fx_b + " differ (too large for a fauxnix line diff)"; $script:fx_exit = 1 }',
    '  else {',
    '    $fx_n = $fx_la.Count; $fx_m = $fx_lb.Count',
    '    $fx_w = $fx_m + 1',
    "    $fx_dp = New-Object 'int[]' (($fx_n + 1) * $fx_w)",
    '    for ($fx_i = $fx_n - 1; $fx_i -ge 0; $fx_i--) {',
    '      for ($fx_j = $fx_m - 1; $fx_j -ge 0; $fx_j--) {',
    '        if ($fx_la[$fx_i] -eq $fx_lb[$fx_j]) { $fx_dp[($fx_i * $fx_w) + $fx_j] = $fx_dp[(($fx_i + 1) * $fx_w) + ($fx_j + 1)] + 1 }',
    '        else { $fx_r = $fx_dp[(($fx_i + 1) * $fx_w) + $fx_j]; $fx_d2 = $fx_dp[($fx_i * $fx_w) + ($fx_j + 1)]; if ($fx_r -ge $fx_d2) { $fx_dp[($fx_i * $fx_w) + $fx_j] = $fx_r } else { $fx_dp[($fx_i * $fx_w) + $fx_j] = $fx_d2 } }',
    '      }',
    '    }',
    "    $fx_ops = @()  # tuples: @('<op>', text, aIndex, bIndex)",
    '    $fx_i = 0; $fx_j = 0',
    '    while ($fx_i -lt $fx_n -and $fx_j -lt $fx_m) {',
    "      if ($fx_la[$fx_i] -eq $fx_lb[$fx_j]) { $fx_ops += ,@('=', $fx_la[$fx_i], $fx_i, $fx_j); $fx_i++; $fx_j++ }",
    "      elseif ($fx_dp[(($fx_i + 1) * $fx_w) + $fx_j] -ge $fx_dp[($fx_i * $fx_w) + ($fx_j + 1)]) { $fx_ops += ,@('-', $fx_la[$fx_i], $fx_i, $fx_j); $fx_i++ }",
    "      else { $fx_ops += ,@('+', $fx_lb[$fx_j], $fx_i, $fx_j); $fx_j++ }",
    '    }',
    "    while ($fx_i -lt $fx_n) { $fx_ops += ,@('-', $fx_la[$fx_i], $fx_i, $fx_j); $fx_i++ }",
    "    while ($fx_j -lt $fx_m) { $fx_ops += ,@('+', $fx_lb[$fx_j], $fx_i, $fx_j); $fx_j++ }",
    '    $script:fx_exit = 1',
    '    $fx_k = 0',
    '    while ($fx_k -lt $fx_ops.Count) {',
    "      if ($fx_ops[$fx_k][0] -eq '=') { $fx_k++; continue }",
    '      $fx_start = $fx_k',
    "      while ($fx_k -lt $fx_ops.Count -and $fx_ops[$fx_k][0] -ne '=') { $fx_k++ }",
    '      $fx_del = @(); $fx_add = @()',
    "      for ($fx_x = $fx_start; $fx_x -lt $fx_k; $fx_x++) { if ($fx_ops[$fx_x][0] -eq '-') { $fx_del += ,@($fx_ops[$fx_x][1], $fx_ops[$fx_x][2]) } else { $fx_add += ,@($fx_ops[$fx_x][1], $fx_ops[$fx_x][3]) } }",
    '      $fx_a1 = 0; $fx_a2 = 0; $fx_b1 = 0; $fx_b2 = 0',
    '      if ($fx_del.Count -gt 0) { $fx_a1 = $fx_del[0][1] + 1; $fx_a2 = $fx_del[$fx_del.Count - 1][1] + 1 }',
    '      if ($fx_add.Count -gt 0) { $fx_b1 = $fx_add[0][1] + 1; $fx_b2 = $fx_add[$fx_add.Count - 1][1] + 1 }',
    '      $fx_range = \'\'',
    "      if ($fx_del.Count -eq 0) { $fx_range = ([string]$fx_b1) + 'a' + (fx-dr $fx_b1 $fx_b2) }",
    "      elseif ($fx_add.Count -eq 0) { $fx_range = (fx-dr $fx_a1 $fx_a2) + 'd' + ([string]$fx_b1) }",
    "      else { $fx_range = (fx-dr $fx_a1 $fx_a2) + 'c' + (fx-dr $fx_b1 $fx_b2) }",
    '      $fx_range',
    "      foreach ($fx_d in $fx_del) { '< ' + $fx_d[0] }",
    "      if ($fx_del.Count -gt 0 -and $fx_add.Count -gt 0) { '---' }",
    "      foreach ($fx_ad in $fx_add) { '> ' + $fx_ad[0] }",
    '    }',
    '  }',
    '}',
  ].join('\n');
};

export const handlers: Record<string, Handler> = {
  ls,
  ll: ls, // common alias
  cp,
  mv,
  rm,
  mkdir,
  rmdir,
  touch,
  mktemp,
  ln,
  readlink,
  realpath,
  basename,
  dirname,
  stat,
  file,
  du,
  df,
  find,
  chmod,
  chown,
  diff,
};
