import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PS_IOERR_FN } from '../src/commands/files.js';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

const hr = (code: number) => (0x80070000 | code) | 0; // signed Int32 HResult

// [PowerShell expression producing an exception, expected text]
const cases: [string, string][] = [
  ['[UnauthorizedAccessException]::new("x")', 'Permission denied'],
  ['[IO.PathTooLongException]::new("x")', 'File name too long'],
  ['[IO.DirectoryNotFoundException]::new("x")', 'No such file or directory'],
  [`[IO.IOException]::new("x", ${hr(32)})`, 'Device or resource busy'],
  [`[IO.IOException]::new("x", ${hr(145)})`, 'Directory not empty'],
  [`[IO.IOException]::new("x", ${hr(267)})`, 'Not a directory'],
  [`[IO.IOException]::new("x", ${hr(183)})`, 'File exists'],
  [`[IO.IOException]::new("x", ${hr(112)})`, 'No space left on device'],
  // generic outer IOException wrapping the specific cause
  ['[IO.IOException]::new("outer", [UnauthorizedAccessException]::new("in"))', 'Permission denied'],
  [`[IO.IOException]::new("outer", [IO.IOException]::new("in", ${hr(267)}))`, 'Not a directory'],
  // unknown: deterministic fallback, not the (localized) message
  ['[IO.IOException]::new("localized text")', 'FALLBACK'],
  ['[InvalidOperationException]::new("localized text")', 'FALLBACK'],
];

describe.skipIf(!runnable)('fx-ioerr on Windows PowerShell', { timeout: 30000 }, () => {
  it('maps real .NET exceptions (including wrapped ones) to GNU text', () => {
    const script = [
      PS_IOERR_FN,
      ...cases.map(([expr]) => `try { throw (${expr}) } catch { [Console]::Out.WriteLine((fx-ioerr $_ 'FALLBACK')) }`),
    ].join('\n');
    const r = spawnSync(selection.executable, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.trim().split(/\r?\n/)).toEqual(cases.map(([, text]) => text));
  });

  describe('through the session', () => {
    let directory: string;
    let session: FauxnixSession;
    beforeAll(() => {
      directory = mkdtempSync(join(tmpdir(), 'fauxnix-ioerr-'));
      writeFileSync(join(directory, 'parent-file'), 'x');
      writeFileSync(join(directory, 'locked.txt'), 'x');
      session = new FauxnixSession();
    });
    afterAll(async () => {
      await session?.dispose();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });
    const run = (command: string) => session.run(translateCommandList(parseCommand(command)), { cwd: directory });

    it('touch under a regular file never prints a localized message', async () => {
      const result = await run('touch parent-file/child');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/^touch: cannot touch 'parent-file\/child': (Not a directory|No such file or directory)\r?\n$/);
    });

    it('rm of a file held open without sharing reports Device or resource busy', async () => {
      const target = join(directory, 'locked.txt');
      const holder = spawn(selection.executable, ['-NoProfile', '-NonInteractive', '-Command',
        `$h = [IO.File]::Open('${target}', 'Open', 'Read', 'None'); [Console]::Out.WriteLine('opened'); Start-Sleep -Seconds 20; $h.Dispose()`]);
      try {
        await new Promise<void>((resolve, reject) => {
          holder.stdout.on('data', (d) => { if (String(d).includes('opened')) resolve(); });
          holder.once('exit', () => reject(new Error('lock holder exited early')));
        });
        const result = await run('rm locked.txt');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("rm: cannot remove 'locked.txt': Device or resource busy");
      } finally {
        holder.kill();
      }
    });
  });
});
