import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { FauxnixSession, cleanupSessionStateSync, sweepStaleStateDirs } from '../src/executor.js';

// #256: session state (cwd + full env snapshot) lives in one private,
// unpredictable directory that is removed on dispose, on exit/signals, by the
// host on stdin EOF, and by a later process's stale sweep.
const ensureStateDir = (s: FauxnixSession) => (s as unknown as { ensureStateDir(): void }).ensureStateDir();
const HEX24 = 'a'.repeat(24);

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid!;
}

describe('session temp-state hygiene (#256)', () => {
  it('keeps every state file inside one per-session directory with the owner pid and a CSPRNG name', () => {
    const session = new FauxnixSession();
    const p = session.statePaths;
    expect(dirname(p.dir)).toBe(tmpdir());
    expect(basename(p.dir)).toMatch(new RegExp(`^fauxnix-${process.pid}-[0-9a-f]{24}$`));
    for (const file of [p.cwd, p.env, p.host]) expect(dirname(file)).toBe(p.dir);
    expect(new FauxnixSession().statePaths.dir).not.toBe(p.dir);
  });

  it('childEnv() has no filesystem side effect', () => {
    const session = new FauxnixSession();
    const env = session.childEnv();
    expect(env.FAUXNIX_ENV_FILE).toBe(session.statePaths.env);
    expect(existsSync(session.statePaths.dir)).toBe(false);
  });

  it('creates the directory owner-only and removes it on dispose', async () => {
    const session = new FauxnixSession();
    const { dir } = session.statePaths;
    ensureStateDir(session);
    expect(statSync(dir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    await session.dispose();
    expect(existsSync(dir)).toBe(false);
    // a disposed session rebinds to a fresh, not-yet-created directory
    expect(session.statePaths.dir).not.toBe(dir);
    expect(existsSync(session.statePaths.dir)).toBe(false);
  });

  it('cleanupSessionStateSync kills the host before deleting, and the session stays usable', () => {
    const session = new FauxnixSession();
    ensureStateDir(session);
    const { dir } = session.statePaths;
    let dirExistedAtKill = false;
    const killSync = vi.fn(() => { dirExistedAtKill = existsSync(dir); });
    (session as unknown as { host: unknown }).host = { killSync };
    cleanupSessionStateSync();
    expect(killSync).toHaveBeenCalledOnce();
    expect(dirExistedAtKill).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect((session as unknown as { host: unknown }).host).toBeNull();
    // stateDirCreated was reset: the same session can recreate its directory
    ensureStateDir(session);
    expect(existsSync(dir)).toBe(true);
    session.releaseStateSync();
    expect(existsSync(dir)).toBe(false);
  });

  it('sweeps only old, matching directories whose owner process is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'fauxnix-sweep-test-'));
    try {
      const dead = deadPid();
      const old = Date.now() / 1000 - 3600;
      const mk = (name: string, age = old) => {
        const d = join(root, name);
        mkdirSync(d);
        writeFileSync(join(d, 'env.json'), '{}');
        utimesSync(d, age, age);
        return d;
      };
      const stale = mk(`fauxnix-${dead}-${HEX24}`);
      const young = mk(`fauxnix-${dead}-${'b'.repeat(24)}`, Date.now() / 1000);
      const alive = mk(`fauxnix-${process.ppid}-${'c'.repeat(24)}`);
      const mine = mk(`fauxnix-${process.pid}-${'d'.repeat(24)}`);
      const other = mk(`fauxnix-${dead}-${HEX24}-x`);
      const target = mk('precious');
      let link: string | null = join(root, `fauxnix-${dead}-${'e'.repeat(24)}`);
      try { symlinkSync(target, link, 'junction'); } catch { link = null; }

      expect(sweepStaleStateDirs(root)).toEqual([stale]);
      expect(existsSync(stale)).toBe(false);
      for (const d of [young, alive, mine, other, target]) expect(existsSync(d), d).toBe(true);
      expect(existsSync(join(target, 'env.json'))).toBe(true);
      if (link) expect(existsSync(link)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('removes state and exits 143 on SIGTERM', async () => {
    const { code, dir } = await signalChild('');
    expect(code).toBe(143);
    expect(existsSync(dir)).toBe(false);
  }, 20000);

  it.skipIf(process.platform === 'win32')('cleans up but defers the exit to another SIGTERM listener', async () => {
    const { code, dir } = await signalChild("process.on('SIGTERM', () => process.exit(7));");
    expect(code).toBe(7);
    expect(existsSync(dir)).toBe(false);
  }, 20000);
});

async function signalChild(prelude: string): Promise<{ code: number | null; dir: string }> {
  const executor = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'executor.ts');
  const script = [
    prelude,
    `const m = await import(${JSON.stringify(executor)});`,
    'm.installSessionExitCleanup();',
    'const s = new m.FauxnixSession();',
    's.ensureStateDir();',
    'console.log(s.statePaths.dir);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dir = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) resolve(out.trim());
    });
    child.once('exit', () => reject(new Error('child exited early')));
  });
  expect(existsSync(dir)).toBe(true);
  const code = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  child.kill('SIGTERM');
  return { code: await code, dir };
}
