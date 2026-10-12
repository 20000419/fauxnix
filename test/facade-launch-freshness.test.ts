import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bundlePath: '',
  execFile: vi.fn(),
  inject: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
}));
vi.mock('postject', () => ({ inject: mocks.inject }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  // Keep the package bundle hermetic without rebuilding or editing dist/.
  const redirect = <T,>(path: T): T | string =>
    path instanceof URL && path.pathname.endsWith('/dist/facade-sea.cjs')
      ? mocks.bundlePath
      : path;
  return {
    ...fs,
    existsSync: (path: Parameters<typeof fs.existsSync>[0]) => fs.existsSync(redirect(path)),
    readFileSync: (
      path: Parameters<typeof fs.readFileSync>[0],
      options: Parameters<typeof fs.readFileSync>[1],
    ) => fs.readFileSync(redirect(path), options),
  };
});

import { buildLauncher, launcherStatus } from '../src/facade-launch.js';
import { packageVersion } from '../src/version.js';

const originalNode = process.execPath;
const bundlePath = fileURLToPath(new URL('../dist/facade-sea.cjs', import.meta.url));
let root: string;
let dir: string;
let stub: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fx-launch-freshness-'));
  dir = join(root, 'launcher');
  stub = join(root, 'stub.exe');
  mocks.bundlePath = join(root, 'facade-sea.cjs');
  writeFileSync(mocks.bundlePath, 'bundle-v1');
  writeFileSync(stub, 'stub-v1');
  process.execPath = join(root, 'node.exe');
  writeFileSync(process.execPath, 'node-v1');
  env = { FAUXNIX_FACADE_DIR: dir };
  mocks.execFile.mockReset().mockImplementation((node, args, callback) => {
    const config = JSON.parse(readFileSync(args[1], 'utf8'));
    writeFileSync(config.output, 'test SEA blob');
    callback(null, '', '');
  });
  mocks.inject.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  process.execPath = originalNode;
  rmSync(root, { recursive: true, force: true });
});

