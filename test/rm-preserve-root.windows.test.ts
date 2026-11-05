import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

// #255 at runtime. The session's cwd is fixture/outer/work so that even a
// regressed "." / ".." / "C:.." guard could only reach fixture/outer.
// Root operands are never executed here: those are covered by the
// generated-code suite, since a regression would be catastrophic on CI.
describe.skipIf(!runnable)('rm safety guards on Windows (#255)', { timeout: 30000 }, () => {
  let fixture: string;
  let work: string;
  let session: FauxnixSession;
  const sentinel = () => join(work, 'keep.txt');
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'fauxnix-rm-guard-'));
    work = join(fixture, 'outer', 'work');
    mkdirSync(join(work, 'sub'), { recursive: true });
    writeFileSync(sentinel(), 'keep\n');
    writeFileSync(join(fixture, 'outer', 'keep-outer.txt'), 'keep\n');
    mkdirSync(join(fixture, 'target'));
    writeFileSync(join(fixture, 'target', 'precious.txt'), 'precious\n');
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: work });

  it.each(['rm -rf .', 'rm -rf ./', 'rm -rf ..', 'rm -rf sub/..', 'rm -rf C:.', 'rm -rf C:..'])(
    '%s is refused and nothing is removed',
    async (command) => {
      const result = await run(command);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("refusing to remove '.' or '..' directory");
      expect(readFileSync(sentinel(), 'utf8')).toBe('keep\n');
      expect(existsSync(join(fixture, 'outer', 'keep-outer.txt'))).toBe(true);
    },
  );

  it('removes a junction as a link without touching its target', async () => {
    const link = join(work, 'junction');
    const made = spawnSync(selection.executable, [
      '-NoProfile', '-Command',
      `New-Item -ItemType Junction -Path '${link}' -Target '${join(fixture, 'target')}' | Out-Null`,
    ]);
    expect(made.status).toBe(0);
    const result = await run('rm -rf junction');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(link)).toBe(false);
    expect(readFileSync(join(fixture, 'target', 'precious.txt'), 'utf8')).toBe('precious\n');
  });

  it('still removes an ordinary directory tree', async () => {
    mkdirSync(join(work, 'tree', 'deep'), { recursive: true });
    writeFileSync(join(work, 'tree', 'deep', 'f.txt'), 'x');
    const result = await run('rm -rf tree');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(work, 'tree'))).toBe(false);
  });
});
