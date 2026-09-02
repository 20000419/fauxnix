import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  claudeUserConfigPath,
  codexConfigPath,
  hasCodexFauxnix,
  hasOpenCodeFauxnix,
  isServerMap,
  openCodeConfigPath,
  serverMapHasFauxnix,
} from './doctor.js';

export type InstallOptions = {
  home?: string;
  /** Accepted for parity with collectDoctorReport; install writes user-level configs only. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type InstallReport = {
  lines: string[];
  ok: boolean;
};

export const INSTALL_FLAGS = ['claude', 'codex', 'opencode', 'kimi', 'qwen'] as const;
export type HarnessName = (typeof INSTALL_FLAGS)[number];

const STDIO = { command: 'fauxnix', args: ['mcp'] };
const OPENCODE_STDIO = { type: 'local', command: ['fauxnix', 'mcp'] };

type Ctx = { home: string; env: NodeJS.ProcessEnv };
type One = { ok: boolean; line: string };

type JsonRead =
  | { state: 'missing' }
  | { state: 'empty' }
  | { state: 'invalid'; reason: string }
  | { state: 'ok'; data: Record<string, unknown> };

export function kimiConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const root = env.KIMI_CODE_HOME?.trim() || join(home, '.kimi-code');
  return join(root, 'mcp.json');
}

export function qwenConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  return join(home, '.qwen', 'settings.json');
}

export function runInstall(argv: string[], opts: InstallOptions = {}): InstallReport {
  const parsed = parseHarnessFlags(argv);
  if (parsed.help) return { lines: installUsageLines(), ok: true };
  if (parsed.error) return { lines: [parsed.error, ...installUsageLines()], ok: false };

  const ctx: Ctx = {
    home: opts.home ?? homedir(),
    env: opts.env ?? process.env,
  };

  const lines: string[] = [];
  let ok = true;
  for (const name of parsed.harnesses) {
    const one = installHarness(name, ctx);
    lines.push(one.line);
    if (!one.ok) ok = false;
  }
  return { lines, ok };
}

function parseHarnessFlags(argv: string[]): {
  help?: boolean;
  error?: string;
  harnesses: HarnessName[];
} {
  if (argv.some((a) => a === '--help' || a === '-h')) return { help: true, harnesses: [] };
  if (argv.length === 0) {
    return { error: 'select a harness: --claude --codex --opencode --kimi --qwen', harnesses: [] };
  }
  const harnesses: HarnessName[] = [];
  const seen = new Set<HarnessName>();
  for (const a of argv) {
    if (!a.startsWith('--') || a === '--') {
      return { error: `unknown argument: ${a}`, harnesses: [] };
    }
    const name = a.slice(2);
    if (!isHarness(name)) return { error: `unknown harness: ${a}`, harnesses: [] };
    if (!seen.has(name)) {
      seen.add(name);
      harnesses.push(name);
    }
  }
  return { harnesses };
}

function isHarness(s: string): s is HarnessName {
  return (INSTALL_FLAGS as readonly string[]).includes(s);
}

function installUsageLines(): string[] {
  return ['Usage:', '  fauxnix install --claude|--codex|--opencode|--kimi|--qwen'];
}

function installHarness(name: HarnessName, ctx: Ctx): One {
  switch (name) {
    case 'claude':
      return patchMcpServers(claudeUserConfigPath(ctx.home, ctx.env), 'claude');
    case 'codex':
      return patchCodex(codexConfigPath(ctx.home, ctx.env));
    case 'opencode':
      return patchOpenCode(openCodeConfigPath(ctx.home, ctx.env));
    case 'kimi':
      return patchMcpServers(kimiConfigPath(ctx.home, ctx.env), 'kimi');
    case 'qwen':
      return patchMcpServers(qwenConfigPath(ctx.home, ctx.env), 'qwen');
  }
}

function patchMcpServers(path: string, harness: HarnessName): One {
  const read = readJsonObject(path);
  if (read.state === 'invalid') {
    return { ok: false, line: `${harness}: ${path} is ${read.reason} — not modified` };
  }
  const existed = read.state !== 'missing';
  const data = read.state === 'ok' ? read.data : {};
  if (serverMapHasFauxnix(data.mcpServers)) {
    return { ok: true, line: `${harness}: already configured (${path})` };
  }
  if (data.mcpServers != null && !isServerMap(data.mcpServers)) {
    return { ok: false, line: `${harness}: ${path} mcpServers is not an object — not modified` };
  }
  if (!isServerMap(data.mcpServers)) data.mcpServers = {};
  (data.mcpServers as Record<string, unknown>).fauxnix = {
    command: STDIO.command,
    args: [...STDIO.args],
  };
  return writeJson(path, data, harness, existed, 'added mcpServers.fauxnix');
}

function patchOpenCode(path: string): One {
  const read = readJsonObject(path);
  if (read.state === 'invalid') {
    return { ok: false, line: `opencode: ${path} is ${read.reason} — not modified` };
  }
  const existed = read.state !== 'missing';
  const data = read.state === 'ok' ? read.data : {};
  if (hasOpenCodeFauxnix(data)) {
    return { ok: true, line: `opencode: already configured (${path})` };
  }
  if (data.mcp != null && !isServerMap(data.mcp)) {
    return { ok: false, line: `opencode: ${path} mcp is not an object — not modified` };
  }
  if (!isServerMap(data.mcp)) data.mcp = {};
  const mcp = data.mcp as Record<string, unknown>;
  const payload = { type: OPENCODE_STDIO.type, command: [...OPENCODE_STDIO.command] };
  if (isServerMap(mcp.servers)) {
    (mcp.servers as Record<string, unknown>).fauxnix = payload;
    return writeJson(path, data, 'opencode', existed, 'added mcp.servers.fauxnix');
  }
  mcp.fauxnix = payload;
  return writeJson(path, data, 'opencode', existed, 'added mcp.fauxnix');
}

function patchCodex(path: string): One {
  const existed = existsSync(path);
  if (!existed) {
    const written = writeText(path, tomlTable('\n'));
    if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
    return { ok: true, line: `codex: created ${path}` };
  }
  const text = readText(path);
  if (text === undefined) {
    return { ok: false, line: `codex: ${path} is unreadable — not modified` };
  }
  if (hasCodexFauxnix(stripBom(text))) {
    return { ok: true, line: `codex: already configured (${path})` };
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  if (stripBom(text).trim() === '') {
    const written = writeText(path, tomlTable(nl));
    if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
    return { ok: true, line: `codex: patched ${path} (appended [mcp_servers.fauxnix])` };
  }
  let body = text;
  if (!body.endsWith('\n')) body += nl;
  if (!body.endsWith(nl + nl)) body += nl;
  const written = writeText(path, body + tomlTable(nl));
  if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
  return { ok: true, line: `codex: patched ${path} (appended [mcp_servers.fauxnix])` };
}

function tomlTable(nl: string): string {
  return `[mcp_servers.fauxnix]${nl}command = "fauxnix"${nl}args = ["mcp"]${nl}`;
}

function writeJson(
  path: string,
  data: Record<string, unknown>,
  harness: HarnessName,
  existed: boolean,
  change: string,
): One {
  const written = writeText(path, JSON.stringify(data, null, 2) + '\n');
  if (!written.ok) {
    return { ok: false, line: `${harness}: failed to write ${path}: ${written.error}` };
  }
  if (existed) return { ok: true, line: `${harness}: patched ${path} (${change})` };
  return { ok: true, line: `${harness}: created ${path}` };
}

function writeText(path: string, contents: string): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function readJsonObject(path: string): JsonRead {
  if (!existsSync(path)) return { state: 'missing' };
  const text = readText(path);
  if (text === undefined) return { state: 'invalid', reason: 'unreadable' };
  const stripped = stripBom(text).trim();
  if (stripped === '') return { state: 'empty' };
  try {
    const data = JSON.parse(stripped);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { state: 'invalid', reason: 'not a JSON object' };
    }
    return { state: 'ok', data: data as Record<string, unknown> };
  } catch {
    return { state: 'invalid', reason: 'not valid JSON' };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
