/**
 * C-7 differential runner: fauxnix session vs Git Bash.
 * Opt-in via FAUXNIX_DIFF_ORACLE; skips when the env is unset or bash.exe is missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommand } from '../../src/parser.js';
import { translateCommandList } from '../../src/translator.js';
import { FauxnixSession } from '../../src/executor.js';
import '../../src/commands/install-all.js';

export interface CorpusCase {
  id: string;
  cmd: string;
  source?: string;
  files?: Record<string, string>;
}

export interface Corpus {
  gate: { targetCases: number; identity: number; note: string };
  files: Record<string, string>;
  cases: CorpusCase[];
}

export interface Streams {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CaseResult {
  id: string;
  cmd: string;
  identical: boolean;
  fauxnix: Streams;
  bash: Streams;
  error?: string;
}

export interface CorpusRun {
  total: number;
  identical: number;
  identity: number;
  gate: number;
  bashPath: string;
  results: CaseResult[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const CORPUS_PATH = join(here, 'corpus.json');

export function loadCorpus(path = CORPUS_PATH): Corpus {
  return JSON.parse(readFileSync(path, 'utf8')) as Corpus;
}

/** True when the caller asked for the Git Bash oracle (any truthy value except 0/false/no/off). */
export function isOracleRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FAUXNIX_DIFF_ORACLE;
  if (raw == null) return false;
  const v = raw.trim();
  if (v === '') return false;
  return !/^(0|false|no|off)$/i.test(v);
}

function gitBashCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const pf = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  return [
    join(pf, 'Git', 'bin', 'bash.exe'),
    join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    join(pf86, 'Git', 'bin', 'bash.exe'),
    local ? join(local, 'Programs', 'Git', 'bin', 'bash.exe') : '',
  ].filter(Boolean);
}

/**
 * Resolve git-bash `bash.exe`. If FAUXNIX_DIFF_ORACLE is a path to an existing
 * executable, that wins; otherwise the usual Git for Windows locations.
 */
export function resolveGitBash(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.FAUXNIX_DIFF_ORACLE?.trim();
  if (raw && existsSync(raw) && /bash(\.exe)?$/i.test(raw)) return raw;
  for (const p of gitBashCandidates(env)) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function hasPowerShell(): boolean {
  if (process.platform !== 'win32') return false;
  return spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { shell: false }).status === 0;
}

/** Oracle runs only when requested *and* git-bash bash.exe is present (and we can execute). */
export function canRunOracle(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOracleRequested(env) && resolveGitBash(env) !== null && hasPowerShell();
}

export function oracleSkipReason(env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isOracleRequested(env)) {
    return 'FAUXNIX_DIFF_ORACLE is unset; Git Bash is not required on developer machines';
  }
  if (resolveGitBash(env) === null) {
    return 'FAUXNIX_DIFF_ORACLE is set but git-bash bash.exe was not found';
  }
  if (!hasPowerShell()) {
    return 'PowerShell is unavailable; fauxnix execution is Windows-only';
  }
  return null;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function sameIdentity(a: Streams, b: Streams): boolean {
  return (
    normalizeNewlines(a.stdout) === normalizeNewlines(b.stdout) &&
    normalizeNewlines(a.stderr) === normalizeNewlines(b.stderr) &&
    a.exitCode === b.exitCode
  );
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body, 'utf8');
  }
}

function bashEnv(bashPath: string): NodeJS.ProcessEnv {
  const gitRoot = dirname(dirname(bashPath));
  const extra = [join(gitRoot, 'usr', 'bin'), dirname(bashPath)];
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return {
    ...process.env,
    [pathKey]: [...extra, process.env[pathKey] ?? ''].join(';'),
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function runBash(bashPath: string, cwd: string, cmd: string): Streams {
  const r = spawnSync(bashPath, ['--noprofile', '--norc', '-c', cmd], {
    cwd,
    env: bashEnv(bashPath),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  if (r.error) {
    return { stdout: '', stderr: r.error.message, exitCode: 127 };
  }
  return {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status ?? 1,
  };
}

function inspect(s: string): string {
  const n = normalizeNewlines(s);
  if (n.length <= 120) return JSON.stringify(n);
  return JSON.stringify(n.slice(0, 117) + '...');
}

export function formatSummary(run: CorpusRun): string {
  const pct = (run.identity * 100).toFixed(1);
  const lines = [
    `differential: ${run.identical}/${run.total} identical (${pct}%) vs ${run.bashPath}`,
    `gate for this corpus: ≥${(run.gate * 100).toFixed(0)}%  |  1.0 gate: ≥200 cases at ≥95% (not this corpus)`,
  ];
  const mismatches = run.results.filter((r) => !r.identical);
  for (const m of mismatches) {
    lines.push(`  FAIL ${m.id}: ${m.cmd}`);
    if (m.error) lines.push(`        error: ${m.error}`);
    if (normalizeNewlines(m.fauxnix.stdout) !== normalizeNewlines(m.bash.stdout)) {
      lines.push(`        stdout fauxnix=${inspect(m.fauxnix.stdout)} bash=${inspect(m.bash.stdout)}`);
    }
    if (normalizeNewlines(m.fauxnix.stderr) !== normalizeNewlines(m.bash.stderr)) {
      lines.push(`        stderr fauxnix=${inspect(m.fauxnix.stderr)} bash=${inspect(m.bash.stderr)}`);
    }
    if (m.fauxnix.exitCode !== m.bash.exitCode) {
      lines.push(`        exit  fauxnix=${m.fauxnix.exitCode} bash=${m.bash.exitCode}`);
    }
  }
  return lines.join('\n');
}

export async function runCorpus(opts: {
  corpus?: Corpus;
  bashPath: string;
}): Promise<CorpusRun> {
  const corpus = opts.corpus ?? loadCorpus();
  const dir = mkdtempSync(join(tmpdir(), 'fauxnix-diff-'));
  const session = new FauxnixSession();
  const results: CaseResult[] = [];
  try {
    writeTree(dir, corpus.files ?? {});
    await session.prewarm();
    await session.run(translateCommandList(parseCommand('cd "' + dir + '"')));

    for (const c of corpus.cases) {
      if (c.files) writeTree(dir, c.files);
      let fauxnix: Streams;
      let error: string | undefined;
      try {
        const r = await session.run(translateCommandList(parseCommand(c.cmd)));
        fauxnix = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        fauxnix = { stdout: '', stderr: error, exitCode: 2 };
      }
      const bash = runBash(opts.bashPath, dir, c.cmd);
      results.push({
        id: c.id,
        cmd: c.cmd,
        identical: !error && sameIdentity(fauxnix, bash),
        fauxnix,
        bash,
        error,
      });
    }
  } finally {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  }

  const identical = results.filter((r) => r.identical).length;
  const total = results.length;
  return {
    total,
    identical,
    identity: total === 0 ? 1 : identical / total,
    gate: corpus.gate.identity,
    bashPath: opts.bashPath,
    results,
  };
}
