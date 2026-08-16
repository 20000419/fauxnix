import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redirect } from './ast.js';
import { SegmentPlan, normalizeLiteralPath } from './translator.js';
import { decodeOutput, encodeCommand, resolveNativePref } from './encoding.js';
import { normalizeStderr } from './errors.js';

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
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

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

/**
 * Open a redirect target the way bash does: before the command runs.
 * `>` truncates; `>>` appends. Failure means the command must not run
 * (so a redirected `cd` cannot change the session cwd).
 */
function appendRedirectText(file: string, text: string): void {
  const prev = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  writeFileSync(file, Buffer.concat([prev, Buffer.from(text, 'utf8')]));
}

function prepareRedirectFile(file: string, append: boolean): string | null {
  try {
    const fd = openSync(file, append ? 'a' : 'w');
    closeSync(fd);
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
  private cwdFile: string;
  private envFile: string;
  private scriptFile: string;

  constructor() {
    const id = randomUUID().slice(0, 8);
    this.cwdFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-cwd.txt');
    this.envFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-env.json');
    this.scriptFile = path.join(os.tmpdir(), 'fauxnix-' + id + '-script.ps1');
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

  async dispose(): Promise<void> {
    await Promise.allSettled([
      fs.rm(this.cwdFile, { force: true }),
      fs.rm(this.envFile, { force: true }),
      fs.rm(this.scriptFile, { force: true }),
    ]);
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
    return runPlans(plans, this, opts, () => this.syncFromDisk(), this.scriptFile);
  }
}

interface RunningChild {
  proc: ChildProcess;
  killed: boolean;
}

async function runPlans(
  plans: SegmentPlan[],
  session: FauxnixSession,
  opts: ExecOptions,
  afterSegment: () => void,
  scriptFile: string,
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    let redirectPrepFailed = false;
    let prepStderrFile: string | null = null;
    let prepStdoutFile: string | null = null;
    let prepSwallowStderr = false;
    let prepMergeStderr = false;
    const emitPrepError = (msg: string) => {
      if (prepSwallowStderr && !prepMergeStderr) return;
      const dest = prepMergeStderr ? prepStdoutFile : prepStderrFile;
      if (dest) {
        try {
          appendRedirectText(dest, msg);
        } catch {
          stderr += msg;
        }
        return;
      }
      stderr += msg;
    };
    for (const r of plan.redirects) {
      if (r.op === '2>&1') {
        prepMergeStderr = true;
        prepSwallowStderr = false;
        continue;
      }
      if (r.op === '1>&2') {
        prepMergeStderr = false;
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
        if (r.op === '2>' || r.op === '2>>') {
          prepSwallowStderr = true;
          prepStderrFile = null;
          prepMergeStderr = false;
        } else if (r.op === '&>' || r.op === '&>>') {
          prepSwallowStderr = true;
          prepStdoutFile = null;
          prepStderrFile = null;
        }
        continue;
      }
      const append = r.op === '>>' || r.op === '2>>' || r.op === '&>>';
      const fail = prepareRedirectFile(target, append);
      if (fail) {
        emitPrepError('bash: ' + fail + '\n');
        redirectPrepFailed = true;
        break;
      }
      if (r.op === '>' || r.op === '>>') prepStdoutFile = target;
      else if (r.op === '2>' || r.op === '2>>') {
        prepStderrFile = target;
        prepSwallowStderr = false;
        prepMergeStderr = false;
      } else if (r.op === '&>' || r.op === '&>>') {
        prepStdoutFile = target;
        prepStderrFile = target;
        prepSwallowStderr = false;
        prepMergeStderr = false;
      }
    }
    if (redirectPrepFailed) {
      exitCode = 1;
      session.prevExit = exitCode;
      chainOk = false;
      continue;
    }

    const encoded = encodeCommand(plan.script);

    // -EncodedCommand is capped by the ~32K command-line limit; heavy
    // pipelines fall back to a UTF-8 BOM temp script (PS 5.1 honors the BOM
    // regardless of the console codepage, so non-ASCII stays intact).
    let psArgs: string[];
    if (encoded.length > 28000) {
      writeFileSync(scriptFile, '\ufeff' + plan.script, 'utf8');
      psArgs = [...PS_ARGS, '-File', scriptFile];
    } else {
      psArgs = [...PS_ARGS, '-EncodedCommand', encoded];
    }

    const child = spawn('powershell.exe', psArgs, {
      env: session.childEnv(currentDir, red.stdinFile),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const running: RunningChild = { proc: child, killed: false };

    const outBufs: Buffer[] = [];
    const errBufs: Buffer[] = [];
    child.stdout!.on('data', (d: Buffer) => outBufs.push(d));
    child.stderr!.on('data', (d: Buffer) => errBufs.push(d));
    child.stdin!.end();

    const timer = setTimeout(() => {
      running.killed = true;
      // Node-native termination — no external kill process, nothing injectable.
      // Grandchildren of a timed-out script may survive; the `kill -9`/`pkill`
      // builtins remain available for explicit Windows tree kills.
      try {
        child.kill();
      } catch {
        /* best effort */
      }
    }, timeoutMs);

    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (e) => {
        stderr += 'fauxnix: failed to start powershell.exe: ' + e.message + '\n';
        resolve(127);
      });
      child.on('close', (c) => resolve(running.killed ? 124 : (c ?? 0)));
    });
    clearTimeout(timer);

    afterSegment();

    const decodePref = resolveNativePref();
    // GNU line discipline: PowerShell's console layer terminates every line
    // with CRLF; bash tools expect LF (redirect-written files and byte counts
    // must match coreutils, e.g. `head -2 f > out.txt; wc -c out.txt`)
    let segOut = decodeOutput(Buffer.concat(outBufs), decodePref).replace(/\r\n/g, '\n');
    let segErr = normalizeStderr(decodeOutput(Buffer.concat(errBufs), decodePref)).replace(/\r\n/g, '\n');

    if (running.killed) {
      segErr += '\nbash: command timed out after ' + Math.round(timeoutMs / 1000) + 's';
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

    // redirect stdout to file instead of the result stream
    let redirectOk = true;
    if (red.stdoutFile) {
      try {
        if (red.appendStdout) {
          const prev = existsSync(red.stdoutFile) ? readFileSync(red.stdoutFile) : Buffer.alloc(0);
          writeFileSync(red.stdoutFile, Buffer.concat([prev, Buffer.from(segOut, 'utf8')]));
        } else {
          writeFileSync(red.stdoutFile, segOut, 'utf8');
        }
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
        if (red.appendStderr && existsSync(red.stderrFile)) {
          const prev = readFileSync(red.stderrFile);
          writeFileSync(red.stderrFile, Buffer.concat([prev, Buffer.from(body, 'utf8')]));
        } else if (red.stderrFile === red.stdoutFile && existsSync(red.stderrFile)) {
          const prev = readFileSync(red.stderrFile);
          writeFileSync(red.stderrFile, Buffer.concat([prev, Buffer.from(body, 'utf8')]));
        } else {
          writeFileSync(red.stderrFile, body, 'utf8');
        }
        segErr = '';
      } catch {
        /* best effort */
      }
    }

    stdout += segOut;
    stderr += segErr;
    exitCode = code ?? 0;
    session.prevExit = exitCode;
    chainOk = exitCode === 0;
    // Only inherit cwd from a segment that actually ran and whose
    // output redirects succeeded. A failed `cd dir > missing/out` must
    // not move later relative redirects.
    if (redirectOk && session.cwd) currentDir = session.cwd;
  }

  return { stdout, stderr, exitCode };
}
