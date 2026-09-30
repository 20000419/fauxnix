import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ prewarm: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/executor.js', () => ({
  FauxnixSession: class {
    id = 'startup-test';
    cwd = null;
    env = {};
    prewarm = session.prewarm;
    dispose = session.dispose;
  },
}));

let input: PassThrough;
let signalListeners: Array<Array<(...args: any[]) => void>>;
const signals = ['SIGINT', 'SIGTERM'] as const;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('FAUXNIX_TOOL_NAME', 'startup_test_shell');
  vi.stubEnv('FAUXNIX_ARG0', 'parent-name');
  session.prewarm.mockReset().mockResolvedValue(undefined);
  session.dispose.mockReset().mockResolvedValue(undefined);
  input = new PassThrough();
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
  signalListeners = signals.map((signal) => process.listeners(signal));
});

afterEach(() => {
  signals.forEach((signal, index) => {
    for (const listener of process.listeners(signal)) {
      if (!signalListeners[index].includes(listener)) process.removeListener(signal, listener);
    }
  });
  input.removeAllListeners();
  input.destroy();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function expectListenersRemoved() {
  for (const event of ['end', 'close', 'data', 'error']) {
    expect(input.listenerCount(event), event).toBe(0);
  }
  signals.forEach((signal, index) => {
    expect(process.listeners(signal), signal).toEqual(signalListeners[index]);
  });
}

describe('MCP startup failure cleanup', () => {
  it('disposes a prewarmed host when the real SDK rejects a duplicate tool name', async () => {
    vi.stubEnv('FAUXNIX_TOOL_NAME', 'fauxnix_translate');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const close = vi.spyOn(McpServer.prototype, 'close');
    const { startMcpServer } = await import('../src/mcp.js');

    await expect(startMcpServer()).rejects.toThrow('Tool fauxnix_translate is already registered');
    expect(session.prewarm).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expectListenersRemoved();
  });

  it.each(['none', 'dispose', 'close'] as const)(
    'cleans up a partially started transport and preserves the failure when %s cleanup fails',
    async (cleanupFailure) => {
      const failure = new Error('transport startup failed');
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const originalStart = StdioServerTransport.prototype.start;
      vi.spyOn(StdioServerTransport.prototype, 'start').mockImplementationOnce(async function (this: InstanceType<typeof StdioServerTransport>) {
        await originalStart.call(this);
        expect(input.listenerCount('data')).toBeGreaterThan(0);
        throw failure;
      });
      const originalClose = McpServer.prototype.close;
      const close = vi.spyOn(McpServer.prototype, 'close');
      if (cleanupFailure === 'dispose') session.dispose.mockRejectedValueOnce(new Error('dispose failed'));
      if (cleanupFailure === 'close') {
        close.mockImplementationOnce(async function (this: InstanceType<typeof McpServer>) {
          await originalClose.call(this);
          throw new Error('close failed');
        });
      }
      const { startMcpServer } = await import('../src/mcp.js');

      await expect(startMcpServer()).rejects.toBe(failure);
      expect(session.dispose).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expectListenersRemoved();
    },
  );

  it('cleans up when prewarming rejects before the transport is created', async () => {
    const failure = new Error('prewarm failed');
    session.prewarm.mockRejectedValueOnce(failure);
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const close = vi.spyOn(McpServer.prototype, 'close');
    const { startMcpServer } = await import('../src/mcp.js');

    await expect(startMcpServer()).rejects.toBe(failure);
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expectListenersRemoved();
  });

  it('keeps a successfully connected server alive until shutdown, then removes listeners', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const close = vi.spyOn(McpServer.prototype, 'close');
    const { startMcpServer } = await import('../src/mcp.js');

    await startMcpServer();
    expect(session.dispose).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(input.listenerCount('data')).toBeGreaterThan(0);
    input.emit('close');
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(session.dispose).toHaveBeenCalledOnce();
    expectListenersRemoved();
  });
});
