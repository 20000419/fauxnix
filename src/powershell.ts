import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
] as const;

export type PowerShellEdition = 'Desktop' | 'Core';

export interface PowerShellSelection {
  /** Absolute executable path resolved once for this check/session. */
  readonly executable: string;
  readonly expectedEdition: PowerShellEdition;
  readonly configured: boolean;
  readonly requested?: string;
  readonly error?: string;
}

export interface PowerShellResolveOptions {
  cwd?: string;
  exists?: (candidate: string) => boolean;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function comparableWindowsPath(value: string): string {
  return win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function isFullyQualifiedWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

function unquotePathEntry(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function desktopSelection(
  env: NodeJS.ProcessEnv,
  configured: boolean,
  requested: string | undefined,
  exists: (candidate: string) => boolean,
): PowerShellSelection {
  const systemRoot = envValue(env, 'SystemRoot')?.trim();
  if (!systemRoot || !/^[a-z]:[\\/]/i.test(systemRoot)) {
    return {
      executable: '',
      expectedEdition: 'Desktop',
      configured,
      requested,
      error:
        'fauxnix: cannot resolve Windows PowerShell safely because SystemRoot is missing or not drive-absolute.',
    };
  }
  const executable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (!exists(executable)) {
    return {
      executable,
      expectedEdition: 'Desktop',
      configured,
      requested,
      error: `fauxnix: Windows PowerShell not found at trusted system path ${executable}.`,
    };
  }
  return { executable, expectedEdition: 'Desktop', configured, requested };
}

function coreSelection(
  env: NodeJS.ProcessEnv,
  requested: string,
  cwd: string,
  exists: (candidate: string) => boolean,
): PowerShellSelection {
  const cwdKey = win32.isAbsolute(cwd) ? comparableWindowsPath(cwd) : '';
  const rawPath = envValue(env, 'PATH') ?? '';
  const seen = new Set<string>();
  for (const rawEntry of rawPath.split(';')) {
    const directory = unquotePathEntry(rawEntry);
    if (!directory || !isFullyQualifiedWindowsPath(directory)) continue;
    const directoryKey = comparableWindowsPath(directory);
    if (!directoryKey || directoryKey === cwdKey || seen.has(directoryKey)) continue;
    seen.add(directoryKey);
    const candidate = win32.join(directory, 'pwsh.exe');
    if (exists(candidate)) {
      return {
        executable: candidate,
        expectedEdition: 'Core',
        configured: true,
        requested,
      };
    }
  }
  return {
    executable: '',
    expectedEdition: 'Core',
    configured: true,
    requested,
    error:
      'fauxnix: pwsh.exe not found in eligible PATH entries ' +
      '(absolute directories only; the current directory is excluded).',
  };
}

/**
 * Select the process-wide PowerShell host. FAUXNIX_PS is intentionally a
 * small enum, not a command line: spawn() receives one executable and the
 * fixed fauxnix arguments separately.
 */
export function resolvePowerShell(
  env: NodeJS.ProcessEnv = process.env,
  options: PowerShellResolveOptions = {},
): PowerShellSelection {
  const requested = envValue(env, 'FAUXNIX_PS')?.trim();
  const exists = options.exists ?? existsSync;
  const cwd = options.cwd ?? process.cwd();
  if (!requested) {
    return desktopSelection(env, false, undefined, exists);
  }

  switch (requested.toLowerCase()) {
    case 'powershell':
    case 'powershell.exe':
      return desktopSelection(env, true, requested, exists);
    case 'pwsh':
    case 'pwsh.exe':
      return coreSelection(env, requested, cwd, exists);
    default:
      return {
        executable: '',
        expectedEdition: 'Desktop',
        configured: true,
        requested,
        error:
          `fauxnix: invalid FAUXNIX_PS=${JSON.stringify(requested)}; ` +
          'expected "powershell" or "pwsh". Unset it to use Windows PowerShell 5.1.',
      };
  }
}

export function powerShellDisplay(selection: PowerShellSelection): string {
  if (selection.error) {
    if (selection.requested === undefined) return 'unresolved default Windows PowerShell';
    return `unresolved selection (FAUXNIX_PS=${JSON.stringify(selection.requested)})`;
  }
  if (!selection.configured) return `${selection.executable} (default, trusted system path)`;
  return `${selection.executable} (FAUXNIX_PS=${selection.requested}, resolved once)`;
}

export function powerShellMissingMessage(selection: PowerShellSelection): string {
  if (selection.expectedEdition === 'Core') {
    return (
      'fauxnix: pwsh.exe not found in eligible absolute PATH entries — FAUXNIX_PS=pwsh selects PowerShell 7.\n' +
      'Install PowerShell 7 in an absolute PATH directory outside the current working directory, ' +
      'or unset FAUXNIX_PS ' +
      'to use Windows PowerShell 5.1.\n'
    );
  }
  return (
    `fauxnix: Windows PowerShell not found at ${selection.executable || 'the trusted SystemRoot path'}.\n` +
    'Run fauxnix on Windows, or set FAUXNIX_PS=pwsh after installing PowerShell 7 in an eligible absolute PATH directory.\n'
  );
}
