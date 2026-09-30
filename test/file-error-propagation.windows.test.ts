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

// These guards must be verified on Windows. Every operand stays inside an
// isolated temporary fixture; no external path or permission is changed.
describe.skipIf(!runnable)('file failure guards on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-file-errors-'));
    for (const name of ['same.txt', 'relative.txt', 'in-parent.txt', 'noclobber.txt', 'parent-file', 'source.txt']) {
      writeFileSync(join(directory, name), `${name} fixture\n`);
    }
    mkdirSync(join(directory, 'same-dir'));
    writeFileSync(join(directory, 'same-dir', 'child.txt'), 'directory fixture\n');
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it.each([
    ['mv same.txt same.txt', 'same.txt'],
    ['mv relative.txt ./relative.txt', 'relative.txt'],
    ['mv in-parent.txt .', 'in-parent.txt'],
  ])('rejects %s without changing the source', async (command, name) => {
    const result = await run(command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('are the same file');
    expect(readFileSync(join(directory, name), 'utf8')).toBe(`${name} fixture\n`);
  });

  it('does not pre-remove a directory when the resolved destination is itself', async () => {
    const result = await run('mv same-dir .');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('are the same file');
    expect(readFileSync(join(directory, 'same-dir', 'child.txt'), 'utf8')).toBe('directory fixture\n');
  });

  it('retains mv -n skip behavior for an existing destination', async () => {
    const result = await run('mv -n noclobber.txt ./noclobber.txt');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(readFileSync(join(directory, 'noclobber.txt'), 'utf8')).toBe('noclobber.txt fixture\n');
  });

  it.each([
    ['cp source.txt parent-file/child', 'cp: cannot copy'],
    ['touch parent-file/child', 'touch: cannot touch'],
    ['mkdir parent-file/child', 'mkdir: cannot create directory'],
  ])('reports a nonzero command error for %s', async (command, diagnostic) => {
    const result = await run(command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(diagnostic);
    expect(readFileSync(join(directory, 'parent-file'), 'utf8')).toBe('parent-file fixture\n');
    expect(readFileSync(join(directory, 'source.txt'), 'utf8')).toBe('source.txt fixture\n');
  });
});