describe('facade launcher freshness', () => {
  it.each(['sea', 'stub'] as const)('reuses an unchanged %s launcher', async (mode) => {
    if (mode === 'stub') env.FAUXNIX_FACADE_STUB = stub;
    const exe = await buildLauncher(env);
    const oldTime = new Date('2020-01-01T00:00:00Z');
    utimesSync(exe, oldTime, oldTime);
    expect(launcherStatus(env)).toMatchObject({ installed: true, upToDate: true });
    expect(await buildLauncher(env)).toBe(exe);
    expect(statSync(exe).mtimeMs).toBe(oldTime.getTime());
    expect(mocks.inject).toHaveBeenCalledTimes(mode === 'sea' ? 1 : 0);
  });

  it('rebuilds when switching SEA to stub and back', async () => {
    const exe = await buildLauncher(env);
    expect(readFileSync(exe, 'utf8')).toBe('node-v1');

    env.FAUXNIX_FACADE_STUB = stub;
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(readFileSync(exe, 'utf8')).toBe('stub-v1');
    expect(JSON.parse(readFileSync(join(dir, 'fauxnix-launch.json'), 'utf8'))).toEqual({
      node: process.execPath,
      bundle: bundlePath,
    });

    delete env.FAUXNIX_FACADE_STUB;
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(readFileSync(exe, 'utf8')).toBe('node-v1');
    expect(mocks.inject).toHaveBeenCalledTimes(2);
    expect(launcherStatus(env).upToDate).toBe(true);
  });

  it('detects changed stub contents even at the same path, size, and timestamp', async () => {
    env.FAUXNIX_FACADE_STUB = stub;
    const exe = await buildLauncher(env);
    const before = statSync(stub);
    writeFileSync(stub, 'stub-v2');
    utimesSync(stub, before.atime, before.mtime);
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(readFileSync(exe, 'utf8')).toBe('stub-v2');
    expect(launcherStatus(env).upToDate).toBe(true);
  });

  it('detects a different selected stub path with identical contents', async () => {
    env.FAUXNIX_FACADE_STUB = stub;
    await buildLauncher(env);
    env.FAUXNIX_FACADE_STUB = join(root, 'other-stub.exe');
    writeFileSync(env.FAUXNIX_FACADE_STUB, 'stub-v1');
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(launcherStatus(env).upToDate).toBe(true);
  });

  it.each(['none', 'sea', 'stub'] as const)(
    'rejects a missing selected stub with a previous %s installation',
    async (previous) => {
      if (previous === 'stub') env.FAUXNIX_FACADE_STUB = stub;
      if (previous !== 'none') await buildLauncher(env);
      const priorBuilds = mocks.execFile.mock.calls.length;
      env.FAUXNIX_FACADE_STUB = join(root, 'missing.exe');
      expect(launcherStatus(env).upToDate).toBe(false);
      await expect(buildLauncher(env)).rejects.toThrow(/FAUXNIX_FACADE_STUB/);
      expect(mocks.execFile).toHaveBeenCalledTimes(priorBuilds);
      if (previous !== 'none') {
        expect(readFileSync(join(dir, 'bash.exe'), 'utf8')).toBe(
          previous === 'stub' ? 'stub-v1' : 'node-v1',
        );
      }
    },
  );

  it('detects when the previously selected stub disappears', async () => {
    env.FAUXNIX_FACADE_STUB = stub;
    await buildLauncher(env);
    rmSync(stub);
    expect(launcherStatus(env).upToDate).toBe(false);
    await expect(buildLauncher(env)).rejects.toThrow(/FAUXNIX_FACADE_STUB/);
  });

  it.each(['missing', 'invalid', 'wrong node', 'wrong bundle'])(
    'repairs %s stub routing configuration',
    async (problem) => {
      env.FAUXNIX_FACADE_STUB = stub;
      await buildLauncher(env);
      const path = join(dir, 'fauxnix-launch.json');
      if (problem === 'missing') rmSync(path);
      else if (problem === 'invalid') writeFileSync(path, '{');
      else {
        writeFileSync(path, JSON.stringify({
          node: problem === 'wrong node' ? 'old-node.exe' : process.execPath,
          bundle: problem === 'wrong bundle' ? 'old-facade.cjs' : bundlePath,
        }));
      }
      expect(launcherStatus(env).upToDate).toBe(false);
      await buildLauncher(env);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ node: process.execPath, bundle: bundlePath });
      expect(launcherStatus(env).upToDate).toBe(true);
    },
  );

  it.each(['sea', 'stub'] as const)('detects changed bundle contents in %s mode', async (mode) => {
    if (mode === 'stub') env.FAUXNIX_FACADE_STUB = stub;
    await buildLauncher(env);
    writeFileSync(mocks.bundlePath, 'bundle-v2');
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(launcherStatus(env).upToDate).toBe(true);
    expect(mocks.inject).toHaveBeenCalledTimes(mode === 'sea' ? 2 : 0);
  });

  it.each(['sea', 'stub'] as const)('detects a different Node path in %s mode', async (mode) => {
    if (mode === 'stub') env.FAUXNIX_FACADE_STUB = stub;
    await buildLauncher(env);
    process.execPath = join(root, 'other-node.exe');
    writeFileSync(process.execPath, 'node-v1');
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(launcherStatus(env).upToDate).toBe(true);
    if (mode === 'stub') {
      expect(JSON.parse(readFileSync(join(dir, 'fauxnix-launch.json'), 'utf8')).node).toBe(process.execPath);
    }
  });

  it('does not reuse a launcher if its bundle disappears', async () => {
    await buildLauncher(env);
    rmSync(mocks.bundlePath);
    expect(launcherStatus(env).upToDate).toBe(false);
    await expect(buildLauncher(env)).rejects.toThrow(/facade-sea.cjs is missing/);
  });

  it('migrates legacy version-only markers by rebuilding once', async () => {
    await buildLauncher(env);
    writeFileSync(join(dir, 'bash.exe.launcher.json'), JSON.stringify({ packageVersion, nodeVersion: process.version }));
    expect(launcherStatus(env).upToDate).toBe(false);
    await buildLauncher(env);
    expect(mocks.inject).toHaveBeenCalledTimes(2);
    expect(launcherStatus(env).upToDate).toBe(true);
  });

  it('does not reuse an old marker after a failed rebuild replaced the executable', async () => {
    env.FAUXNIX_FACADE_STUB = stub;
    await buildLauncher(env);
    delete env.FAUXNIX_FACADE_STUB;
    mocks.inject.mockRejectedValueOnce(new Error('injection failed'));
    await expect(buildLauncher(env)).rejects.toThrow('injection failed');
    env.FAUXNIX_FACADE_STUB = stub;
    expect(launcherStatus(env).upToDate).toBe(false);
    const exe = await buildLauncher(env);
    expect(readFileSync(exe, 'utf8')).toBe('stub-v1');
    expect(launcherStatus(env).upToDate).toBe(true);
  });
});
