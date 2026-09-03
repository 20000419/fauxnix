import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { npmChildEnvironment } from './npm-child-env.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed${result.status === null ? '' : ` (${result.status})`}` +
        `${result.error ? `: ${result.error.message}` : ''}` +
        `${detail ? `\n${detail}` : ''}`,
    );
  }

  return result.stdout.trim();
}

function runNpm(args, options = {}) {
  const { env = process.env, ...spawnOptions } = options;
  const childOptions = {
    ...spawnOptions,
    env: npmChildEnvironment(packageRoot, env),
  };
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], childOptions);
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return run(npmCommand, args, {
    shell: process.platform === 'win32',
    ...childOptions,
  });
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'fauxnix-package-smoke-'));
const sourceDirectory = join(temporaryRoot, 'source');
const sourceInstallDirectory = join(temporaryRoot, 'source-install');
const packDirectory = join(temporaryRoot, 'pack');
const installDirectory = join(temporaryRoot, 'installed package with spaces');

try {
  mkdirSync(sourceDirectory);
  mkdirSync(sourceInstallDirectory);
  mkdirSync(packDirectory);
  mkdirSync(installDirectory);

  for (const filename of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE']) {
    cpSync(join(packageRoot, filename), join(sourceDirectory, filename));
  }
  cpSync(join(packageRoot, 'src'), join(sourceDirectory, 'src'), { recursive: true });

  const cleanEnvironment = npmChildEnvironment(packageRoot);
  runNpm(['ci', '--no-audit', '--no-fund'], {
    cwd: sourceDirectory,
    env: cleanEnvironment,
  });
  const sourceCliEntry = join(sourceDirectory, 'dist', 'index.js');
  assert.ok(existsSync(sourceCliEntry), 'npm ci in clean source should build dist/index.js');

  runNpm(
    [
      'install',
      '--global',
      '--prefix',
      sourceInstallDirectory,
      '--no-audit',
      '--no-fund',
      sourceDirectory,
    ],
    { cwd: sourceDirectory, env: cleanEnvironment },
  );

  const globalPackageRoot =
    process.platform === 'win32'
      ? join(sourceInstallDirectory, 'node_modules', metadata.name)
      : join(sourceInstallDirectory, 'lib', 'node_modules', metadata.name);
  const globalCliShim =
    process.platform === 'win32'
      ? join(sourceInstallDirectory, 'fauxnix.cmd')
      : join(sourceInstallDirectory, 'bin', 'fauxnix');
  const globalCliEntry = join(globalPackageRoot, 'dist', 'index.js');
  assert.ok(existsSync(sourceCliEntry), 'installing clean source should build dist/index.js');
  assert.ok(
    existsSync(globalCliEntry),
    'global source install should expose dist/index.js',
  );
  assert.ok(existsSync(globalCliShim), 'global source install should expose the fauxnix executable');
  const sourceVersion = run(process.execPath, [sourceCliEntry, '--version'], {
    cwd: temporaryRoot,
    env: cleanEnvironment,
  });
  assert.equal(sourceVersion, `fauxnix ${metadata.version}`);

  runNpm(['pack', '--silent', '--pack-destination', packDirectory]);
  const tarballs = readdirSync(packDirectory).filter((name) => name.endsWith('.tgz'));
  assert.equal(tarballs.length, 1, 'npm pack should produce exactly one tarball');

  const tarball = join(packDirectory, tarballs[0]);
  runNpm(
    ['install', '--prefix', installDirectory, '--no-audit', '--no-fund', tarball],
    { cwd: temporaryRoot, env: cleanEnvironment },
  );

  const installedRoot = join(installDirectory, 'node_modules', metadata.name);
  const cliEntry = join(installedRoot, 'dist', 'index.js');
  const cliShim = join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'fauxnix.cmd' : 'fauxnix',
  );
  assert.ok(existsSync(cliEntry), 'packed install should contain dist/index.js');
  assert.ok(existsSync(cliShim), 'packed install should expose the fauxnix executable');

  const version = runNpm(
    ['exec', '--prefix', installDirectory, '--offline', '--', 'fauxnix', '--version'],
    { cwd: temporaryRoot, env: cleanEnvironment },
  );
  assert.equal(version, `fauxnix ${metadata.version}`);

  const qwenHome = join(temporaryRoot, 'qwen home');
  const qwenWorkspace = join(temporaryRoot, 'qwen workspace');
  mkdirSync(qwenHome);
  mkdirSync(qwenWorkspace);
  const wrongLauncherMarker = join(qwenWorkspace, 'wrong-launcher.txt');
  writeFileSync(
    join(qwenWorkspace, 'fauxnix.cmd'),
    `@echo off\r\n>"${wrongLauncherMarker}" echo wrong\r\nexit /b 0\r\n`,
  );
  const qwenEnvironment = {
    ...cleanEnvironment,
    HOME: qwenHome,
    USERPROFILE: qwenHome,
  };
  const qwenPathKey =
    Object.keys(qwenEnvironment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  qwenEnvironment[qwenPathKey] =
    qwenWorkspace + delimiter + (qwenEnvironment[qwenPathKey] ?? '');
  const qwenInstall = run(process.execPath, [cliEntry, 'install', '--qwen'], {
    cwd: qwenWorkspace,
    env: qwenEnvironment,
  });
  assert.match(qwenInstall, /qwen: created/);
  const qwenConfig = JSON.parse(
    readFileSync(join(qwenHome, '.qwen', 'settings.json'), 'utf8'),
  );
  const qwenServer = qwenConfig.mcpServers.fauxnix;
  assert.equal(qwenServer.command, process.execPath);
  assert.deepEqual(qwenServer.args, [cliEntry, 'mcp']);
  assert.match(qwenServer.args[0], /installed package with spaces/);
  run(qwenServer.command, qwenServer.args, {
    cwd: qwenWorkspace,
    env: qwenEnvironment,
  });
  const qwenVersion = run(qwenServer.command, [qwenServer.args[0], '--version'], {
    cwd: qwenWorkspace,
    env: qwenEnvironment,
  });
  assert.equal(qwenVersion, `fauxnix ${metadata.version}`);
  assert.equal(existsSync(wrongLauncherMarker), false);

  const globalQwenHome = join(temporaryRoot, 'global qwen home');
  mkdirSync(globalQwenHome);
  const globalQwenEnvironment = {
    ...qwenEnvironment,
    HOME: globalQwenHome,
    USERPROFILE: globalQwenHome,
  };
  run(process.execPath, [globalCliEntry, 'install', '--qwen'], {
    cwd: qwenWorkspace,
    env: globalQwenEnvironment,
  });
  const globalQwenConfig = JSON.parse(
    readFileSync(join(globalQwenHome, '.qwen', 'settings.json'), 'utf8'),
  );
  assert.deepEqual(globalQwenConfig.mcpServers.fauxnix, {
    command: process.execPath,
    // `npm install -g <local-dir>` links the package, and Node resolves the
    // module URL to the source tree's real path. Registry installs are copied.
    args: [sourceCliEntry, 'mcp'],
  });
  run(
    globalQwenConfig.mcpServers.fauxnix.command,
    globalQwenConfig.mcpServers.fauxnix.args,
    { cwd: qwenWorkspace, env: globalQwenEnvironment },
  );

  const translation = runNpm(
    [
      'exec',
      '--prefix',
      installDirectory,
      '--offline',
      '--',
      'fauxnix',
      'translate',
      'echo',
      'package-smoke',
    ],
    { cwd: temporaryRoot, env: cleanEnvironment },
  );
  assert.match(translation, /package-smoke/);

  console.log(`clean source install passed: ${sourceVersion}`);
  console.log(`package smoke passed: ${basename(tarball)}`);
  console.log(`  ${version}`);
  console.log('Qwen absolute launcher passed from a workspace-local fauxnix shim');
} finally {
  const temporaryParent = dirname(temporaryRoot);
  assert.equal(temporaryParent, tmpdir(), 'refusing to clean a non-temporary path');
  rmSync(temporaryRoot, { recursive: true, force: true });
}
