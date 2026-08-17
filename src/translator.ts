import {
  Assignment,
  CommandList,
  FauxnixParseError,
  Redirect,
  SimpleCommand,
  Word,
  WordPart,
  isUnquotedLiteral,
} from './ast.js';
import { parseCommand } from './parser.js';
import { PipelineCtx, lookup, psStr } from './registry.js';

/* ------------------------------------------------------------------ */
/* Variable mapping                                                    */
/* ------------------------------------------------------------------ */

/** Map a bash $VAR name to a PowerShell expression (usable inside $(...)). */
export function varExpr(name: string): string {
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
function escDq(s: string): string {
  return s.replace(/`/g, '``').replace(/"/g, '\\"').replace(/\$/g, '`$');
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
export function exprOfWord(w: Word): string {
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
    return varExpr(expanded[0].name);
  }

  const literal = expanded.every((p) => p.kind === 'Text' || p.kind === 'SingleQuoted');
  if (literal) {
    const text = expanded.map((p) => (p as { text: string }).text).join('');
    return pathExpr(normalizeLiteralPath(text));
  }

  // dynamic — build a PS double-quoted string with interpolation
  let out = '"';
  const emitPart = (p: WordPart) => {
    switch (p.kind) {
      case 'Text':
        out += escDq(p.text);
        break;
      case 'SingleQuoted':
        out += escDq(p.text);
        break;
      case 'DoubleQuoted':
        for (const q of p.parts) emitPart(q);
        break;
      case 'Var':
        out += '$(' + varExpr(p.name) + ')';
        break;
      case 'CmdSub':
        out += '$(' + translateCmdSub(p.cmd) + ')';
        break;
    }
  };
  for (const p of expanded) emitPart(p);
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

/* ------------------------------------------------------------------ */
/* Command substitution                                                */
/* ------------------------------------------------------------------ */

/** Translate the inside of $(...) — pipelines only, no wrappers. */
export function translateCmdSub(cmdText: string): string {
  const list = parseCommand(cmdText);
  if (list.segments.length !== 1) {
    throw new FauxnixParseError(
      'fauxnix: command substitution with ; && || is not supported yet',
    );
  }
  const { defs, call } = translatePipelineBody(list.segments[0].pipeline);
  return defs ? defs + '\n' + call : call;
}

/* ------------------------------------------------------------------ */
/* Simple command translation                                          */
/* ------------------------------------------------------------------ */

export function translateSimple(
  cmd: SimpleCommand,
  position: PipelineCtx['position'],
  hasStdin: boolean,
): string {
  const nameLit = literalOfWord(cmd.name);

  let body: string;
  if (nameLit !== null) {
    const handler = lookup(nameLit);
    if (handler && !(nameLit === '[[' && !isUnquotedLiteral(cmd.name, '[['))) {
      body = handler(cmd.args, { position, hasStdin });
    } else {
      // passthrough: native command (git, node, npm, python, cargo, ...)
      // invoked with the call operator and an argv-style argument array —
      // no string re-parsing of user text.
      const nameExpr = psStr(nameLit);
      const argExprs = cmd.args.map((a) => exprOfWord(a));
      const args = argExprs.length ? ' @(' + argExprs.join(', ') + ')' : '';
      const call = '& ' + nameExpr + args;
      body = [
        // feed pipeline stdin into the native process when we are a non-first stage
        (hasStdin ? '($input | ' + call + ')' : call) + ' | ForEach-Object { [string]$_ }',
        'if ($LASTEXITCODE -gt 0) { $script:fx_exit = $LASTEXITCODE } elseif ($LASTEXITCODE -lt 0) { $script:fx_exit = 1 }',
      ].join('\n');
    }
  } else {
    // dynamic command name — evaluate it
    const nameExpr = exprOfWord(cmd.name);
    const argExprs = cmd.args.map((a) => exprOfWord(a));
    const args = argExprs.length ? ' @(' + argExprs.join(', ') + ')' : '';
    const call = '& (' + nameExpr + ')' + args;
    body = [
      (hasStdin ? '($input | ' + call + ')' : call) + ' | ForEach-Object { [string]$_ }',
      'if ($LASTEXITCODE -gt 0) { $script:fx_exit = $LASTEXITCODE } elseif ($LASTEXITCODE -lt 0) { $script:fx_exit = 1 }',
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

  const id = tempEnvSeq++;
  const save = '$fx_es' + id;
  const keep = persistWords && persistWords.length > 0 ? '$fx_ek' + id : '';
  const lines: string[] = [
    save + ' = @{}',
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
  }
  const valVars: string[] = [];
  for (let i = 0; i < sets.length; i++) {
    const vn = '$fx_ev' + id + '_' + i;
    valVars.push(vn);
    lines.push(vn + ' = ' + exprOfWord(sets[i].value));
  }
  lines.push('try {');
  for (const u of unsets) {
    lines.push(
      '  Remove-Item -LiteralPath ' + psStr('Env:\\' + u) + ' -ErrorAction SilentlyContinue',
    );
  }
  for (let i = 0; i < sets.length; i++) {
    const n = sets[i].name;
    const nq = n.replace(/'/g, "''");
    lines.push('  $env:' + n + ' = ' + valVars[i]);
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
        "' + [string][char]61 + [string](" +
        valVars[i] +
        ')); $env:FAUXNIX_SETVALS = ($fx_sm -join [string][char]10)',
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
  }
  for (const n of persistNames) {
    const nq = n.replace(/'/g, "''");
    lines.push(
      "  $env:FAUXNIX_SETVARS = ((@($env:FAUXNIX_SETVARS -split ';' | Where-Object { $_ -ne '' -and $_ -cne '" +
        nq +
        "' }) + '" +
        nq +
        "') -join ';')",
    );
  }
  lines.push('}');
  return lines.join('\n');
}

/** Unique suffix for generated stage functions (nested pipelines included). */
let stageSeq = 0;

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
export function translatePipelineBody(p: { commands: SimpleCommand[] }): PipelineParts {
  const bodies: string[] = [];
  for (let i = 0; i < p.commands.length; i++) {
    const hasStdin = i > 0 || p.commands[i].redirects.some((r) => r.op === '<');
    const position: PipelineCtx['position'] =
      i === 0 ? 'first' : i === p.commands.length - 1 ? 'last' : 'middle';
    bodies.push(translateSimple(p.commands[i], position, hasStdin));
  }

  if (bodies.length === 1) {
    return { defs: '', call: '(& {\n' + bodies[0] + '\n})' };
  }

  const names: string[] = [];
  const defs: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const name = '__fx_s' + stageSeq++;
    names.push(name);
    const indented = bodies[i]
      .split('\n')
      .map((l) => (l ? '  ' + l : l))
      .join('\n');
    defs.push('function ' + name + ' {\n' + indented + '\n}');
  }
  return { defs: defs.join('\n'), call: names.join(' | ') };
}

/* ------------------------------------------------------------------ */
/* Full translation with executor wrapper                              */
/* ------------------------------------------------------------------ */

export interface SegmentPlan {
  op: ';' | '&&' | '||';
  /** Complete PowerShell script for one powershell.exe invocation. */
  script: string;
  /** All redirects collected from this segment (executor handles them). */
  redirects: Redirect[];
}

export function translateCommandList(list: CommandList): SegmentPlan[] {
  const plans: SegmentPlan[] = [];
  for (const seg of list.segments) {
    const redirects: Redirect[] = [];
    for (const c of seg.pipeline.commands) redirects.push(...c.redirects);
    const { defs, call } = translatePipelineBody(seg.pipeline);
    let body = defs ? defs + '\n' + call : call;
    // `< file` redirects feed the pipeline via the FAUXNIX_STDIN_FILE channel
    if (redirects.some((r) => r.op === '<')) {
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
    plans.push({ op: seg.op, script: wrapScript(body), redirects });
  }
  return plans;
}

/**
 * Wrap a pipeline body with the Fauxnix executor contract:
 * UTF-8 everywhere, bash-style exit codes, cwd/env persistence channels.
 */
export function wrapScript(body: string): string {
  const lines = [
    '$ErrorActionPreference = "Continue"',
    "$ProgressPreference = 'SilentlyContinue'",
    '$fx_exit = 0',
    '$fx_prev = 0',
    'if ($env:FAUXNIX_PREV_EXIT) { try { $fx_prev = [int]$env:FAUXNIX_PREV_EXIT } catch { $fx_prev = 0 } }',
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
    'if ($env:FAUXNIX_CWD) { try { Set-Location -LiteralPath $env:FAUXNIX_CWD } catch {} }',
    // capture AFTER the session cwd is applied — OLDPWD must refer to the
    // shell's previous directory, not the host process' startup directory
    '$fx_oldcwd = (Get-Location).ProviderPath',
    // .NET APIs (ReadAllBytes & friends) resolve relative paths against the
    // process working directory, NOT the PS location — keep them in sync.
    'try { [Environment]::CurrentDirectory = (Get-Location).ProviderPath } catch {}',
    // byte-sniffing line reader for `< file` stdin redirects (UTF-8 → GBK)
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
    'exit $script:fx_exit',
  ];
  return lines.join('\n');
}
