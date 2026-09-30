import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { GZIP_DECODER_SOURCE, gzipNodeFunctions } from '../src/commands/gzip-node.js';

const directory = mkdtempSync(join(tmpdir(), 'fauxnix-node-gzip-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const data = Buffer.from('ordinary archive fixture\n');
const good = gzipSync(data);
const checksum = Buffer.from(good);
checksum[checksum.length - 8] ^= 1;
const invalid = [
  ['short header', good.subarray(0, 5)],
  ['missing footer', good.subarray(0, -4)],
  ['truncated body', good.subarray(0, -9)],
  ['checksum mismatch', checksum],
  ['trailing garbage', Buffer.concat([good, Buffer.from('unrelated text')])],
  ['truncated second member', Buffer.concat([good, good.subarray(0, -4)])],
] as const;
function args(path: string, mode: string, parent = process.pid) {
  return ['-e', GZIP_DECODER_SOURCE, '--', Buffer.from(path).toString('base64'), mode, String(parent)];
}
describe('real Node gzip decoder', () => {
  it.each([
    ['complete', good, data],
    ['empty', gzipSync(Buffer.alloc(0)), Buffer.alloc(0)],
    ['concatenated', Buffer.concat([good, good]), Buffer.concat([data, data])],
  ] as const)('decodes %s streams completely', (name, archive, expected) => {
    const path = join(directory, `${name} 新 archive.gz`);
    writeFileSync(path, archive);
    const result = spawnSync(process.execPath, args(path, 'stream'), { timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(result.stdout).toEqual(expected);
    expect(readFileSync(path)).toEqual(archive);
  });
  for (const mode of ['test', 'stream']) it.each(invalid)(`rejects %s in ${mode} mode`, (name, archive) => {
    const path = join(directory, `${name}.gz`);
    writeFileSync(path, archive);
    const result = spawnSync(process.execPath, args(path, mode), { timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2); // Private decoder protocol: invalid data, not an I/O failure.
    expect(result.stderr.toString()).toContain('gzip decoder:');
    if (mode === 'test') expect(result.stdout.length).toBe(0);
    // Stream mode may emit partial bytes, but only to the caller's owned stage.
    expect(readFileSync(path)).toEqual(archive);
  });
  it('validates a large legitimate archive without emitting decoded bytes in test mode', () => {
    const path = join(directory, 'large.gz');
    writeFileSync(path, gzipSync(Buffer.alloc(16 * 1024 * 1024, 97)));
    const result = spawnSync(process.execPath, args(path, 'test'), { timeout: 10000, maxBuffer: 8192 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(result.stdout.length).toBe(0);
  });
  it('aborts a backpressured decoder when its known disposable parent has exited', async () => {
    const parent = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
    expect(parent.status).toBe(0);
    const path = join(directory, 'parent-exit.gz');
    const archive = gzipSync(Buffer.alloc(4 * 1024 * 1024, 97));
    writeFileSync(path, archive);
    const child = spawn(process.execPath, args(path, 'stream', parent.pid), { stdio: ['ignore', 'pipe', 'pipe'] });
    // Leave stdout paused so completion cannot race ahead of the watcher.
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('decoder did not stop')), 5000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
      });
      expect(status).toBe(1);
      expect(readFileSync(path)).toEqual(archive);
    } finally { child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null) child.kill(); }
  });
  it('pins executable plans and renders an explicit pure-script Node dependency', () => {
    expect(gzipNodeFunctions(false)).toContain(process.execPath.replaceAll("'", "''"));
    expect(gzipNodeFunctions(true)).toContain('Get-Command node.exe -CommandType Application -ErrorAction Stop');
    expect(gzipNodeFunctions(false)).toContain('ReadToEndAsync()');
    expect(gzipNodeFunctions(false)).toContain('BaseStream.CopyTo($sink, 65536)');
    expect(gzipNodeFunctions(false)).toContain('[IO.FileOptions]::DeleteOnClose');
  });
});
