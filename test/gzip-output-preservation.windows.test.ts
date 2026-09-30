import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { psStr } from '../src/registry.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const payload = Buffer.from('original archive fixture\n');
const compressed = gzipSync(payload);

// Every source, destination, directory and raw-helper output belongs to this
// suite's newly created temp tree. No ACL changes or live user paths are used.
describe.skipIf(!runnable)('gzip default output preservation on Windows', { timeout: 30000 }, () => {
  let root: string;
  let session: FauxnixSession;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fauxnix-gzip-preserve-'));
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const fixture = () => mkdtempSync(join(root, 'case-'));
  const run = (command: string, cwd: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd });
  const noStagingFiles = (directory: string) =>
    expect(readdirSync(directory).filter((name) => name.startsWith('.fauxnix-gzip-'))).toEqual([]);

  it.each(['gzip source', 'gzip -k source', 'gzip --keep source'])(
    'preserves an existing destination and its source for %s', async (command) => {
      const directory = fixture();
      writeFileSync(join(directory, 'source'), payload);
      writeFileSync(join(directory, 'source.gz'), 'existing destination');
      const result = await run(command, directory);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('already exists; not overwritten');
      expect(readFileSync(join(directory, 'source'))).toEqual(payload);
      expect(readFileSync(join(directory, 'source.gz'), 'utf8')).toBe('existing destination');
      noStagingFiles(directory);
    },
  );

  it.each(['gunzip source.gz', 'gunzip -k source.gz', 'gzip -d source.gz', 'gzip -dk source.gz'])(
    'preserves both files after validating the input for %s', async (command) => {
      const directory = fixture();
      writeFileSync(join(directory, 'source.gz'), compressed);
      writeFileSync(join(directory, 'source'), 'existing destination');
      const result = await run(command, directory);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('already exists; not overwritten');
      expect(readFileSync(join(directory, 'source.gz'))).toEqual(compressed);
      expect(readFileSync(join(directory, 'source'), 'utf8')).toBe('existing destination');
      noStagingFiles(directory);
    },
  );

  it.each(['compress', 'decompress'])(
    'keeps a pre-existing destination directory unchanged during %s', async (mode) => {
      const directory = fixture();
      const source = mode === 'compress' ? 'source' : 'source.gz';
      const target = mode === 'compress' ? 'source.gz' : 'source';
      const bytes = mode === 'compress' ? payload : compressed;
      writeFileSync(join(directory, source), bytes);
      mkdirSync(join(directory, target));
      writeFileSync(join(directory, target, 'child'), 'keep directory content');
      const result = await run(`${mode === 'compress' ? 'gzip' : 'gunzip'} ${source}`, directory);
      expect(result.exitCode, result.stderr).toBe(2);
      expect(readFileSync(join(directory, source))).toEqual(bytes);
      expect(readFileSync(join(directory, target, 'child'), 'utf8')).toBe('keep directory content');
      noStagingFiles(directory);
    },
  );

  it.each(['gzip missing source', 'gunzip missing.gz source.gz'])(
    'does not downgrade an earlier error when %s later encounters a collision', async (command) => {
      const directory = fixture();
      writeFileSync(join(directory, 'source'), payload);
      writeFileSync(join(directory, 'source.gz'), compressed);
      const result = await run(command, directory);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('No such file or directory');
      expect(result.stderr).toContain('already exists; not overwritten');
      expect(readFileSync(join(directory, 'source'))).toEqual(payload);
      expect(readFileSync(join(directory, 'source.gz'))).toEqual(compressed);
      noStagingFiles(directory);
    },
  );

  it.each([
    ['gzip existing.gz', 0],
    ['gzip existing.tgz', 0],
    ['gzip missing existing.gz', 1],
    ['gzip existing.gz missing', 1],
    ['gunzip unknown.data', 2],
    ['gunzip missing.gz unknown.data', 1],
    ['gunzip unknown.data missing.gz', 1],
  ])('matches GNU suffix-diagnostic status for %s', async (command, status) => {
    const directory = fixture();
    for (const name of ['existing.gz', 'existing.tgz', 'unknown.data']) {
      writeFileSync(join(directory, name), compressed);
    }
    const result = await run(command, directory);
    expect(result.exitCode, result.stderr).toBe(status);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(command.startsWith('gunzip') ? 'unknown suffix -- ignored' : 'suffix -- unchanged');
    if (command.includes('missing')) expect(result.stderr).toContain('No such file or directory');
    for (const name of ['existing.gz', 'existing.tgz', 'unknown.data']) {
      expect(readFileSync(join(directory, name))).toEqual(compressed);
    }
    expect(readdirSync(directory).sort()).toEqual(['existing.gz', 'existing.tgz', 'unknown.data']);
  });

  it.each([false, true])('cleans malformed input staging, existing destination=%s', async (existing) => {
    const directory = fixture();
    writeFileSync(join(directory, 'bad.gz'), 'not a gzip stream');
    if (existing) writeFileSync(join(directory, 'bad'), 'keep existing');
    const result = await run('gunzip bad.gz', directory);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not in gzip format');
    expect(readFileSync(join(directory, 'bad.gz'), 'utf8')).toBe('not a gzip stream');
    if (existing) expect(readFileSync(join(directory, 'bad'), 'utf8')).toBe('keep existing');
    else expect(existsSync(join(directory, 'bad'))).toBe(false);
    noStagingFiles(directory);
  });

  it('cleans staging when a complete stream has a bad checksum', async () => {
    const directory = fixture();
    const corrupt = Buffer.from(compressed);
    corrupt[corrupt.length - 8] ^= 1;
    writeFileSync(join(directory, 'bad-crc.gz'), corrupt);
    const result = await run('gunzip bad-crc.gz', directory);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(join(directory, 'bad-crc.gz'))).toEqual(corrupt);
    expect(existsSync(join(directory, 'bad-crc'))).toBe(false);
    noStagingFiles(directory);
  });

  it.each([false, true])('still round-trips absent destinations, keep=%s', async (keep) => {
    const directory = fixture();
    writeFileSync(join(directory, 'source'), payload);
    const packed = await run(`gzip ${keep ? '-k ' : ''}source`, directory);
    expect(packed.exitCode, packed.stderr).toBe(0);
    expect(packed.stderr).toBe('');
    expect(gunzipSync(readFileSync(join(directory, 'source.gz')))).toEqual(payload);
    expect(existsSync(join(directory, 'source'))).toBe(keep);
    if (keep) rmSync(join(directory, 'source'));
    const unpacked = await run(`gunzip ${keep ? '-k ' : ''}source.gz`, directory);
    expect(unpacked.exitCode, unpacked.stderr).toBe(0);
    expect(unpacked.stderr).toBe('');
    expect(readFileSync(join(directory, 'source'))).toEqual(payload);
    expect(existsSync(join(directory, 'source.gz'))).toBe(keep);
    noStagingFiles(directory);
  });

  it.each(['compress', 'decompress'])(
    'reports real helper output-creation failure without removing unrelated files for %s', (mode) => {
      const directory = fixture();
      writeFileSync(join(directory, 'parent-file'), 'unrelated parent fixture');
      writeFileSync(join(directory, 'source.gz'), compressed);
      // Run unchanged production helpers with an impossible own-temp output
      // parent. This exercises real FileStream creation, without mocking it.
      const body = translateCommandList(parseCommand('gzip source'))[0].body;
      const helpers = body.slice(body.indexOf('Add-Type'), body.indexOf('$fx_files ='));
      const destination = join(directory, 'parent-file', 'child');
      const operation = mode === 'compress'
        ? `fx-gz-write-new ([byte[]]@(1, 2, 3)) ${psStr(destination)}`
        : `fx-gz-stream-file ${psStr(join(directory, 'source.gz'))} ${psStr(destination)}`;
      const script = [
        "$ErrorActionPreference = 'Stop'", "$ProgressPreference = 'SilentlyContinue'",
        '$script:fx_exit = 0', helpers,
        `try { $fx_test_success = ${operation}; if ($fx_test_success) { exit 0 } }`,
        "catch { [Console]::Error.WriteLine('fixture: caught output exception: ' + $_.Exception.Message); exit 1 }",
        'if ($script:fx_exit -eq 1) { exit 1 }; exit 99',
      ].join('\n');
      const result = spawnSync(selection.executable, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { cwd: directory, encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stderr || result.stdout).toBe(1);
      if (mode === 'compress') expect(result.stderr).toContain('fixture: caught output exception:');
      else {
        expect(result.stderr).toContain('gzip: ' + destination + ':');
        expect(result.stderr).not.toContain('fixture: caught output exception:');
      }
      expect(readFileSync(join(directory, 'parent-file'), 'utf8')).toBe('unrelated parent fixture');
      expect(readFileSync(join(directory, 'source.gz'))).toEqual(compressed);
      expect(readdirSync(directory).sort()).toEqual(['parent-file', 'source.gz']);
    },
  );

  it.each([
    ['short-header', compressed.subarray(0, 5)],
    ['missing-footer', compressed.subarray(0, -4)],
    ['truncated-body', compressed.subarray(0, -9)],
  ])('characterizes .NET truncation handling for %s without assuming validation parity', async (name, bytes) => {
    const directory = fixture();
    const source = `${name}.gz`;
    writeFileSync(join(directory, source), bytes);
    const result = await run(`gunzip -k ${source}`, directory);
    const destination = join(directory, name);
    // Some GZipStream versions accept premature EOF. Keep this observation
    // separate from no-clobber guarantees; -k preserves our input either way.
    console.log('gzip truncation characterization', JSON.stringify({
      edition: selection.expectedEdition, fixture: name, exitCode: result.exitCode,
      acceptedTruncatedInput: result.exitCode === 0,
      outputBytes: existsSync(destination) ? readFileSync(destination).length : null,
    }));
    expect([0, 1]).toContain(result.exitCode);
    expect(readFileSync(join(directory, source))).toEqual(bytes);
    if (result.exitCode !== 0) expect(existsSync(destination)).toBe(false);
    noStagingFiles(directory);
  });
});
