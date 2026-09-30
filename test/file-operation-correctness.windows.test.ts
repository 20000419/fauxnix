import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe.skipIf(!runnable)('file operation correctness on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-file-correctness-'));
    for (const [name, contents] of Object.entries({
      'upper.txt': 'Alpha\n',
      'lower.txt': 'alpha\n',
      'base.txt': 'a\nb\n',
      'middle.txt': 'a\nx\nb\n',
      'front.txt': 'x\na\nb\n',
    })) writeFileSync(join(directory, name), contents);
    mkdirSync(join(directory, 'existing-dir'));
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it.each([
    ['diff upper.txt lower.txt', '1c1\n< Alpha\n---\n> alpha\n'],
    ['diff -q upper.txt lower.txt', 'Files upper.txt and lower.txt differ\n'],
    ['diff base.txt middle.txt', '1a2\n> x\n'],
    ['diff middle.txt base.txt', '2d1\n< x\n'],
    ['diff base.txt front.txt', '0a1\n> x\n'],
    ['diff front.txt base.txt', '1d0\n< x\n'],
  ])('compares read-only fixtures with %s', async (command, stdout) => {
    const result = await run(command);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
  });

  it('only accepts pre-existing directories with mkdir -p', async () => {
    const accepted = await run('mkdir -p existing-dir');
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(accepted.stderr).toBe('');
    const rejected = await run('mkdir -p base.txt');
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain('File exists');
    expect(readFileSync(join(directory, 'base.txt'), 'utf8')).toBe('a\nb\n');
  });
});
