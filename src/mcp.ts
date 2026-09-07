import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { BatchExecResult, ExecResult, FauxnixSession } from './executor.js';
import { parseCommand } from './parser.js';
import {
  EXECUTE_TRANSLATION,
  PURE_TRANSLATION,
  translateCommandList,
  wrapScript,
  translatePipelineBody,
} from './translator.js';
import { registeredNames } from './registry.js';
import { packageVersion } from './version.js';
import './commands/install-all.js';

const TOOL_NAME = process.env.FAUXNIX_TOOL_NAME || 'bash';
const BATCH_TOOL_NAME = TOOL_NAME + '_batch';
// Text and structured output both appear in the JSON response. Leave room for
// worst-case JSON escaping below the official stdio client's 10 MiB limit.
const BATCH_STDOUT_LIMIT = 262_144;
const BATCH_STDERR_LIMIT = 65_536;

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

Supported: pipes (|), && / || / ;, redirections (> >> 2> 2>&1 < /dev/null), variables ($VAR $HOME $1 $# "$@" ~), set -- / shift, array assignment A=(x y z), \${name[n]} \${#name[@]} \${name//pat/str} \${name:off:len}, command substitution $(...), and ${registeredNames().length}+ coreutils-style commands (${registeredNames().slice(0, 18).join(', ')}...).
Unknown commands (git, node, npm, python, cargo...) are passed through and executed natively with argv-style quoting.
Not supported: heredocs, env -i/--ignore-environment, background jobs. if/then/elif/else/fi, for-in loops, while/until, case ... esac, and word-level \$((...)) arithmetic expansion are supported.
CWD, environment variables, export/unset, cd, and positional parameters (set -- / $1 / "$@") persist across calls within this session — a resident PowerShell 5.1 host is started when the MCP session begins (and after reset), so the first bash tool call is already warm.
Efficiency: when two or more commands or verification steps are already known, prefer ${BATCH_TOOL_NAME} once instead of making several ${TOOL_NAME} calls. Keep separate calls only when the next command requires model interpretation of the previous output. For byte-exact work, measure with wc -c or stat -c %s instead of inferring CRLF byte counts from displayed text.
Exit codes follow bash conventions (0 ok, 1 fail, 2 usage/serious, 127 command not found, 124 timeout, 130 cancelled). The tool also returns structuredContent (schemaVersion 1) with stdout/stderr/exitCode/timedOut/cancelled/truncated/sessionId.

Platform requirement: the execution backend is native Windows PowerShell 5.1+. On hosts without PowerShell on PATH (e.g. Linux containers/sandboxes), the bash tool returns exit code 127 with an actionable error instead of running the command.`;

const BATCH_TOOL_DESCRIPTION = `Compile and execute a preplanned multi-step bash workflow in one MCP round trip.

Use this instead of repeated ${TOOL_NAME} calls when the complete sequence is already known. Steps run serially and atomically in the same persistent session: later steps see cwd, environment, and files from earlier steps, while run/reset requests cannot interleave. Every command is parsed and translated before step 1 runs, and the result reports each step separately.

By default the batch stops after the first nonzero exit. Set stop_on_error=false only when later steps should still run. timeout_ms and both output limits apply to the whole batch, not once per step. Output defaults to 256 KiB stdout and 64 KiB stderr; redirect larger artifacts to files. Preflight performs no operand-file reads: use sed -e with inline script text instead of sed -f. If a later command depends on model interpretation of an earlier result, use separate ${TOOL_NAME} calls instead. For byte counts, include wc -c or stat -c %s as a verification step rather than calculating CRLF bytes mentally.`;

export interface BatchStepInput {
  id?: string;
  command: string;
}

export class BatchCompileError extends Error {
  constructor(
    readonly stepIndex: number,
    readonly stepId: string | undefined,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      'fauxnix: batch compile failed at step ' +
        String(stepIndex + 1) +
        (stepId ? ' (' + stepId + ')' : '') +
        ': ' +
        detail,
    );
    this.name = 'BatchCompileError';
  }
}

export function compileBatchSteps(steps: BatchStepInput[]) {
  return steps.map((step, index) => {
    try {
      return translateCommandList(parseCommand(step.command), PURE_TRANSLATION);
    } catch (e) {
      throw new BatchCompileError(index, step.id, e);
    }
  });
}

function batchStepStatus(
  r: ExecResult,
): 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'infrastructure_error' {
  if (r.spawnError || r.infrastructureError) return 'infrastructure_error';
  if (r.cancelled) return 'cancelled';
  if (r.timedOut) return 'timed_out';
  return r.exitCode === 0 ? 'completed' : 'failed';
}

export function batchToolResult(
  inputs: BatchStepInput[],
  batch: BatchExecResult,
  sessionId: string,
) {
  const steps = inputs.map((input, index) => {
    const result = batch.results[index];
    if (!result) return { index, ...(input.id ? { id: input.id } : {}), status: 'skipped' as const };
    return {
      index,
      ...(input.id ? { id: input.id } : {}),
      status: batchStepStatus(result),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      truncated: result.truncated,
    };
  });
  const text = steps
    .map((step, index) => {
      const label = '[' + String(index + 1) + '/' + String(steps.length) + (step.id ? ' ' + step.id : '') + ']';
      if (step.status === 'skipped') return label + ' skipped';
      const result = batch.results[index];
      return label + ' ' + step.status + ' (exit ' + String(result.exitCode) + ')\n' + formatBashText(result);
    })
    .join('\n');
  const structuredContent = {
    schemaVersion: 1 as const,
    sessionId,
    preflightOk: true,
    stopReason: batch.stopReason,
    stepsRequested: inputs.length,
    stepsCompleted: batch.results.length,
    timedOut: batch.stopReason === 'timed_out',
    cancelled: batch.stopReason === 'cancelled',
    truncated: batch.results.some((result) => result.truncated),
    steps,
  };
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
    ...(batch.stopReason === 'infrastructure' ? { isError: true as const } : {}),
  };
}

export function batchCompileErrorResult(
  inputs: BatchStepInput[],
  error: BatchCompileError,
  sessionId: string,
) {
  return {
    content: [{ type: 'text' as const, text: error.message }],
    structuredContent: {
      schemaVersion: 1 as const,
      sessionId,
      preflightOk: false,
      stopReason: 'compile_error' as const,
      stepsRequested: inputs.length,
      stepsCompleted: 0,
      failedStep: error.stepIndex,
      steps: inputs.map((input, index) => ({
        index,
        ...(input.id ? { id: input.id } : {}),
        status: index === error.stepIndex ? ('compile_error' as const) : ('skipped' as const),
      })),
    },
    isError: true as const,
  };
}

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

export function translateToolResult(command: string) {
  try {
    const list = parseCommand(command);
    const plans = translateCommandList(list, PURE_TRANSLATION);
    const script = wrapScript(plans.map((p) => p.script).join('\n# ---- next segment ----\n'));
    return { content: [{ type: 'text' as const, text: script }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: msg }], isError: true as const };
  }
}

/** Packed FAUXNIX_POS uses char-30 separators (same as array sidecar). */
const POS_SEP = '\x1e';

export function positionalCountFromEnv(env: Record<string, string>): number {
  let packed: string | undefined;
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === 'FAUXNIX_POS') {
      packed = v;
      break;
    }
  }
  if (packed == null || packed === '') return 0;
  return packed.split(POS_SEP).length;
}

export function formatSessionStatus(session: {
  cwd: string | null;
  env: Record<string, string>;
  id: string;
}): string {
  const envKeys = Object.keys(session.env).sort();
  return (
    'cwd: ' +
    (session.cwd ?? '(inherit from server start)') +
    '\nenv keys: ' +
    (envKeys.length ? envKeys.join(', ') : '(none tracked)') +
    '\npositionals: ' +
    positionalCountFromEnv(session.env) +
    '\nsession: ' +
    session.id +
    '\ncommands registered: ' +
    registeredNames().length
  );
}

export async function startMcpServer(): Promise<void> {
  process.env.FAUXNIX_ARG0 = TOOL_NAME;
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
        const plans = translateCommandList(parseCommand(command), EXECUTE_TRANSLATION);
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
    BATCH_TOOL_NAME,
    BATCH_TOOL_DESCRIPTION,
    {
      steps: z
        .array(
          z.object({
            id: z.string().min(1).max(64).optional().describe('Optional short step label'),
            command: z.string().min(1).max(16384).describe('Bash-style command for this step'),
          }),
        )
        .min(1)
        .max(32)
        .describe('Ordered workflow steps; all are compiled before execution begins'),
      stop_on_error: z
        .boolean()
        .optional()
        .default(true)
        .describe('Stop after the first nonzero exit (default true)'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(600_000)
        .optional()
        .describe('Total timeout for the complete batch (default 120000)'),
      stdout_limit_bytes: z
        .number()
        .int()
        .min(0)
        .max(BATCH_STDOUT_LIMIT)
        .optional()
        .describe('Total stdout budget shared by every step (default 262144)'),
      stderr_limit_bytes: z
        .number()
        .int()
        .min(0)
        .max(BATCH_STDERR_LIMIT)
        .optional()
        .describe('Total stderr budget shared by every step (default 65536)'),
    },
    EXEC_ANNOTATIONS,
    async (
      { steps, stop_on_error, timeout_ms, stdout_limit_bytes, stderr_limit_bytes },
      extra,
    ) => {
      try {
        const compiled = compileBatchSteps(steps);
        const result = await session.runBatch(compiled, {
          stopOnError: stop_on_error,
          timeoutMs: timeout_ms,
          stdoutLimit: stdout_limit_bytes ?? BATCH_STDOUT_LIMIT,
          stderrLimit: stderr_limit_bytes ?? BATCH_STDERR_LIMIT,
          signal: extra.signal,
        });
        return batchToolResult(steps, result, session.id);
      } catch (e) {
        if (e instanceof BatchCompileError) {
          return batchCompileErrorResult(steps, e, session.id);
        }
        const message = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: 'text' as const, text: message }],
          structuredContent: {
            schemaVersion: 1 as const,
            sessionId: session.id,
            preflightOk: true,
            stopReason: 'infrastructure' as const,
            stepsRequested: steps.length,
            stepsCompleted: 0,
            timedOut: false,
            cancelled: false,
            truncated: false,
            steps: steps.map((step, index) => ({
              index,
              ...(step.id ? { id: step.id } : {}),
              status: 'skipped' as const,
            })),
          },
          isError: true as const,
        };
      }
    },
  );

  server.tool(
    'fauxnix_translate',
    'Translate a bash-style command into the equivalent PowerShell script WITHOUT executing it. Useful for learning/debugging what fauxnix does under the hood.',
    { command: z.string().describe('The bash-style command line to translate (never executed)') },
    TRANSLATE_ANNOTATIONS,
    async ({ command }) => translateToolResult(command),
  );

  server.tool(
    'fauxnix_session',
    'Inspect or reset the persistent fauxnix shell session (current directory, environment, positional count, session id). Actions: "status" (default) or "reset".',
    {
      action: z
        .enum(['status', 'reset'])
        .default('status')
        .describe('"status" shows the session state (cwd, tracked env keys, positional count); "reset" clears it back to a fresh shell'),
    },
    SESSION_ANNOTATIONS,
    async ({ action }) => {
      if (action === 'reset') {
        await session.reset();
        return { content: [{ type: 'text', text: 'fauxnix: session reset' }] };
      }
      return { content: [{ type: 'text', text: formatSessionStatus(session) }] };
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
