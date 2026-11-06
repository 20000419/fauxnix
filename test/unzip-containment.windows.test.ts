import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { resolvePowerShell } from '../src/powershell.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

/** General-purpose flag bit 11: entry names are UTF-8 (APPNOTE 4.4.4). */
const UTF8_NAMES = 0x0800;

/** Minimal stored (uncompressed) zip writer so tests can craft hostile entry names. */
function storedZip(entries: { name: string; data: string; attrs?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(e.attrs ?? 0, 38); // external attributes (MS-DOS low byte)
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

// All writes stay inside our own mkdtemp directory; the hostile entry targets
// a sibling path *inside* that directory, so a regression cannot escape it.
describe.skipIf(!runnable)('unzip containment on Windows (#257)', { timeout: 30000 }, () => {
  let directory: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-unzip-slip-'));
    writeFileSync(join(directory, 'evil.zip'), storedZip([
      { name: 'ok.txt', data: 'fine\n' },
      { name: '../escaped.txt', data: 'pwned\n' },
    ]));
    writeFileSync(join(directory, 'good.zip'), storedZip([
      { name: 'dir/', data: '' },
      { name: 'dir/a.txt', data: 'alpha\n' },
    ]));
    writeFileSync(join(directory, 'dots.zip'), storedZip([
      { name: './', data: '' },
      { name: './a.txt', data: 'A\n' },
      { name: 'sub/../b.txt', data: 'B\n' },
    ]));
    writeFileSync(join(directory, 'self.zip'), storedZip([{ name: '.', data: 'x' }]));
    writeFileSync(join(directory, 'device.zip'), storedZip([
      { name: 'ok.txt', data: 'x' },
      { name: 'sub/CON.txt', data: 'x' },
    ]));
    writeFileSync(join(directory, 'utf8.zip'), storedZip([{ name: 'héllo/wörld.txt', data: 'u\n' }]));
    writeFileSync(join(directory, 'partial.zip'), storedZip([
      { name: 'blocker/x.txt', data: 'x' },
      { name: 'later.txt', data: 'later\n' },
    ]));
    writeFileSync(join(directory, 'linked.zip'), storedZip([
      { name: 'link/evil.txt', data: 'x' },
      { name: 'safe.txt', data: 's\n' },
    ]));
    writeFileSync(join(directory, 'case.zip'), storedZip([
      { name: 'Foo.txt', data: 'first\n' },
      { name: 'foo.txt', data: 'second\n' },
      { name: 'z.txt', data: 'z\n' },
    ]));
    writeFileSync(join(directory, 'dirattr.zip'), storedZip([
      { name: 'd', data: '', attrs: 0x10 },
      { name: 'd/c.txt', data: 'c\n' },
    ]));
    writeFileSync(join(directory, 'over.zip'), storedZip([
      { name: 'ro.txt', data: 'new\n' },
      { name: 'col', data: 'x' },
      { name: 'after.txt', data: 'a\n' },
    ]));
    for (const [i, name] of ['..\\escaped.txt', 'sub/../../escaped.txt', '/abs.txt', 'C:\\abs.txt', 'file.txt:ads'].entries()) {
      writeFileSync(join(directory, `bad${i}.zip`), storedZip([{ name: 'ok.txt', data: 'x' }, { name, data: 'x' }]));
    }
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const run = (command: string) =>
    session.run(translateCommandList(parseCommand(command)), { cwd: directory });

  it('refuses archives with entries outside the destination and writes nothing', async () => {
    const r = await run('unzip evil.zip -d out');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing unsafe entry '../escaped.txt'");
    expect(existsSync(join(directory, 'escaped.txt'))).toBe(false);
    expect(existsSync(join(directory, 'out', 'ok.txt'))).toBe(false);
  });

  it('extracts well-formed archives, and only overwrites with -o', async () => {
    let r = await run('unzip good.zip -d out2');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(join(directory, 'out2', 'dir', 'a.txt'), 'utf8')).toBe('alpha\n');
    r = await run('unzip good.zip -d out2');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('already exists (use -o to overwrite)');
    r = await run('unzip -o good.zip -d out2');
    expect(r.exitCode, r.stderr).toBe(0);
  });

  it('accepts "./" and "a/../" entries that stay inside the destination', async () => {
    const r = await run('unzip dots.zip -d dots');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(join(directory, 'dots', 'a.txt'), 'utf8')).toBe('A\n');
    expect(readFileSync(join(directory, 'dots', 'b.txt'), 'utf8')).toBe('B\n');
  });

  it('refuses a file entry that names the destination itself', async () => {
    const r = await run('unzip self.zip -d self');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing unsafe entry '.' (names the destination itself)");
  });

  it('refuses reserved device names and writes nothing', async () => {
    const r = await run('unzip device.zip -d dev');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing unsafe entry 'sub/CON.txt' (reserved device name)");
    expect(existsSync(join(directory, 'dev', 'ok.txt'))).toBe(false);
  });

  it('decodes UTF-8 entry names', async () => {
    const r = await run('unzip utf8.zip -d u');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(join(directory, 'u', 'héllo', 'wörld.txt'), 'utf8')).toBe('u\n');
  });

  it('reports a per-entry failure and continues with the remaining entries', async () => {
    mkdirSync(join(directory, 'part'));
    writeFileSync(join(directory, 'part', 'blocker'), 'i am a file');
    const r = await run('unzip partial.zip -d part');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('cannot extract blocker/x.txt');
    expect(readFileSync(join(directory, 'part', 'later.txt'), 'utf8')).toBe('later\n');
  });

  it('refuses to write through a junction inside the destination', async () => {
    mkdirSync(join(directory, 'jdest'));
    mkdirSync(join(directory, 'jtarget'));
    const made = spawnSync(selection.executable, ['-NoProfile', '-Command',
      `New-Item -ItemType Junction -Path '${join(directory, 'jdest', 'link')}' -Target '${join(directory, 'jtarget')}' | Out-Null`]);
    expect(made.status).toBe(0);
    const r = await run('unzip linked.zip -d jdest');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("refusing entry 'link/evil.txt' (path goes through a symbolic link or junction)");
    expect(existsSync(join(directory, 'jtarget', 'evil.txt'))).toBe(false);
    expect(readFileSync(join(directory, 'jdest', 'safe.txt'), 'utf8')).toBe('s\n');
  });

  it.each([
    [0, '..\\escaped.txt', 'outside destination'],
    [1, 'sub/../../escaped.txt', 'outside destination'],
    [2, '/abs.txt', 'absolute path'],
    [3, 'C:\\abs.txt', 'drive or stream name'],
    [4, 'file.txt:ads', 'drive or stream name'],
  ])('refuses bad%i.zip (%s) and writes nothing', async (i, name, why) => {
    const r = await run(`unzip bad${i}.zip -d bad${i}`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`refusing unsafe entry '${name}' (${why})`);
    expect(existsSync(join(directory, `bad${i}`))).toBe(false);
    expect(existsSync(join(directory, 'escaped.txt'))).toBe(false);
  });

  it('keeps the first of two case-colliding entries without -o (warning, exit 0)', async () => {
    let r = await run('unzip case.zip -d case1');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr).toContain('skipping foo.txt: same name as an entry already extracted (Foo.txt)');
    expect(readFileSync(join(directory, 'case1', 'Foo.txt'), 'utf8')).toBe('first\n');
    expect(readFileSync(join(directory, 'case1', 'z.txt'), 'utf8')).toBe('z\n');
    r = await run('unzip -o case.zip -d case2');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(join(directory, 'case2', 'foo.txt'), 'utf8')).toBe('second\n');
  });

  it('treats a zero-length entry with the directory attribute as a directory', async () => {
    const r = await run('unzip dirattr.zip -d da');
    expect(r.exitCode, r.stderr).toBe(0);
    expect(readFileSync(join(directory, 'da', 'd', 'c.txt'), 'utf8')).toBe('c\n');
  });

  it('-o replaces a ReadOnly file and reports a directory in the way, then continues', async () => {
    mkdirSync(join(directory, 'ov', 'col'), { recursive: true });
    writeFileSync(join(directory, 'ov', 'ro.txt'), 'old\n');
    chmodSync(join(directory, 'ov', 'ro.txt'), 0o444);
    const r = await run('unzip -o over.zip -d ov');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('cannot extract col: a directory with that name exists');
    expect(readFileSync(join(directory, 'ov', 'ro.txt'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(directory, 'ov', 'after.txt'), 'utf8')).toBe('a\n');
  });
});
