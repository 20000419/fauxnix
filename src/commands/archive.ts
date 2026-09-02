import { Word, wordToString } from '../ast.js';
import { CommandSpec, Handler, OptionSpec, PipelineCtx, parseWords, psStr } from '../registry.js';
import { argListExpr, exprOfWord, operandExpr } from '../translator.js';

/* ------------------------------------------------------------------ */
/* gzip family — .NET GZipStream helpers                               */
/* ------------------------------------------------------------------ */

const PS_GZ_FNS = [
  'Add-Type -AssemblyName System.IO.Compression',
  'function fx-dec($b) {',
  '  try { return (New-Object System.Text.UTF8Encoding($false, $true)).GetString($b) }',
  '  catch { try { return [System.Text.Encoding]::GetEncoding(936).GetString($b) } catch { return [System.Text.Encoding]::ASCII.GetString($b) } }',
  '}',
  // emit text as one string per line (trailing newline does not add an empty line)
  'function fx-lines($t) {',
  '  if ($null -eq $t) { return @() }',
  '  $fx_ls = @($t -split "`r?`n")',
  "  if ($fx_ls.Count -eq 1 -and $fx_ls[0] -eq '') { return @() }",
  "  if ($fx_ls[$fx_ls.Count - 1] -eq '') { $fx_ls = @($fx_ls[0..($fx_ls.Count - 2)]) }",
  '  return $fx_ls',
  '}',
  // compress byte[] → byte[]; -1..-3 ≈ Fastest, -4..-9 ≈ Optimal (.NET has no finer steps)
  'function fx-gz-cbytes($b, $lvl) {',
  '  $fx_lv = [System.IO.Compression.CompressionLevel]::Optimal',
  '  if ($lvl -le 3) { $fx_lv = [System.IO.Compression.CompressionLevel]::Fastest }',
  '  $fx_ms = New-Object System.IO.MemoryStream',
  '  $fx_gz = New-Object System.IO.Compression.GZipStream($fx_ms, $fx_lv, $false)',
  '  $fx_gz.Write($b, 0, $b.Length)',
  '  $fx_gz.Close()',
  '  return ,$fx_ms.ToArray()',
  '}',
  'function fx-gz-open($src, $isBytes) {',
  '  if ($isBytes) { $fx_raw = New-Object System.IO.MemoryStream(,$src) }',
  '  else { $fx_raw = [IO.File]::OpenRead($src) }',
  '  try {',
  '    return (New-Object System.IO.Compression.GZipStream($fx_raw, [System.IO.Compression.CompressionMode]::Decompress))',
  '  } catch {',
  '    $fx_raw.Dispose()',
  '    throw',
  '  }',
  '}',
  // Drain the complete stream before producing stdout. Besides keeping -t
  // bounded, this preserves the old all-or-nothing behavior for malformed
  // inputs while remembering which text decoder the second pass should use.
  'function fx-gz-validate($src, $isBytes) {',
  '  $fx_gz = fx-gz-open $src $isBytes',
  '  $fx_buf = New-Object byte[] 65536',
  '  $fx_dec = (New-Object System.Text.UTF8Encoding($false, $true)).GetDecoder()',
  '  $fx_utf8 = $true',
  '  try {',
  '    while ($true) {',
  '      $fx_n = $fx_gz.Read($fx_buf, 0, $fx_buf.Length)',
  '      if ($fx_n -le 0) { break }',
  '      if ($fx_utf8) {',
  '        try { [void]$fx_dec.GetCharCount($fx_buf, 0, $fx_n, $false) }',
  '        catch [System.Text.DecoderFallbackException] { $fx_utf8 = $false }',
  '      }',
  '    }',
  '    if ($fx_utf8) {',
  '      try { [void]$fx_dec.GetCharCount($fx_buf, 0, 0, $true) }',
  '      catch [System.Text.DecoderFallbackException] { $fx_utf8 = $false }',
  '    }',
  '    return $fx_utf8',
  '  } finally {',
  '    $fx_gz.Dispose()',
  '  }',
  '}',
  'function fx-gz-stream-text($src, $isBytes) {',
  '  $fx_utf8 = fx-gz-validate $src $isBytes',
  '  if ($fx_utf8) { $fx_enc = New-Object System.Text.UTF8Encoding($false, $true) }',
  '  else { try { $fx_enc = [System.Text.Encoding]::GetEncoding(936) } catch { $fx_enc = [System.Text.Encoding]::ASCII } }',
  '  $fx_gz = fx-gz-open $src $isBytes',
  '  $fx_sr = New-Object System.IO.StreamReader($fx_gz, $fx_enc, $false, 65536)',
  '  try {',
  '    while ($true) {',
  '      $fx_line = $fx_sr.ReadLine()',
  '      if ($null -eq $fx_line) { break }',
  '      Write-Output -NoEnumerate $fx_line',
  '    }',
  '  } finally {',
  '    $fx_sr.Dispose()',
  '  }',
  '}',
  // File output is streamed into a sibling temporary file. The destination
  // changes only after a complete decompression, and the temporary is removed
  // on every failed path.
  'function fx-gz-stream-file($src, $dst) {',
  '  $fx_full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dst)',
  '  $fx_parent = [IO.Path]::GetDirectoryName($fx_full)',
  "  $fx_tmp = [IO.Path]::Combine($fx_parent, '.fauxnix-gzip-' + [Guid]::NewGuid().ToString('N') + '.tmp')",
  '  $fx_gz = $null',
  '  $fx_os = $null',
  '  try {',
  '    $fx_gz = fx-gz-open $src $false',
  "    $fx_os = New-Object System.IO.FileStream($fx_tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)",
  '    $fx_buf = New-Object byte[] 65536',
  '    while ($true) {',
  '      $fx_n = $fx_gz.Read($fx_buf, 0, $fx_buf.Length)',
  '      if ($fx_n -le 0) { break }',
  '      $fx_os.Write($fx_buf, 0, $fx_n)',
  '    }',
  '    $fx_os.Dispose(); $fx_os = $null',
  '    $fx_gz.Dispose(); $fx_gz = $null',
  '    if ([IO.File]::Exists($fx_full)) {',
  '      $fx_null = [System.Management.Automation.Language.NullString]::Value',
  '      [IO.File]::Replace($fx_tmp, $fx_full, $fx_null)',
  '    }',
  '    else { [IO.File]::Move($fx_tmp, $fx_full) }',
  '  } catch {',
  '    if ($null -ne $fx_os) { $fx_os.Dispose() }',
  '    if ($null -ne $fx_gz) { $fx_gz.Dispose() }',
  '    if ([IO.File]::Exists($fx_tmp)) { [IO.File]::Delete($fx_tmp) }',
  '    throw',
  '  }',
  '}',
].join('\n');

