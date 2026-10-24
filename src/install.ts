import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  claudeUserConfigPath,
  codexConfigPath,
  fauxnixServerNames,
  hasCodexFauxnix,
  hasOpenCodeFauxnix,
  isServerMap,
  openCodeConfigPath,
  serverMapHasFauxnix,
} from './doctor.js';
import {
  isLegacyFauxnixCommand,
  resolveMcpLaunchTuple,
  sameMcpLaunchTuple,
  type McpLaunchTuple,
} from './mcp-launch.js';

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

  // Every harness config carries the spawn-safe absolute launcher (#252):
  // resolve it once; a failure to locate Node or the built entry fails the
  // whole run rather than writing a config that cannot start.
  const launch = resolveMcpLaunchTuple();
  if (!launch.ok) return { lines: [launch.reason], ok: false };

  const ctx: Ctx = {
    home: opts.home ?? homedir(),
    env: opts.env ?? process.env,
  };

  const lines: string[] = [];
  let ok = true;
  for (const name of parsed.harnesses) {
    const one = installHarness(name, ctx, launch.value);
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

function installHarness(name: HarnessName, ctx: Ctx, launch: McpLaunchTuple): One {
  switch (name) {
    case 'claude':
      return patchMcpServers(claudeUserConfigPath(ctx.home, ctx.env), 'claude', launch);
    case 'codex':
      return patchCodex(codexConfigPath(ctx.home, ctx.env), launch);
    case 'opencode':
      return patchOpenCode(openCodeConfigPath(ctx.home, ctx.env), launch);
    case 'kimi':
      return patchMcpServers(kimiConfigPath(ctx.home, ctx.env), 'kimi', launch);
    case 'qwen':
      return patchQwen(qwenConfigPath(ctx.home, ctx.env), launch);
  }
}

function patchQwen(path: string, launch: McpLaunchTuple): One {
  const read = readJsonObject(path);
  if (read.state === 'invalid') {
    return { ok: false, line: `qwen: ${path} is ${read.reason} — not modified` };
  }
  const existed = read.state !== 'missing';
  const data = read.state === 'ok' ? read.data : {};
  if (data.mcpServers != null && !isServerMap(data.mcpServers)) {
    return { ok: false, line: `qwen: ${path} mcpServers is not an object — not modified` };
  }
  if (!isServerMap(data.mcpServers)) data.mcpServers = {};

  const servers = data.mcpServers as Record<string, unknown>;
  const extraNames = fauxnixServerNames(servers).filter((name) => name !== 'fauxnix');
  if (extraNames.length) {
    return {
      ok: false,
      line: `qwen: ${path} has another fauxnix MCP entry (${extraNames.join(', ')}) — remove the extra entry, then retry; not modified`,
    };
  }
  const current = servers.fauxnix;
  if (current != null && !isServerMap(current)) {
    return {
      ok: false,
      line: `qwen: ${path} mcpServers.fauxnix is not an object — not modified`,
    };
  }
  if (sameMcpLaunchTuple(current, launch)) {
    return { ok: true, line: `qwen: already configured with an absolute launcher (${path})` };
  }
  if (current != null && !isLegacyFauxnixCommand(current)) {
    // A hand-written launcher the user chose deliberately; leave it alone.
    return { ok: true, line: `qwen: already configured (${path})` };
  }

  servers.fauxnix = {
    ...(isServerMap(current) ? (current as Record<string, unknown>) : {}),
    command: launch.command,
    args: [...launch.args],
  };
  return writeJson(
    path,
    data,
    'qwen',
    existed,
    current == null ? 'added mcpServers.fauxnix' : 'upgraded mcpServers.fauxnix to the absolute launcher',
  );
}

function patchMcpServers(path: string, harness: HarnessName, launch: McpLaunchTuple): One {
  const read = readJsonObject(path);
  if (read.state === 'invalid') {
    return { ok: false, line: `${harness}: ${path} is ${read.reason} — not modified` };
  }
  const existed = read.state !== 'missing';
  const data = read.state === 'ok' ? read.data : {};
  if (data.mcpServers != null && !isServerMap(data.mcpServers)) {
    return { ok: false, line: `${harness}: ${path} mcpServers is not an object — not modified` };
  }
  if (!isServerMap(data.mcpServers)) data.mcpServers = {};
  const servers = data.mcpServers as Record<string, unknown>;
  const current = servers.fauxnix;
  if (current != null && !isServerMap(current)) {
    return { ok: false, line: `${harness}: ${path} mcpServers.fauxnix is not an object — not modified` };
  }
  if (sameMcpLaunchTuple(current, launch)) {
    return { ok: true, line: `${harness}: already configured with an absolute launcher (${path})` };
  }
  if (current != null && !isLegacyFauxnixCommand(current)) {
    return { ok: true, line: `${harness}: already configured (${path})` };
  }
  // New entry, or the pre-#252 `command: "fauxnix"` form that direct-spawn
  // MCP clients cannot execute on Windows — both get the absolute launcher.
  servers.fauxnix = {
    ...(isServerMap(current) ? (current as Record<string, unknown>) : {}),
    command: launch.command,
    args: [...launch.args],
  };
  return writeJson(
    path,
    data,
    harness,
    existed,
    current == null ? 'added mcpServers.fauxnix' : 'upgraded mcpServers.fauxnix to the spawn-safe absolute launcher (#252)',
  );
}

function patchOpenCode(path: string, launch: McpLaunchTuple): One {
  const read = readJsonObject(path);
  if (read.state === 'invalid') {
    return { ok: false, line: `opencode: ${path} is ${read.reason} — not modified` };
  }
  const existed = read.state !== 'missing';
  const data = read.state === 'ok' ? read.data : {};
  if (data.mcp != null && !isServerMap(data.mcp)) {
    return { ok: false, line: `opencode: ${path} mcp is not an object — not modified` };
  }
  if (!isServerMap(data.mcp)) data.mcp = {};
  const mcp = data.mcp as Record<string, unknown>;
  const payload = { type: 'local', command: [launch.command, ...launch.args] };
  const slot = isServerMap(mcp.servers) ? (mcp.servers as Record<string, unknown>) : mcp;
  const where = isServerMap(mcp.servers) ? 'mcp.servers.fauxnix' : 'mcp.fauxnix';
  const current = slot.fauxnix;
  if (current != null && !isLegacyFauxnixCommand(current)) {
    return { ok: true, line: `opencode: already configured (${path})` };
  }
  const change =
    current == null ? `added ${where}` : `upgraded ${where} to the spawn-safe absolute launcher (#252)`;
  slot.fauxnix = payload;
  return writeJson(path, data, 'opencode', existed, change);
}

function patchCodex(path: string, launch: McpLaunchTuple): One {
  const existed = existsSync(path);
  if (!existed) {
    const written = writeText(path, tomlTable('\n', launch));
    if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
    return { ok: true, line: `codex: created ${path}` };
  }
  const text = readText(path);
  if (text === undefined) {
    return { ok: false, line: `codex: ${path} is unreadable — not modified` };
  }
  if (hasCodexFauxnix(stripBom(text))) {
    const upgraded = upgradeCodexLegacyTable(text, launch);
    if (upgraded === undefined) {
      return { ok: true, line: `codex: already configured (${path})` };
    }
    const written = writeText(path, upgraded);
    if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
    return { ok: true, line: `codex: patched ${path} (upgraded mcp_servers.fauxnix to the spawn-safe absolute launcher (#252))` };
  }
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  if (stripBom(text).trim() === '') {
    const written = writeText(path, tomlTable(nl, launch));
    if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
    return { ok: true, line: `codex: patched ${path} (appended [mcp_servers.fauxnix])` };
  }
  let body = text;
  if (!body.endsWith('\n')) body += nl;
  if (!body.endsWith(nl + nl)) body += nl;
  const written = writeText(path, body + tomlTable(nl, launch));
  if (!written.ok) return { ok: false, line: `codex: failed to write ${path}: ${written.error}` };
  return { ok: true, line: `codex: patched ${path} (appended [mcp_servers.fauxnix])` };
}

/**
 * TOML literal strings (single quotes) keep Windows backslash paths intact
 * without escape processing.
 */
function tomlTable(nl: string, launch: McpLaunchTuple): string {
  return (
    `[mcp_servers.fauxnix]${nl}` +
    `command = '${launch.command.replace(/'/g, "''")}'${nl}` +
    `args = ['${launch.args[0]!.replace(/'/g, "''")}', 'mcp']${nl}`
  );
}

/**
 * Rewrite only the table our own installer wrote pre-#252 — the exact
 * `command = "fauxnix"` + `args = ["mcp"]` spelling inside the fauxnix
 * table. Anything else (user-edited, differently spelled) is left alone.
 */
function upgradeCodexLegacyTable(text: string, launch: McpLaunchTuple): string | undefined {
  const re = /(\[mcp_servers\.fauxnix\][^\[]*?)^[ \t]*command[ \t]*=[ \t]*"fauxnix"[ \t]*$[\s\S]*?^[ \t]*args[ \t]*=[ \t]*\["mcp"\][ \t]*$/m;
  if (!re.test(text)) return undefined;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  return text.replace(re, (_m, head: string) =>
    head +
    `command = '${launch.command.replace(/'/g, "''")}'${nl}` +
    `args = ['${launch.args[0]!.replace(/'/g, "''")}', 'mcp']`,
  );
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
