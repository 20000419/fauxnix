import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import { awkTextCases, parityFiles, sortTextCases } from './awk-sort-parity.fixtures.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

describe.skipIf(!runnable)('awk/sort text parity on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-awk-sort-'));
    for (const [name, content] of Object.entries(parityFiles)) writeFileSync(join(directory, name), content);
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) => session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it.each([...awkTextCases, ...sortTextCases])('preserves exact text for %s', async (command, stdout) => {
    const result = await run(command);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(stdout);
  });

  it('keeps adjacent printf fragments exact through raw-text consumers', async () => {
    const result = await run(String.raw`awk '{printf "%s", $1}' nums.txt | md5sum`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.split(/\s/)[0]).toBe(createHash('md5').update('135').digest('hex'));
  });

  it('preserves exact tails and CRLF in redirected files', async () => {
    const result = await run(String.raw`awk '{printf "%s", $1}' nums.txt > tail.out; awk 'BEGIN {printf "%s%c\n", "x", 13}' > crlf.out; sort -f mixed-case.txt > sorted.out`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    expect(readFileSync(join(directory, 'tail.out'))).toEqual(Buffer.from('135'));
    expect(readFileSync(join(directory, 'crlf.out'))).toEqual(Buffer.from('x\r\n'));
    expect(readFileSync(join(directory, 'sorted.out'))).toEqual(Buffer.from('Apple\napple\nBanana\nbanana\n'));
  });

  it('retains awk exit status after flushing printf output and running END', async () => {
    const result = await run(String.raw`awk '{printf "%s", $1; exit 7} END {printf "%s", "end"}' nums.txt`);
    expect(result.exitCode, result.stderr).toBe(7);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('1end');
  });

  it('preserves partial successful output and missing-file errors', async () => {
    const result = await run(String.raw`awk '{printf "%s", $1}' nums.txt missing.txt`);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('135');
    expect(result.stderr).toContain('awk: fatal: cannot open file');
    expect(result.stderr).toContain('missing.txt');

    const begin = await run(String.raw`awk 'BEGIN {printf "%s", "start"}' missing.txt`);
    expect(begin.exitCode).toBe(2);
    expect(begin.stdout).toBe('start');
    expect(begin.stderr).toContain('missing.txt');

    // The first stage buffers; the final stage streams. Each owns its helpers
    // and status slot, so the successful last stage still determines exit.
    const pipeline = await run(String.raw`awk '{printf "%s", $1}' nums.txt missing.txt | awk '{printf "%s", $0}'`);
    expect(pipeline.exitCode).toBe(0);
    expect(pipeline.stdout).toBe('135');
    expect(pipeline.stderr).toContain('missing.txt');
  });

  it('keeps direct awk output capture bounded without truncating redirected files', async () => {
    const direct = await session.run(
      translateCommandList(parseCommand(String.raw`awk '{printf "%s", $1}' nums.txt`)),
      { cwd: directory, stdoutLimit: 2 },
    );
    expect(direct.exitCode, direct.stderr).toBe(0);
    expect(direct.stderr).toBe('');
    expect(direct.stdout).toBe('13');
    expect(direct.truncated).toBe(true);
    const redirected = await session.run(
      translateCommandList(parseCommand(String.raw`awk '{printf "%s", $1}' nums.txt > budget.out`)),
      { cwd: directory, stdoutLimit: 2 },
    );
    expect(redirected.exitCode, redirected.stderr).toBe(0);
    expect(redirected.stdout).toBe('');
    expect(redirected.truncated).toBe(false);
    expect(readFileSync(join(directory, 'budget.out'))).toEqual(Buffer.from('135'));
  });

  it.each(['sort -s mixed-case.txt', 'sort -fs mixed-case.txt', 'sort --stable mixed-case.txt'])(
    'keeps the stable option unsupported in %s', async (command) => {
      const result = await run(command);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/invalid option|unrecognized option/);
    },
  );
});
