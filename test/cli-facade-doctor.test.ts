import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectDoctorReport } from '../src/doctor.js';
import { runFacade } from '../src/facade.js';
import '../src/commands/install-all.js';

const distEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const cli = (args: string[]) =>
  spawnSync(process.execPath, [distEntry, ...args], { encoding: 'utf8' });

describe('CLI help and argv quoting (#259)', () => {
  it('answers --help, -h and help without spawning PowerShell', () => {
    for (const flag of ['--help', '-h', 'help']) {
      const r = cli([flag]);
      expect(r.status, flag).toBe(0);
      expect(r.stdout, flag).toContain('Usage');
    }
  });

  it('keeps multi-token argv quoting intact in translation', () => {
    const r = cli(['translate', 'echo', 'a  b']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("@('a  b')");
  });

  it('passes a single-token command line through verbatim', () => {
    const r = cli(['translate', 'echo a  b']);
    expect(r.status).toBe(0);
    // two separate words after field splitting — the old (pre-#259) shape
    expect(r.stdout).not.toContain("'a  b'");
  });
});

describe('facade --version after leading flags (#259)', () => {
  it('prints the version for -l --version and -i --version', () => {
    for (const flags of [['-l', '--version'], ['-i', '--version']]) {
      const r = cli(['facade', ...flags]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('GNU bash');
    }
  });

  it('does not treat --version inside a -c script as an option', () => {
    const r = cli(['facade', '-c', 'echo ok']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ok');
    expect(r.stdout).not.toContain('GNU bash,');
  });
});

describe('doctor reports Kimi (#259)', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'fauxnix-doctor-kimi-'));
    mkdirSync(join(home, '.kimi-code'), { recursive: true });
    writeFileSync(
      join(home, '.kimi-code', 'mcp.json'),
      JSON.stringify({ mcpServers: { fauxnix: { command: 'fauxnix', args: ['mcp'] } } }),
    );
  });
  afterAll(() => {
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('lists a kimi row flagging the legacy bare shim', async () => {
    const report = await collectDoctorReport({ home, env: { ...process.env } });
    const kimiLine = report.lines.find((l) => l.includes('kimi'));
    expect(kimiLine).toBeDefined();
    expect(String(kimiLine)).toMatch(/fauxnix MCP launcher does not match|absolute launcher/);
  });

  it('recommends install --kimi when no config exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'fauxnix-doctor-kimi2-'));
    try {
      const report = await collectDoctorReport({ home: empty, env: { ...process.env } });
      const kimiLine = report.lines.find((l) => l.includes('kimi'));
      expect(String(kimiLine)).toContain('not detected');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
