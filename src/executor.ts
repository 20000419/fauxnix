import { randomUUID } from 'node:crypto';
import {
  promises as fs,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redirect } from './ast.js';
import { SegmentPlan, normalizeLiteralPath, wrapScript } from './translator.js';
import { decodeOutput, resolveNativePref } from './encoding.js';
import { normalizeStderr } from './errors.js';
import {
  DEFAULT_STDERR_LIMIT,
  DEFAULT_STDOUT_LIMIT,
  HostStreamMode,
  PowerShellHost,
} from './ps-host.js';
import { PowerShellSelection, resolvePowerShell } from './powershell.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  spawnError?: 'ENOENT' | 'START';
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Extra environment layered over the session (used by MCP per-call cwd). */
  cwd?: string;
  signal?: AbortSignal;
  stdoutLimit?: number;
  stderrLimit?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const MAX_HOST_CAPTURE_LIMIT = 0x7fffffff;
const UTF8_BOUNDARY_SUFFIX = 4;
const MAX_CALLER_OUTPUT_LIMIT = MAX_HOST_CAPTURE_LIMIT - UTF8_BOUNDARY_SUFFIX;

function validateOutputLimit(name: 'stdoutLimit' | 'stderrLimit', value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CALLER_OUTPUT_LIMIT) {
    throw new RangeError(
      'fauxnix: ' + name + ' must be an integer from 0 to ' + MAX_CALLER_OUTPUT_LIMIT,
    );
  }
  return value;
}

/**
 * Retain one complete codepoint beyond the logical caller budget so Node can
 * detect truncation and clip at a UTF-8 boundary. The host itself stays
 * bounded even when the caller has no remaining budget.
 */
function rawHostCaptureLimit(logicalBytes: number): number {
  if (!Number.isFinite(logicalBytes)) {
    return logicalBytes === Number.POSITIVE_INFINITY ? MAX_HOST_CAPTURE_LIMIT : 0;
  }
  const bytes = Math.max(0, Math.floor(logicalBytes));
  return Math.min(MAX_HOST_CAPTURE_LIMIT, bytes + UTF8_BOUNDARY_SUFFIX);
}

function hasEnvKey(env: NodeJS.ProcessEnv, name: string): boolean {
  const normalized = name.toUpperCase();
  return Object.keys(env).some((key) => key.toUpperCase() === normalized);
}

/** Resolve /dev/null and POSIX-ish literal targets to real Windows paths. */
function winTarget(target: string): string {
  const p = normalizeLiteralPath(target);
  if (p === '$env:TEMP') return os.tmpdir();
  if (p.startsWith('$env:TEMP\\')) return path.join(os.tmpdir(), p.slice('$env:TEMP\\'.length));
  return p;
}

/** Windows NUL device — `NUL`, `\\.\NUL`, and `cwd\NUL` after path.resolve. */
function isNulPath(p: string): boolean {
  const base = p.split(/[/\\]/).pop() ?? p;
  return /^NUL$/i.test(base);
}

interface SegmentRedirects {
  stdinFile: string | null;
  stdoutFile: string | null;
  appendStdout: boolean;
  stderrFile: string | null;
  appendStderr: boolean;
}

/**
 * Where a fd points after left-to-right redirects.
 * `2>&1` copies stdout's dest at that moment; a later `>/dev/null` must
 * not drag stderr along (bash fd dup). `caller.fd` is the original
 * caller stream (1=stdout, 2=stderr).
 */
type FdDest = { kind: 'caller'; fd: 1 | 2 } | { kind: 'nul' } | { kind: 'file'; path: string };

function applyRedirectDest(
  op: Redirect['op'],
  target: string | undefined,
  stdout: FdDest,
  stderr: FdDest,
): { stdout: FdDest; stderr: FdDest } {
  if (op === '2>&1') return { stdout, stderr: stdout };
  if (op === '1>&2') return { stdout: stderr, stderr };
  if (op === '<' || target === undefined) return { stdout, stderr };
  const dest: FdDest = isNulPath(target) ? { kind: 'nul' } : { kind: 'file', path: target };
  if (op === '>' || op === '>>') return { stdout: dest, stderr };
  if (op === '2>' || op === '2>>') return { stdout, stderr: dest };
  if (op === '&>' || op === '&>>') return { stdout: dest, stderr: dest };
  return { stdout, stderr };
}

