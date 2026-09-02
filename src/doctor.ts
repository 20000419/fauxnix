import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DoctorOptions = {
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** Injected MCP-module loader. Default: dynamic import of ./mcp.js (does not start the server). */
  loadMcp?: () => Promise<unknown>;
};

export type DoctorReport = {
  lines: string[];
  ok: boolean;
};

const VALUE_INDENT = '             ';

export async function collectDoctorReport(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const nodeVersion = opts.nodeVersion ?? process.version;

  const lines: string[] = [''];
  lines.push(...encodingLines(env));
  lines.push('');
  lines.push(field('claude', detectClaude(home, cwd, env)));
  lines.push(field('codex', detectCodex(home, env)));
  lines.push(field('opencode', detectOpenCode(home, env)));
  lines.push('');

  const mcp = await mcpLines(nodeVersion, opts.loadMcp);
  lines.push(...mcp.lines);
  return { lines, ok: mcp.ok };
}

function field(label: string, value: string): string {
  return `${label.padEnd(10)} : ${value}`;
}

function encodingLines(env: NodeJS.ProcessEnv): string[] {
  const raw = env.FAUXNIX_NATIVE_ENCODING;
  const current =
    raw === undefined || raw === ''
      ? 'unset → utf8 (default)'
      : raw === 'ansi'
        ? 'ansi → GBK-native admin tools'
        : `${raw} → utf8 (only ansi selects GBK)`;
  return [
    field('encoding', 'UTF-8 default for native-tool pipelines'),
    VALUE_INDENT + `current FAUXNIX_NATIVE_ENCODING=${current}`,
    VALUE_INDENT + 'set FAUXNIX_NATIVE_ENCODING=ansi for GBK-native admin tools (ipconfig, tasklist)',
  ];
}

function detectClaude(home: string, cwd: string, env: NodeJS.ProcessEnv): string {
  const userPath = claudeUserConfigPath(home, env);
  const projectPath = join(cwd, '.mcp.json');
  const userExists = existsSync(userPath);
  const projectExists = existsSync(projectPath);

  let user: ReturnType<typeof inspectClaudeJson> | undefined;
  let project: ReturnType<typeof inspectClaudeJson> | undefined;
  if (userExists) user = inspectClaudeJson(userPath);
  if (projectExists) {
    const inspected = inspectClaudeJson(projectPath);
    // Project-scope Claude MCP is always a top-level mcpServers object.
    if (!inspected.parseError && inspected.hasTopLevelMcpServers) project = inspected;
  }

  if (!userExists && !project) return 'not detected — see README';

  if (user?.hasFauxnix) return `fauxnix MCP configured (${userPath})`;
  if (project?.hasFauxnix) return `fauxnix MCP configured (${projectPath})`;

  if (userExists && user?.parseError) {
    return `found ${userPath} (unreadable JSON) — see README`;
  }
  if (userExists) {
    return `found ${userPath}, fauxnix MCP not listed — run: claude mcp add fauxnix -- fauxnix mcp`;
  }
  return `found ${projectPath}, fauxnix MCP not listed — see README`;
}

function claudeUserConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  if (dir) return join(dir, '.claude.json');
  return join(home, '.claude.json');
}

function inspectClaudeJson(path: string): {
  parseError: boolean;
  hasTopLevelMcpServers: boolean;
  hasFauxnix: boolean;
} {
  const text = readText(path);
  if (text === undefined) {
    return { parseError: true, hasTopLevelMcpServers: false, hasFauxnix: false };
  }
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return { parseError: true, hasTopLevelMcpServers: false, hasFauxnix: false };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { parseError: true, hasTopLevelMcpServers: false, hasFauxnix: false };
  }
  const rec = data as Record<string, unknown>;
  const hasTopLevelMcpServers = isServerMap(rec.mcpServers);
  let hasFauxnix = hasTopLevelMcpServers && serverMapHasFauxnix(rec.mcpServers);
  const projects = rec.projects;
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const proj of Object.values(projects as Record<string, unknown>)) {
      if (!proj || typeof proj !== 'object' || Array.isArray(proj)) continue;
      const servers = (proj as Record<string, unknown>).mcpServers;
      if (isServerMap(servers) && serverMapHasFauxnix(servers)) hasFauxnix = true;
    }
  }
  return { parseError: false, hasTopLevelMcpServers, hasFauxnix };
}

