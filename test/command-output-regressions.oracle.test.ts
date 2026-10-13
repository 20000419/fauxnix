import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandOutputCases, commandOutputErrorCases, commandOutputFiles } from './command-output-regressions.fixtures.js';

const bash = spawnSync('bash', ['-c', 'command -v uniq && command -v tac']);
describe.skipIf(bash.status !== 0)('command output Bash oracle', () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-command-output-oracle-'));
    for (const [name, contents] of Object.entries(commandOutputFiles)) {
      writeFileSync(join(directory, name), contents);
    }
  });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each(commandOutputCases)('%s', (command, stdout) => {
    const result = spawnSync('bash', ['-c', command], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(stdout);
  });
  it.each(commandOutputErrorCases)('retains errors from %s', (command, stdout) => {
    const result = spawnSync('bash', ['-c', command], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('missing.txt');
    expect(result.stdout).toBe(stdout);
  });
});
