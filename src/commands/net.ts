import { Word, wordToString } from '../ast.js';
import { Handler, parseWords, psErr, psStr } from '../registry.js';
import { argListExpr, exprOfWord, literalOfWord, operandExpr } from '../translator.js';

/* ------------------------------------------------------------------ */
/* Shared PS snippets                                                  */
/* ------------------------------------------------------------------ */

/**
 * Mimosa security guard for HTTP(S) client commands (curl/wget): refuse
 * loopback / private / reserved destinations before any request is made.
 * Applied to every argv element that starts with http:// or https://.
 */
const PS_NETGUARD_FNS = [
  'function fx-badhost($h) {',
  '  $h = ([string]$h).Trim(\'[]\').ToLower()',
  "  if ($h -eq '') { return $false }",
  "  if ($h -eq 'localhost' -or $h -eq '::1') { return $true }",
  "  if ($h.StartsWith('127.') -or $h.StartsWith('10.') -or $h.StartsWith('192.168.') -or $h.StartsWith('169.254.')) { return $true }",
  "  if ($h.StartsWith('172.')) {",
  "    $fx_p = $h.Split('.')",
  '    if ($fx_p.Count -ge 2) { $fx_n = 0; if ([int]::TryParse($fx_p[1], [ref]$fx_n)) { if ($fx_n -ge 16 -and $fx_n -le 31) { return $true } } }',
  '  }',
  '  return $false',
  '}',
  'function fx-urlhost($u) {',
  '  $fx_r = [string]$u',
  "  $fx_i = $fx_r.IndexOf('://')",
  '  if ($fx_i -lt 0) { return \'\' }',
  '  $fx_r = $fx_r.Substring($fx_i + 3)',
  "  foreach ($fx_c in @('/', '?', '#')) { $fx_i = $fx_r.IndexOf($fx_c); if ($fx_i -ge 0) { $fx_r = $fx_r.Substring(0, $fx_i) } }",
  "  $fx_i = $fx_r.LastIndexOf('@')",
  '  if ($fx_i -ge 0) { $fx_r = $fx_r.Substring($fx_i + 1) }',
  "  if ($fx_r.StartsWith('[')) {",
  "    $fx_j = $fx_r.IndexOf(']')",
  '    if ($fx_j -ge 0) { $fx_r = $fx_r.Substring(0, $fx_j + 1) }',
  '  } else {',
  "    $fx_i = $fx_r.IndexOf(':')",
  '    if ($fx_i -ge 0) { $fx_r = $fx_r.Substring(0, $fx_i) }',
  '  }',
  "  return $fx_r.Trim('[]')",
  '}',
  'function fx-netguard($cmd, $a) {',
  '  $fx_s = [string]$a',
  "  if ($fx_s.StartsWith('http://', [System.StringComparison]::OrdinalIgnoreCase) -or $fx_s.StartsWith('https://', [System.StringComparison]::OrdinalIgnoreCase)) {",
  '    $fx_h = fx-urlhost $fx_s',
  '    if (fx-badhost $fx_h) {',
  "      [Console]::Error.WriteLine($cmd + ': fauxnix refused private/loopback address ' + $fx_h)",
  '      return $true',
  '    }',
  '  }',
  '  return $false',
  '}',
].join('\n');

/** IPv4 netmask math helpers (prefix → mask/broadcast), shared by ip/ifconfig. */
const PS_IP_MASK_FNS = [
  'function fx-mask($len, $oct) {',
  '  $fx_rem = $len - ($oct * 8)',
  '  if ($fx_rem -le 0) { return 0 }',
  '  if ($fx_rem -ge 8) { return 255 }',
  '  return ((255 -shl (8 - $fx_rem)) -band 255)',
  '}',
  'function fx-nm($len) {',
  '  $fx_o = @()',
  '  for ($fx_i = 0; $fx_i -lt 4; $fx_i++) { $fx_o += [string](fx-mask $len $fx_i) }',
  "  return ($fx_o -join '.')",
  '}',
  'function fx-brd($ip, $len) {',
  "  $fx_b = ([string]$ip).Split('.')",
  '  $fx_o = @()',
  '  for ($fx_i = 0; $fx_i -lt 4; $fx_i++) {',
  '    $fx_m = fx-mask $len $fx_i',
  '    $fx_o += [string](([int]$fx_b[$fx_i]) -bor (255 -bxor $fx_m))',
  '  }',
  "  return ($fx_o -join '.')",
  '}',
].join('\n');

