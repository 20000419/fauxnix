import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { psStr } from '../src/registry.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

// No live paths or reference executables: every file and timestamp belongs to
// this suite's temporary directory. Reference expectations were checked with
// GNU stat/gzip on separate own-temp fixtures and the official manuals.
describe.skipIf(!runnable)('stat and gzip output contracts on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  const literalName = 'name%F%Y%%.txt';
  const compressed = gzipSync('alpha\nbeta\n');
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-stat-gzip-'));
    writeFileSync(join(directory, literalName), 'abc\n');
    mkdirSync(join(directory, 'folder'));
    for (const name of ['archive', 'archive.data', 'archive.gz']) {
      writeFileSync(join(directory, name), compressed);
    }
    for (const name of ['plain.gz', 'plain.tgz']) {
      writeFileSync(join(directory, name), 'plain text\n');
    }
    writeFileSync(join(directory, 'invalid.data'), 'not a gzip stream');
    for (const [name, timestamp] of [
      ['fractional.txt', '2020-01-01T00:00:00.750Z'],
      ['future.txt', '2040-01-01T00:00:00.750Z'],
    ]) {
      const file = join(directory, name);
      writeFileSync(file, 'timestamp fixture\n');
      const date = new Date(timestamp);
      utimesSync(file, date, date);
    }
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });
  const output = async (command: string) => {
    const result = await run(command);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.stdout.replace(/\r\n/g, '\n');
  };

  it('keeps escaped directives literal and does not reinterpret inserted names', async () => {
    expect(await output(`stat -c '%%s|%%n|%%F|%%a|%%Y|%%y' '${literalName}'`))
      .toBe('%s|%n|%F|%a|%Y|%y\n');
    expect(await output(`stat -c '%n|%s|%F' '${literalName}'`))
      .toBe(`${literalName}|4|regular file\n`);
    expect(await output(`stat -c '%%%s|%%%%n' '${literalName}'`)).toBe('%4|%%n\n');
  });

  it.each(["-c ''", "--format=''"])(
    'prints one empty line per operand for %s', async (option) => {
      expect(await output(`stat ${option} '${literalName}' folder`)).toBe('\n\n');
    },
  );

  it.each([
    '-c first --format=last',
    '--format=first -c last',
    '-c first --format=middle -c last',
  ])('uses the final format option in %s', async (options) => {
    expect(await output(`stat ${options} '${literalName}'`)).toBe('last\n');
  });

  it('quotes format literals and preserves unsupported directives', async () => {
    expect(await output(`stat -c "it's constructor|toString|%q|trailing%" '${literalName}'`))
      .toBe("it's constructor|toString|%q|trailing%\n");
  });

  it('prints the existing Windows-derived mode without an added octal prefix', async () => {
    expect(await output(`stat -c '%a' '${literalName}' folder`)).toBe('664\n775\n');
  });

  it.each(['fractional.txt', 'future.txt'])(
    'reports whole epoch seconds without rounding or overflow for %s', async (name) => {
      const expected = Math.floor(statSync(join(directory, name)).mtimeMs / 1000);
      expect(await output(`stat -c %Y ${name}`)).toBe(`${expected}\n`);
    },
  );

  it.each([
    'gzip -dc archive.data',
    'gzip --decompress --stdout archive',
    'gunzip -c archive.data',
    'gunzip --to-stdout archive',
    'zcat archive.data',
    'zcat archive',
  ])('streams %s regardless of the input suffix and preserves every input', async (command) => {
    const before = readdirSync(directory).sort();
    expect(await output(command)).toBe('alpha\nbeta\n');
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(readFileSync(join(directory, 'archive.data'))).toEqual(compressed);
    expect(readFileSync(join(directory, 'archive'))).toEqual(compressed);
  });

  it('streams multiple differently named inputs in operand order', async () => {
    expect(await output('zcat archive.data archive')).toBe('alpha\nbeta\nalpha\nbeta\n');
  });

  it.each(['gzip -c plain.gz', 'gzip --stdout plain.tgz', 'gzip --to-stdout archive.gz'])(
    'does not skip %s because of its suffix', (command) => {
      const before = readdirSync(directory).sort();
      const source = command.split(' ').at(-1)!;
      const bytes = readFileSync(join(directory, source));
      const destination = `stdout-fixture-${source}.bin`;
      const destinationPath = join(directory, destination);
      const body = translateCommandList(parseCommand(command))[0].body;
      // gzip -c's documented output is a Latin-1 string, not raw bytes.
      // Run the real generated handler and redirect that string to our own
      // binary fixture using the inverse encoding. No writer is mocked, and
      // Node independently checks the resulting archive rather than relying
      // on a magic-byte prefix in captured terminal text.
      const script = [
        // Match the normal host: module auto-loading progress is not stderr.
        "$ProgressPreference = 'SilentlyContinue'",
        "$ErrorActionPreference = 'Stop'",
        '$script:fx_exit = 0',
        '$fx_test_output = @(& {', body, '})',
        'if ($script:fx_exit -ne 0) { exit $script:fx_exit }',
        "if ($fx_test_output.Count -ne 1) { throw 'expected one compressed stdout value' }",
        `[IO.File]::WriteAllBytes(${psStr(destinationPath)}, [Text.Encoding]::GetEncoding(28591).GetBytes([string]$fx_test_output[0]))`,
      ].join('\n');
      const result = spawnSync(selection.executable, [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
      ], { cwd: directory, encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).toBe('');
      expect(gunzipSync(readFileSync(destinationPath))).toEqual(bytes);
      expect(readFileSync(join(directory, source))).toEqual(bytes);
      expect(readdirSync(directory).sort()).toEqual([...before, destination].sort());
      rmSync(destinationPath);
    },
  );

  it('validates content rather than reporting a filename-suffix warning on stdout', async () => {
    const result = await run('gunzip -c invalid.data');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('not in gzip format');
    expect(result.stderr).not.toContain('unknown suffix');
    expect(readFileSync(join(directory, 'invalid.data'), 'utf8')).toBe('not a gzip stream');
  });

  it('retains the unknown-suffix warning for file-output decompression', async () => {
    const before = readdirSync(directory).sort();
    const result = await run('gunzip archive.data');
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown suffix -- ignored');
    expect(readFileSync(join(directory, 'archive.data'))).toEqual(compressed);
    expect(readdirSync(directory).sort()).toEqual(before);
  });
});
