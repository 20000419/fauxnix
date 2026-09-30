// Pure translation only: no generated command is executed or operand file read.
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv[2] ? resolve(process.argv[2]) : null;
const rounds = 9;
const iterations = 1000;
const commands = [
  'echo hello', 'git status --short', 'ls -la src',
  "grep -n -e first -e second input.txt", 'sort -n -k2,2 input.txt',
  "find . -name '*.ts'", "printf 'a\\nb\\n' | head -n 1",
  'if true; then echo yes; else echo no; fi',
  'for item in one two three; do echo "$item"; done',
  'echo "prefix-$HOME-suffix"',
];

async function load(directory) {
  const moduleUrl = (name) => pathToFileURL(resolve(directory, 'dist', name)).href;
  await import(moduleUrl('commands/install-all.js'));
  const { parseCommand } = await import(moduleUrl('parser.js'));
  const { translateCommandList, PURE_TRANSLATION } = await import(moduleUrl('translator.js'));
  return () => {
    for (const command of commands) translateCommandList(parseCommand(command), PURE_TRANSLATION);
  };
}
const candidates = [];
if (baseline) candidates.push({ label: 'baseline', run: await load(baseline), samples: [] });
candidates.push({ label: 'candidate', run: await load(root), samples: [] });
for (const candidate of candidates) for (let i = 0; i < 200; i++) candidate.run();
for (let round = 0; round < rounds; round++) {
  // Alternate order to reduce systematic warmup / scheduler bias.
  for (const candidate of round % 2 ? [...candidates].reverse() : candidates) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) candidate.run();
    candidate.samples.push(performance.now() - start);
  }
}
console.log(JSON.stringify({
  node: process.version, platform: process.platform, architecture: process.arch,
  rounds, commandsPerRound: iterations * commands.length,
  caveat: 'Local pure-translation microbenchmark; does not measure Windows command execution or MCP latency.',
  results: candidates.map(({ label, samples }) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const medianMs = sorted[Math.floor(sorted.length / 2)];
    return { label, samplesMs: samples, medianMs, commandsPerSecond: iterations * commands.length * 1000 / medianMs };
  }),
}, null, 2));
