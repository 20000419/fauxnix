import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { FauxnixSession } from './executor.js';
import { parseCommand } from './parser.js';
import { translateCommandList, wrapScript, translatePipelineBody } from './translator.js';
import { registeredNames } from './registry.js';
import './commands/install-all.js';

// single source of truth: the npm package version in package.json
// (src/ and dist/ sit one level below the root, so the relative path holds in both)
const pkgVersion: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
).version;

const TOOL_NAME = process.env.FAUXNIX_TOOL_NAME || 'bash';

const EXEC_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const TRANSLATE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const SESSION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const TOOL_DESCRIPTION = `Execute a Linux/bash-style command on this Windows machine.

Commands are deterministically translated to PowerShell and executed natively — no WSL or VM.
Output is formatted to look like GNU/Linux tooling (ls -l, ps aux, df -h ...), errors look like bash errors, and text encoding (UTF-8/GBK) is handled automatically.

Supported: pipes (|), && / || / ;, redirections (> >> 2> 2>&1 < /dev/null), variables ($VAR $HOME ~), command substitution $(...), and ${registeredNames().length}+ coreutils-style commands (${registeredNames().slice(0, 18).join(', ')}...).
Unknown commands (git, node, npm, python, cargo...) are passed through and executed natively with argv-style quoting.
Not supported: heredocs, while/until/case, background jobs. if/then/else/fi and for-in loops are supported.

CWD, environment variables, export/unset and cd persist across calls within this session — but prefer COMBINING related commands in one call with ; or && (e.g. 'cd src && ls | wc -l'); each call is a fresh translation+process, so batching is faster than many tiny calls.
Exit codes follow bash conventions (0 ok, 1 fail, 2 usage/serious, 127 command not found, 124 timeout).

Platform requirement: the execution backend is native Windows PowerShell 5.1+. On hosts without PowerShell on PATH (e.g. Linux containers/sandboxes), the bash tool returns exit code 127 with an actionable error instead of running the command.`;

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'fauxnix', version: pkgVersion },
    { capabilities: { tools: {} } },
  );
  const session = new FauxnixSession();

  server.tool(
    TOOL_NAME,
    TOOL_DESCRIPTION,
    {
      command: z.string().describe('The bash-style command line to run'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(600_000)
        .optional()
        .describe('Timeout in milliseconds (default 120000)'),
    },
    EXEC_ANNOTATIONS,
    async ({ command, timeout_ms }) => {
      try {
        const plans = translateCommandList(parseCommand(command));
        const result = await session.run(plans, { timeoutMs: timeout_ms });
        const parts: string[] = [];
        if (result.stdout.trim()) parts.push(result.stdout.replace(/\n$/, ''));
        if (result.stderr.trim()) parts.push(result.stderr.replace(/\n$/, ''));
        if (result.exitCode !== 0) parts.push('Exit code: ' + result.exitCode);
        const text = parts.length ? parts.join('\n') : '(no output)';
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
    },
  );

  server.tool(
    'fauxnix_translate',
    'Translate a bash-style command into the equivalent PowerShell script WITHOUT executing it. Useful for learning/debugging what fauxnix does under the hood.',
    { command: z.string().describe('The bash-style command line to translate (never executed)') },
    TRANSLATE_ANNOTATIONS,
    async ({ command }) => {
      try {
        const list = parseCommand(command);
        const plans = translateCommandList(list);
        const script = wrapScript(plans.map((p) => p.script).join('\n# ---- next segment ----\n'));
        return { content: [{ type: 'text', text: script }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
    },
  );

  server.tool(
    'fauxnix_session',
    'Inspect or reset the persistent fauxnix shell session (current directory, environment, session id). Actions: "status" (default) or "reset".',
    {
      action: z
        .enum(['status', 'reset'])
        .default('status')
        .describe('"status" shows the session state (cwd, tracked env keys); "reset" clears it back to a fresh shell'),
    },
    SESSION_ANNOTATIONS,
    async ({ action }) => {
      if (action === 'reset') {
        await session.dispose();
        return { content: [{ type: 'text', text: 'fauxnix: session reset' }] };
      }
      const envKeys = Object.keys(session.env).sort();
      const text =
        'cwd: ' + (session.cwd ?? '(inherit from server start)') +
        '\nenv keys: ' + (envKeys.length ? envKeys.join(', ') : '(none tracked)') +
        '\ncommands registered: ' + registeredNames().length;
      return { content: [{ type: 'text', text }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// keep referenced for tree-shaking clarity
export { translatePipelineBody };
