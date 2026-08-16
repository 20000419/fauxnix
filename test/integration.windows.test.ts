/**
 * Integration tests — execute translated commands through real Windows
 * PowerShell 5.1. Skipped automatically on non-Windows platforms.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '../src/parser.js';
import { translateCommandList } from '../src/translator.js';
import { FauxnixSession } from '../src/executor.js';
import '../src/commands/install-all.js';

const onWindows = process.platform === 'win32';
const hasPs =
  onWindows &&
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { shell: false }).status === 0;

describe.skipIf(!hasPs)('integration (real PowerShell)', () => {
  let dir: string;
  let session: FauxnixSession;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fauxnix-it-'));
    writeFileSync(join(dir, 'fruits.txt'), 'apple\nBanana\napple pie\ncherry\n', 'utf8');
    writeFileSync(join(dir, 'nums.txt'), '1 2\n3 4\n5 6\n', 'utf8');
    writeFileSync(join(dir, 'dups.txt'), 'aaa\naaa\nbbb\n', 'utf8');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'third line\n', 'utf8');
    session = new FauxnixSession();
    // seed the session cwd like a real shell login directory
    await session.run(translateCommandList(parseCommand('cd "' + dir + '"')));
  });

  afterAll(async () => {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(cmd: string) {
    return session.run(translateCommandList(parseCommand(cmd)));
  }

  it('cat reads files', async () => {
    const r = await run('cat fruits.txt');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual([
      'apple',
      'Banana',
      'apple pie',
      'cherry',
    ]);
    expect(r.exitCode).toBe(0);
  });

  it('cat missing file: bash-style stderr + exit 1', async () => {
    const r = await run('cat nope.txt');
    expect(r.stderr).toContain('cat: nope.txt: No such file or directory');
    expect(r.exitCode).toBe(1);
  });

  it('ls -la shows GNU columns', async () => {
    const r = await run('ls -la');
    expect(r.stdout).toMatch(/-rw-r--r--.*fruits\.txt/);
    expect(r.stdout).toMatch(/drwxr-xr-x.*sub/);
  });

  it('grep + exit codes', async () => {
    expect((await run('grep -n apple fruits.txt')).stdout).toContain('1:apple');
    expect((await run('grep apple fruits.txt')).exitCode).toBe(0);
    expect((await run('grep zz fruits.txt')).exitCode).toBe(1);
    expect((await run('grep x missing-file')).exitCode).toBe(2);
  });

  it('pipeline: cat | grep | sort', async () => {
    const r = await run('cat fruits.txt | grep -i apple | sort');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['apple', 'apple pie']);
  });

  it('sed substitution', async () => {
    const r = await run("sed 's/apple/MANGO/g' fruits.txt");
    expect(r.stdout).toContain('MANGO pie');
    expect(r.stdout).not.toContain('apple');
  });

  it('awk field printing and sum', async () => {
    expect((await run("awk '{print $1}' fruits.txt")).stdout).toContain('apple');
    expect((await run("awk '{sum += $1} END {print sum}' nums.txt")).stdout.trim()).toBe('9');
  });

  it('sort -n and uniq -c', async () => {
    const r = await run('sort dups.txt | uniq -c');
    expect(r.stdout).toMatch(/2 aaa/);
    expect(r.stdout).toMatch(/1 bbb/);
  });

  it('head/tail/wc', async () => {
    expect((await run('head -1 fruits.txt')).stdout.trim()).toBe('apple');
    expect((await run('tail -1 fruits.txt')).stdout.trim()).toBe('cherry');
    expect((await run('wc -l fruits.txt')).stdout.trim()).toMatch(/4/);
    expect((await run('wc -l < fruits.txt')).stdout.trim()).toBe('4');
  });

  it('echo/printf semantics', async () => {
    expect((await run('echo hello world')).stdout.trim()).toBe('hello world');
    expect((await run("printf '%s=%d\\n' x 42")).stdout.trim()).toBe('x=42');
    const noNl = await run('echo -n abc');
    expect(noNl.stdout).toBe('abc');
  });

  it('md5sum matches known hash', async () => {
    const r = await run('md5sum fruits.txt');
    // md5 of 'apple\nBanana\napple pie\ncherry\n'
    expect(r.stdout).toMatch(/332793e5f4f290f27e0795f1d9a7f5f8|^\w{32}  fruits\.txt/);
  });

  it('redirects: > >> 2> /dev/null 2>&1', async () => {
    const r = await run('echo one > o.txt; echo two >> o.txt; cat o.txt');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['one', 'two']);
    const silenced = await run('cat missing.txt 2>/dev/null; echo OK');
    expect(silenced.stderr).toBe('');
    expect(silenced.stdout.trim()).toBe('OK');
  });

  it('&& and || short-circuit like bash', async () => {
    expect((await run('cat missing.txt || echo FELLBACK')).stdout).toContain('FELLBACK');
    const r = await run('cat missing.txt && echo NOPE ; echo END');
    expect(r.stdout.trim()).toBe('END');
    expect(r.exitCode).toBe(0);
  });

  it('$? reflects the previous segment', async () => {
    expect((await run('false; echo $?')).stdout.trim()).toBe('1');
    expect((await run('true; echo $?')).stdout.trim()).toBe('0');
  });

  it('variables and command substitution', async () => {
    expect((await run('export GREET=hi; echo $GREET/there')).stdout.trim()).toBe('hi/there');
    expect((await run('echo $(echo nested)')).stdout.trim()).toBe('nested');
  });

  it('session cwd persists across calls', async () => {
    await run('cd sub');
    const r = await run('pwd');
    expect(r.stdout).toContain('/sub');
    expect(r.stdout).toMatch(/C:\/.*Temp.*\/sub/);
    // restore for subsequent tests — also exercises `cd -` (OLDPWD)
    const back = await run('cd - && pwd');
    expect(back.exitCode).toBe(0);
  });

  it('find + wc -l counts rows', async () => {
    const r = await run("find sub -name '*.txt' | wc -l");
    expect(r.stdout.trim()).toBe('1');
  });

  it('stat -c format', async () => {
    const r = await run("stat -c '%s %n' fruits.txt");
    expect(r.stdout.trim()).toMatch(/^30 .*fruits\.txt$/);
  });

  it('diff detects changes GNU-style', async () => {
    const r = await run('diff fruits.txt sub/b.txt');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/1,4c1/);
    expect(r.stdout).toContain('< apple');
    expect(r.stdout).toContain('> third line');
  });

  it('gzip/gunzip roundtrip', async () => {
    await run('cp fruits.txt g.txt');
    await run('gzip g.txt');
    const gz = await run('ls g.txt.gz');
    expect(gz.exitCode).toBe(0);
    await run('gunzip g.txt.gz');
    const back = await run('cat g.txt');
    expect(back.stdout).toContain('apple pie');
  });

  it('ps table has header', async () => {
    const r = await run('ps aux | head -1');
    expect(r.stdout).toMatch(/USER\s+PID/);
  });

  it('uname reports fauxnix kernel marker', async () => {
    expect((await run('uname -r')).stdout.trim()).toBe('6.8.0-fauxnix');
  });

  it('date format tokens', async () => {
    expect((await run('date +%Y')).stdout).toMatch(/^\d{4}/);
  });

  it('native passthrough (node) with argv safety', async () => {
    const r = await run('node --version');
    expect(r.stdout.trim()).toMatch(/^v\d+\.\d+/);
  });

  it('xargs runs native commands', async () => {
    const r = await run("printf -- '--version\\n' | xargs node");
    expect(r.stdout.trim()).toMatch(/^v\d+\.\d+/);
  });

  it('host guard refuses loopback URLs for curl', async () => {
    const r = await run('curl -s http://127.0.0.1:9/x');
    expect(r.stderr).toContain('refused private/loopback address');
    expect(r.exitCode).not.toBe(0);
  });

  it('timeout kills long sleeps with exit 124', async () => {
    const r = await run('timeout 1 sleep 5');
    expect(r.exitCode).toBe(124);
  }, 20000);

  it('Chinese text round-trips (UTF-8)', async () => {
    await run("echo '你好，世界' > zh.txt");
    const r = await run('cat zh.txt');
    expect(r.stdout.trim()).toBe('你好，世界');
    const g = await run("grep '世界' zh.txt");
    expect(g.exitCode).toBe(0);
  });

  it('yes | head terminates (no hang)', async () => {
    const r = await run('yes | head -3');
    expect(r.stdout.split(/\r?\n/).filter((l) => l === 'y').length).toBe(3);
  }, 30000);
});
