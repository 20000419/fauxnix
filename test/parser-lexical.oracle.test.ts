import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { invalidForHeaders, lexicalCases } from './parser-lexical.fixtures.js';

const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : '/bin/bash';

describe.skipIf(!existsSync(bash))('shell lexical Bash expectations', () => {
  it.each(lexicalCases)('matches Bash: %s', (command, stdout, exitCode, stderrFragment) => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', command], {
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    if (stderrFragment) expect(result.stderr).toContain(stderrFragment);
    else expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
    expect(result.status).toBe(exitCode);
  });

  it.each(invalidForHeaders)('rejects malformed for syntax: %s', (command) => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-n', '-c', command], {
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
  });
});
