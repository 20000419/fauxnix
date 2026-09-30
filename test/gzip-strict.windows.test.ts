import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { POWERSHELL_ARGS, resolvePowerShell } from '../src/powershell.js';
import { psStr } from '../src/registry.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const ps = resolvePowerShell();
const runnable = process.platform === 'win32' && !ps.error &&
  spawnSync(ps.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const payload = Buffer.from('first line\nsecond line\n');
const good = gzipSync(payload);
const crc = Buffer.from(good); crc[crc.length - 8] ^= 1;
const bad = [
  ['short-header', good.subarray(0, 5)], ['missing-footer', good.subarray(0, -4)],
  ['truncated-body', good.subarray(0, -9)], ['bad-checksum', crc],
  ['trailing-garbage', Buffer.concat([good, Buffer.from('ordinary trailing text')])],
  ['second-member-cut', Buffer.concat([good, good.subarray(0, -4)])],
] as const;

describe.skipIf(!runnable)('strict translated gzip decoding on Windows', { timeout: 60000 }, () => {
  let root: string;
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'fauxnix-gzip-strict-')); session = new FauxnixSession(); });
  beforeEach(() => { directory = mkdtempSync(join(root, 'case-')); });
  afterAll(async () => { await session?.dispose(); if (root) rmSync(root, { recursive: true, force: true }); });
  const run = (command: string) => session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  for (const command of ['gunzip sample.gz', 'gunzip -c sample.gz', 'gzip -t sample.gz']) {
    it.each(bad)(`${command} rejects %s without source loss or partial destination/stdout`, async (_name, bytes) => {
      writeFileSync(join(directory, 'sample.gz'), bytes);
      const result = await run(command);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('strict gzip decode failed');
      expect(readFileSync(join(directory, 'sample.gz'))).toEqual(bytes);
      expect(readdirSync(directory)).toEqual(['sample.gz']);
    });
  }

  it.each(['gunzip sample.gz', 'gunzip -c sample.gz', 'gzip -t sample.gz'])('decodes every concatenated member with %s', async (command) => {
    const bytes = Buffer.concat([good, gzipSync(Buffer.from('third line\n'))]);
    writeFileSync(join(directory, 'sample.gz'), bytes);
    const result = await run(command);
    expect(result.exitCode, result.stderr).toBe(0);
    if (command === 'gunzip sample.gz') {
      expect(readFileSync(join(directory, 'sample'), 'utf8')).toBe(payload.toString() + 'third line\n');
      expect(existsSync(join(directory, 'sample.gz'))).toBe(false);
    } else {
      expect(result.stdout).toBe(command.includes('-c') ? payload.toString() + 'third line\n' : '');
      expect(readFileSync(join(directory, 'sample.gz'))).toEqual(bytes);
    }
  });

  it('handles an empty complete member', async () => {
    writeFileSync(join(directory, 'empty.gz'), gzipSync(Buffer.alloc(0)));
    const result = await run('gunzip empty.gz');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(directory, 'empty')).length).toBe(0);
    expect(existsSync(join(directory, 'empty.gz'))).toBe(false);
  });

  it('passes Unicode, spaces and quote characters as filename data', async () => {
    const name = "新 gzip's 😀.gz";
    writeFileSync(join(directory, name), good);
    const quoted = "'" + name.replaceAll("'", "'\\''") + "'";
    const result = await run(`gunzip -c ${quoted}`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe(payload.toString());
    expect(readFileSync(join(directory, name))).toEqual(good);
  });

  it('records strict validation cost on small and large legitimate files', async () => {
    expect((await run('true')).exitCode).toBe(0);
    for (const bytes of [1024, 16 * 1024 * 1024]) {
      writeFileSync(join(directory, 'measure.gz'), gzipSync(Buffer.alloc(bytes, 97)));
      const start = performance.now();
      const result = await run('gzip -t measure.gz');
      const elapsedMs = performance.now() - start;
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
      console.log('strict gzip validation diagnostic (single warm-host sample)', JSON.stringify({ bytes, elapsedMs }));
    }
  });

  function raw(script: string, spool: string) {
    return spawnSync(ps.executable, [...POWERSHELL_ARGS, '-EncodedCommand', Buffer.from(
      `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; Set-Location -LiteralPath ${psStr(directory)}; $script:fx_exit = 0;\n` + script,
      'utf16le').toString('base64')], { encoding: 'utf8', timeout: 45000, env: { ...process.env, TEMP: spool, TMP: spool } });
  }

  it('cleans delete-on-close input/stdout spools for a valid byte-array helper input', () => {
    const spool = join(directory, 'spools'); mkdirSync(spool);
    const body = translateCommandList(parseCommand('gunzip -c unused.gz'))[0].body;
    const helpers = body.slice(0, body.indexOf('$fx_files ='));
    const result = raw(helpers + `\n$inputBytes = [Convert]::FromBase64String('${good.toString('base64')}'); ` +
      '$stream = fx-gz-open $inputBytes $true; $reader = New-Object IO.StreamReader($stream); ' +
      'try { [Console]::Out.Write($reader.ReadToEnd()) } finally { $reader.Dispose() }; exit 0', spool);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(payload.toString());
    expect(readdirSync(spool)).toEqual([]);
  });

  it('preserves the archive and removes owned stages if the pinned decoder is unavailable', () => {
    writeFileSync(join(directory, 'sample.gz'), good);
    const spool = join(directory, 'spools'); mkdirSync(spool);
    const body = translateCommandList(parseCommand('gunzip sample.gz'))[0].body;
    const pinned = '$fx_psi.FileName = ' + psStr(process.execPath);
    expect(body).toContain(pinned);
    const missing = body.replace(pinned, '$fx_psi.FileName = ' + psStr(join(directory, 'missing-node.exe')));
    const result = raw(missing + '\nexit $script:fx_exit', spool);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).not.toContain('not in gzip format');
    expect(result.stderr).toContain('gzip: sample.gz:');
    expect(readFileSync(join(directory, 'sample.gz'))).toEqual(good);
    expect(readdirSync(directory).sort()).toEqual(['sample.gz', 'spools']);
    expect(readdirSync(spool)).toEqual([]);
  });

  it('reports output-stream failure distinctly from corrupt gzip data', () => {
    writeFileSync(join(directory, 'sample.gz'), good);
    const spool = join(directory, 'spools'); mkdirSync(spool);
    const body = translateCommandList(parseCommand('gunzip -c sample.gz'))[0].body;
    const helpers = body.slice(0, body.indexOf('$fx_files ='));
    const script = helpers + '\n$sink = New-Object IO.MemoryStream(,[byte[]]@(65,66,67)); ' +
      '$sink.Dispose(); try { fx-gz-decode ' + psStr(join(directory, 'sample.gz')) +
      ' $false $sink $false; exit 99 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }';
    const result = raw(script, spool);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gzip output transfer failed');
    expect(result.stderr).not.toContain('not in gzip format');
    expect(readFileSync(join(directory, 'sample.gz'))).toEqual(good);
    expect(readdirSync(directory).sort()).toEqual(['sample.gz', 'spools']);
    expect(readdirSync(spool)).toEqual([]);
  });

  it('preserves an archive and an existing destination if a command is cancelled', async () => {
    const cancelled = new FauxnixSession();
    try {
      const bytes = gzipSync(Buffer.alloc(16 * 1024 * 1024, 97));
      writeFileSync(join(directory, 'sample.gz'), bytes);
      writeFileSync(join(directory, 'sample'), 'preexisting bytes');
      expect((await cancelled.run(translateCommandList(parseCommand('true')), { cwd: directory })).exitCode).toBe(0);
      const controller = new AbortController();
      const pending = cancelled.run(translateCommandList(parseCommand('gunzip sample.gz')), { cwd: directory, signal: controller.signal });
      controller.abort();
      const result = await pending;
      expect(result.cancelled).toBe(true);
      expect(readFileSync(join(directory, 'sample.gz'))).toEqual(bytes);
      expect(readFileSync(join(directory, 'sample'), 'utf8')).toBe('preexisting bytes');
    } finally { await cancelled.dispose(); }
  });
});
