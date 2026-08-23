import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, existsSync, openSync, closeSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redirect } from './ast.js';
import { SegmentPlan, normalizeLiteralPath, wrapScript } from './translator.js';
import { decodeOutput, normalizeHostNewlines, resolveNativePref } from './encoding.js';
import { normalizeStderr } from './errors.js';
import { PowerShellHost, PS_MISSING_MESSAGE } from './ps-host.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Extra environment layered over the session (used by MCP per-call cwd). */
  cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Resolve /dev/null and POSIX-ish literal targets to real Windows paths. */
function winTarget(target: string): string {
  const p = normalizeLiteralPath(target);
  if (p === '$env:TEMP') return os.tmpdir();
  if (p.startsWith('$env:TEMP\\')) return path.join(os.tmpdir(), p.slice('$env:TEMP\\'.length));
  return p;
}

interface SegmentRedirects {
  stdinFile: string | null;
  stdoutFile: string | null;
  appendStdout: boolean;
  stderrFile: string | null;
  appendStderr: boolean;
  mergeStderr: boolean;
  devNull: boolean;
}

/** Where a fd points during left-to-right redirect setup. */
type PrepDest = { kind: 'caller' } | { kind: 'nul' } | { kind: 'file'; path: string };

function emitToPrepDest(
  dest: PrepDest,
  msg: string,
  fds: Map<string, number>,
  fallback: (s: string) => void,
): void {
  if (dest.kind === 'nul') return;
  if (dest.kind === 'file') {
    try {
      writeToPrepFd(fds, dest.path, msg);
      return;
    } catch {
      /* fall through to caller */
    }
  }
  fallback(msg);
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
    mergeStderr: false,
    devNull: false,
  };
  for (const red of redirects) {
    const target = winTarget(red.target);
    switch (red.op) {
      case '<':
        r.stdinFile = target;
        break;
      case '>':
      case '&>':
        if (target === 'NUL') r.devNull = true;
        else {
          r.stdoutFile = target;
          r.appendStdout = false;
          if (red.op === '&>') r.stderrFile = target;
        }
        break;
      case '>>':
      case '&>>':
        if (target === 'NUL') r.devNull = true;
        else {
          r.stdoutFile = target;
          r.appendStdout = true;
          if (red.op === '&>>') {
            r.stderrFile = target;
            r.appendStderr = true;
          }
        }
        break;
      case '2>':
        if (target === 'NUL') {
          // 2>/dev/null swallows stderr only
          r.stderrFile = null;
          r.devNull = false;
          (r as { swallowStderr?: boolean }).swallowStderr = true;
        } else {
          r.stderrFile = target;
          r.appendStderr = false;
        }
        break;
      case '2>>':
        if (target !== 'NUL') {
          r.stderrFile = target;
          r.appendStderr = true;
        }
        break;
      case '2>&1':
        r.mergeStderr = true;
        break;
      case '1>&2':
        r.mergeStderr = false;
        (r as { stdoutToStderr?: boolean }).stdoutToStderr = true;
        break;
    }
  }
  return r;
}

/** Session persists cwd and env across segments, like a real shell. */
export class FauxnixSession {
  cwd: string | null = null;
  env: Record<string, string> = {};
  /** Exit code of the previous segment — powers bash's `$?`. */
  prevExit: number | null = null;
  private cwdFile!: string;
  private envFile!: string;
  private scriptFile!: string;
  private hostFile!: string;
  private host: PowerShellHost | null = null;
  private runLock: Promise<unknown> = Promise.resolve();

  constructor() {
    this.bindFiles(randomUUID().slice(0, 8));
  }