interface GzOpts {
  decompress: boolean;
  keep: boolean;
  stdout: boolean;
  level: number;
  test: boolean;
}

interface GzParsed extends GzOpts {
  files: Word[];
}

/** Parse GNU gzip-style argv (works for gzip/gunzip/zcat). */
function parseGzipArgs(args: Word[]): GzParsed {
  const p: GzParsed = {
    decompress: false,
    keep: false,
    stdout: false,
    level: 6,
    test: false,
    files: [],
  };
  const raw = args.map(wordToString);
  let i = 0;
  for (; i < raw.length; i++) {
    const t = raw[i];
    if (t === '--') {
      p.files.push(...args.slice(i + 1));
      return p;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      if (name === 'decompress' || name === 'uncompress') p.decompress = true;
      else if (name === 'keep') p.keep = true;
      else if (name === 'stdout' || name === 'to-stdout') p.stdout = true;
      else if (name === 'fast') p.level = 1;
      else if (name === 'best') p.level = 9;
      else if (name === 'test') p.test = true;
      else if (name === 'suffix') {
        if (eq < 0) i++; // consumes a following value; unsupported either way
      }
      // other long options (force/quiet/verbose/no-name/recursive...) ignored
      continue;
    }
    if (/^-[1-9]$/.test(t)) {
      p.level = parseInt(t.slice(1), 10);
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) {
      for (const c of t.slice(1)) {
        if (c === 'd') p.decompress = true;
        else if (c === 'k') p.keep = true;
        else if (c === 'c') p.stdout = true;
        else if (c === 't') p.test = true;
        // f/q/v/n/r accepted as no-ops
      }
      continue;
    }
    p.files.push(args[i]);
  }
  return p;
}

