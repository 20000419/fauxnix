/**
 * RFC C-7 growth: curated fauxnix vs Git Bash identity.
 *
 * Default `npm test` imports this file and runs the corpus-shape check, then
 * skipIf's the oracle unless FAUXNIX_DIFF_ORACLE is set and git-bash bash.exe
 * exists. Missing Git Bash never fails CI. The weekly schedule in
 * `.github/workflows/differential.yml` is skip-safe the same way.
 */
import { describe, expect, it } from 'vitest';
import {
  canRunOracle,
  loadCorpus,
  oracleSkipReason,
  resolveGitBash,
  runCorpus,
  formatSummary,
} from './differential/run.js';

const corpus = loadCorpus();
const skipOracle = !canRunOracle();
const skipWhy = oracleSkipReason();

describe('differential corpus growth (C-7 / #118)', () => {
  it('loads a grown corpus, not the 200-case 1.0 gate', () => {
    expect(corpus.gate.targetCases).toBe(200);
    expect(corpus.gate.identity).toBe(0.95);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(40);
    expect(corpus.cases.length).toBeLessThan(200);
    const ids = corpus.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'echo-dev-null',
      'printf-grep-split',
      'head-lines-neg',
      'grep-e-or',
      'middle-stdin-redirect',
      'last-stage-stderr-file',
      'last-stage-stderr-append',
      'last-stage-stderr-to-stdout',
      'attached-digit-stdout-append',
      'last-stage-stdout-to-stderr',
    ]));
    expect(corpus.files['three.txt']?.split('\n').filter(Boolean)).toHaveLength(3);
    if (skipOracle) console.log(`differential oracle skipped: ${skipWhy}`);
  });
});

describe.skipIf(skipOracle)('differential vs Git Bash oracle', { timeout: 300_000 }, () => {
  it('identity is ≥95% of this corpus', async () => {
    const bashPath = resolveGitBash();
    expect(bashPath).toBeTruthy();
    const run = await runCorpus({ corpus, bashPath: bashPath! });
    const summary = formatSummary(run);
    console.log(summary);
    expect(run.total).toBe(corpus.cases.length);
    expect(
      run.identity,
      `${summary}\nidentity ${(run.identity * 100).toFixed(1)}% < ${(run.gate * 100).toFixed(0)}% gate`,
    ).toBeGreaterThanOrEqual(run.gate);
  });
});
