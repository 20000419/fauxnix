import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('portable MCP stdio integration', () => {
  it('keeps tool discovery and translation usable after unavailable-host errors', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/index.ts', 'mcp'],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        // A deliberately invalid alias prevents any PowerShell process from
        // starting, so the portable test never executes translated commands.
        FAUXNIX_PS: 'portable-test-no-host',
        FAUXNIX_TOOL_NAME: 'quality_shell',
      },
      stderr: 'pipe',
    });
    let childStderr = '';
    transport.stderr?.on('data', (chunk) => { childStderr += String(chunk); });
    const client = new Client({ name: 'fauxnix-portable-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'quality_shell', 'quality_shell_batch', 'fauxnix_translate', 'fauxnix_session',
      ]));
      const missing = await client.callTool({ name: 'quality_shell', arguments: { command: 'echo fixture' } });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toMatchObject({ exitCode: 127, timedOut: false, cancelled: false });
      const invalid = await client.callTool({ name: 'fauxnix_translate', arguments: { command: 'echo "unfinished' } });
      expect(invalid.isError).toBe(true);
      const valid = await client.callTool({ name: 'fauxnix_translate', arguments: { command: 'echo fixture' } });
      expect(valid.isError).not.toBe(true);
      expect(valid.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('fixture') })]));
      const batch = await client.callTool({
        name: 'quality_shell_batch', arguments: { steps: [{ command: 'echo first' }, { command: 'echo second' }] },
      });
      expect(batch.isError).toBe(true);
      expect(batch.structuredContent).toMatchObject({ stopReason: 'infrastructure', stepsCompleted: 1 });
      const status = await client.callTool({ name: 'fauxnix_session', arguments: { action: 'status' } });
      expect(status.isError).not.toBe(true);
    } catch (error) {
      throw new Error(String(error) + ": " + childStderr);
    } finally {
      await client.close();
    }
  }, 15000);
});