/** Build the PS block shared by gzip / gunzip / zcat. */
function gzBlock(args: Word[], ctx: PipelineCtx, forced: Partial<GzOpts>): string {
  const p = { ...parseGzipArgs(args), ...forced };
  // Compressed stdout is binary; the fauxnix contract only carries text
  // lines (and the executor's capture layer is UTF-8 text anyway), so the
  // stream is emitted as one latin-1-decoded string — byte fidelity is a
  // documented limitation (spec: "binary fidelity limitation acceptable").
  const emitBin = (bytesExpr: string): string =>
    '[System.Text.Encoding]::GetEncoding(28591).GetString(' + bytesExpr + ')';

  const b = (v: boolean) => (v ? '$true' : '$false');

  const stdinBranch = !ctx.hasStdin
    ? [
        p.decompress || p.test
          ? "  [Console]::Error.WriteLine('gzip: compressed data not read from a terminal. Use -f to force decompression.')"
          : "  [Console]::Error.WriteLine('gzip: compressed data not written to a terminal. Use -f to force compression.')",
        '  $script:fx_exit = 1',
      ].join('\n')
    : p.decompress || p.test
      ? [
          // NOTE stdin fidelity limitation: pipeline stdin arrives as decoded
          // text lines, so only gzip streams that survived the text pipeline
          // round-trip can be decompressed here.
          '  $fx_txt = (@($input | ForEach-Object { [string]$_ }) -join "`n")',
          "  if ($fx_txt -ne '') { $fx_txt = $fx_txt + \"`n\" }",
          '  $fx_in = [System.Text.Encoding]::UTF8.GetBytes($fx_txt)',
          '  try {',
          p.test ? '    [void](fx-gz-validate $fx_in $true)' : '    fx-gz-stream-text $fx_in $true',
          '  } catch {',
          "    [Console]::Error.WriteLine('gzip: stdin: not in gzip format')",
          '    $script:fx_exit = 1',
          '  }',
        ].join('\n')
      : [
          // NOTE stdin fidelity limitation: bytes are UTF-8 re-encoded text.
          '  $fx_txt = (@($input | ForEach-Object { [string]$_ }) -join "`n")',
          "  if ($fx_txt -ne '') { $fx_txt = $fx_txt + \"`n\" }",
          '  $fx_in = [System.Text.Encoding]::UTF8.GetBytes($fx_txt)',
          '  ' + emitBin('(fx-gz-cbytes $fx_in ' + p.level + ')'),
        ].join('\n');

  const fileLoop: string[] = [
    '  foreach ($fx_f in $fx_files) {',
    '    if (-not (Test-Path -LiteralPath $fx_f)) {',
    "      [Console]::Error.WriteLine('gzip: ' + $fx_f + ': No such file or directory')",
    '      $script:fx_exit = 1',
    '      continue',
    '    }',
    '    if (Test-Path -LiteralPath $fx_f -PathType Container) {',
    "      [Console]::Error.WriteLine('gzip: ' + $fx_f + ': is a directory -- ignored')",
    '      $script:fx_exit = 1',
    '      continue',
    '    }',
  ];

  if (p.test) {
    fileLoop.push(
      '    try { [void](fx-gz-validate $fx_f $false) }',
      "    catch { [Console]::Error.WriteLine('gzip: ' + $fx_f + ': not in gzip format'); $script:fx_exit = 1 }",
      '    continue',
    );
  } else if (p.decompress) {
    fileLoop.push(
      '    $fx_low = $fx_f.ToLower()',
      "    if (-not ($fx_low.EndsWith('.gz') -or $fx_low.EndsWith('.tgz'))) {",
      "      [Console]::Error.WriteLine('gzip: ' + $fx_f + ': unknown suffix -- ignored')",
      '      $script:fx_exit = 2',
      '      continue',
      '    }',
      '    $fx_out = $fx_f.Substring(0, $fx_f.Length - 3)',
      "    if ($fx_low.EndsWith('.tgz')) { $fx_out = $fx_f.Substring(0, $fx_f.Length - 4) + '.tar' }",
      '    try {',
      p.stdout
        ? '      fx-gz-stream-text $fx_f $false'
        : [
            '      fx-gz-stream-file $fx_f $fx_out',
            '      try { (Get-Item -LiteralPath $fx_out).LastWriteTime = (Get-Item -LiteralPath $fx_f).LastWriteTime } catch {}',
            '      if (-not ' + b(p.keep) + ') { Remove-Item -LiteralPath $fx_f -Force }',
          ].join('\n'),
      "    } catch { [Console]::Error.WriteLine('gzip: ' + $fx_f + ': not in gzip format'); $script:fx_exit = 1 }",
    );
  } else {
    fileLoop.push(
      '    $fx_low = $fx_f.ToLower()',
      "    if ($fx_low.EndsWith('.gz') -or $fx_low.EndsWith('.tgz')) {",
      "      [Console]::Error.WriteLine('gzip: ' + $fx_f + ': already has .gz suffix -- unchanged')",
      '      continue',
      '    }',
      '    try {',
      p.stdout
        ? '      ' + emitBin('(fx-gz-cbytes ([IO.File]::ReadAllBytes($fx_f)) ' + p.level + ')')
        : [
            '      $fx_o = fx-gz-cbytes ([IO.File]::ReadAllBytes($fx_f)) ' + p.level,
            "      [IO.File]::WriteAllBytes($fx_f + '.gz', $fx_o)",
            "      try { (Get-Item -LiteralPath ($fx_f + '.gz')).LastWriteTime = (Get-Item -LiteralPath $fx_f).LastWriteTime } catch {}",
            '      if (-not ' + b(p.keep) + ') { Remove-Item -LiteralPath $fx_f -Force }',
          ].join('\n'),
      "    } catch { [Console]::Error.WriteLine('gzip: ' + $fx_f + ': ' + $_.Exception.Message); $script:fx_exit = 1 }",
    );
  }
  fileLoop.push('  }');

  return [
    PS_GZ_FNS,
    '$fx_files = ' + (p.files.length ? argListExpr(p.files, operandExpr) : '@()'),
    'if ($fx_files.Count -eq 0) {',
    stdinBranch,
    '} else {',
    ...fileLoop,
    '}',
  ].join('\n');
}

