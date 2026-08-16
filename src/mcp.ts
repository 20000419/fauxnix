import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FauxnixSession } from './executor.js';
import { parseCommand } from './parser.js';
import { translateCommandList, wrapScript, translatePipelineBody } from './translator.js';
import { registeredNames } from './registry.js';
import './commands/install-all.js';

const TOOL_NAME = process.env.FAUXNIX_TOOL_NAME || 'bash';

const TOOL_DESCRIPTION = `Execute a Linux/bash-style command on this Windows machine.

Commands are deterministically translated to PowerShell and executed natively — no WSL or VM.
Output is formatted to look like GNU/Linux tooling (ls -l, ps aux, df -h ...), errors look like bash errors, and text encoding (UTF-8/GBK) is handled automatically.

Supported: pipes (|), && / || / ;, redirections (> >> 2> 2>&1 < /dev/null), variables ($VAR $HOME ~), command substitution $(...), and ${registeredNames().length}+ coreutils-style commands (${registeredNames().slice(0, 18).join(', ')}...).
Unknown commands (git, node, npm, python, cargo...) are passed through and executed natively with argv-style quoting.
Not supported: heredocs, backticks, control flow (if/for/while), background jobs.

CWD, environment variables, export/unset and cd persist across calls within this session.
Exit codes follow bash conventions (0 ok, 1 fail, 2 usage/serious, 127 command not found, 124 timeout).`;

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'fauxnix', version: '0.1.0' },
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
    { command: z.string() },
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
    { action: z.enum(['status', 'reset']).default('status') },
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
