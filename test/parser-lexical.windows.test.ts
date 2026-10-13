import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { POWERSHELL_ARGS, resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import { lexicalCases } from './parser-lexical.fixtures.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

describe.skipIf(!runnable)('shell lexical execution on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-lexical-'));
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(lexicalCases)('matches Bash through the resident host: %s', async (command, stdout, exitCode, stderrFragment) => {
    const result = await session.run(translateCommandList(parseCommand(command)), {
      cwd: directory, timeoutMs: 10000,
    });
    expect(result.timedOut).toBe(false);
    if (stderrFragment) expect(result.stderr).toContain(stderrFragment);
    else expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
    expect(result.exitCode).toBe(exitCode);
  });

  it.each(lexicalCases)('matches Bash in a standalone script: %s', (command, stdout, exitCode, stderrFragment) => {
    const [plan] = translateCommandList(parseCommand(`if true; then ${command}; fi`));
    const script = join(directory, 'lexical.ps1');
    writeFileSync(script, '\uFEFF' + plan.script);
    const result = spawnSync(selection.executable, [...POWERSHELL_ARGS, '-File', script], {
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.error).toBeUndefined();
    if (stderrFragment) expect(result.stderr).toContain(stderrFragment);
    else expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
    expect(result.status).toBe(exitCode);
  });
});
