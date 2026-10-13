/** Runtime evidence on Windows PS5.1/7; portable tests do not substitute for this. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import { commandOutputCases, commandOutputErrorCases, commandOutputFiles } from './command-output-regressions.fixtures.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

describe.skipIf(!runnable)('command output regressions on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-command-output-'));
    for (const [name, contents] of Object.entries(commandOutputFiles)) {
      writeFileSync(join(directory, name), contents);
    }
    writeFileSync(join(directory, 'human-size.txt'), 'x'.repeat(1536));
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it.each(['ls -lh human-size.txt', 'ls -l --human-readable human-size.txt'])(
    '%s renders human-readable file sizes without a missing helper', async (command) => {
      const result = await run(command);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toMatch(/\b1[.,]5K\b/);
      expect(result.stdout).toContain('human-size.txt');
    },
  );

  it.each(commandOutputCases)('%s', async (command, stdout) => {
    const result = await run(command);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
  });
  it.each(commandOutputErrorCases)('retains errors from %s', async (command, stdout) => {
    const result = await run(command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing.txt');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
  });
});
