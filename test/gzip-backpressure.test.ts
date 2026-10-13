import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { GZIP_DECODER_SOURCE } from '../src/commands/gzip-node.js';

it('observes lease closure after stdout has filled its pipe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fauxnix-gzip-stalled-'));
  const path = join(directory, 'ordinary.gz');
  const archive = gzipSync(Buffer.alloc(4 * 1024 * 1024, 97));
  writeFileSync(path, archive);
  // Record the native stdout write boundary without changing its behavior.
  // A stalled synchronous write leaves an unmatched "begin", and prevents
  // both the heartbeat and the lease event from reaching the event loop.
  const probe = String.raw`
const { writeSync: probeWrite } = require('node:fs');
const originalWrite = process.stdout.write;
process.stdout.write = function (...args) {
  probeWrite(2, 'stdout:begin\n');
  const result = originalWrite.apply(this, args);
  probeWrite(2, 'stdout:return\n');
  return result;
};
setInterval(() => probeWrite(2, 'heartbeat\n'), 100).unref();
process.stdin.on('end', () => probeWrite(2, 'lease:end\n'));
`;
  const child = spawn(process.execPath, [
    '-e', probe + GZIP_DECODER_SOURCE, '--',
    Buffer.from(path).toString('base64'), 'stream', String(process.pid), 'lease',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no decoder output: ' + diagnostics)), 20_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.stdout.once('readable', () => { clearTimeout(timer); resolve(); });
    });
    // The older test releases the lease on the first output chunk, racing the
    // pipe becoming full. Keep the consumer stalled before releasing ownership.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.stdout.readableLength).toBeGreaterThan(0);
    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lease shutdown stalled: ' + diagnostics)), 5_000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    child.stdin.end();
    child.stdin.destroy();
    expect(await exited, diagnostics).toBe(1);
    expect(diagnostics).toContain('lease:end');
    expect(readFileSync(path)).toEqual(archive);
  } finally {
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (child.exitCode === null) child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