const gzip: Handler = (args, ctx) => gzBlock(args, ctx, {});

const gunzip: Handler = (args, ctx) => gzBlock(args, ctx, { decompress: true });

const zcat: Handler = (args, ctx) => gzBlock(args, ctx, { decompress: true, stdout: true });

/* ------------------------------------------------------------------ */
/* tar — Windows 10+ ships bsdtar as tar.exe, pass everything through  */
/* Intentionally unspec'd: registerSpec fail-loud would reject GNU     */
/* flags bsdtar accepts (--numeric-owner, …). Same class as find.      */
/* ------------------------------------------------------------------ */

const tar: Handler = (args) => {
  return [
    '$fx_args = ' + argListExpr(args, exprOfWord),
    // Prefer the Windows-shipped bsdtar (System32): it accepts both path
    // styles. A PATH lookup could resolve to Git Bash's GNU tar, which
    // misreads `C:\...` argv as a remote-host spec (host:path syntax).
    '$fx_tar = "$env:SystemRoot\\System32\\tar.exe"',
    'if (-not (Test-Path -LiteralPath $fx_tar)) {',
    "  $fx_c = Get-Command 'tar.exe' -ErrorAction SilentlyContinue",
    '  if ($fx_c) { $fx_tar = $fx_c.Source } else { $fx_tar = $null }',
    '}',
    'if ($fx_tar) {',
    // fx-native captures stdout as pipeline strings and sets fx_exit.
    // [object[]]@(...) keeps an empty argv from unwrapping to $null on PS 5.1.
    '  fx-native $fx_tar ([object[]]@($fx_args))',
    '} else {',
    "  [Console]::Error.WriteLine('tar: fauxnix: tar.exe not found (Windows 10+ ships bsdtar as tar.exe)')",
    '  $script:fx_exit = 1',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* zip / unzip                                                         */
/* ------------------------------------------------------------------ */

const zip: Handler = (args) => {
  const raw = args.map(wordToString);
  let excludeNote = false;
  const rest: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === '-x' || t === '--exclude') {
      excludeNote = true;
      if (i + 1 < args.length) i++;
      continue;
    }
    if (t.startsWith('--exclude=')) {
      excludeNote = true;
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) continue; // -r -q ... implicit
    rest.push(args[i]);
  }
  const note = excludeNote
    ? '[Console]::Error.WriteLine(' +
      psStr('zip: fauxnix: -x/--exclude patterns are not supported, ignoring') +
      ')\n'
    : '';
  if (rest.length < 2) {
    return (
      note +
      "[Console]::Error.WriteLine('zip error: Nothing to do! (fauxnix: usage: zip [-r] ARCHIVE FILES...)'); $script:fx_exit = 12"
    );
  }
  const arc = operandExpr(rest[0]);
  const inputs = argListExpr(rest.slice(1), operandExpr);
  return [
    note + '$fx_arc = ' + arc,
    '$fx_inputs = ' + inputs,
    '$fx_valid = @()',
    'foreach ($fx_p in $fx_inputs) {',
    '  if (Test-Path -LiteralPath $fx_p) { $fx_valid += $fx_p }',
    "  else { [Console]::Error.WriteLine('zip warning: name not matched: ' + $fx_p) }",
    '}',
    'if ($fx_valid.Count -eq 0) {',
    "  [Console]::Error.WriteLine('zip error: Nothing to do!')",
    '  $script:fx_exit = 12',
    '} else {',
    '  try {',
    // Compress-Archive keeps the trailing path component as the archive root,
    // always includes directory contents, and appends .zip when the extension
    // is missing (GNU zip does not) — hence the rename dance.
    "    $fx_dst = $fx_arc",
    '    $fx_rename = $false',
    "    if (-not $fx_arc.ToLower().EndsWith('.zip')) { $fx_dst = $fx_arc + '.zip'; $fx_rename = $true }",
    '    Compress-Archive -LiteralPath $fx_valid -DestinationPath $fx_dst -Force -ErrorAction Stop',
    // PS 5.1 Compress-Archive writes `\` entry separators; rewrite them to `/`
    // so GNU unzip/bsdtar see proper directory entries.
    '    Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '    $fx_z = [IO.Compression.ZipFile]::Open($fx_dst, \'Update\')',
    '    try {',
    '      foreach ($fx_e in @($fx_z.Entries)) {',
    "        if ($fx_e.FullName.Contains('\\')) {",
    "          $fx_ne = $fx_z.CreateEntry($fx_e.FullName.Replace('\\', '/'))",
    '          $fx_os = $fx_ne.Open()',
    '          $fx_is = $fx_e.Open()',
    '          $fx_is.CopyTo($fx_os)',
    '          $fx_is.Close()',
    '          $fx_os.Close()',
    '          $fx_e.Delete()',
    '        }',
    '      }',
    '    } finally { $fx_z.Dispose() }',
    '    if ($fx_rename) { Move-Item -LiteralPath $fx_dst -Destination $fx_arc -Force }',
    "  } catch { [Console]::Error.WriteLine('zip: fauxnix: ' + $_.Exception.Message); $script:fx_exit = 1 }",
    '}',
  ].join('\n');
};

const unzip: Handler = (args) => {
  const raw = args.map(wordToString);
  let list = false;
  let over = false;
  let dir: Word | null = null;
  const rest: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === '-d' && i + 1 < args.length) {
      dir = args[i + 1];
      i++;
      continue;
    }
    if (t.startsWith('--directory=')) {
      const dv: Word = [{ kind: 'Text', text: t.slice('--directory='.length) }];
      dir = dv;
      continue;
    }
    if (t === '--directory' && i + 1 < args.length) {
      dir = args[i + 1];
      i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d/.test(t)) {
      if (t.includes('l')) list = true;
      if (t.includes('o')) over = true;
      continue;
    }
    rest.push(args[i]);
  }
  if (rest.length === 0) {
    return "[Console]::Error.WriteLine('unzip: fauxnix: missing archive operand (usage: unzip ARCHIVE [-d DIR] [-o] [-l])'); $script:fx_exit = 1";
  }
  const arc = operandExpr(rest[0]);
  const dirExpr = dir ? operandExpr(dir) : "'.'";
  return [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$fx_arc = ' + arc,
    'if (-not (Test-Path -LiteralPath $fx_arc -PathType Leaf)) {',
    // GNU message shape: "unzip:  cannot find x, x.zip or x.Z." (two spaces)
    "  [Console]::Error.WriteLine('unzip:  cannot find ' + $fx_arc + ', ' + $fx_arc + '.zip or ' + $fx_arc + '.Z.')",
    '  $script:fx_exit = 1',
    '}',
    'else {',
    list
      ? [
          '  $fx_z = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $fx_arc).ProviderPath)',
          '  try {',
          "    'Archive:  ' + $fx_arc",
          "    '  Length      Date    Time    Name'",
          "    '---------  ---------- -----   ----'",
          '    $fx_tot = 0',
          '    $fx_cnt = 0',
          '    foreach ($fx_e in $fx_z.Entries) {',
          "      if (-not $fx_e.FullName.EndsWith('/')) { $fx_tot = $fx_tot + $fx_e.Length; $fx_cnt = $fx_cnt + 1 }",
          "      ('{0,9}  {1}   {2}' -f $fx_e.Length, $fx_e.LastWriteTime.ToString('MM-dd-yy HH:mm'), $fx_e.FullName.Replace('\\', '/'))",
          '    }',
          "    '---------  ---------- -----   ----'",
          "    $fx_pl = 's'",
          "    if ($fx_cnt -eq 1) { $fx_pl = '' }",
          "    ((([string]$fx_tot).PadLeft(9)) + '                   ' + $fx_cnt + ' file' + $fx_pl)",
          '  } finally { $fx_z.Dispose() }',
        ].join('\n')
      : [
          '  $fx_dir = ' + dirExpr,
          '  try {',
          '    Expand-Archive -LiteralPath $fx_arc -DestinationPath $fx_dir -Force:' + (over ? '$true' : '$false') + ' -ErrorAction Stop',
          "  } catch { [Console]::Error.WriteLine('unzip: fauxnix: ' + $_.Exception.Message + ' (use -o to overwrite)'); $script:fx_exit = 1 }",
        ].join('\n'),
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* CommandSpec (C-5 archive slice)                                     */
/* tar stays unspec'd: fx-native to tar.exe; unknown GNU flags must    */
/* reach bsdtar. gzip -f is a no-op today and the stdin-from-terminal  */
/* message advertises it, so it is unsupported (force from terminal)   */
/* rather than a silent ignore.                                        */
/* ------------------------------------------------------------------ */

const gzipOptions: OptionSpec[] = [
  { short: 'd', long: '--decompress', support: 'implemented' },
  { long: '--uncompress', support: 'implemented' },
  { short: 'k', long: '--keep', support: 'implemented' },
  { short: 'c', long: '--stdout', support: 'implemented' },
  { long: '--to-stdout', support: 'implemented' },
  { short: 't', long: '--test', support: 'implemented' },
  { short: '1', long: '--fast', support: 'implemented' },
  { short: '2', support: 'implemented' },
  { short: '3', support: 'implemented' },
  { short: '4', support: 'implemented' },
  { short: '5', support: 'implemented' },
  { short: '6', support: 'implemented' },
  { short: '7', support: 'implemented' },
  { short: '8', support: 'implemented' },
  { short: '9', long: '--best', support: 'implemented' },
  { short: 'f', long: '--force', support: 'unsupported', reason: 'force from terminal' },
  { short: 'q', long: '--quiet', support: 'unsupported', reason: 'quiet' },
  { short: 'v', long: '--verbose', support: 'unsupported', reason: 'verbose' },
  { short: 'n', long: '--no-name', support: 'unsupported', reason: 'no-name' },
  { short: 'r', long: '--recursive', support: 'unsupported', reason: 'recursive' },
  { short: 'S', long: '--suffix', takesValue: true, support: 'unsupported', reason: 'suffix' },
];

export const specs: CommandSpec[] = [
  {
    names: ['gzip'],
    options: gzipOptions,
    effects: ['read', 'write', 'delete'],
    platform: 'windows-ps51',
    dispatch: 'translated',
    handler: gzip,
  },
  {
    names: ['gunzip'],
    options: gzipOptions,
    effects: ['read', 'write', 'delete'],
    platform: 'windows-ps51',
    dispatch: 'translated',
    handler: gunzip,
  },
  {
    names: ['zcat'],
    options: gzipOptions,
    effects: ['read'],
    platform: 'windows-ps51',
    dispatch: 'translated',
    handler: zcat,
  },
  {
    names: ['zip'],
    options: [
      // Compress-Archive always recurses directory inputs; -q is already quiet.
      { short: 'r', support: 'implemented' },
      { short: 'q', support: 'implemented' },
      { short: 'x', long: '--exclude', takesValue: true, support: 'unsupported', reason: 'exclude patterns' },
    ],
    effects: ['read', 'write'],
    platform: 'windows-ps51',
    dispatch: 'translated',
    handler: zip,
  },
  {
    names: ['unzip'],
    options: [
      { short: 'l', support: 'implemented' },
      { short: 'o', support: 'implemented' },
      { short: 'q', support: 'implemented' },
      { short: 'd', long: '--directory', takesValue: true, support: 'implemented' },
    ],
    effects: ['read', 'write'],
    platform: 'windows-ps51',
    dispatch: 'translated',
    handler: unzip,
  },
];

export const handlers: Record<string, Handler> = {
  tar,
  gzip,
  gunzip,
  zcat,
  zip,
  unzip,
};
