import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
import { spawn } from 'node:child_process';
import { PowerShellHost } from '../src/ps-host.js';

const roots: string[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fauxnix-lifecycle-'));
  roots.push(root);
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', 0)); return true; });
  vi.mocked(spawn).mockReturnValue(child as never);
  const host = new PowerShellHost(join(root, 'host.ps1'), () => ({}), {
    executable: 'test-host', expectedEdition: 'Core', configured: true,
  });
  const requests: string[] = [];
  child.stdin.on('data', (chunk) => requests.push(String(chunk)));
  return { host, child, requests };
}

describe('host startup cancellation and deadline', () => {
  it('never sends a request when cancellation arrives during startup', async () => {
    const { host, child, requests } = fixture();
    const controller = new AbortController();
    const resultPromise = host.invoke('fixture', {}, 1000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalled();
    controller.abort();
    child.stdout.write('{"ready":true}\n');
    // Any unexpected request gets an ordinary successful response, avoiding a test hang.
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ id: request.id, stdoutB64: '', stderrB64: '', exitCode: 0 }) + '\n');
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    await host.stop();
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(requests).toEqual([]);
  });

  it('includes a delayed cold start in the invocation deadline', async () => {
    const { host, child, requests } = fixture();
    const started = Date.now();
    const resultPromise = host.invoke('fixture', {}, 30);
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalled();
    const handshake = setTimeout(() => child.stdout.write('{"ready":true}\n'), 150);
    await vi.advanceTimersByTimeAsync(30);
    const result = await resultPromise;
    clearTimeout(handshake);
    await host.stop();
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(requests).toEqual([]);
    expect(Date.now() - started).toBe(30);
  });

  it('cancels promptly even if a cold host never sends its handshake', async () => {
    const { host, child, requests } = fixture();
    const controller = new AbortController();
    const resultPromise = host.invoke('fixture', {}, 1000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(await resultPromise).toMatchObject({ cancelled: true, exitCode: 130 });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses only the remaining deadline after a successful cold start', async () => {
    const { host, child, requests } = fixture();
    const resultPromise = host.invoke('fixture', {}, 100);
    await vi.advanceTimersByTimeAsync(60);
    child.stdout.write('{"ready":true}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40);
    expect(await resultPromise).toMatchObject({ timedOut: true, exitCode: 124 });
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps successful startup and ordinary result handling intact', async () => {
    const { host, child } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ id: request.id, stdoutB64: 'b2s=', exitCode: 0 }) + '\n');
    });
    const resultPromise = host.invoke('fixture', {}, 100);
    await vi.advanceTimersByTimeAsync(20);
    child.stdout.write('{"ready":true}\n');
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.stdout.toString()).toBe('ok');
    expect(result).toMatchObject({ timedOut: false, cancelled: false, exitCode: 0 });
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
  });


  it('can start a fresh host after startup cancellation', async () => {
    const { host } = fixture();
    const controller = new AbortController();
    const cancelled = host.invoke('first', {}, 100, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect((await cancelled).cancelled).toBe(true);

    const { child } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ id: request.id, stdoutB64: 'b2s=', exitCode: 0 }) + '\n');
    });
    const recovered = host.invoke('second', {}, 100);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"ready":true}\n');
    await vi.advanceTimersByTimeAsync(0);
    expect((await recovered).stdout.toString()).toBe('ok');
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains the version-two host stream and marker handshake', async () => {
    const { host, child } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      expect(request.v).toBe(2);
      child.stdout.write(JSON.stringify({ v: 2, type: 'stdout', id: request.id, seq: 0, dataB64: 'b2s=' }) + '\n');
      child.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
      queueMicrotask(() => child.stderr.write('FAUXNIX_ERR_END:' + request.id + '\n'));
    });
    const resultPromise = host.invoke('fixture', {}, 100);
    await vi.advanceTimersByTimeAsync(20);
    child.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;
    expect(result.stdout.toString()).toBe('ok');
    expect(result).toMatchObject({ timedOut: false, cancelled: false, exitCode: 0 });
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

});