/** Last-stage output fds only — captured stdout/stderr apply. */
function lastStageOutputDests(
  redirects: Redirect[],
  resolveTarget: (t: string) => string,
): { stdout: FdDest; stderr: FdDest } {
  let stdout: FdDest = { kind: 'caller', fd: 1 };
  let stderr: FdDest = { kind: 'caller', fd: 2 };
  for (const r of redirects) {
    const target =
      r.op === '2>&1' || r.op === '1>&2' || r.op === '<'
        ? undefined
        : resolveTarget(winTarget(r.target));
    ({ stdout, stderr } = applyRedirectDest(r.op, target, stdout, stderr));
  }
  return { stdout, stderr };
}

function emitToPrepDest(
  dest: FdDest,
  msg: string,
  fds: Map<string, number>,
  caller: { stdout: (s: string) => void; stderr: (s: string) => void },
): void {
  if (dest.kind === 'nul') return;
  if (dest.kind === 'file') {
    try {
      writeToPrepFd(fds, dest.path, msg);
      return;
    } catch {
      caller.stderr(msg);
      return;
    }
  }
  if (dest.fd === 1) caller.stdout(msg);
  else caller.stderr(msg);
}

function writeAllSync(fd: number, data: Buffer): void {
  let off = 0;
  while (off < data.length) {
    const n = writeSync(fd, data, off, data.length - off);
    if (n <= 0) throw new Error('fauxnix: short write to redirect');
    off += n;
  }
}

function writeToPrepFd(fds: Map<string, number>, file: string, data: string): void {
  const fd = fds.get(file);
  if (fd === undefined) throw new Error('fauxnix: redirect fd missing for ' + file);
  writeAllSync(fd, Buffer.from(data, 'utf8'));
}

function closePrepFds(fds: Map<string, number>): void {
  for (const fd of fds.values()) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  fds.clear();
}

function prepareRedirectFile(file: string, append: boolean, fds: Map<string, number>): string | null {
  try {
    const prev = fds.get(file);
    if (prev !== undefined) {
      closeSync(prev);
      fds.delete(file);
    }
    fds.set(file, openSync(file, append ? 'a' : 'w'));
    return null;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return file + ': No such file or directory';
    if (err.code === 'EACCES' || err.code === 'EPERM') return file + ': Permission denied';
    if (err.code === 'EISDIR') return file + ': Is a directory';
    return file + ': cannot create: ' + err.message;
  }
}

function planRedirects(redirects: Redirect[]): SegmentRedirects {
  const r: SegmentRedirects = {
    stdinFile: null,
    stdoutFile: null,
    appendStdout: false,
    stderrFile: null,
    appendStderr: false,
  };
  for (const red of redirects) {
    const target = winTarget(red.target);
    switch (red.op) {
      case '<':
        r.stdinFile = isNulPath(target) ? null : target;
        break;
      case '>':
      case '&>':
        if (isNulPath(target)) {
          r.stdoutFile = null;
          if (red.op === '&>') r.stderrFile = null;
        } else {
          r.stdoutFile = target;
          r.appendStdout = false;
          if (red.op === '&>') r.stderrFile = target;
        }
        break;
      case '>>':
      case '&>>':
        if (isNulPath(target)) {
          r.stdoutFile = null;
          if (red.op === '&>>') r.stderrFile = null;
        } else {
          r.stdoutFile = target;
          r.appendStdout = true;
          if (red.op === '&>>') {
            r.stderrFile = target;
            r.appendStderr = true;
          }
        }
        break;
      case '2>':
        if (isNulPath(target)) {
          // stderr only — must not undo a prior >/dev/null
          r.stderrFile = null;
        } else {
          r.stderrFile = target;
          r.appendStderr = false;
        }
        break;
      case '2>>':
        if (isNulPath(target)) {
          r.stderrFile = null;
        } else {
          r.stderrFile = target;
          r.appendStderr = true;
        }
        break;
      default:
        break;
    }
  }
  return r;
}

/** Session persists cwd and env across segments, like a real shell. */
export class FauxnixSession {
  id: string;
  cwd: string | null = null;
  env: Record<string, string> = {};
  /** Exit code of the previous segment — powers bash's `$?`. */
  prevExit: number | null = null;
  private cwdFile!: string;
  private envFile!: string;
  private scriptFile!: string;
  private hostFile!: string;
  private host: PowerShellHost | null = null;
  private lifecycleLock: Promise<unknown> = Promise.resolve();
  /** True once `env` was loaded from the host's complete environment snapshot. */
  private hasEnvSnapshot = false;
  private readonly powerShell: PowerShellSelection;

