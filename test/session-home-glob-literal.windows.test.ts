import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Runtime halves of #255 items 2/4/5. GNU expectations captured from Git Bash
// on the same fixtures: quoted globs touch nothing and error on the literal
// name; HOME overrides steer "$HOME" and ~; quoted/escaped creations are
// literal where the name is representable on NTFS.
describe.skipIf(!runnable)('session HOME / quote-aware globbing / literal creation on Windows (#255)', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-home-glob-'));
    const g = join(directory, 'g');
    mkdirSync(g);
    writeFileSync(join(g, 'a1b'), 'x');
    writeFileSync(join(g, 'aXb'), 'x');
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const run = (command: string) => session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it('rm with a quoted glob deletes nothing and reports the literal name (GNU parity)', async () => {
    const result = await run("rm 'a*b'");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("rm: cannot remove 'a*b': No such file or directory\n");
    expect(existsSync(join(directory, 'g', 'a1b'))).toBe(true);
    expect(existsSync(join(directory, 'g', 'aXb'))).toBe(true);
  });

  it('rm with an unquoted glob still expands', async () => {
    const result = await run('rm g/a*b');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(directory, 'g', 'a1b'))).toBe(false);
    expect(existsSync(join(directory, 'g', 'aXb'))).toBe(false);
  });

  it('HOME assignment steers "$HOME" and ~ within the session', async () => {
    const result = await run('HOME=/tmp/fx-home-test; echo "$HOME"');
    expect(result.exitCode, result.stderr).toBe(0);
    // /tmp normalizes to %TEMP%; the override must answer, not the profile.
    expect(result.stdout).toContain('fx-home-test');
  });

  it('mkdir/touch create literal names for representable metacharacters', async () => {
    const result = await run("touch 'a[1]b'; mkdir 'd[1]'");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(directory, 'a[1]b'))).toBe(true);
    expect(existsSync(join(directory, 'd[1]'))).toBe(true);
  });

  it('touch never creates a PowerShell provider object (Env:)', async () => {
    const result = await run("touch 'Env:\\FAUXNIX_TRAP'");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("touch: cannot touch 'Env:\\FAUXNIX_TRAP': No such file or directory\n");
  });
});
