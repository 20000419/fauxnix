import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { POWERSHELL_ARGS, resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const ps = resolvePowerShell();
const runnable = process.platform === 'win32' && !ps.error &&
  spawnSync(ps.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const crossVolumeDirectory = process.platform === 'win32'
  ? [process.cwd(), process.env.USERPROFILE].find((path) => {
      try { return !!path && statSync(path).dev !== statSync(tmpdir()).dev; }
      catch { return false; }
    }) : undefined;

describe.skipIf(!runnable)('native move replacement preserves disposable fixtures', { timeout: 60000 }, () => {
  let root: string;
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'fauxnix-move-native-')); session = new FauxnixSession(); });
  beforeEach(() => { directory = mkdtempSync(join(root, 'case-')); });
  afterAll(async () => { await session?.dispose(); if (root) rmSync(root, { recursive: true, force: true }); });
  const run = (command: string) => session.run(translateCommandList(parseCommand(command)), { cwd: directory });
  function fixture(source = 'source.txt', target = 'target.txt') {
    writeFileSync(join(directory, source), 'source bytes');
    writeFileSync(join(directory, target), 'target bytes');
  }
  function unchanged(source = 'source.txt', target = 'target.txt') {
    expect(readFileSync(join(directory, source), 'utf8')).toBe('source bytes');
    expect(readFileSync(join(directory, target), 'utf8')).toBe('target bytes');
    expect(readdirSync(directory).sort()).toEqual([source, target].sort());
  }
  function raw(command: string, setup: string, cleanup = '') {
    const body = translateCommandList(parseCommand(command))[0].body;
    const script = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; ` +
      `Set-Location -LiteralPath ${psQuote(directory)}; $script:fx_exit = 0; ` + setup +
      `; try {\n${body}\n} finally { ${cleanup} }; exit $script:fx_exit`;
    return spawnSync(ps.executable, [...POWERSHELL_ARGS, '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 45000 });
  }

  it.each([['source.txt', 'target.txt'], ["新 source's 😀.txt", '目标 空格.txt']])(
    'replaces %s and retains source timestamps and alternate streams', async (source, target) => {
      fixture(source, target);
      const sourcePath = join(directory, source);
      const targetPath = join(directory, target);
      writeFileSync(sourcePath + ':source-stream', 'source stream');
      writeFileSync(targetPath + ':target-stream', 'old target stream');
      const stamp = new Date('2020-01-02T03:04:05Z');
      utimesSync(sourcePath, stamp, stamp);
      const before = statSync(sourcePath);
      const result = await run(`mv -v ${quote(source)} ${quote(target)}`);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toContain('renamed');
      expect(existsSync(sourcePath)).toBe(false);
      expect(readFileSync(targetPath, 'utf8')).toBe('source bytes');
      expect(statSync(targetPath).mtimeMs).toBe(before.mtimeMs);
      expect(readFileSync(targetPath + ':source-stream', 'utf8')).toBe('source stream');
      expect(existsSync(targetPath + ':target-stream')).toBe(false);
    });

  it('rejects same-file hardlink aliases without unlinking either name', async () => {
    writeFileSync(join(directory, 'source.txt'), 'same bytes');
    linkSync(join(directory, 'source.txt'), join(directory, 'alias.txt'));
    const result = await run('mv source.txt alias.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('same file');
    expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('same bytes');
    expect(readFileSync(join(directory, 'alias.txt'), 'utf8')).toBe('same bytes');
    expect(statSync(join(directory, 'source.txt')).nlink).toBe(2);
  });

  for (const side of ['source', 'target']) it(`rejects a ${side} file symlink without following it`, async (context) => {
    fixture();
    try { symlinkSync(join(directory, side === 'source' ? 'source.txt' : 'target.txt'), join(directory, 'alias.txt'), 'file'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        context.skip(); // Symlink privilege is not enabled or changed by tests.
        return;
      }
      throw error;
    }
    const result = await run(side === 'source' ? 'mv alias.txt target.txt' : 'mv source.txt alias.txt');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('reparse points');
    expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('source bytes');
    expect(readFileSync(join(directory, 'target.txt'), 'utf8')).toBe('target bytes');
    expect(lstatSync(join(directory, 'alias.txt')).isSymbolicLink()).toBe(true);
  });

  it.skipIf(!crossVolumeDirectory)('rejects replacement across two existing volumes with both files intact', async () => {
    const other = mkdtempSync(join(crossVolumeDirectory!, 'fauxnix-cross-volume-'));
    try {
      const source = join(directory, 'source.txt');
      const target = join(other, 'target.txt');
      writeFileSync(source, 'source bytes');
      writeFileSync(target, 'target bytes');
      expect(statSync(source).dev).not.toBe(statSync(target).dev);
      const result = await run(`mv source.txt ${quote(target.replaceAll('\\', '/'))}`);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cross-volume replacement is unsupported');
      expect(readFileSync(source, 'utf8')).toBe('source bytes');
      expect(readFileSync(target, 'utf8')).toBe('target bytes');
      expect(readdirSync(other)).toEqual(['target.txt']);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it.each(['source.txt', 'target.txt'])('preserves both files when %s is locked', (locked) => {
    fixture();
    const result = raw('mv source.txt target.txt',
      `$held = [IO.File]::Open(${psQuote(join(directory, locked))}, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)`,
      '$held.Dispose()');
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('mv: cannot move');
    unchanged();
  });

  it('preserves a read-only destination without altering its attributes', () => {
    fixture();
    const target = psQuote(join(directory, 'target.txt'));
    const result = raw('mv -f source.txt target.txt',
      `$original = [IO.File]::GetAttributes(${target}); [IO.File]::SetAttributes(${target}, $original -bor [IO.FileAttributes]::ReadOnly)`,
      `[Console]::Out.WriteLine('readonly=' + (([IO.File]::GetAttributes(${target}) -band [IO.FileAttributes]::ReadOnly) -ne 0)); [IO.File]::SetAttributes(${target}, $original)`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('readonly=True');
    unchanged();
  });

  it('fails closed if the native helper cannot be loaded', () => {
    fixture();
    const result = raw('mv source.txt target.txt', "function Add-Type { throw 'fixture helper unavailable' }");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('fixture helper unavailable');
    unchanged();
  });

  it('does not load the native helper for -n or an absent destination', () => {
    fixture();
    const result = raw('mv -n source.txt target.txt', "function Add-Type { throw 'unexpected helper load' }");
    expect(result.status, result.stderr).toBe(0);
    unchanged();
    const absent = raw('mv source.txt new.txt', "function Add-Type { throw 'unexpected helper load' }");
    expect(absent.status, absent.stderr).toBe(0);
    expect(existsSync(join(directory, 'source.txt'))).toBe(false);
    expect(readFileSync(join(directory, 'new.txt'), 'utf8')).toBe('source bytes');
  });

  it('refuses an empty destination directory without removing either directory', async () => {
    mkdirSync(join(directory, 'source'));
    mkdirSync(join(directory, 'target'));
    mkdirSync(join(directory, 'target', 'source'));
    const result = await run('mv source target');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('both directories retained');
    expect(statSync(join(directory, 'source')).isDirectory()).toBe(true);
    expect(statSync(join(directory, 'target', 'source')).isDirectory()).toBe(true);
  });

  it('records lazy helper cost separately from host startup', async () => {
    const measured = new FauxnixSession();
    try {
      const invoke = (command: string) => measured.run(translateCommandList(parseCommand(command)), { cwd: directory });
      expect((await invoke('true')).exitCode).toBe(0);
      const times: number[] = [];
      for (const i of [0, 1]) {
        fixture(`source${i}.txt`, `target${i}.txt`);
        const start = performance.now();
        const result = await invoke(`mv source${i}.txt target${i}.txt`);
        times.push(performance.now() - start);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(readFileSync(join(directory, `target${i}.txt`), 'utf8')).toBe('source bytes');
      }
      console.log('mv native helper diagnostic (single cold/warm sample, no speedup claim)', JSON.stringify({ firstMs: times[0], warmMs: times[1] }));
    } finally { await measured.dispose(); }
  });
});
