import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// Golden text expectations were checked using GNU stat 9.7 on identical
// newly created fixtures. Official semantics:
// https://www.gnu.org/s/coreutils/manual/html_node/stat-invocation.html
const textCases = [
  ["stat --printf='%s' a b", '42'],
  ["stat --printf='' a b", ''],
  [String.raw`stat --printf='%s\n' a b`, '4\n2\n'],
  [String.raw`stat --printf='%s\t%n\r\n' a b`, '4\ta\r\n2\tb\r\n'],
  [String.raw`stat --printf='\x25s|\045s|%%s\n' a`, '%s|%s|%s\n'],
  [String.raw`stat --printf='\a\b\e\f\n\r\t\v\\' a`, '\x07\b\x1b\f\n\r\t\v\\'],
  [String.raw`stat --printf='\x41G|\1012|\0|\400|\08' a`, 'AG|A2|\x00|\x00|\x008'],
  [String.raw`stat -c '%s\n' a`, '4\\n\n'],
  [String.raw`stat --printf=first --format='%s\n' a`, '4\\n\n'],
  [String.raw`stat -c first --printf='%s\n' a`, '4\n'],
  [String.raw`stat --printf=first -c '%s' a`, '4\n'],
  [String.raw`stat --printf='%s' a b | wc -c`, '2\n'],
  [String.raw`stat --printf='%s\0' a b | wc -c`, '4\n'],
  [String.raw`printf '<%s>' "$(stat --printf='%s' a b)"`, '<42>'],
  [String.raw`printf '<%s>' "$(stat --printf='%s\n' a b)"`, '<4\n2>'],
  [String.raw`OUT="$(stat --printf='%s' a b)"; printf '<%s>' "$OUT"`, '<42>'],
  [String.raw`stat --printf='你好\n' a`, '你好\n'],
  [String.raw`stat --printf='$VALUE|%n|\n' 'literal$VALUE%F.txt'`, '$VALUE|literal$VALUE%F.txt|\n'],
];

describe.skipIf(!runnable)('stat --printf text fidelity on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-stat-printf-'));
    writeFileSync(join(directory, 'a'), 'abcd');
    writeFileSync(join(directory, 'b'), '12');
    writeFileSync(join(directory, 'literal$VALUE%F.txt'), 'literal fixture');
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested', 'n-file%F.txt'), 'nested fixture');
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it.each(textCases)('matches GNU text output for %s', async (command, expected) => {
    const result = await run(command);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(expected);
  });

  it('does not interpret backslashes or percent fields inserted from filenames', async () => {
    const result = await run(String.raw`stat --printf='%n' 'nested\n-file%F.txt'`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(String.raw`nested\n-file%F.txt`);
  });

  it('keeps ASCII NUL through a raw-text pipeline and terminal output', async () => {
    const result = await run(String.raw`stat --printf='%s\0' a b`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe('4\x002\x00');
    const hash = await run(String.raw`stat --printf='%s\0' a b | md5sum`);
    expect(hash.exitCode, hash.stderr).toBe(0);
    expect(hash.stdout.split(/\s/)[0]).toBe(createHash('md5').update(Buffer.from([52, 0, 50, 0])).digest('hex'));
  });

  it('retains NUL in command substitution under the documented fauxnix text behavior', async () => {
    // Bash strips these NULs; the existing fauxnix collector preserves them.
    // This is an explicit transport limitation, not a GNU golden case.
    const result = await run(String.raw`printf '<%s>' "$(stat --printf='%s\0' a b)"`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('<4\x002\x00>');
  });

  it('preserves exact text tails, CRLF, and NUL in redirected files', async () => {
    const result = await run(String.raw`stat --printf='%s' a b > plain.out; stat --printf='%s\r\n' a b > crlf.out; stat --printf='%s\0' a b > nul.out`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    expect(readFileSync(join(directory, 'plain.out'))).toEqual(Buffer.from('42'));
    expect(readFileSync(join(directory, 'crlf.out'))).toEqual(Buffer.from('4\r\n2\r\n'));
    expect(readFileSync(join(directory, 'nul.out'))).toEqual(Buffer.from([52, 0, 50, 0]));
  });

  it('reports unknown escapes per operand without changing the successful status', async () => {
    const result = await run(String.raw`stat --printf='\q%s' a b`);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('q4q2');
    expect(result.stderr.replace(/\r\n/g, '\n')).toBe("stat: warning: unrecognized escape '\\q'\n".repeat(2));
    const trailing = await run(String.raw`stat --printf='\' a`);
    expect(trailing.exitCode).toBe(0);
    expect(trailing.stdout).toBe('\\');
    expect(trailing.stderr).toContain('backslash at end of format');
  });

  it('retains missing-file failures while emitting all successful operands', async () => {
    const result = await run("stat --printf='%s' a missing b");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('42');
    expect(result.stderr).toContain("stat: cannot statx 'missing'");
    const missingOperands = await run("stat --printf='%s'");
    expect(missingOperands.exitCode).toBe(1);
    expect(missingOperands.stdout).toBe('');
    expect(missingOperands.stderr).toContain('stat: missing operand');
  });

  it.each([String.raw`\200`, String.raw`\377`, String.raw`\x80`, String.raw`\xFF`])(
    'rejects %s explicitly before producing any stdout', async (escape) => {
      const result = await run(`stat --printf='prefix${escape}%s' a b`);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('non-ASCII numeric byte escapes are not supported');
    },
  );
});
