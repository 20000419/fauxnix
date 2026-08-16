#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