  private bindFiles(id: string): void {
    this.cwdFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-cwd.txt');
    this.envFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-env.json');
    this.scriptFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-script.ps1');
    this.hostFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-host.ps1');
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
        if (raw.trim()) this.env = JSON.parse(raw) as Record<string, string>;
      }
    } catch {
      /* ignore */
    }
  }

  private ensureHost(): PowerShellHost {
    if (!this.host) {
      this.host = new PowerShellHost(this.hostFile, () => this.childEnv());
    }
    return this.host;
  }

  /** Boot powershell.exe now so the first run() is not the 1.1s cold start. */
  async prewarm(): Promise<void> {
    await this.ensureHost().ready();
  }

  async dispose(): Promise<void> {
    if (this.host) {
      await this.host.stop();
      this.host = null;
    }
    this.cwd = null;
    this.env = {};
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
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
    const done = this.runLock.then(() =>
      runPlans(plans, this, opts, () => this.syncFromDisk(), () => this.ensureHost()),
    );
    this.runLock = done.then(
      () => undefined,
      () => undefined,
    );
    return done;
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
  const timeoutMessage =
    '\nbash: command timed out after ' + Math.round(timeoutMs / 1000) + 's';
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
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
    if (Date.now() >= deadline) {
      stderr += timeoutMessage;
      exitCode = 124;
      session.prevExit = exitCode;
      break;
    }

    const red = planRedirects(plan.redirects);
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
    let prepStdout: PrepDest = { kind: 'caller' };
    let prepStderr: PrepDest = { kind: 'caller' };
    const emitPrepError = (msg: string) =>
      emitToPrepDest(prepStderr, msg, prepFds, (s) => {
        stderr += s;
      });
    for (const r of plan.redirects) {
      if (r.op === '2>&1') {
        prepStderr = prepStdout;
        continue;
      }
      if (r.op === '1>&2') {
        prepStdout = prepStderr;
        continue;
      }
      const target = resolveTarget(winTarget(r.target));
      if (r.op === '<') {
        if (!existsSync(target)) {
          emitPrepError('bash: ' + target + ': No such file or directory\n');
          redirectPrepFailed = true;
          break;
        }
        continue;
      }
      if (target === 'NUL') {
        if (r.op === '>' || r.op === '>>') prepStdout = { kind: 'nul' };
        else if (r.op === '2>' || r.op === '2>>') prepStderr = { kind: 'nul' };
        else if (r.op === '&>' || r.op === '&>>') {
          prepStdout = { kind: 'nul' };
          prepStderr = { kind: 'nul' };
        }
        continue;
      }
      const append = r.op === '>>' || r.op === '2>>' || r.op === '&>>';
      const fail = prepareRedirectFile(target, append, prepFds);
      if (fail) {
        emitPrepError('bash: ' + fail + '\n');
        redirectPrepFailed = true;
        break;
      }
      const fileDest: PrepDest = { kind: 'file', path: target };
      if (r.op === '>' || r.op === '>>') prepStdout = fileDest;
      else if (r.op === '2>' || r.op === '2>>') prepStderr = fileDest;
      else if (r.op === '&>' || r.op === '&>>') {
        prepStdout = fileDest;
        prepStderr = fileDest;
      }
    }
    if (redirectPrepFailed) {
      exitCode = 1;
      session.prevExit = exitCode;
      chainOk = false;
      continue;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      stderr += timeoutMessage;
      exitCode = 124;
      session.prevExit = exitCode;
      break;
    }

    const encoded = wrapScript(plan.body, { mode: 'host' });
    const inv = await ensureHost().invoke(
      encoded,
      {
        FAUXNIX_CWD: currentDir,
        FAUXNIX_PREV_EXIT: session.prevExit === null ? '' : String(session.prevExit),
        FAUXNIX_STDIN_FILE: red.stdinFile || '',
      },
      remainingMs,
    );

    if (inv.spawnError === 'ENOENT') {
      stderr += inv.stderr.toString('utf8') || PS_MISSING_MESSAGE;
      exitCode = 127;
      session.prevExit = exitCode;
      chainOk = false;
      continue;
    }

    afterSegment();

    const decodePref = resolveNativePref();
    // GNU line discipline: the PS host terminates Write-Output lines with
    // CRLF. Exact writers (fx-write / printf / echo -n) must keep embedded
    // CR so `printf 'a\r\nb' > out` stays 4 bytes.
    let segOut = normalizeHostNewlines(decodeOutput(inv.stdout, decodePref));
    let segErr = normalizeHostNewlines(normalizeStderr(decodeOutput(inv.stderr, decodePref)));

    if (inv.timedOut) {
      segErr += timeoutMessage;
    }

    if (red.mergeStderr) {
      segOut += (segOut && !segOut.endsWith('\n') && segErr ? '\n' : '') + segErr;
      segErr = '';
    }
    const stdoutToStderr = (red as { stdoutToStderr?: boolean }).stdoutToStderr;
    if (stdoutToStderr) {
      segErr += segOut;
      segOut = '';
    }
    const swallowStderr = (red as { swallowStderr?: boolean }).swallowStderr;
    if (swallowStderr) segErr = '';

    // Write captured streams through the fds opened during preflight
    // (bash: the redirect refers to the open file, not the path). Reopening
    // the path would recreate a file the command just unlinked
    // (`rm out.txt > out.txt`).
    let redirectOk = true;
    if (red.stdoutFile) {
      try {
        writeToPrepFd(prepFds, red.stdoutFile, segOut);
        segOut = '';
      } catch (e) {
        segErr += 'bash: ' + red.stdoutFile + ': cannot create: ' + (e as Error).message + '\n';
        exitCode = 1;
        redirectOk = false;
      }
    }
    if (red.stderrFile) {
      try {
        const body = red.stderrFile === red.stdoutFile ? segOut + segErr : segErr;
        writeToPrepFd(prepFds, red.stderrFile, body);
        segErr = '';
      } catch {
        /* best effort */
      }
    }

    stdout += segOut;
    stderr += segErr;
    exitCode = inv.timedOut ? 124 : inv.exitCode;
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

  return { stdout, stderr, exitCode };
}