/** Synthetic literal Word (for values extracted out of a larger argument). */
function synthWord(text: string): Word {
  return [{ kind: 'Text', text }];
}

/** A native-exe invocation obeying the fauxnix contract (string lines + exit code). */
function nativeCall(exe: string, argArray: string): string {
  // fx-native captures stdout as pipeline strings and sets fx_exit.
  // [object[]]@(...) keeps an empty argv from unwrapping to $null on PS 5.1.
  return 'fx-native ' + psStr(exe) + ' ([object[]]@(' + argArray + '))';
}

/* ------------------------------------------------------------------ */
/* curl                                                                */
/* ------------------------------------------------------------------ */

const curl: Handler = (args) => {
  // CRITICAL: in PS 5.1 `curl` is an alias for Invoke-WebRequest — the real
  // curl must be invoked explicitly as curl.exe. All args pass through
  // untouched (Windows curl.exe is real curl); the runtime host guard below
  // refuses private/loopback URLs before the process is even started.
  return [
    PS_NETGUARD_FNS,
    '$fx_args = ' + argListExpr(args, exprOfWord),
    '$fx_bad = $false',
    "foreach ($fx_a in $fx_args) { if (fx-netguard 'curl' $fx_a) { $fx_bad = $true } }",
    'if ($fx_bad) { $script:fx_exit = 1 }',
    'else {',
    "  " + nativeCall('curl.exe', '$fx_args'),
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* wget                                                                */
/* ------------------------------------------------------------------ */

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function percentEncodeChar(char: string): string {
  return Array.from(Buffer.from(char, 'utf8'), (byte) => '%' + byte.toString(16).toUpperCase()).join('');
}

/**
 * GNU wget-style default output basename for the curl fallback.
 *
 * A valid UTF-8 percent sequence is decoded exactly once. Malformed sequences
 * remain literal, while characters Windows cannot put in a filename are
 * percent-encoded again. This keeps encoded separators inside one basename
 * instead of accidentally turning them into local path components.
 */
export function urlFileName(u: string): string {
  let pathname: string;
  try {
    pathname = new URL(u).pathname;
  } catch {
    return 'index.html';
  }

  // URL normalisation handles dot segments. A bare path or trailing slash uses
  // wget's conventional index filename.
  if (pathname === '' || pathname.endsWith('/')) return 'index.html';
  const rawName = pathname.slice(pathname.lastIndexOf('/') + 1);

  let decoded = rawName;
  try {
    decoded = decodeURIComponent(rawName);
  } catch {
    // Keep malformed percent escapes literal so naming remains deterministic.
  }

  let safe = '';
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || /[<>:"/\\|?*]/.test(char)) {
      safe += percentEncodeChar(char);
    } else {
      safe += char;
    }
  }

  // Windows strips trailing dots/spaces and treats DOS device basenames as
  // special even when an extension is present. Preserve the intended text in
  // a stable, ordinary filename instead.
  safe = safe.replace(/[. ]+$/, (suffix) =>
    Array.from(suffix, (char) => percentEncodeChar(char)).join(''),
  );
  if (safe === '' || safe === '.' || safe === '..') return 'index.html';
  if (WINDOWS_DEVICE_NAME.test(safe)) safe = '_' + safe;
  return safe;
}

interface WgetMap {
  margs: string[];
  sawOutput: boolean;
  urls: string[];
}

/** Map GNU wget argv → curl.exe argv (only literal words are rewritten). */
function mapWgetArgs(args: Word[]): WgetMap {
  const margs: string[] = [];
  const urls: string[] = [];
  let sawOutput = false;
  const raw = args.map(wordToString);
  let i = 0;
  while (i < args.length) {
    const lit = literalOfWord(args[i]);
    if (lit === null) {
      margs.push(exprOfWord(args[i]));
      i++;
      continue;
    }
    // bundles like -q, -qO-, -O-
    const m = /^-(q*)O(.*)$/.exec(lit);
    if (m) {
      if (m[1].length > 0) margs.push("'-s'");
      const rest = m[2];
      if (rest === '') {
        if (i + 1 < args.length) {
          const v = wordToString(args[i + 1]);
          if (v === '-') {
            sawOutput = true; // -O - → curl writes to stdout by default
          } else {
            margs.push("'-o'", operandExpr(args[i + 1]));
            sawOutput = true;
          }
          i++;
        }
      } else if (rest === '-') {
        sawOutput = true; // -O- → stdout passthrough (curl default)
      } else {
        margs.push("'-o'", operandExpr(synthWord(rest)));
        sawOutput = true;
      }
      i++;
      continue;
    }
    if (lit === '--output-document' && i + 1 < args.length) {
      const v = wordToString(args[i + 1]);
      if (v === '-') {
        sawOutput = true;
      } else {
        margs.push("'-o'", operandExpr(args[i + 1]));
        sawOutput = true;
      }
      i += 2;
      continue;
    }
    const eq = /^--output-document=(.*)$/.exec(lit);
    if (eq) {
      if (eq[1] === '') {
        sawOutput = true;
      } else {
        margs.push("'-o'", operandExpr(synthWord(eq[1])));
        sawOutput = true;
      }
      i++;
      continue;
    }
    if (lit === '-q' || lit === '--quiet') {
      margs.push("'-s'");
      i++;
      continue;
    }
    if (lit === '--spider') {
      margs.push("'-I'");
      i++;
      continue;
    }
    if (/^https?:\/\//i.test(lit)) urls.push(lit);
    margs.push(exprOfWord(args[i]));
    i++;
  }
  // GNU wget saves the document in the current directory when -O is absent;
  // curl would dump it on stdout, so derive the filename from the URL.
  if (!sawOutput && urls.length === 1) {
    margs.push("'-o'", operandExpr(synthWord(urlFileName(urls[0]))));
  }
  return { margs, sawOutput, urls };
}

const wget: Handler = (args) => {
  const orig = args.map((w) => exprOfWord(w));
  const mapped = mapWgetArgs(args);
  return [
    PS_NETGUARD_FNS,
    '$fx_args = ' + argListExpr(args, exprOfWord),
    '$fx_margs = @(' + mapped.margs.join(', ') + ')',
    '$fx_bad = $false',
    "foreach ($fx_a in $fx_args) { if (fx-netguard 'wget' $fx_a) { $fx_bad = $true } }",
    'if ($fx_bad) { $script:fx_exit = 1 }',
    // real GNU wget on PATH (Git Bash etc.) → use it natively with the original argv
    "elseif (Get-Command 'wget.exe' -ErrorAction SilentlyContinue) {",
    "  " + nativeCall('wget.exe', '$fx_args'),
    '}',
    // otherwise map onto curl.exe
    'else {',
    "  " + nativeCall('curl.exe', '$fx_margs'),
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* ping                                                                */
/* ------------------------------------------------------------------ */

const ping: Handler = (args) => {
  const raw = args.map(wordToString);
  const out: string[] = [];
  let hasCount = false;
  let i = 0;
  while (i < args.length) {
    const t = raw[i];
    let handled = false;
    let m = /^-c(\d+)$/.exec(t);
    if (m) {
      out.push("'-n'", psStr(m[1]));
      hasCount = true;
      handled = true;
    }
    if (!handled && t === '-c' && i + 1 < args.length) {
      out.push("'-n'", exprOfWord(args[i + 1]));
      hasCount = true;
      i++;
      handled = true;
    }
    m = /^-W(\d+(?:\.\d+)?)$/.exec(t);
    if (!handled && m) {
      out.push("'-w'", psStr(String(Math.round(parseFloat(m[1]) * 1000))));
      handled = true;
    }
    if (!handled && t === '-W' && i + 1 < args.length && /^\d+(\.\d+)?$/.test(raw[i + 1])) {
      out.push("'-w'", psStr(String(Math.round(parseFloat(raw[i + 1]) * 1000))));
      i++;
      handled = true;
    }
    // -i interval: no equivalent — dropped (with its value)
    if (!handled && /^-i\d+(\.\d+)?$/.test(t)) {
      handled = true;
    }
    if (!handled && t === '-i' && i + 1 < args.length && /^\d+(\.\d+)?$/.test(raw[i + 1])) {
      i++;
      handled = true;
    }
    if (!handled) out.push(exprOfWord(args[i]));
    i++;
  }
  // Linux ping defaults to endless echoing → Windows needs -t
  if (!hasCount) out.unshift("'-t'");
  return nativeCall('ping.exe', out.join(', '));
};

/* ------------------------------------------------------------------ */
/* netstat / ss                                                        */
/* ------------------------------------------------------------------ */

const netstat: Handler = (args) => {
  const raw = args.map(wordToString);
  const out: string[] = [];
  const notes: string[] = [];
  let i = 0;
  while (i < args.length) {
    const t = raw[i];
    // listening-socket combos (-tlnp -tlpn -tulpn -tln -tl ...) → -ano
    const body = t.slice(1);
    if (
      /^-[tulnp]+$/.test(t) &&
      body.includes('l') &&
      (body.includes('n') || body.includes('p'))
    ) {
      if (!out.includes("'-ano'")) out.push("'-ano'");
      i++;
      continue;
    }
    if (t === '-an' || t === '-na') {
      if (!out.includes("'-ano'")) out.push("'-ano'");
      i++;
      continue;
    }
    if (t === '-p') {
      if (i + 1 < args.length && !raw[i + 1].startsWith('-')) i++;
      notes.push('netstat: fauxnix: -p is not supported on Windows (all sockets shown)');
      i++;
      continue;
    }
    out.push(exprOfWord(args[i]));
    i++;
  }
  // if -p swallowed everything, still list sockets as -ano — a bare
  // `netstat` (no flags) reverse-DNSes every address and takes minutes
  if (out.length === 0) out.push("'-ano'");
  return [
    ...notes.map((n) => '[Console]::Error.WriteLine(' + psStr(n) + ')'),
    nativeCall('netstat.exe', out.join(', ')),
  ].join('\n');
};

const ss: Handler = () => {
  // Windows has no ss; netstat -ano is the closest (all sockets + PIDs).
  return [
    '[Console]::Error.WriteLine(' + psStr('ss: fauxnix maps ss → netstat -ano (Windows)') + ')',
    nativeCall('netstat.exe', "'-ano'"),
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* ip / ifconfig                                                       */
/* ------------------------------------------------------------------ */

/** PS: unique interface alias list, loopback first (GNU puts lo first). */
const PS_IFLIST = [
  "$fx_addrs = @(Get-NetIPAddress -ErrorAction SilentlyContinue |",
  "  Sort-Object -Property @{e={ if ($_.InterfaceAlias -like '*Loopback*') { 0 } else { 1 } }}, InterfaceAlias, AddressFamily)",
  "$fx_ifs = @($fx_addrs | Select-Object -ExpandProperty InterfaceAlias -Unique)",
].join('\n');

const ip: Handler = (args) => {
  const raw = args.map(wordToString);
  let sub = '';
  for (const t of raw) {
    if (!t.startsWith('-')) {
      sub = t;
      break;
    }
  }
  const fam = raw.includes('-6') ? 'IPv6' : raw.includes('-4') ? 'IPv4' : '';
  const famFilter = fam ? " | Where-Object { $_.AddressFamily -eq '" + fam + "' }" : '';

  if (sub === 'addr' || sub === 'a' || sub === 'address') {
    return [
      PS_IP_MASK_FNS,
      '$fx_addrs = @(Get-NetIPAddress -ErrorAction SilentlyContinue' + famFilter + ' |',
      "  Sort-Object -Property @{e={ if ($_.InterfaceAlias -like '*Loopback*') { 0 } else { 1 } }}, InterfaceAlias, AddressFamily)",
      "$fx_ifs = @($fx_addrs | Select-Object -ExpandProperty InterfaceAlias -Unique)",
      '$fx_n = 0',
      'foreach ($fx_name in $fx_ifs) {',
      '  $fx_n = $fx_n + 1',
      "  $fx_lo = ($fx_name -like '*Loopback*')",
      "  if ($fx_lo) { ('' + $fx_n + ': ' + $fx_name + ': <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000') }",
      "  else { ('' + $fx_n + ': ' + $fx_name + ': <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000') }",
      '  foreach ($fx_a in @($fx_addrs | Where-Object { $_.InterfaceAlias -eq $fx_name })) {',
      "    if ($fx_a.AddressFamily -eq 'IPv4') {",
      "      $fx_scope = 'global'",
      "      if ($fx_lo) { $fx_scope = 'host' } elseif ($fx_a.IPAddress.StartsWith('169.254.')) { $fx_scope = 'link' }",
      "      ('    inet ' + $fx_a.IPAddress + '/' + $fx_a.PrefixLength + ' brd ' + (fx-brd $fx_a.IPAddress $fx_a.PrefixLength) + ' scope ' + $fx_scope + ' ' + $fx_name)",
      '    } else {',
      "      $fx_scope = 'global'",
      "      if ($fx_a.IPAddress -eq '::1') { $fx_scope = 'host' } elseif ($fx_a.IPAddress.ToLower().StartsWith('fe80:')) { $fx_scope = 'link' }",
      "      ('    inet6 ' + $fx_a.IPAddress + '/' + $fx_a.PrefixLength + ' scope ' + $fx_scope + ' ' + $fx_name)",
      '    }',
      '  }',
      '}',
    ].join('\n');
  }

  if (sub === 'link' || sub === 'l') {
    return [
      PS_IFLIST,
      '$fx_mac = @{}',
      'foreach ($fx_ad in @(Get-NetAdapter -ErrorAction SilentlyContinue)) { if ($fx_ad.MacAddress) { $fx_mac[$fx_ad.Name] = $fx_ad.MacAddress.Replace(\'-\', \':\').ToLower() } }',
      '$fx_n = 0',
      'foreach ($fx_name in $fx_ifs) {',
      '  $fx_n = $fx_n + 1',
      "  $fx_lo = ($fx_name -like '*Loopback*')",
      "  if ($fx_lo) { ('' + $fx_n + ': ' + $fx_name + ': <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000') }",
      "  else { ('' + $fx_n + ': ' + $fx_name + ': <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP mode DEFAULT group default qlen 1000') }",
      '  if ($fx_lo) {',
      "    '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00'",
      '  } else {',
      '    $fx_m = $fx_mac[$fx_name]',
      "    if (-not $fx_m) { $fx_m = '00:00:00:00:00:00' }",
      "    ('    link/ether ' + $fx_m + ' brd ff:ff:ff:ff:ff:ff')",
      '  }',
      '}',
    ].join('\n');
  }

  if (sub === 'route' || sub === 'r') {
    return [
      '$fx_a4 = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)',
      '$fx_rts = @(Get-NetRoute -ErrorAction SilentlyContinue |',
      "  Where-Object { $_.DestinationPrefix -match '\\.' -and $_.DestinationPrefix -ne '255.255.255.255/32' } |",
      '  Sort-Object -Property DestinationPrefix)',
      'foreach ($fx_r in @($fx_rts | Where-Object { $_.DestinationPrefix -eq \'0.0.0.0/0\' })) {',
      "  $fx_l = 'default'",
      "  if ($null -ne $fx_r.NextHop -and $fx_r.NextHop -ne '' -and $fx_r.NextHop -ne '0.0.0.0') { $fx_l = $fx_l + ' via ' + $fx_r.NextHop }",
      "  $fx_l = $fx_l + ' dev ' + $fx_r.InterfaceAlias",
      "  $fx_c = @($fx_a4 | Where-Object { $_.InterfaceAlias -eq $fx_r.InterfaceAlias })",
      "  if ($fx_c.Count -gt 0) { $fx_l = $fx_l + ' proto dhcp src ' + $fx_c[0].IPAddress }",
      '  $fx_l',
      '}',
      'foreach ($fx_r in @($fx_rts | Where-Object { $_.DestinationPrefix -ne \'0.0.0.0/0\' })) {',
      '  $fx_l = $fx_r.DestinationPrefix',
      "  if ($null -ne $fx_r.NextHop -and $fx_r.NextHop -ne '' -and $fx_r.NextHop -ne '0.0.0.0') { $fx_l = $fx_l + ' via ' + $fx_r.NextHop }",
      "  $fx_l = $fx_l + ' dev ' + $fx_r.InterfaceAlias + ' proto kernel scope link'",
      "  $fx_c = @($fx_a4 | Where-Object { $_.InterfaceAlias -eq $fx_r.InterfaceAlias })",
      "  if ($fx_c.Count -gt 0) { $fx_l = $fx_l + ' src ' + $fx_c[0].IPAddress }",
      '  $fx_l',
      '}',
    ].join('\n');
  }

  return psErr('ip', 'fauxnix does not support "ip ' + sub + '"');
};

const ifconfig: Handler = (args) => {
  const { operandWords } = parseWords(args);
  const filter = operandWords.length
    ? "$fx_ifs = @($fx_ifs | Where-Object { $_ -like ('*' + (" + exprOfWord(operandWords[0]) + ") + '*') })\n"
    : '';
  return [
    PS_IP_MASK_FNS,
    PS_IFLIST,
    filter,
    'foreach ($fx_name in $fx_ifs) {',
    "  $fx_lo = ($fx_name -like '*Loopback*')",
    "  if ($fx_lo) { ($fx_name + ': flags=73<UP,LOOPBACK,RUNNING>  mtu 65536') } else { ($fx_name + ': flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500') }",
    '  foreach ($fx_a in @($fx_addrs | Where-Object { $_.InterfaceAlias -eq $fx_name })) {',
    "    if ($fx_a.AddressFamily -eq 'IPv4') {",
    "      $fx_l = '        inet addr:' + $fx_a.IPAddress + '  netmask:' + (fx-nm $fx_a.PrefixLength)",
    "      if (-not $fx_lo) { $fx_l = $fx_l + '  broadcast:' + (fx-brd $fx_a.IPAddress $fx_a.PrefixLength) }",
    '      $fx_l',
    '    } else {',
    "      $fx_sc = 'Scope:Global'",
    "      if ($fx_a.IPAddress -eq '::1') { $fx_sc = 'Scope:Host' } elseif ($fx_a.IPAddress.ToLower().StartsWith('fe80:')) { $fx_sc = 'Scope:Link' }",
    "      '        inet6 addr: ' + $fx_a.IPAddress + '/' + $fx_a.PrefixLength + ' ' + $fx_sc",
    '    }',
    '  }',
    "  ''",
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* nslookup / dig / host                                               */
/* ------------------------------------------------------------------ */

const nslookup: Handler = (args) =>
  [
    '$fx_args = ' + argListExpr(args, exprOfWord),
    nativeCall('nslookup.exe', '$fx_args'),
  ].join('\n');

const dig: Handler = (args) => {
  const raw = args.map(wordToString);
  let short = false;
  const ops: Word[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (t === '+short') {
      short = true;
      continue;
    }
    if (t.startsWith('-') || t.startsWith('+')) continue; // other dig options dropped
    if (t.startsWith('@')) continue; // @server dropped
    ops.push(args[i]);
  }
  const note = '[Console]::Error.WriteLine(' + psStr('dig: fauxnix maps dig → nslookup') + ')';
  if (short) {
    // dig +short HOST → only the answer addresses, no server preamble
    if (ops.length === 0) {
      return note + '; ' + psErr('dig', 'fauxnix: no host given');
    }
    return [
      note,
      '$fx_h = ' + exprOfWord(ops[0]),
      'try {',
      "  foreach ($fx_a in @([System.Net.Dns]::GetHostAddresses($fx_h) | Sort-Object -Property @{e={ if ($_.AddressFamily -eq 'InterNetwork') { 0 } else { 1 } }})) { $fx_a.IPAddressToString }",
      '} catch { }',
    ].join('\n');
  }
  const nsArgs: string[] = [];
  if (ops.length >= 2) nsArgs.push(psStr('-type=' + wordToString(ops[1])));
  if (ops.length >= 1) nsArgs.push(exprOfWord(ops[0]));
  return [
    note,
    nativeCall('nslookup.exe', nsArgs.join(', ')),
  ].join('\n');
};

const host: Handler = (args) => {
  const { operandWords } = parseWords(args);
  if (operandWords.length === 0) {
    return psErr('host', 'you must specify a host name (usage: host NAME)');
  }
  return [
    '$fx_name = ' + exprOfWord(operandWords[0]),
    'try {',
    "  $fx_addrs = @([System.Net.Dns]::GetHostAddresses($fx_name) | Sort-Object -Property @{e={ if ($_.AddressFamily -eq 'InterNetwork') { 0 } else { 1 } }})",
    '  foreach ($fx_a in $fx_addrs) {',
    "    if ($fx_a.AddressFamily -eq 'InterNetwork') { ($fx_name + ' has address ' + $fx_a.IPAddressToString) }",
    "    else { ($fx_name + ' has IPv6 address ' + $fx_a.IPAddressToString) }",
    '  }',
    '} catch {',
    "  [Console]::Error.WriteLine('Host ' + $fx_name + ' not found: 3(NXDOMAIN)')",
    '  $script:fx_exit = 1',
    '}',
  ].join('\n');
};

/* ------------------------------------------------------------------ */
/* exports                                                             */
/* ------------------------------------------------------------------ */

export const handlers: Record<string, Handler> = {
  curl,
  wget,
  ping,
  netstat,
  ss,
  ip,
  ifconfig,
  nslookup,
  dig,
  host,
};