  constructor() {
    this.id = randomUUID().slice(0, 8);
    this.powerShell = resolvePowerShell();
    this.bindFiles(this.id);
  }

  private bindFiles(id: string): void {
    this.id = id;
    this.cwdFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-cwd.txt');
    this.envFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-env.json');
    this.scriptFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-script.ps1');
    this.hostFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-host.ps1');
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const done = this.lifecycleLock.then(fn, fn);
    this.lifecycleLock = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
  }

  private syncFromDisk(): void {
    try {
      if (existsSync(this.cwdFile)) {
        const c = readFileSync(this.cwdFile, 'utf8').trim();
        if (c) this.cwd = c;
      }
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(this.envFile)) {
        const raw = readFileSync(this.envFile, 'utf8');
        if (raw.trim()) {
          this.env = JSON.parse(raw) as Record<string, string>;
          this.hasEnvSnapshot = true;
        }
      }
    } catch {
      /* ignore */
    }
  }

  private ensureHost(): PowerShellHost {
    if (!this.host) {
      this.host = new PowerShellHost(this.hostFile, () => this.childEnv(), this.powerShell);
    }
    return this.host;
  }

  /** Boot the selected PowerShell now so the first run() is not a cold start. */
  prewarm(): Promise<void> {
    return this.withLock(async () => {
      await this.ensureHost().ready();
    });
  }

  dispose(): Promise<void> {
    return this.withLock(() => this.disposeUnlocked());
  }

  /** Kill the host and re-prewarm the same session object (no second FauxnixSession). */
  reset(): Promise<void> {
    return this.withLock(async () => {
      await this.disposeUnlocked();
      await this.ensureHost().ready();
    });
  }

  private async disposeUnlocked(): Promise<void> {
    if (this.host) {
      await this.host.stop();
      this.host = null;
    }
    this.cwd = null;
    this.env = {};
    this.hasEnvSnapshot = false;
    this.prevExit = null;
    await Promise.allSettled([
      fs.rm(this.cwdFile, { force: true }),
      fs.rm(this.envFile, { force: true }),
      fs.rm(this.scriptFile, { force: true }),
      fs.rm(this.hostFile, { force: true }),
    ]);
    this.bindFiles(randomUUID().slice(0, 8));
  }

  /** env for the child powershell process. */
  childEnv(cwdOverride?: string, stdinFile?: string | null): NodeJS.ProcessEnv {
    // Before the first completed request, `env` contains optional caller
    // overrides and is layered over the process baseline. Afterwards it is a
    // complete snapshot written by the resident host. Restore that snapshot
    // verbatim on transparent host restarts: merging it with process.env would
    // resurrect inherited variables that the shell successfully unset.
    const env: NodeJS.ProcessEnv = this.hasEnvSnapshot ? { ...this.env } : { ...process.env };
    if (!this.hasEnvSnapshot) {
      for (const [k, v] of Object.entries(this.env)) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
    // The MCP SDK's safe Windows stdio environment omits PATHEXT. Without it,
    // PowerShell cannot resolve extensionless native commands such as `node`.
    // Windows environment names are case-insensitive, so preserve any explicit
    // spelling/value supplied by the caller and only restore the OS default
    // when no variant is present at all.
    if (process.platform === 'win32' && !hasEnvKey(env, 'PATHEXT')) {
      env.PATHEXT = DEFAULT_WINDOWS_PATHEXT;
    }
    env.FAUXNIX_CWD_FILE = this.cwdFile;
    env.FAUXNIX_ENV_FILE = this.envFile;
    if (stdinFile) env.FAUXNIX_STDIN_FILE = stdinFile;
    else delete env.FAUXNIX_STDIN_FILE;
    if (this.prevExit !== null) env.FAUXNIX_PREV_EXIT = String(this.prevExit);
    else delete env.FAUXNIX_PREV_EXIT;
    const cwd = cwdOverride ?? this.cwd;
    if (cwd) env.FAUXNIX_CWD = cwd;
    else delete env.FAUXNIX_CWD;
    return env;
  }

  run(plans: SegmentPlan[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.withLock(() =>
      runPlans(plans, this, opts, () => this.syncFromDisk(), () => this.ensureHost()),
    );
  }
}

async function runPlans(
  plans: SegmentPlan[],
  session: FauxnixSession,
  opts: ExecOptions,
  afterSegment: () => void,
  ensureHost: () => PowerShellHost,
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const stdoutLimit = validateOutputLimit(
    'stdoutLimit',
    opts.stdoutLimit ?? DEFAULT_STDOUT_LIMIT,
  );
  const stderrLimit = validateOutputLimit(
    'stderrLimit',
    opts.stderrLimit ?? DEFAULT_STDERR_LIMIT,
  );
  const timeoutMessage =
    '\nbash: command timed out after ' + Math.round(timeoutMs / 1000) + 's';
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutClosed = false;
  let stderrClosed = false;
  let exitCode = 0;
  let timedOut = false;
  let cancelled = false;
  let truncated = false;
  let spawnError: ExecResult['spawnError'];
  const appendCaller = (fd: 1 | 2, data: string): void => {
    if (!data) return;
    if (fd === 1 ? stdoutClosed : stderrClosed) return;
    const used = fd === 1 ? stdoutBytes : stderrBytes;
    const limit = fd === 1 ? stdoutLimit : stderrLimit;
    const clipped = clipUtf8(data, Math.max(0, limit - used));
    if (fd === 1) {
      stdout += clipped.text;
      stdoutBytes += Buffer.byteLength(clipped.text, 'utf8');
    } else {
      stderr += clipped.text;
      stderrBytes += Buffer.byteLength(clipped.text, 'utf8');
    }
    if (clipped.truncated) {
      if (fd === 1) stdoutClosed = true;
      else stderrClosed = true;
      truncated = true;
    }
  };
  const remainingFor = (dest: FdDest): number => {
    if (dest.kind !== 'caller') return 0;
    if (dest.fd === 1 ? stdoutClosed : stderrClosed) return 0;
    const limit = dest.fd === 1 ? stdoutLimit : stderrLimit;
    const used = dest.fd === 1 ? stdoutBytes : stderrBytes;
    return Math.max(0, limit - used);
  };
  const closeCallerDest = (dest: FdDest): void => {
    if (dest.kind !== 'caller') return;
    if (dest.fd === 1) stdoutClosed = true;
    else stderrClosed = true;
  };
  const hostStream = (dest: FdDest): { mode: HostStreamMode; limit: number } => {
    if (dest.kind === 'file') return { mode: 'spool', limit: 0 };
    if (dest.kind === 'nul') return { mode: 'discard', limit: 0 };
    if (dest.fd === 1 ? stdoutClosed : stderrClosed) return { mode: 'discard', limit: 0 };
    return { mode: 'capture', limit: rawHostCaptureLimit(remainingFor(dest)) };
  };
  // bash list semantics: `a && b ; c` runs c regardless of a; `a && b && c`
  // skips b AND c when a fails. chainOk models the value of the current
  // &&/|| chain; `;` segments always run and restart the chain.
  let chainOk = true;
  // Redirect targets are relative to the *current* session cwd, not this
  // Node process. Re-read after every segment so `cd src && echo x > out.txt`
  // writes under src (same as two separate session calls). A one-shot
  // capture of the entry cwd would land the file in the old directory.
  let currentDir = opts.cwd ?? session.cwd ?? process.cwd();
  const resolveTarget = (t: string): string =>
    path.isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(t) ? t : path.resolve(currentDir, t);

  for (const plan of plans) {
    if (plan.op === '&&' && !chainOk) continue;
    if (plan.op === '||' && chainOk) continue;
    if (opts.signal?.aborted) {
      cancelled = true;
      exitCode = 130;
      session.prevExit = exitCode;
      break;
    }
    if (Date.now() >= deadline) {
      appendCaller(2, timeoutMessage);
      exitCode = 124;
      timedOut = true;
      session.prevExit = exitCode;
      break;
    }

    const red = planRedirects(plan.outputRedirects);
    const inRed = planRedirects(plan.stdinRedirects);
    red.stdinFile = inRed.stdinFile;
    red.stdinFile = red.stdinFile ? resolveTarget(red.stdinFile) : null;
    red.stdoutFile = red.stdoutFile ? resolveTarget(red.stdoutFile) : null;
    red.stderrFile = red.stderrFile ? resolveTarget(red.stderrFile) : null;

    // bash applies redirects left-to-right *before* the command runs.
    // Walk the parsed list in source order so a failing earlier redirect
    // (e.g. `2>nosuch/err >important.txt`) does not truncate a later file,
    // and a failing redirected `cd` cannot change cwd. Setup errors after
    // an earlier `2>file` go to that file, not the caller (bash already
    // applied the stderr redirect).
    const prepFds = new Map<string, number>();
    try {
    let redirectPrepFailed = false;
    // Snapshot fd destinations as we walk. `2>&1` copies stdout *at that
    // moment*; a later `>file` must not drag stderr along (bash fd dup).
    let prepStdout: FdDest = { kind: 'caller', fd: 1 };
    let prepStderr: FdDest = { kind: 'caller', fd: 2 };
    const emitPrepError = (msg: string) =>
      emitToPrepDest(prepStderr, msg, prepFds, {
        stdout: (s) => {
          appendCaller(1, s);
        },
        stderr: (s) => {
          appendCaller(2, s);
        },
      });
    for (const r of plan.redirects) {
      if (r.op === '2>&1' || r.op === '1>&2') {
        ({ stdout: prepStdout, stderr: prepStderr } = applyRedirectDest(
          r.op,
          undefined,
          prepStdout,
          prepStderr,
        ));
        continue;
      }
      const target = resolveTarget(winTarget(r.target));
      if (r.op === '<') {
        if (isNulPath(target)) continue;
        if (!existsSync(target)) {
          emitPrepError('bash: ' + target + ': No such file or directory\n');
          redirectPrepFailed = true;
          break;
        }
        continue;
      }
      if (!isNulPath(target)) {
        const append = r.op === '>>' || r.op === '2>>' || r.op === '&>>';
        const fail = prepareRedirectFile(target, append, prepFds);
        if (fail) {
          emitPrepError('bash: ' + fail + '\n');
          redirectPrepFailed = true;
          break;
        }
      }
      ({ stdout: prepStdout, stderr: prepStderr } = applyRedirectDest(
        r.op,
        target,
        prepStdout,
        prepStderr,
      ));
    }
    if (redirectPrepFailed) {
      exitCode = 1;
      session.prevExit = exitCode;
      chainOk = false;
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (opts.signal?.aborted) {
      cancelled = true;
      exitCode = 130;
      session.prevExit = exitCode;
      break;
    }
    if (remainingMs <= 0) {
      appendCaller(2, timeoutMessage);
      exitCode = 124;
      timedOut = true;
      session.prevExit = exitCode;
      break;
    }

    const encoded = wrapScript(plan.body, { mode: 'host' });
    // Last-stage fds last-win independently. `2>&1 >/dev/null` snapshots
    // stderr onto the caller's stdout before stdout is pointed at NUL, so
    // captured stderr is still returned; `>/dev/null 2>&1` points both at NUL.
    const applyDests = lastStageOutputDests(plan.outputRedirects, resolveTarget);
    // Each source stream is bounded according to its final destination.
    // A file keeps the complete stream, /dev/null retains nothing, and a
    // caller stream receives only the budget left by earlier list segments.
    const hostStdout = hostStream(applyDests.stdout);
    const hostStderr = hostStream(applyDests.stderr);
    const inv = await ensureHost().invoke(
      encoded,
      {
        FAUXNIX_CWD: currentDir,
        FAUXNIX_PREV_EXIT: session.prevExit === null ? '' : String(session.prevExit),
        FAUXNIX_STDIN_FILE: red.stdinFile || '',
      },
      remainingMs,
      opts.signal,
      {
        stdoutLimit: hostStdout.limit,
        stderrLimit: hostStderr.limit,
        stdoutMode: hostStdout.mode,
        stderrMode: hostStderr.mode,
      },
    );

    if (inv.spawnError === 'ENOENT' || inv.spawnError === 'START') {
      appendCaller(
        2,
        inv.stderr.toString('utf8') || 'fauxnix: failed to start the selected PowerShell host\n',
      );
      exitCode = 127;
      spawnError = inv.spawnError;
      session.prevExit = exitCode;
      chainOk = false;
      continue;
    }

    if (inv.cancelled) {
      cancelled = true;
      exitCode = 130;
      session.prevExit = exitCode;
      chainOk = false;
      break;
    }

    afterSegment();

    const decodePref = resolveNativePref();
    // Captured protocol frames are always UTF-8. FAUXNIX_NATIVE_ENCODING is
    // consumed at the native-process boundary inside fx-native; applying it
    // again here double-decodes every translated/non-ASCII frame. Only bytes
    // written directly to the host's OS stderr pipe retain a native encoding.
    const segOut = decodeOutput(inv.stdout, 'utf8');
    const framedErr = decodeOutput(inv.stderr, 'utf8');
    const nativeErr = decodeOutput(inv.nativeStderr ?? Buffer.alloc(0), decodePref);
    let segErr = normalizeStderr(framedErr + nativeErr);

    if (inv.timedOut) {
      segErr += timeoutMessage;
    }

    // Write captured streams through the fds opened during preflight
    // (bash: the redirect refers to the open file, not the path). Reopening
    // the path would recreate a file the command just unlinked
    // (`rm out.txt > out.txt`).
    let redirectOk = true;
    const deliverCaptured = (dest: FdDest, data: string, fromStdout: boolean): void => {
      if (!data) return;
      if (dest.kind === 'nul') return;
      if (dest.kind === 'file') {
        try {
          writeToPrepFd(prepFds, dest.path, data);
        } catch (e) {
          if (fromStdout) {
            appendCaller(
              2,
              'bash: ' + dest.path + ': cannot create: ' + (e as Error).message + '\n',
            );
            exitCode = 1;
            redirectOk = false;
            appendCaller(1, data);
          } else {
            appendCaller(2, data);
          }
        }
        return;
      }
      appendCaller(dest.fd, data);
    };
    const deliverSpool = (dest: FdDest, spool: string | undefined, fromStdout: boolean): void => {
      if (!spool) return;
      if (dest.kind !== 'file') {
        throw new Error('fauxnix: host returned a spool for a non-file destination');
      }
      try {
        writeSpoolToPrepFd(prepFds, spool, dest.path);
      } catch (e) {
        appendCaller(
          2,
          'bash: ' + dest.path + ': cannot write: ' + (e as Error).message + '\n',
        );
        exitCode = 1;
        redirectOk = false;
      }
    };
    const spools = [inv.stdoutSpool, inv.stderrSpool, inv.nativeStderrSpool].filter(
      (file): file is string => !!file,
    );
    try {
      deliverCaptured(applyDests.stdout, segOut, true);
      if (inv.stdoutTruncated) closeCallerDest(applyDests.stdout);
      deliverCaptured(applyDests.stderr, segErr, false);
      if (inv.stderrTruncated) closeCallerDest(applyDests.stderr);
      deliverSpool(applyDests.stdout, inv.stdoutSpool, true);
      deliverSpool(applyDests.stderr, inv.stderrSpool, false);
      deliverSpool(applyDests.stderr, inv.nativeStderrSpool, false);
    } finally {
      for (const spool of spools) rmSync(spool, { force: true });
    }
    if (inv.truncated) truncated = true;
    exitCode = !redirectOk ? 1 : inv.timedOut ? 124 : inv.cancelled ? 130 : inv.exitCode;
    if (inv.timedOut) timedOut = true;
    session.prevExit = exitCode;
    chainOk = exitCode === 0;
    // Only inherit cwd from a segment that actually ran and whose
    // output redirects succeeded. A failed `cd dir > missing/out` must
    // not move later relative redirects.
    if (redirectOk && session.cwd) currentDir = session.cwd;
    if (inv.timedOut) break;
    } finally {
      closePrepFds(prepFds);
    }
  }

  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    cancelled,
    truncated,
    spawnError,
  };
}

function clipUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  let used = 0;
  let end = 0;
  for (const codepoint of text) {
    const size = Buffer.byteLength(codepoint, 'utf8');
    if (used + size > limit) break;
    used += size;
    end += codepoint.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** Copy a host spool into an already-open redirect fd with bounded memory. */
function writeSpoolToPrepFd(
  fds: Map<string, number>,
  file: string,
  target: string,
): void {
  const outFd = fds.get(target);
  if (outFd === undefined) throw new Error('fauxnix: redirect fd missing for ' + target);
  const inFd = openSync(file, 'r');
  const input = Buffer.allocUnsafe(65_536);
  try {
    while (true) {
      const n = readSync(inFd, input, 0, input.length, null);
      if (n <= 0) break;
      writeAllSync(outFd, input.subarray(0, n));
    }
  } finally {
    closeSync(inFd);
  }
}
