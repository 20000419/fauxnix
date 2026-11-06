import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FauxnixSession, cleanupSessionStateSync } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { hostBootstrapScript, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

describe.skipIf(!runnable)('session temp-state hygiene on Windows (#256)', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fauxnix-hygiene-'));
  // Best-effort with retries: AV scanners on Windows intermittently hold
  // fresh temp files (same EPERM family as #248) — never fail the suite for it.
  afterAll(async () => {
    for (let i = 0; i < 3; i++) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  });

  const runHostToEof = (dir: string) => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'host.ps1'), hostBootstrapScript());
    writeFileSync(join(dir, 'env.json'), '{}');
    // stdin is empty: the host reads EOF immediately and exits.
    return spawnSync(selection.executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'host.ps1')], { input: '' });
  };

  it('the host removes its own per-session directory on stdin EOF', () => {
    const dir = join(tmpdir(), `fauxnix-999999-${'f'.repeat(24)}`);
    runHostToEof(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('the host never removes a directory that is not a per-session directory', () => {
    const dir = join(root, 'not-a-session-dir');
    runHostToEof(dir);
    expect(existsSync(join(dir, 'env.json'))).toBe(true);
  });

  it('sync cleanup terminates a busy host and removes the directory despite open handles', async () => {
    const session = new FauxnixSession();
    const { dir } = session.statePaths;
    const busy = session.run(translateCommandList(parseCommand('sleep 30')), { cwd: root });
    await new Promise((r) => setTimeout(r, 3000));
    expect(existsSync(dir)).toBe(true);
    cleanupSessionStateSync();
    expect(existsSync(dir)).toBe(false);
    await busy.catch(() => undefined);
    await session.dispose();
  });
});
