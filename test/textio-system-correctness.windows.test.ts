/** Real-runtime evidence is Windows-only; portable tests inspect generated code. */
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

describe.skipIf(!runnable)('text and system command regression execution', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-textio-correctness-'));
    writeFileSync(join(directory, 'lines.txt'), 'a\nb\nc\n');
    writeFileSync(join(directory, 'unicode.txt'), 'A😀e\u0301\n');
    writeFileSync(join(directory, 'empty.txt'), '');
    session = new FauxnixSession();
  });

  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ['head -qn2 lines.txt', 'a\nb\n'],
    ['head -vn 2 lines.txt', '==> lines.txt <==\na\nb\n'],
    ['head -qc-2 lines.txt', 'a\nb\n'],
    ['head -c1 -n2 lines.txt', 'a\nb\n'],
    ['head -n -0 lines.txt', 'a\nb\nc\n'],
    ['head -c -0 lines.txt', 'a\nb\nc\n'],
    ['head -n 0 lines.txt', ''],
    ['head -c 0 lines.txt', ''],
    ['head -n +0002 lines.txt', 'a\nb\n'],
    ['head -vq -n1 lines.txt', 'a\n'],
    ['tail -vq -n1 lines.txt', 'c\n'],
    ["echo -Een 'a\\nb'", 'a\nb'],
    ["echo -neE 'a\\nb'", 'a\\nb'],
    ['printf -- --', '--'],
    ['date -u -d @0 --date=@1 +%s', '1\n'],
    ['date -u --date=@0 -ud@1 +%s', '1\n'],
    ['base64 -w4 --wrap=8 lines.txt', 'YQpiCmMK\n'],
    ['base64 --wrap=4 -w8 lines.txt', 'YQpiCmMK\n'],
    ['wc -m unicode.txt', '5 unicode.txt\n'],
    ['wc -m empty.txt', '0 empty.txt\n'],
    ["printf 'A😀é\\n' | wc -m", '5\n'],
  ])('executes %s', async (command, stdout) => {
    const result = await session.run(translateCommandList(parseCommand(command)), { cwd: directory });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
  });

  it.each([
    ['head -n 2147483648 lines.txt', 'head: invalid number of'],
    ['head -n invalid -n2 lines.txt', 'head: invalid number of'],
    ['base64 -w', 'base64: option requires an argument'],
    ['base64 --wrap=-1 lines.txt', 'base64: invalid wrap size'],
    ['base64 --wrap=bad -w0 lines.txt', 'base64: invalid wrap size'],
  ])('fails loudly for %s', async (command, error) => {
    const result = await session.run(translateCommandList(parseCommand(command)), { cwd: directory });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(error);
  });
});
