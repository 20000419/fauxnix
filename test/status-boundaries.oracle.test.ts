import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { statusBoundaryCases } from './status-boundaries.fixtures.js';

const bash = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : '/bin/bash';

describe.skipIf(!existsSync(bash))('status boundary Bash expectations', () => {
  it.each(statusBoundaryCases)('matches Bash: %s', (command, stdout, exitCode) => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', command], {
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
    expect(result.status).toBe(exitCode);
  });
});
