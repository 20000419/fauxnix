import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

type Fixture = {
  label: string;
  command: string;
  directories: string[];
  files: Record<string, string>;
  diagnostic: string;
};

const collisions: Fixture[] = [
  {
    label: 'a populated directory collision',
    command: 'mv -v source/item destination',
    directories: [],
    files: { 'source/item/source.txt': 'source data', 'destination/item/nested/keep.txt': 'destination data' },
    diagnostic: 'Directory not empty',
  },
  {
    label: 'an empty source over a populated directory',
    command: 'mv -v source/item destination',
    directories: ['source/item'],
    files: { 'destination/item/keep.txt': 'destination data' },
    diagnostic: 'Directory not empty',
  },
  {
    label: 'a file over an empty computed destination directory',
    command: 'mv -v source/item destination',
    directories: ['destination/item'],
    files: { 'source/item': 'source data' },
    diagnostic: 'cannot overwrite directory',
  },
  {
    label: 'a file over a populated computed destination directory',
    command: 'mv -v source/item destination',
    directories: [],
    files: { 'source/item': 'source data', 'destination/item/keep.txt': 'destination data' },
    diagnostic: 'cannot overwrite directory',
  },
  {
    label: 'a directory over a direct destination file',
    command: 'mv -v source destination',
    directories: [],
    files: { 'source/source.txt': 'source data', destination: 'destination data' },
    diagnostic: 'cannot overwrite non-directory',
  },
  {
    label: 'a directory over a computed destination file',
    command: 'mv -v source/item destination',
    directories: [],
    files: { 'source/item/source.txt': 'source data', 'destination/item': 'destination data' },
    diagnostic: 'cannot overwrite non-directory',
  },
];

// All source, target, and cleanup paths belong to a fresh per-test fixture.
// No live/user paths, link identity, or cross-volume behavior are exercised.
describe.skipIf(!runnable)('mv destination preservation on Windows', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => { session = new FauxnixSession(); });
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'fauxnix-mv-destination-')); });
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  afterAll(async () => { await session?.dispose(); });

  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });
  const makeDirectory = (path: string) => mkdirSync(join(directory, path), { recursive: true });
  const makeFile = (path: string, contents: string) => {
    const absolute = join(directory, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  };
  const setUp = (fixture: Fixture) => {
    for (const path of fixture.directories) makeDirectory(path);
    for (const [path, contents] of Object.entries(fixture.files)) makeFile(path, contents);
  };
  function snapshot(relative = ''): Record<string, string | null> {
    const entries: Record<string, string | null> = {};
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) {
        entries[path] = null;
        Object.assign(entries, snapshot(path));
      } else entries[path] = readFileSync(join(directory, path), 'utf8');
    }
    return entries;
  }

  it.each(collisions)('rejects $label and preserves both sides', async (fixture) => {
    setUp(fixture);
    const before = snapshot();
    const result = await run(fixture.command);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(fixture.diagnostic);
    expect(result.stderr).not.toContain('renamed');
    expect(snapshot()).toEqual(before);
  });

  it.each(collisions)('silently skips $label with -n', async (fixture) => {
    setUp(fixture);
    const before = snapshot();
    const result = await run(fixture.command.replace('mv -v ', 'mv -n -v '));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(snapshot()).toEqual(before);
  });

  it.each(['-n', '--no-clobber'])('preserves an existing file with %s', async (flag) => {
    makeFile('source.txt', 'source data');
    makeFile('destination.txt', 'destination data');
    const before = snapshot();
    const result = await run(`mv ${flag} source.txt destination.txt`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(snapshot()).toEqual(before);
  });

  it.each(['destination.txt', 'destination/source.txt'])('still replaces a regular file at %s', async (target) => {
    makeFile('source.txt', 'replacement data');
    makeFile(target, 'old data');
    const operand = target === 'destination.txt' ? target : 'destination';
    const result = await run(`mv -v source.txt ${operand}`);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain('renamed');
    expect(existsSync(join(directory, 'source.txt'))).toBe(false);
    expect(readFileSync(join(directory, target), 'utf8')).toBe('replacement data');
  });

  it.each([false, true])('still replaces an empty directory (populated source: %s)', async (populated) => {
    makeDirectory('source/item');
    makeDirectory('destination/item');
    if (populated) makeFile('source/item/source.txt', 'replacement data');
    const result = await run('mv source/item destination');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(join(directory, 'source/item'))).toBe(false);
    expect(readdirSync(join(directory, 'destination/item'))).toEqual(populated ? ['source.txt'] : []);
    if (populated) expect(readFileSync(join(directory, 'destination/item/source.txt'), 'utf8')).toBe('replacement data');
  });

  it.each([false, true])('still moves to an absent target (directory: %s)', async (isDirectory) => {
    if (isDirectory) makeFile('source/child.txt', 'source data');
    else makeFile('source', 'source data');
    const result = await run('mv source destination');
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(join(directory, 'source'))).toBe(false);
    expect(readFileSync(join(directory, isDirectory ? 'destination/child.txt' : 'destination'), 'utf8')).toBe('source data');
  });

  it('keeps a rejected source but continues moving independent later operands', async () => {
    makeFile('source/item/source.txt', 'source data');
    makeFile('destination/item/keep.txt', 'destination data');
    makeFile('source/next.txt', 'next data');
    const result = await run('mv source/item source/next.txt destination');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Directory not empty');
    expect(readFileSync(join(directory, 'source/item/source.txt'), 'utf8')).toBe('source data');
    expect(readFileSync(join(directory, 'destination/item/keep.txt'), 'utf8')).toBe('destination data');
    expect(existsSync(join(directory, 'source/next.txt'))).toBe(false);
    expect(readFileSync(join(directory, 'destination/next.txt'), 'utf8')).toBe('next data');
  });
});
