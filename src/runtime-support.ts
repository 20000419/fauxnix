import { readFileSync } from 'node:fs';

// Keep diagnostics and the entrypoint aligned with the install contract.
// The SEA launcher bundle has no package.json beside its executable; the
// launcher build injects the engine range as a banner global instead.
const bundledRange = (globalThis as Record<string, unknown>).__FAUXNIX_ENGINES_NODE__;
export let nodeEngineRange: string;
if (typeof bundledRange === 'string') {
  nodeEngineRange = bundledRange;
} else {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  nodeEngineRange = metadata.engines?.node;
}
const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(nodeEngineRange);
if (!minimum) throw new Error('fauxnix: unsupported package.json Node engine range');
const required = minimum.slice(1).map(Number);

/** This package uses one inclusive stable-version floor, not general semver ranges. */
export function supportsNode(version: string): boolean {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/.exec(version);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  if (!actual.every(Number.isSafeInteger)) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}