function detectCodex(home: string, env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || join(home, '.codex');
  const path = join(codexHome, 'config.toml');
  if (!existsSync(path)) return 'not detected — see README';
  const text = readText(path);
  if (text === undefined) return `found ${path} (unreadable) — see README`;
  if (hasCodexFauxnix(stripBom(text))) return `fauxnix MCP configured (${path})`;
  return `found ${path}, fauxnix MCP not listed — run: codex mcp add fauxnix -- fauxnix mcp`;
}

function hasCodexFauxnix(text: string): boolean {
  if (/^\s*\[mcp_servers\.(?:fauxnix|"fauxnix"|'fauxnix')\]/im.test(text)) return true;
  const tables = text.split(/^\s*\[/m);
  for (const table of tables) {
    if (!/^mcp_servers\./i.test(table)) continue;
    const header = (table.split(/[\]\r\n]/, 1)[0] ?? '').trim();
    if (/^mcp_servers\.(?:fauxnix|"fauxnix"|'fauxnix')$/i.test(header)) return true;
    const cmd = /^\s*command\s*=\s*(?:"([^"]*)"|'([^']*)')/im.exec(table);
    const command = cmd?.[1] ?? cmd?.[2];
    if (command && isFauxnixExecutable(command)) return true;
    const args = /^\s*args\s*=\s*\[([^\]]*)\]/im.exec(table);
    if (args) {
      const items = [...args[1].matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');
      if (items.some(isFauxnixExecutable)) return true;
    }
  }
  return false;
}

function detectOpenCode(home: string, env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
  const path = join(xdg, 'opencode', 'opencode.json');
  if (!existsSync(path)) return 'not detected — see README';
  const text = readText(path);
  if (text === undefined) return `found ${path} (unreadable) — see README`;
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return `found ${path} (unreadable JSON) — see README`;
  }
  if (hasOpenCodeFauxnix(data)) return `fauxnix MCP configured (${path})`;
  return `found ${path}, fauxnix MCP not listed — add mcp.fauxnix (see README)`;
}

function hasOpenCodeFauxnix(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const mcp = (data as Record<string, unknown>).mcp;
  if (!isServerMap(mcp)) return false;
  if (serverMapHasFauxnix(mcp)) return true;
  const nested = (mcp as Record<string, unknown>).servers;
  return isServerMap(nested) && serverMapHasFauxnix(nested);
}

function isServerMap(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function serverMapHasFauxnix(value: unknown): boolean {
  if (!isServerMap(value)) return false;
  for (const [name, cfg] of Object.entries(value as Record<string, unknown>)) {
    if (name === 'servers') continue;
    if (looksLikeFauxnixServer(name, cfg)) return true;
  }
  return false;
}

function looksLikeFauxnixServer(name: string, cfg: unknown): boolean {
  if (/^fauxnix(-cli)?$/i.test(name)) return true;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  const rec = cfg as Record<string, unknown>;
  const chunks: string[] = [];
  if (typeof rec.command === 'string') chunks.push(rec.command);
  if (Array.isArray(rec.command)) {
    for (const part of rec.command) if (typeof part === 'string') chunks.push(part);
  }
  if (Array.isArray(rec.args)) {
    for (const part of rec.args) if (typeof part === 'string') chunks.push(part);
  }
  return chunks.some(isFauxnixExecutable);
}

function isFauxnixExecutable(s: string): boolean {
  const base = s.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  return /^fauxnix(-cli)?(\.cmd|\.exe)?$/i.test(base);
}

async function mcpLines(
  nodeVersion: string,
  loadMcp?: () => Promise<unknown>,
): Promise<{ lines: string[]; ok: boolean }> {
  const major = nodeMajor(nodeVersion);
  const nodeOk = major >= 18;
  let moduleOk = false;
  let moduleDetail = '';
  try {
    const mod = await (loadMcp ?? defaultLoadMcp)();
    moduleOk =
      !!mod && typeof (mod as { startMcpServer?: unknown }).startMcpServer === 'function';
    if (!moduleOk) moduleDetail = 'startMcpServer export missing';
  } catch (e) {
    moduleDetail = e instanceof Error ? e.message : String(e);
  }

  const lines = [
    field('node', `${nodeVersion.startsWith('v') ? nodeVersion : 'v' + nodeVersion}${nodeOk ? ' (>=18 required)' : '  FAILED (requires >=18)'}`),
    field('mcp', moduleOk ? 'module loads' : `FAILED to load${moduleDetail ? ': ' + moduleDetail : ''}`),
    VALUE_INDENT + 'start with: fauxnix mcp',
  ];
  return { lines, ok: nodeOk && moduleOk };
}

async function defaultLoadMcp(): Promise<unknown> {
  return import('./mcp.js');
}

function nodeMajor(version: string): number {
  const m = /^v?(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
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
