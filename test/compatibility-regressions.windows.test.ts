import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe.skipIf(!runnable)('supported syntax regression execution', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-compatibility-'));
    writeFileSync(join(directory, 'numbers.txt'), 'z 2\na 10\nm 1\n');
    writeFileSync(join(directory, 'notes.log'), '--include=*.txt\nordinary\n');
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it.each([
    ['sort -nk2,2 numbers.txt', 'm 1\nz 2\na 10\n'],
    ["grep -F -e '--include=*.txt' notes.log", '--include=*.txt\n'],
    ['printf "%s" "first\\\nsecond"', 'firstsecond'],
    ["printf '%s' \"$(printf '%s' \\))\"", ')'],
    ["printf '%s' \"$(printf '%s' \\()\"", '('],
    ["printf '%s' \"$(printf '%s' '\\')\"", '\\'],
    ["printf 'a\\nb\\n' |\n# continuation\nhead -n 1", 'a\n'],
  ])('executes %s', async (command, stdout) => {
    const result = await session.run(translateCommandList(parseCommand(command)), { cwd: directory });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
  });
});
