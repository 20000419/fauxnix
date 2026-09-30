/**
 * RFC C-7 hard gate: curated fauxnix vs Git Bash identity.
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

describe('differential corpus hard gate (C-7 / #118)', () => {
  it('loads at least 200 sourced, non-duplicate cases', () => {
    expect(corpus.gate.targetCases).toBe(200);
    expect(corpus.gate.identity).toBe(0.95);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(corpus.gate.targetCases);
    const ids = corpus.cases.map((c) => c.id);
    const commands = corpus.cases.map((c) => c.cmd);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(commands).size).toBe(commands.length);
    expect(corpus.cases.every((c) => c.cmd.trim() !== '' && c.source?.trim())).toBe(true);
    expect(new Set(corpus.gate.knownMismatchIds).size).toBe(corpus.gate.knownMismatchIds.length);
    expect(corpus.gate.knownMismatchIds.every((id) => ids.includes(id))).toBe(true);
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
      'grep-fixed-phrase',
      'bracket-grouped-logic',
      'gzip-file-roundtrip',
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
    const knownMismatches = new Set(corpus.gate.knownMismatchIds);
    const unexpected = run.results.filter(
      (result) => !result.identical && !knownMismatches.has(result.id),
    );
    expect(
      unexpected.map((result) => result.id),
      `${summary}\nnew differential mismatches are not covered by the reviewed baseline`,
    ).toEqual([]);
  });

  it('reports the astral Unicode oracle limitation while enforcing scalar counting', async () => {
    const diagnostic = {
      ...corpus,
      cases: [{
        id: 'wc-astral-unicode-oracle',
        cmd: "printf 'A😀é\\n' | LC_ALL=C.UTF-8 wc -m",
        source: 'Unicode scalar golden / GNU Linux reference; MSYS oracle diagnostic',
      }],
    };
    const run = await runCorpus({ corpus: diagnostic, bashPath: resolveGitBash()! });
    const result = run.results[0];
    expect(result.fauxnix).toEqual({ stdout: '5\n', stderr: '', exitCode: 0 });
    expect(result.bash.exitCode).toBe(0);
    expect(result.bash.stderr).toBe('');
    console.log('Astral Unicode oracle diagnostic (excluded from identity score): ' + JSON.stringify({
      command: diagnostic.cases[0].cmd,
      expectedLinuxScalarCount: '5\n',
      fauxnix: result.fauxnix.stdout,
      gitBash: result.bash.stdout,
    }));
  });

});
