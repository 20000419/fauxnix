import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inject as postjectInject } from 'postject';
import { packageVersion } from './version.js';

const execFileAsync = promisify(execFile);

/**
 * Experimental bash.exe launcher (RFC: docs/rfc-bash-facade.md).
 *
 * Harnesses point CLAUDE_CODE_GIT_BASH_PATH at an executable whose basename
 * is exactly bash.exe, so the launcher is a copy of the active node.exe with
 * the prebuilt facade bundle (dist/facade-sea.cjs) injected via Node SEA +
 * postject. Roughly 85 MB per install — the documented experimental-phase
 * trade; the GA plan is a small prebuilt stub.
 */

export interface LauncherStatus {
  /** Directory that holds (or would hold) bash.exe. */
  dir: string;
  exePath: string;
  installed: boolean;
  upToDate: boolean;
  packageVersion: string;
  nodeVersion: string;
}

export function launcherDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['FAUXNIX_FACADE_DIR'];
  if (override) return override;
  const base = env['LOCALAPPDATA'] ?? env['USERPROFILE'] ?? '.';
  return join(base, 'fauxnix', 'bin');
}

function markerPath(dir: string): string {
  return join(dir, 'bash.exe.launcher.json');
}

interface LauncherInputs {
  formatVersion: number;
  packageVersion: string;
  nodeVersion: string;
  mode: 'sea' | 'stub';
  nodePath: string;
  bundlePath: string;
  bundleHash: string;
  stubPath: string | null;
  stubHash: string | null;
}

function launcherInputs(env: NodeJS.ProcessEnv): LauncherInputs {
  // src/ and dist/ are both one level below the package root.
  const bundle = new URL('../dist/facade-sea.cjs', import.meta.url);
  if (!existsSync(bundle)) {
    throw new Error('fauxnix: dist/facade-sea.cjs is missing — run npm run build first');
  }
  const stubPath = env['FAUXNIX_FACADE_STUB'] ? resolve(env['FAUXNIX_FACADE_STUB']) : null;
  if (stubPath && !existsSync(stubPath)) {
    throw new Error(`fauxnix: FAUXNIX_FACADE_STUB does not exist: ${stubPath}`);
  }
  return {
    formatVersion: 1,
    packageVersion,
    nodeVersion: process.version,
    mode: stubPath ? 'stub' : 'sea',
    nodePath: process.execPath,
    bundlePath: fileURLToPath(bundle),
    bundleHash: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
    stubPath,
    stubHash: stubPath ? createHash('sha256').update(readFileSync(stubPath)).digest('hex') : null,
  };
}

