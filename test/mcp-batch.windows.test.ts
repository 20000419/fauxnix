import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const onWindows = process.platform === 'win32';

describe.skipIf(!onWindows)('MCP compiled batch tool', () => {
  it('preflights every step and returns byte-exact per-step results in one call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-mcp-batch-'));
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsx, 'src/index.ts', 'mcp'],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        FAUXNIX_PS: process.env.FAUXNIX_PS ?? '',
      },
      stderr: 'pipe',
    });
    transport.stderr?.on('data', () => undefined);
    const client = new Client({ name: 'fauxnix-batch-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const batchTool = tools.tools.find((tool) => tool.name === 'bash_batch');
      expect(batchTool?.description).toContain('one MCP round trip');
      expect(batchTool?.description).toContain('wc -c');

      const result = await client.callTool({
        name: 'bash_batch',
        arguments: {
          steps: [
            { id: 'enter', command: 'cd ' + JSON.stringify(dir) },
            { id: 'write', command: "printf 'a\\r\\nb' > bytes.txt" },
            { id: 'measure', command: 'wc -c bytes.txt' },
            { id: 'stop', command: 'false' },
            { id: 'skipped', command: "printf 'bad' > should-not-exist.txt" },
          ],
        },
      });
      const structured = result.structuredContent as {
        stopReason: string;
        stepsCompleted: number;
        steps: Array<{ id?: string; status: string; stdout?: string; exitCode?: number }>;
      };
      expect(result.isError).not.toBe(true);
      expect(structured.stopReason).toBe('command_failed');
      expect(structured.stepsCompleted).toBe(4);
      expect(structured.steps[2].id).toBe('measure');
      expect(structured.steps[2].stdout).toMatch(/^4\s+bytes\.txt\s*$/);
      expect(structured.steps[3]).toMatchObject({ status: 'failed', exitCode: 1 });
      expect(structured.steps[4].status).toBe('skipped');
      expect(existsSync(join(dir, 'should-not-exist.txt'))).toBe(false);

      const compileFailure = await client.callTool({
        name: 'bash_batch',
        arguments: {
          steps: [
            { id: 'must-not-run', command: "printf 'bad' > compile-marker.txt" },
            { id: 'invalid', command: 'echo "unterminated' },
          ],
        },
      });
      const failed = compileFailure.structuredContent as {
        stopReason: string;
        stepsCompleted: number;
        failedStep: number;
      };
      expect(compileFailure.isError).toBe(true);
      expect(failed).toMatchObject({
        stopReason: 'compile_error',
        stepsCompleted: 0,
        failedStep: 1,
      });
      expect(existsSync(join(dir, 'compile-marker.txt'))).toBe(false);
    } finally {
      await client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
