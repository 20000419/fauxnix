import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { POWERSHELL_ARGS, resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import { statusBoundaryCases } from './status-boundaries.fixtures.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

describe.skipIf(!runnable)('status boundaries on Windows', { timeout: 30000 }, () => {
  let session: FauxnixSession;
  beforeAll(() => { session = new FauxnixSession(); });
  afterAll(async () => { await session?.dispose(); });

  it.each(statusBoundaryCases)('matches Bash through the resident host: %s', async (command, stdout, exitCode) => {
    const result = await session.run(translateCommandList(parseCommand(command)), { timeoutMs: 10000 });
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
    expect(result.exitCode).toBe(exitCode);
  });

  it.each(statusBoundaryCases)('matches Bash in one generated spawn script: %s', (command, stdout, exitCode) => {
    // An enclosing compound keeps the whole list in one generated script,
    // independently exercising inline boundaries instead of host segments.
    const [plan] = translateCommandList(parseCommand(`if true; then ${command}; fi`));
    const result = spawnSync(selection.executable, [...POWERSHELL_ARGS, '-Command', plan.script], {
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
    expect(result.status).toBe(exitCode);
  });
});
