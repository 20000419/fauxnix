import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { nodeEngineRange, supportsNode } from '../src/runtime-support.js';

describe('Node support contract', () => {
  it('uses the same minimum as package installation and the lockfile', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
    expect(nodeEngineRange).toBe('>=22.20.0');
    expect(pkg.engines.node).toBe(nodeEngineRange);
    expect(lock.packages[''].engines.node).toBe(nodeEngineRange);
  });

  it.each(['v18.20.8', 'v20.20.2', 'v22.0.0', 'v22.12.0', 'v22.19.9',
    'v22.20.0-rc.1', '22', '22.20', '22.20.0garbage', 'v022.20.0', '',
    'v9007199254740992.0.0'])('rejects unsupported or malformed version %s', (version) => {
    expect(supportsNode(version)).toBe(false);
  });

  it.each(['v22.20.0', '22.20.0', 'v22.20.1', 'v22.23.3', 'v24.0.0',
    'v24.12.0', 'v24.19.0', '22.20.0+vendor.1'])('accepts stable version %s at or above the floor', (version) => {
    expect(supportsNode(version)).toBe(true);
  });
});
