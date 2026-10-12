/**
 * Differential corpus through the native facade entry (RFC #224).
 *
 * The standing corpus gate exercises the in-process session; this companion
 * runs a deterministic sample through real `fauxnix facade -c` processes —
 * the argv boundary a harness's bash.exe actually crosses. Opt-in like the
 * oracle itself: FAUXNIX_FACADE_DIFF=1 plus the Git Bash oracle, enabled on
 * one CI lane. Each facade invocation is its own cold session, so the sample
 * is strided (every 7th case) plus every control-flow case, capped for lane
 * time.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canRunOracle,
  loadCorpus,
  resolveGitBash,
  runBash,
  writeTree,
} from './run.js';

const facadeEntry = join(process.cwd(), 'dist', 'index.js');
const enabled =
  !!process.env.FAUXNIX_FACADE_DIFF && canRunOracle() && existsSync(facadeEntry);

function sampleCases(): { id: string; cmd: string; files?: Record<string, string> }[] {
  const corpus = loadCorpus();
  const controlFlow = /\b(while|until|for|case|break|continue)\b/;
  const picked = new Set<number>();
  corpus.cases.forEach((c, i) => {
    if (i % 7 === 0 || controlFlow.test(c.cmd)) picked.add(i);
  });
  return [...picked].slice(0, 60).map((i) => corpus.cases[i]!);
}

describe.skipIf(!enabled)('differential through the facade entry (RFC #224)', { timeout: 600_000 }, () => {
  it('sample identity is ≥95% vs Git Bash through real facade processes', async () => {
    const bashPath = resolveGitBash()!;
    const cases = sampleCases();
    expect(cases.length).toBeGreaterThanOrEqual(20);
    const corpus = loadCorpus();
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-diff-facade-'));
    let identical = 0;
    const mismatches: string[] = [];
    try {
      for (const [index, c] of cases.entries()) {
        const caseName = String(index + 1).padStart(3, '0') + '-' + c.id.replace(/[^a-z0-9_.-]/gi, '_');
        const facadeDir = join(dir, 'facade', caseName);
        const bashDir = join(dir, 'bash', caseName);
        const files = { ...(corpus.files ?? {}), ...(c.files ?? {}) };
        writeTree(facadeDir, files);
        writeTree(bashDir, files);

        const fx = spawnSync(process.execPath, [facadeEntry, 'facade', '-c', c.cmd], {
          cwd: facadeDir,
          encoding: 'utf8',
          timeout: 30_000,
          windowsHide: true,
        });
        const facade = {
          stdout: fx.stdout ?? '',
          stderr: fx.stderr ?? '',
          exitCode: fx.status ?? 1,
        };
        const bash = runBash(bashPath, bashDir, c.cmd);
        const same =
          facade.stdout.replaceAll('\r\n', '\n') === bash.stdout.replaceAll('\r\n', '\n') &&
          facade.stderr.replaceAll('\r\n', '\n') === bash.stderr.replaceAll('\r\n', '\n') &&
          facade.exitCode === bash.exitCode;
        if (same) identical++;
        else mismatches.push(`${c.id}: ${c.cmd}`);
        // yield so the vitest worker RPC (onTaskUpdate) does not time out
        // during this long spawn-heavy loop
        await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const identity = identical / cases.length;
    console.log(`facade differential: ${identical}/${cases.length} identical (${(identity * 100).toFixed(1)}%)`);
    for (const m of mismatches) console.log(`  FAIL ${m}`);
    expect(identity).toBeGreaterThanOrEqual(0.95);
  });
});
