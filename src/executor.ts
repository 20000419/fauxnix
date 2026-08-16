import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redirect } from './ast.js';
import { SegmentPlan, normalizeLiteralPath } from './translator.js';
import { decodeOutput, encodeCommand } from './encoding.js';
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
  // redirect targets are relative to the session cwd, not this node process
  const baseDir = opts.cwd ?? session.cwd ?? process.cwd();
  const resolveTarget = (t: string): string =>
    path.isAbsolute(t) || /^[A-Za-z]:[\\/]/.test(t) ? t : path.resolve(baseDir, t);

  for (const plan of plans) {
    if (plan.op === '&&' && !chainOk) continue;
    if (plan.op === '||' && chainOk) continue;

    const red = planRedirects(plan.redirects);
    red.stdinFile = red.stdinFile ? resolveTarget(red.stdinFile) : null;
    red.stdoutFile = red.stdoutFile ? resolveTarget(red.stdoutFile) : null;
    red.stderrFile = red.stderrFile ? resolveTarget(red.stderrFile) : null;

    // bash: a missing `< file` target aborts the segment before running it
    if (red.stdinFile && !existsSync(red.stdinFile)) {
      stderr += 'bash: ' + red.stdinFile + ': No such file or directory\n';
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
      env: session.childEnv(opts.cwd, red.stdinFile),
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

    let segOut = decodeOutput(Buffer.concat(outBufs));
    let segErr = normalizeStderr(decodeOutput(Buffer.concat(errBufs)));

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
  }

  return { stdout, stderr, exitCode };
}
