import { spawn, ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostBootstrapScript } from './translator.js';

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const READY_TIMEOUT_MS = 30_000;

export const PS_MISSING_MESSAGE =
  'fauxnix: powershell.exe not found — fauxnix executes bash via native Windows PowerShell 5.1+.\n' +
  'This host has no PowerShell on PATH (typical for Linux containers/sandboxes).\n' +
  'Run fauxnix on Windows, or install PowerShell and make powershell.exe reachable on PATH.\n';

export const DEFAULT_STDOUT_LIMIT = 8_388_608;
export const DEFAULT_STDERR_LIMIT = 1_048_576;

export interface HostInvokeResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  spawnError?: 'ENOENT' | 'START';
  spawnMessage?: string;
}

export interface HostRequestEnv {
  [key: string]: string;
}

export function encodeHostRequest(
  id: string,
  script: string,
  env: HostRequestEnv,
  opts?: { v?: number; stdoutLimit?: number; stderrLimit?: number },
): string {
  const body: Record<string, unknown> = {
    id,
    scriptB64: Buffer.from(script, 'utf8').toString('base64'),
    env,
  };
  if (opts?.v === 2) {
    body.v = 2;
    body.type = 'run';
    body.stdoutLimit = opts.stdoutLimit ?? DEFAULT_STDOUT_LIMIT;
    body.stderrLimit = opts.stderrLimit ?? DEFAULT_STDERR_LIMIT;
  }
  return JSON.stringify(body);
}

export type HostV2Frame =
  | { v: 2; type: 'ready'; capabilities?: { cancel?: boolean; maxChunkBytes?: number; stderrMarker?: boolean } }
  | { v: 2; type: 'stdout' | 'stderr'; id: string; seq: number; dataB64: string }
  | {
      v: 2;
      type: 'end';
      id: string;
      exitCode: number;
      timedOut?: boolean;
      cancelled?: boolean;
      truncated?: boolean;
    };

export function parseHostLine(line: string): {
  v1Ready?: boolean;
  v2?: HostV2Frame;
  v1?: ReturnType<typeof decodeHostResponse>;
} {
  const j = JSON.parse(line) as Record<string, unknown>;
  if (j && j.v === 2 && typeof j.type === 'string') return { v2: j as unknown as HostV2Frame };
  if (j && j.ready === true) return { v1Ready: true };
  return { v1: decodeHostResponse(line) };
}

export function decodeHostResponse(line: string): {
  id: string;
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  ready?: boolean;
} {
  const j = JSON.parse(line) as {
    id?: string;
    stdoutB64?: string;
    stderrB64?: string;
    exitCode?: number;
    ready?: boolean;
  };
  const n = Number(j.exitCode);
  return {
    id: j.id ?? '',
    stdout: Buffer.from(j.stdoutB64 ?? '', 'base64'),
    stderr: Buffer.from(j.stderrB64 ?? '', 'base64'),
    exitCode: Number.isFinite(n) ? n : 0,
    ready: j.ready === true,
  };
}

/**
 * One resident powershell.exe 5.1 process. Frames are UTF-8 JSON lines;
 * command stdout/stderr come back as base64 so PS 5.1's UTF-16LE pipe
 * encoding cannot scramble the payload.
 */
export class PowerShellHost {
  private proc: ChildProcess | null = null;
  private stdoutBuf = Buffer.alloc(0);
  private queuedLines: string[] = [];
  private waiters: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private stderrChunks: Buffer[] = [];
  private closeCode: number | null | undefined;
  private closeErr: Error | null = null;
  private closed = false;
  private startLock: Promise<void> | null = null;
  private invokeLock: Promise<unknown> = Promise.resolve();
  protocol: 1 | 2 = 1;

  constructor(
    private readonly hostFile: string,
    private readonly envFn: () => NodeJS.ProcessEnv,
  ) {}

  /** Start the resident process and wait for the ready handshake (B1 prewarm). */
  async ready(): Promise<HostInvokeResult | null> {
    return this.ensureStarted();
  }

