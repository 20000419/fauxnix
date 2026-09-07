import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(root, 'dist', 'index.js');
const stepCount = Number.parseInt(process.env.FAUXNIX_BENCH_STEPS ?? '10', 10);
const roundCount = Number.parseInt(process.env.FAUXNIX_BENCH_ROUNDS ?? '3', 10);
assert.ok(Number.isInteger(stepCount) && stepCount > 1 && stepCount <= 32);
assert.ok(Number.isInteger(roundCount) && roundCount > 0 && roundCount <= 20);

const client = new Client({ name: 'fauxnix-batch-benchmark', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, 'mcp'],
  cwd: root,
  env: process.env,
  stderr: 'pipe',
});
transport.stderr?.on('data', () => undefined);

async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function runSeparate() {
  for (let index = 0; index < stepCount; index++) {
    const result = await client.callTool({
      name: 'bash',
      arguments: { command: `printf 's${index}\\n'` },
    });
    assert.equal(result.structuredContent?.exitCode, 0);
  }
}

async function runBatch() {
  const result = await client.callTool({
    name: 'bash_batch',
    arguments: {
      steps: Array.from({ length: stepCount }, (_, index) => ({
        id: 's' + String(index),
        command: `printf 's${index}\\n'`,
      })),
    },
  });
  assert.equal(result.structuredContent?.stopReason, 'completed');
  assert.equal(result.structuredContent?.stepsCompleted, stepCount);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

try {
  const connectMs = await timed(() => client.connect(transport));
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === 'bash_batch'));
  const warmupMs = await timed(() =>
    client.callTool({ name: 'bash', arguments: { command: ':' } }),
  );

  const rounds = [];
  for (let round = 0; round < roundCount; round++) {
    let separateMs;
    let batchMs;
    if (round % 2 === 0) {
      separateMs = await timed(runSeparate);
      batchMs = await timed(runBatch);
    } else {
      batchMs = await timed(runBatch);
      separateMs = await timed(runSeparate);
    }
    rounds.push({ round: round + 1, separateMs, batchMs });
  }

  const separateMedianMs = median(rounds.map((round) => round.separateMs));
  const batchMedianMs = median(rounds.map((round) => round.batchMs));
  process.stdout.write(
    JSON.stringify(
      {
        node: process.version,
        powerShell: process.env.FAUXNIX_PS || 'powershell-5.1-default',
        stepCount,
        roundCount,
        connectMs,
        warmupMs,
        rounds,
        separateMedianMs,
        batchMedianMs,
        speedup: separateMedianMs / batchMedianMs,
        note: 'Measures MCP/server overhead only; eliminated model turns are not represented.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await client.close();
}
