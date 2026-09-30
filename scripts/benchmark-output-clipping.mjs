// Pure string processing only. The reference is clipUtf8 from upstream 1bbff5e.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { clipUtf8 } from '../dist/encoding.js';

function baseline(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return { text, truncated: false };
  let used = 0;
  let end = 0;
  for (const codepoint of text) {
    const size = Buffer.byteLength(codepoint, 'utf8');
    if (used + size > limit) break;
    used += size;
    end += codepoint.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

const workloads = [
  { name: '256KiB MCP ASCII prefix, four-byte excess', text: 'x'.repeat(262_148), limit: 262_144 },
  { name: '8MiB ASCII prefix, four-byte excess', text: 'x'.repeat(8_388_612), limit: 8_388_608 },
  { name: '8MiB emoji prefix, one-codepoint excess', text: '🙂'.repeat(2_097_153), limit: 8_388_608 },
  { name: '8MiB CJK output, four-byte excess', text: '你好'.repeat(1_398_102), limit: 8_388_608 },
  { name: 'small prefix of large output', text: 'x'.repeat(8_388_608), limit: 65_536 },
];
const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const results = [];
for (const workload of workloads) {
  assert.deepEqual(clipUtf8(workload.text, workload.limit), baseline(workload.text, workload.limit));
  const entries = [ { name: 'baseline', fn: baseline, samplesMs: [] }, { name: 'candidate', fn: clipUtf8, samplesMs: [] } ];
  for (const entry of entries) entry.fn(workload.text, workload.limit);
  for (let round = 0; round < 9; round++) {
    for (const entry of round % 2 ? [...entries].reverse() : entries) {
      const start = performance.now();
      entry.fn(workload.text, workload.limit);
      entry.samplesMs.push(performance.now() - start);
    }
  }
  results.push({ name: workload.name, inputBytes: Buffer.byteLength(workload.text), limitBytes: workload.limit,
    results: entries.map(({ name, samplesMs }) => ({ name, samplesMs, medianMs: median(samplesMs) })) });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, architecture: process.arch,
  caveat: 'Output-clipping helper microbenchmark only; not end-to-end Windows or MCP speed.', results }, null, 2));