  async invoke(
    script: string,
    env: HostRequestEnv,
    timeoutMs: number,
    signal?: AbortSignal,
    limits?: { stdoutLimit?: number; stderrLimit?: number },
  ): Promise<HostInvokeResult> {
    const run = this.invokeLock.then(() =>
      this.invokeSerial(script, env, timeoutMs, signal, limits),
    );
    this.invokeLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  drainNativeStderr(): Buffer {
    if (!this.stderrChunks.length) return Buffer.alloc(0);
    const b = Buffer.concat(this.stderrChunks);
    this.stderrChunks = [];
    return b;
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    this.closed = true;
    this.failWaiters(new Error('fauxnix: powershell host stopped'));
    if (!proc) return;
    try {
      proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000);
      proc.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private cancelledResult(): HostInvokeResult {
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 130,
      timedOut: false,
      cancelled: true,
      truncated: false,
    };
  }

  private async invokeSerial(
    script: string,
    env: HostRequestEnv,
    timeoutMs: number,
    signal?: AbortSignal,
    limits?: { stdoutLimit?: number; stderrLimit?: number },
  ): Promise<HostInvokeResult> {
    if (signal?.aborted) {
      await this.stop();
      return this.cancelledResult();
    }

    const started = await this.ensureStarted();
    if (started) return { ...started, cancelled: false, truncated: false };

    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const line = encodeHostRequest(
      id,
      script,
      env,
      this.protocol === 2
        ? { v: 2, stdoutLimit: limits?.stdoutLimit, stderrLimit: limits?.stderrLimit }
        : undefined,
    );
    try {
      this.proc!.stdin!.write(line + '\n');
    } catch (e) {
      await this.deadRestart();
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('fauxnix: powershell host exited unexpectedly\n', 'utf8'),
        exitCode: 1,
        timedOut: false,
        cancelled: false,
        truncated: false,
        spawnMessage: (e as Error).message,
      };
    }

    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      void this.stop();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.protocol === 2) {
        return await this.collectV2(id, timeoutMs);
      }
      const raw = await this.nextJsonLine(timeoutMs, id);
      const msg = decodeHostResponse(raw);
      const native = this.drainNativeStderr();
      return {
        stdout: msg.stdout,
        stderr: native.length ? Buffer.concat([msg.stderr, native]) : msg.stderr,
        exitCode: msg.exitCode,
        timedOut: false,
        cancelled: false,
        truncated: false,
      };
    } catch (e) {
      const timedOut = (e as { timedOut?: boolean }).timedOut === true;
      await this.stop();
      this.drainNativeStderr();
      if (cancelled || signal?.aborted) return this.cancelledResult();
      if (timedOut) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 124,
          timedOut: true,
          cancelled: false,
          truncated: false,
        };
      }
      if (this.closeErr && (this.closeErr as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(PS_MISSING_MESSAGE, 'utf8'),
          exitCode: 127,
          timedOut: false,
          cancelled: false,
          truncated: false,
          spawnError: 'ENOENT',
        };
      }
      const code = this.closeCode ?? 1;
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(
          'fauxnix: powershell host exited unexpectedly' +
            (code !== 1 ? ' (exit ' + String(code) + ')' : '') +
            '\n',
          'utf8',
        ),
        exitCode: code === 0 ? 1 : code,
        timedOut: false,
        cancelled: false,
        truncated: false,
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async ensureStarted(): Promise<HostInvokeResult | null> {
    if (this.proc && !this.closed) return null;
    if (!this.startLock) this.startLock = this.start();
    try {
      await this.startLock;
      return null;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(PS_MISSING_MESSAGE, 'utf8'),
          exitCode: 127,
          timedOut: false,
          cancelled: false,
          truncated: false,
          spawnError: 'ENOENT',
        };
      }
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(
          'fauxnix: failed to start powershell.exe: ' + err.message + '\n',
          'utf8',
        ),
        exitCode: 127,
        timedOut: false,
        cancelled: false,
        truncated: false,
        spawnError: 'START',
        spawnMessage: err.message,
      };
    } finally {
      this.startLock = null;
    }
  }

  private async deadRestart(): Promise<void> {
    await this.stop();
    this.closed = false;
    this.closeCode = undefined;
    this.closeErr = null;
    this.stdoutBuf = Buffer.alloc(0);
    this.queuedLines = [];
    this.stderrChunks = [];
  }

  private async start(): Promise<void> {
    await this.deadRestart();
    this.closed = false;
    writeFileSync(this.hostFile, '\ufeff' + hostBootstrapScript(), 'utf8');
    const child = spawn('powershell.exe', [...PS_ARGS, '-File', this.hostFile], {
      env: this.envFn(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = child;
    child.stdout!.on('data', (d: Buffer) => {
      if (this.proc !== child) return;
      this.onStdout(d);
    });
    child.stderr!.on('data', (d: Buffer) => {
      if (this.proc !== child) return;
      this.stderrChunks.push(d);
    });
    child.on('error', (e) => {
      if (this.proc !== child) return;
      this.closeErr = e;
      this.closed = true;
      this.failWaiters(e);
    });
    child.on('close', (c) => {
      if (this.proc !== child) return;
      this.closeCode = c;
      this.closed = true;
      this.proc = null;
      this.failWaiters(new Error('fauxnix: powershell host closed'));
    });
    try {
      const readyLine = await this.nextReadyLine(READY_TIMEOUT_MS);
      const parsed = parseHostLine(readyLine);
      if (parsed.v2?.type === 'ready') this.protocol = 2;
      else if (parsed.v1Ready || decodeHostResponse(readyLine).ready) this.protocol = 1;
      else throw new Error('fauxnix: powershell host handshake failed');
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
    while (true) {
      const i = this.stdoutBuf.indexOf(0x0a);
      if (i < 0) break;
      let line = this.stdoutBuf.subarray(0, i);
      this.stdoutBuf = this.stdoutBuf.subarray(i + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      const s = line.toString('utf8').replace(/^\uFEFF/, '');
      const w = this.waiters.shift();
      if (w) w.resolve(s);
      else this.queuedLines.push(s);
    }
  }

  private nextLine(timeoutMs: number): Promise<string> {
    if (this.queuedLines.length) return Promise.resolve(this.queuedLines.shift()!);
    if (this.closed) {
      return Promise.reject(this.closeErr ?? new Error('fauxnix: powershell host closed'));
    }
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        const err = new Error('fauxnix: powershell host timed out') as Error & { timedOut: boolean };
        err.timedOut = true;
        reject(err);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private async nextReadyLine(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = await this.nextLine(Math.max(1, deadline - Date.now()));
      if (!line.trim()) continue;
      try {
        const parsed = parseHostLine(line);
        if (parsed.v2?.type === 'ready' || parsed.v1Ready) return line;
        if (parsed.v1?.ready) return line;
      } catch {
        /* skip PS boot noise */
      }
    }
    const err = new Error('fauxnix: powershell host handshake timed out') as Error & {
      timedOut: boolean;
    };
    err.timedOut = true;
    throw err;
  }

  private async nextJsonLine(timeoutMs: number, id: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = await this.nextLine(Math.max(1, deadline - Date.now()));
      if (!line.trim()) continue;
      try {
        const msg = decodeHostResponse(line);
        if (msg.ready) continue;
        if (msg.id === id) return line;
      } catch {
        /* skip noise */
      }
    }
    const err = new Error('fauxnix: powershell host timed out') as Error & { timedOut: boolean };
    err.timedOut = true;
    throw err;
  }

  private async collectV2(id: string, timeoutMs: number): Promise<HostInvokeResult> {
    const deadline = Date.now() + timeoutMs;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSeq = 0;
    let errSeq = 0;
    let end: Extract<HostV2Frame, { type: 'end' }> | null = null;
    while (!end) {
      const line = await this.nextLine(Math.max(1, deadline - Date.now()));
      if (!line.trim()) continue;
      let parsed: ReturnType<typeof parseHostLine>;
      try {
        parsed = parseHostLine(line);
      } catch {
        continue;
      }
      const f = parsed.v2;
      if (!f) continue;
      if (f.type === 'stdout' && f.id === id) {
        if (f.seq !== outSeq) throw new Error('fauxnix: host stdout seq gap');
        out.push(Buffer.from(f.dataB64 ?? '', 'base64'));
        outSeq++;
      } else if (f.type === 'stderr' && f.id === id) {
        if (f.seq !== errSeq) throw new Error('fauxnix: host stderr seq gap');
        err.push(Buffer.from(f.dataB64 ?? '', 'base64'));
        errSeq++;
      } else if (f.type === 'end' && f.id === id) {
        end = f;
      }
    }
    let native = Buffer.alloc(0);
    try {
      native = Buffer.from(await this.waitNativeMarker(id, 2000));
    } catch {
      native = Buffer.from(this.drainNativeStderr());
    }
    const capturedErr = Buffer.from(Buffer.concat(err));
    const n = Number(end.exitCode);
    return {
      stdout: Buffer.from(Buffer.concat(out)),
      stderr: native.length ? Buffer.from(Buffer.concat([capturedErr, native])) : capturedErr,
      exitCode: Number.isFinite(n) ? n : 0,
      timedOut: end.timedOut === true,
      cancelled: end.cancelled === true,
      truncated: end.truncated === true,
    };
  }

  private async waitNativeMarker(id: string, timeoutMs: number): Promise<Buffer> {
    const needle = Buffer.from('FAUXNIX_ERR_END:' + id + '\n', 'utf8');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const buf = Buffer.concat(this.stderrChunks);
      const idx = buf.indexOf(needle);
      if (idx >= 0) {
        const before = buf.subarray(0, idx);
        const after = buf.subarray(idx + needle.length);
        this.stderrChunks = after.length ? [Buffer.from(after)] : [];
        return Buffer.from(before) as Buffer;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('fauxnix: native stderr marker missing');
  }

  private failWaiters(err: Error): void {
    const ws = this.waiters.splice(0);
    for (const w of ws) {
      try {
        w.reject(err);
      } catch {
        /* ignore */
      }
    }
  }
}