// Stdout and stderr are separate OS pipes. The end frame can be delivered
// before the stderr completion marker although the host writes the marker first.
describe('version-two native stderr completion boundary', () => {
  it('contains a host stdin stream error and starts a fresh host without replaying the failed request', async () => {
    const { host, child, requests } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
    });
    const pending = host.invoke('fixture', {}, 1000);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(0);
    let unhandled: unknown;
    try {
      child.stdin.emit('error', Object.assign(new Error('fixture broken pipe'), { code: 'EPIPE' }));
    } catch (error) {
      unhandled = error;
    }
    await vi.advanceTimersByTimeAsync(0);
    if (unhandled) await host.stop();
    const result = await pending;
    await host.stop();
    expect(unhandled).toBeUndefined();
    expect(result).toMatchObject({ infrastructureError: true, cancelled: false, timedOut: false, exitCode: 1 });
    expect(requests).toHaveLength(1);

    const { child: freshChild, requests: freshRequests } = fixture();
    freshChild.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      freshChild.stdout.write(JSON.stringify({ v: 2, type: 'stdout', id: request.id, seq: 0, dataB64: 'b2s=' }) + '\n');
      freshChild.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
      queueMicrotask(() => freshChild.stderr.write('FAUXNIX_ERR_END:' + request.id + '\n'));
    });
    const recovered = host.invoke('next request', {}, 1000);
    await vi.advanceTimersByTimeAsync(0);
    // Late errors from the retired child must not poison its replacement.
    child.stdin.emit('error', Object.assign(new Error('retired pipe'), { code: 'EPIPE' }));
    freshChild.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(0);
    const nextResult = await recovered;
    expect(nextResult).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
    expect(nextResult.infrastructureError).not.toBe(true);
    expect(nextResult.stdout.toString()).toBe('ok');
    expect(requests).toHaveLength(1);
    expect(freshRequests).toHaveLength(1);
    expect(Buffer.from(JSON.parse(freshRequests[0]).scriptB64, 'base64').toString()).toBe('next request');
    await host.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports cancellation after the end frame while the marker is pending', async () => {
    const { host, child } = fixture();
    const controller = new AbortController();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
    });
    const pending = host.invoke('fixture', {}, 1000, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(20);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const result = await pending;
    await host.stop();
    expect(result).toMatchObject({ cancelled: true, timedOut: false, exitCode: 130 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps native marker collection inside the original invocation deadline', async () => {
    const { host, child } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
      setTimeout(() => child.stderr.write('FAUXNIX_ERR_END:' + request.id + '\n'), 200);
    });
    const started = Date.now();
    let settledAt: number | undefined;
    const pending = host.invoke('fixture', {}, 100).then((result) => {
      settledAt = Date.now() - started;
      return result;
    });
    await vi.advanceTimersByTimeAsync(20);
    child.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    await host.stop();
    expect(result).toMatchObject({ cancelled: false, timedOut: true, exitCode: 124 });
    expect(settledAt).toBe(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails and removes native stderr spools when the marker never arrives', async () => {
    const { host, child } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stderr.write('ordinary diagnostic '.repeat(8));
      child.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
    });
    const pending = host.invoke('fixture', {}, 100);
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(2100);
    const result = await pending;
    await host.stop();
    expect(result).toMatchObject({ cancelled: false, timedOut: true, exitCode: 124 });
    expect(readdirSync(roots[roots.length - 1]).filter((name) => name.endsWith('.native-stderr'))).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a closed host promptly when native completion is still pending', async () => {
    const { host, child } = fixture();
    child.stdin.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      child.stdout.write(JSON.stringify({ v: 2, type: 'end', id: request.id, exitCode: 0 }) + '\n');
    });
    const started = Date.now();
    let settledAt: number | undefined;
    const pending = host.invoke('fixture', {}, 5000).then((result) => {
      settledAt = Date.now() - started;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    child.stdout.write('{"v":2,"type":"ready"}\n');
    await vi.advanceTimersByTimeAsync(20);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    await host.stop();
    expect(result).toMatchObject({ infrastructureError: true, cancelled: false, timedOut: false, exitCode: 1 });
    expect(settledAt).toBe(20);
    expect(vi.getTimerCount()).toBe(0);
  });
});
