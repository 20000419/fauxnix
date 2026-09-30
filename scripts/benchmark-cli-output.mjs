// Reproduce the CLI pipe-drain spot-check without starting PowerShell.
// Usage: node scripts/benchmark-cli-output.mjs [built checkout] [baseline ref]
// The checkout's dist/ files must already be built. The baseline temporary JS
// file is created inside dist/ so its relative module imports remain unchanged,
// and removed in finally. No tracked source or configuration files are changed.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const baselineRef = process.argv[3] ?? '1bbff5eb9e42e59147ada59e3c8b4a3bd4fd42fa';
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const bytes = 2 * 1024 * 1024;
const baselinePath = join(root, 'dist', `cli-output-baseline-${randomUUID()}.js`);
if (!existsSync(join(root, 'dist', 'cli.js'))) throw new Error('Build the checkout first');

console.log(JSON.stringify({
  checkout: root,
  platform: platform(),
  osRelease: release(),
  node: process.version,
  expectedBytes: bytes,
  transport: 'spawnSync default stdout pipe, captured as a Buffer',
  replacements: ['FauxnixSession.prototype.run', 'FauxnixSession.prototype.dispose'],
}));

try {
  const source = execFileSync('git', ['show', baselineRef + ':src/cli.ts'], {
    cwd: root,
    encoding: 'utf8',
  });
  const baseline = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  writeFileSync(baselinePath, baseline);

  for (const [label, cliPath] of [
    ['baseline', baselinePath],
    ['fixed', join(root, 'dist', 'cli.js')],
  ]) {
    // Real FauxnixSession constructor and real CLI parsing/translation run.
    // run() supplies controlled output, and dispose() avoids host/filesystem
    // cleanup timing. Neither case launches a host or executes shell commands.
    const childSource = `
      import { FauxnixSession } from ${JSON.stringify(pathToFileURL(join(root, 'dist', 'executor.js')).href)};
      import { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};
      FauxnixSession.prototype.run = async () => ({ stdout: 'x'.repeat(${bytes}), stderr: '', exitCode: 3 });
      FauxnixSession.prototype.dispose = async () => {};
      await runCli(['echo hello']);
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    });
    if (result.error) throw result.error;
    console.log(JSON.stringify({
      label,
      exitCode: result.status,
      actualBytes: result.stdout.length,
      expectedBytes: bytes,
      stderr: result.stderr.toString('utf8'),
    }));
    if (result.status !== 3) throw new Error(`${label}: unexpected process exit`);
    if (label === 'fixed' && result.stdout.length !== bytes) throw new Error('Fixed CLI lost output');
  }
} finally {
  rmSync(baselinePath, { force: true });
}
