#!/usr/bin/env node
import { nodeEngineRange, supportsNode } from './runtime-support.js';

if (!supportsNode(process.version)) {
  console.error(`fauxnix: Node.js ${nodeEngineRange} is required; found ${process.version}`);
  process.exitCode = 1;
} else {
  await import('./cli.js').then(({ runCli }) => runCli(process.argv.slice(2))).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
