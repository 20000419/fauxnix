import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { ExecResult, FauxnixSession } from './executor.js';
import { parseCommand } from './parser.js';
import { translateCommandList, wrapScript, translatePipelineBody } from './translator.js';
import { registeredNames } from './registry.js';
import { packageVersion } from './version.js';
import './commands/install-all.js';

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

Supported: pipes (|), && / || / ;, redirections (> >> 2> 2>&1 < /dev/null), variables ($VAR $HOME ~), array assignment A=(x y z), \${name[n]} \${#name[@]} \${name//pat/str} \${name:off:len}, command substitution $(...), and ${registeredNames().length}+ coreutils-style commands (${registeredNames().slice(0, 18).join(', ')}...).
Unknown commands (git, node, npm, python, cargo...) are passed through and executed natively with argv-style quoting.
Not supported: heredocs, while/until/case, env -i/--ignore-environment, background jobs. if/then/elif/else/fi, for-in loops, and word-level \$((...)) arithmetic expansion are supported.

CWD, environment variables, export/unset and cd persist across calls within this session — a resident PowerShell 5.1 host is started when the MCP session begins (and after reset), so the first bash tool call is already warm.
Exit codes follow bash conventions (0 ok, 1 fail, 2 usage/serious, 127 command not found, 124 timeout, 130 cancelled). The tool also returns structuredContent (schemaVersion 1) with stdout/stderr/exitCode/timedOut/cancelled/truncated/sessionId.

Platform requirement: the execution backend is native Windows PowerShell 5.1+. On hosts without PowerShell on PATH (e.g. Linux containers/sandboxes), the bash tool returns exit code 127 with an actionable error instead of running the command.`;

export function formatBashText(
  r: Pick<ExecResult, 'stdout' | 'stderr' | 'exitCode' | 'timedOut' | 'cancelled'>,
): string {
  const parts: string[] = [];
  if (r.stdout.length) parts.push(r.stdout.replace(/\n$/, ''));
  if (r.stderr.length) parts.push(r.stderr.replace(/\n$/, ''));
  if (r.cancelled) parts.push('Cancelled');
  else if (r.timedOut) parts.push('Exit code: 124');
  else if (r.exitCode !== 0) parts.push('Exit code: ' + r.exitCode);
  return parts.length ? parts.join('\n') : '(no output)';
}

export function bashToolResult(r: ExecResult, sessionId: string, infra: boolean) {
  const structuredContent = {
    schemaVersion: 1 as const,
    stdout: r.stdout,
    stderr: r.stderr,
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    cancelled: r.cancelled,
    truncated: r.truncated,
    sessionId,
  };
  return {
    content: [{ type: 'text' as const, text: formatBashText(r) }],
    structuredContent,
    ...(infra ? { isError: true as const } : {}),
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    { name: 'fauxnix', version: packageVersion },
    { capabilities: { tools: {} } },
  );
  const session = new FauxnixSession();
  await session.prewarm();

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
    async ({ command, timeout_ms }, extra) => {
      try {
        const plans = translateCommandList(parseCommand(command));
        const result = await session.run(plans, {
          timeoutMs: timeout_ms,
          signal: extra.signal,
        });
        const infra = result.spawnError === 'ENOENT' || result.spawnError === 'START';
        return bashToolResult(result, session.id, infra);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return bashToolResult(
          {
            stdout: '',
            stderr: msg,
            exitCode: 2,
            timedOut: false,
            cancelled: false,
            truncated: false,
          },
          session.id,
          true,
        );
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
        await session.reset();
        return { content: [{ type: 'text', text: 'fauxnix: session reset' }] };
      }
      const envKeys = Object.keys(session.env).sort();
      const text =
        'cwd: ' + (session.cwd ?? '(inherit from server start)') +
        '\nenv keys: ' + (envKeys.length ? envKeys.join(', ') : '(none tracked)') +
        '\nsession: ' + session.id +
        '\ncommands registered: ' + registeredNames().length;
      return { content: [{ type: 'text', text }] };
    },
  );

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await session.dispose();
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  };
  process.stdin.on('end', () => {
    void shutdown();
  });
  process.stdin.on('close', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  transport.onclose = () => {
    void shutdown();
  };
  await server.connect(transport);
}

// keep referenced for tree-shaking clarity
export { translatePipelineBody };
