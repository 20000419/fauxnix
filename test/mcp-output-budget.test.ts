import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(), run: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class {
    tool(name: string, ...args: any[]) { harness.handlers.set(name, args.at(-1)); }
    async connect() {}
    async close() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));
vi.mock('../src/executor.js', () => ({
  FauxnixSession: class {
    id = 'budget-test'; cwd = null; env = {};
    async prewarm() {}
    async dispose() {}
    run = harness.run;
  },
}));
import { startMcpServer } from '../src/mcp.js';

const tracked: Array<[EventEmitter, string]> = [
  [process.stdin, 'end'], [process.stdin, 'close'],
  [process, 'SIGINT'], [process, 'SIGTERM'],
];
const originalListeners = tracked.map(([target, event]) => target.listeners(event));
const originalArg0 = process.env.FAUXNIX_ARG0;
afterEach(() => {
  tracked.forEach(([target, event], index) => {
    for (const listener of target.listeners(event)) {
      if (!originalListeners[index].includes(listener)) target.removeListener(event, listener as never);
    }
  });
  if (originalArg0 === undefined) delete process.env.FAUXNIX_ARG0;
  else process.env.FAUXNIX_ARG0 = originalArg0;
  harness.run.mockReset();
  harness.handlers.clear();
});

const successful = { stdout: '', stderr: '', exitCode: 0, timedOut: false, cancelled: false, truncated: false };

describe('MCP single-command transport contract', () => {
  it.each(['x', '\u0000', '\\'])('bounds duplicated JSON output for %j', async (character) => {
    harness.run.mockImplementation(async (_plans, opts) => {
      expect(opts.stdoutLimit).toBeGreaterThan(0);
      expect(opts.stderrLimit).toBeGreaterThan(0);
      return {
        ...successful,
        stdout: character.repeat(opts.stdoutLimit),
        stderr: character.repeat(opts.stderrLimit),
        truncated: true,
      };
    });
    await startMcpServer();
    const handler = harness.handlers.get(process.env.FAUXNIX_TOOL_NAME || 'bash')!;
    const result = await handler({ command: 'echo fixture', timeout_ms: 1000 }, {});
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))).toBeLessThan(10 * 1024 * 1024);
  });

  it('reports a host infrastructure failure as an MCP error', async () => {
    harness.run.mockResolvedValue({ ...successful, exitCode: 1, stderr: 'host stopped', infrastructureError: true });
    await startMcpServer();
    const handler = harness.handlers.get(process.env.FAUXNIX_TOOL_NAME || 'bash')!;
    const result = await handler({ command: 'echo fixture' }, {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent.exitCode).toBe(1);
  });
});
