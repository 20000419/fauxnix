import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

// Real Windows coverage, skipped rather than simulated on other platforms.
// All writes are newly created archives/extraction paths in our own temp dir.
describe.skipIf(!runnable)('file/archive supported argument execution', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-file-archive-'));
    writeFileSync(join(directory, '-input.txt'), 'archive fixture\n');
    writeFileSync(join(directory, 'data.gz'), gzipSync('compressed fixture\n'));
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = async (command: string) => {
    const result = await session.run(translateCommandList(parseCommand(command)), { cwd: directory });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return result.stdout.replace(/\r\n/g, '\n');
  };

  it('round-trips flag-looking filenames with bundled extraction-directory options', async () => {
    await run('zip -q -- -log.zip -input.txt');
    await run('unzip -qdlogs -- -log.zip');
    expect(readFileSync(join(directory, 'logs', '-input.txt'), 'utf8')).toBe('archive fixture\n');
  });

  it('retains quoted expansion in attached long directory values', async () => {
    await run('zip quoted.zip -- -input.txt');
    await run('OUTPUT="quoted output"; unzip --directory="$OUTPUT" quoted.zip');
    expect(readFileSync(join(directory, 'quoted output', '-input.txt'), 'utf8')).toBe('archive fixture\n');
  });

  it.each(['gunzip -9c data.gz', 'gunzip -c9 data.gz', 'zcat -1 data.gz'])(
    'streams %s without changing the compressed input', async (command) => {
      expect(await run(command)).toBe('compressed fixture\n');
      expect(readFileSync(join(directory, 'data.gz')).length).toBeGreaterThan(0);
    },
  );

  it.each([
    ['basename -- /usr/bin', 'bin\n'],
    ['dirname -- /usr/bin', '/usr\n'],
  ])('consumes the option terminator in %s', async (command, expected) => {
    expect(await run(command)).toBe(expected);
  });
});
