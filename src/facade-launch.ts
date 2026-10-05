import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

function readMarker(dir: string): { packageVersion?: string; nodeVersion?: string } | null {
  try {
    return JSON.parse(readFileSync(markerPath(dir), 'utf8'));
  } catch {
    return null;
  }
}

export function launcherStatus(env: NodeJS.ProcessEnv = process.env): LauncherStatus {
  const dir = launcherDir(env);
  const exePath = join(dir, 'bash.exe');
  const marker = readMarker(dir);
  const installed = existsSync(exePath);
  return {
    dir,
    exePath,
    installed,
    upToDate:
      installed &&
      marker?.packageVersion === packageVersion &&
      marker?.nodeVersion === process.version,
    packageVersion,
    nodeVersion: process.version,
  };
}

/** Build (or rebuild when stale) the launcher; returns the bash.exe path. */
export async function buildLauncher(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const dir = launcherDir(env);
  const status = launcherStatus(env);
  if (status.upToDate) return status.exePath;

  // dist/facade-sea.cjs ships in the package; src/ and dist/ are both one
  // level below the package root, so the relative lookup holds in dev too.
  const bundle = new URL('../dist/facade-sea.cjs', import.meta.url);
  if (!existsSync(bundle)) {
    throw new Error('fauxnix: dist/facade-sea.cjs is missing — run npm run build first');
  }

  const { mkdirSync } = await import('node:fs');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'sea-config.json');
  const blobPath = join(dir, 'sea-prep.blob');
  const exePath = join(dir, 'bash.exe');
  writeFileSync(
    configPath,
    JSON.stringify({
      main: decodeURIComponent(bundle.pathname.replace(/^\/([A-Za-z]):/, '$1:')),
      output: blobPath,
      disableExperimentalSEAWarning: true,
    }),
  );
  try {
    await execFileAsync(process.execPath, ['--experimental-sea-config', configPath]);
    rmSync(exePath, { force: true });
    copyFileSync(process.execPath, exePath);
    // postject rewrites the PE resource section; any original Authenticode
    // signature is invalidated, which is expected for a local build.
    await postjectInject(exePath, 'NODE_SEA_BLOB', readFileSync(blobPath), {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    });
  } finally {
    rmSync(configPath, { force: true });
    rmSync(blobPath, { force: true });
  }
  writeFileSync(markerPath(dir), JSON.stringify({ packageVersion, nodeVersion: process.version }));
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
