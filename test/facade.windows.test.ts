import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFacade } from '../src/facade.js';

const onWindows = process.platform === 'win32';

// All contract assertions run through real `fauxnix facade` processes:
// the argv/stdin/exit-code surface is the thing under test. Spawn count is
// kept low (3) because the perf guard (RFC U-8) in integration.windows.test.ts
// measures sub-400ms frames and starves when sibling files spawn heavily.
function facadeProcess(args: string[], input?: string) {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawnSync(process.execPath, [tsx, 'src/index.ts', 'facade', ...args], {
    encoding: 'utf8',
    input: input ?? '',
    timeout: 60_000,
  });
}

describe.skipIf(!onWindows)('facade entry (RFC #224 phase 1)', { timeout: 120_000, hookTimeout: 120_000 }, () => {
  it('--version discloses the fauxnix identity', async () => {
    // pure string path: assert in-process to keep the spawn budget for contracts
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stdout.write;
    try {
      const code = await runFacade(['--version']);
      expect(code).toBe(0);
      expect(out.join('')).toMatch(/GNU bash, version .+\(fauxnix facade [\d.]+\)/);
    } finally {
      process.stdout.write = orig;
    }
  });

  it('-c one-shot propagates the exit code end-to-end', () => {
    const r = facadeProcess(['-c', "printf 'one\\n'; exit 3"]);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('one\n');
  });

  it('-c trailing operands set $0 and $1 (bash argv contract)', () => {
    const r = facadeProcess(['-c', 'echo "$0-$1"', 'myname', 'arg1']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('myname-arg1\n');
  });

  it('persistent stdin session keeps cwd across <bash-input> blocks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-facade-s-'));
    mkdirSync(join(dir, 'sub'));
    try {
      const r = facadeProcess(
        [],
        [
          `<bash-input>cd ${JSON.stringify(join(dir, 'sub'))}</bash-input>`,
          '<bash-input>pwd</bash-input>',
          '<bash-input>definitely_not_a_command_xyz</bash-input>',
          '<bash-input>echo done</bash-input>',
        ].join('\n') + '\n',
      );
      expect(r.status).toBe(0);
      // one exit marker per block; the unknown command reports 127, later blocks still run
      const exits = r.stdout.match(/<bash-exit>\d+<\/bash-exit>/g) ?? [];
      expect(exits).toEqual([
        '<bash-exit>0</bash-exit>',
        '<bash-exit>0</bash-exit>',
        '<bash-exit>127</bash-exit>',
        '<bash-exit>0</bash-exit>',
      ]);
      expect(r.stderr).toContain('command not found');
      expect(r.stderr.endsWith('\n')).toBe(true);
      // cwd persisted and rendered POSIX-form at the boundary (#223)
      expect(r.stdout).toMatch(/\/[a-z]\/.*fauxnix-facade-s-\w+\/sub/);
      expect(r.stdout).toContain('done\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
