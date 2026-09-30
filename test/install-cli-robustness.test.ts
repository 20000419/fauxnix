import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  run: vi.fn(),
  dispose: vi.fn(),
  prewarm: vi.fn(),
  env: {} as Record<string, string>,
}));

vi.mock('../src/executor.js', () => ({
  FauxnixSession: vi.fn(function () { return session; }),
}));

import { runCli } from '../src/cli.js';
import { hasCodexFauxnix } from '../src/doctor.js';
import { runFacade } from '../src/facade.js';
import { runInstall } from '../src/install.js';

let savedExitCode: typeof process.exitCode;
let savedArg0: string | undefined;
const directories: string[] = [];

beforeEach(() => {
  savedExitCode = process.exitCode;
  savedArg0 = process.env.FAUXNIX_ARG0;
  session.run.mockReset().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  session.dispose.mockReset().mockResolvedValue(undefined);
  session.prewarm.mockReset().mockResolvedValue(undefined);
  session.env = {};
});

afterEach(() => {
  process.exitCode = savedExitCode;
  if (savedArg0 === undefined) delete process.env.FAUXNIX_ARG0;
  else process.env.FAUXNIX_ARG0 = savedArg0;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempHome(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fauxnix-install-cli-'));
  directories.push(directory);
  return directory;
}

describe('CLI session lifecycle', () => {
  it('disposes the session when execution rejects', async () => {
    const failure = new Error('host stopped');
    session.run.mockRejectedValueOnce(failure);
    await expect(runCli(['echo hello'])).rejects.toBe(failure);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('disposes the session when writing output fails', async () => {
    session.run.mockResolvedValueOnce({ stdout: 'hello\n', stderr: '', exitCode: 0 });
    const failure = new Error('output closed');
    vi.spyOn(process.stdout, 'write').mockImplementationOnce(() => { throw failure; });
    await expect(runCli(['echo hello'])).rejects.toBe(failure);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('sets the exit code without forcing buffered output to be discarded', async () => {
    session.run.mockResolvedValueOnce({ stdout: 'hello\n', stderr: 'detail\n', exitCode: 3 });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(false);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(false);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runCli(['echo hello']);
    expect(stdout).toHaveBeenCalledWith('hello\n');
    expect(stderr).toHaveBeenCalledWith('detail\n');
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(3);
  });

  it('allows facade output to drain and does not fall through to command execution', async () => {
    session.run.mockResolvedValueOnce({ stdout: 'hello\n', stderr: '', exitCode: 7 });
    vi.spyOn(process.stdout, 'write').mockReturnValue(false);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runCli(['facade', '-c', 'echo hello']);
    expect(session.run).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(7);
  });
});

describe('facade one-shot robustness', () => {
  it('accepts an explicitly empty command string', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runFacade(['-c', ''])).toBe(0);
    expect(session.run).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('still rejects a missing command operand', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runFacade(['-c'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith('bash: -c: option requires an argument\n');
    expect(session.run).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, 'host stopped'])('reports non-Error rejection %s without throwing', async (failure) => {
    session.run.mockRejectedValueOnce(failure);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runFacade(['-c', 'echo hello'])).toBe(2);
    expect(stderr).toHaveBeenCalledWith(`bash: -c: ${String(failure)}\n`);
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the invocation name scoped to the facade session', async () => {
    process.env.FAUXNIX_ARG0 = 'parent-name';
    expect(await runFacade(['-c', 'echo hello', 'facade-name'])).toBe(0);
    expect(session.env.FAUXNIX_ARG0).toBe('facade-name');
    expect(process.env.FAUXNIX_ARG0).toBe('parent-name');
  });

  it('prints startup diagnostics when positional setup fails', async () => {
    session.run.mockResolvedValueOnce({ stdout: '', stderr: 'host unavailable\n', exitCode: 127 });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(await runFacade(['-c', 'echo hello', 'name', 'arg'])).toBe(127);
    expect(stderr).toHaveBeenCalledWith('host unavailable\n');
    expect(session.run).toHaveBeenCalledOnce();
  });

  it('continues the marker queue after a non-Error rejection', async () => {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    session.run.mockRejectedValueOnce(null);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const completion = runFacade([]);
    await Promise.resolve();
    input.end('<bash-input>echo first</bash-input><bash-input>echo second</bash-input>');
    expect(await completion).toBe(0);
    expect(stderr).toHaveBeenCalledWith('fauxnix: facade: null\n');
    expect(stdout.mock.calls.map(([text]) => text)).toEqual([
      '<bash-exit>127</bash-exit>\n',
      '<bash-exit>0</bash-exit>\n',
    ]);
    expect(session.run).toHaveBeenCalledTimes(2);
    expect(session.dispose).toHaveBeenCalledOnce();
  });
});

describe('installer config compatibility', () => {
  it.each([
    '[ mcp_servers . fauxnix ]',
    '["mcp_servers"."fauxnix"]',
    "[ 'mcp_servers' . 'fauxnix' ]",
  ])('recognizes a valid TOML table header %s without appending a duplicate', (header) => {
    const home = tempHome();
    mkdirSync(join(home, '.codex'));
    const path = join(home, '.codex', 'config.toml');
    const original = `${header}\ncommand = "fauxnix"\nargs = ["mcp"]\n`;
    writeFileSync(path, original);
    expect(hasCodexFauxnix(original)).toBe(true);
    const report = runInstall(['--codex'], { home, env: {} });
    expect(report.ok).toBe(true);
    expect(report.lines[0]).toContain('already configured');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  it('recognizes a differently named server in a spaced TOML table', () => {
    expect(hasCodexFauxnix('[ mcp_servers . shell ]\ncommand = "fauxnix"\n')).toBe(true);
  });

  it('does not confuse neighboring TOML tables with the MCP server table', () => {
    expect(hasCodexFauxnix('[ mcp_servers . other ]\ncommand = "other"\n[tool]\ncommand = "fauxnix"\n')).toBe(false);
  });
});