function readMarker(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(markerPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

function launcherMatches(dir: string, inputs: LauncherInputs): boolean {
  const marker = readMarker(dir);
  // Version-only markers predate input tracking and must be rebuilt once.
  if (!Object.entries(inputs).every(([key, value]) => marker?.[key] === value)) return false;
  if (inputs.mode === 'sea') return true;
  try {
    const routing = JSON.parse(readFileSync(join(dir, 'fauxnix-launch.json'), 'utf8'));
    return routing?.node === inputs.nodePath && routing?.bundle === inputs.bundlePath;
  } catch {
    return false;
  }
}

export function launcherStatus(env: NodeJS.ProcessEnv = process.env): LauncherStatus {
  const dir = launcherDir(env);
  const exePath = join(dir, 'bash.exe');
  const installed = existsSync(exePath);
  let upToDate = false;
  try {
    upToDate = installed && launcherMatches(dir, launcherInputs(env));
  } catch {
    // Doctor reports stale for missing/unreadable inputs; buildLauncher gives
    // the actionable error rather than silently reusing or changing modes.
  }
  return {
    dir,
    exePath,
    installed,
    upToDate,
    packageVersion,
    nodeVersion: process.version,
  };
}

/** Build (or rebuild when stale) the launcher; returns the bash.exe path. */
export async function buildLauncher(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = launcherDir(env);
  const exePath = join(dir, 'bash.exe');
  const inputs = launcherInputs(env);
  if (existsSync(exePath) && launcherMatches(dir, inputs)) return exePath;

  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  // A failed rebuild can replace bash.exe. Never leave the previous marker
  // claiming that partially replaced launcher is still current.
  rmSync(markerPath(dir), { force: true });

  // GA path (RFC #224 Option B): a small prebuilt stub that forwards argv to
  // this installation's node + bundle. Its build/signing pipeline is tracked
  // separately; when FAUXNIX_FACADE_STUB points at a stub binary, install it
  // with a routing config instead of the ~85 MB SEA copy.
  if (inputs.stubPath) {
    rmSync(exePath, { force: true });
    copyFileSync(inputs.stubPath, exePath);
    writeFileSync(
      join(dir, 'fauxnix-launch.json'),
      JSON.stringify({ node: inputs.nodePath, bundle: inputs.bundlePath }, null, 2),
    );
    writeFileSync(markerPath(dir), JSON.stringify(inputs));
    return exePath;
  }

  const configPath = join(dir, 'sea-config.json');
  const blobPath = join(dir, 'sea-prep.blob');
  writeFileSync(
    configPath,
    JSON.stringify({
      main: inputs.bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    }),
  );
  try {
    await execFileAsync(inputs.nodePath, ['--experimental-sea-config', configPath]);
    rmSync(exePath, { force: true });
    copyFileSync(inputs.nodePath, exePath);
    // postject rewrites the PE resource section; any original Authenticode
    // signature is invalidated, which is expected for a local build.
    await postjectInject(exePath, 'NODE_SEA_BLOB', readFileSync(blobPath), {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    });
  } finally {
    rmSync(configPath, { force: true });
    rmSync(blobPath, { force: true });
  }
  writeFileSync(markerPath(dir), JSON.stringify(inputs));
  return exePath;
}

/** User-level CLAUDE_CODE_GIT_BASH_PATH management, with prior-value restore. */
export async function setUserEnv(name: string, value: string | null): Promise<void> {
  const ps =
    value === null
      ? `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`
      : `[Environment]::SetEnvironmentVariable('${name}', ${JSON.stringify(value)}, 'User')`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps]);
}

export async function getUserEnv(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `[Environment]::GetEnvironmentVariable('${name}', 'User')`,
    ]);
    const v = stdout.trim();
    return v === '' ? null : v;
  } catch {
    return null;
  }
}

const SHELL_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';
const PREVIOUS_FILE = 'claude-shell.previous.txt';

function previousPath(dir: string): string {
  return join(dir, PREVIOUS_FILE);
}

/** `fauxnix install --claude-shell` — build the launcher and point Claude Code at it. */
export async function installClaudeShell(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const lines: string[] = [];
  const exePath = await buildLauncher(env);
  lines.push(`launcher ready: ${exePath}`);
  const prev = await getUserEnv(SHELL_ENV);
  if (prev && prev !== exePath) {
    const dir = launcherDir(env);
    if (!existsSync(previousPath(dir))) {
      writeFileSync(previousPath(dir), prev, 'utf8');
      lines.push(`saved previous ${SHELL_ENV}: ${prev}`);
    }
  }
  await setUserEnv(SHELL_ENV, exePath);
  lines.push(`set user ${SHELL_ENV}=${exePath}`);
  lines.push('restart Claude Code from a new terminal to pick it up');
  lines.push('note: the harness approval flow for its built-in Bash tool now governs fauxnix runs');
  lines.push('undo anytime with: fauxnix install --claude-shell-off');
  return lines;
}

/** `fauxnix install --claude-shell-off` — restore the previous value and remove the launcher. */
export async function uninstallClaudeShell(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const lines: string[] = [];
  const dir = launcherDir(env);
  let prev: string | null = null;
  try {
    prev = readFileSync(previousPath(dir), 'utf8').trim() || null;
  } catch {
    /* no saved previous value */
  }
  await setUserEnv(SHELL_ENV, prev);
  lines.push(prev ? `restored ${SHELL_ENV}=${prev}` : `removed user ${SHELL_ENV}`);
  rmSync(join(dir, 'bash.exe'), { force: true });
  rmSync(markerPath(dir), { force: true });
  rmSync(previousPath(dir), { force: true });
  lines.push(`removed launcher: ${join(dir, 'bash.exe')}`);
  return lines;
}
