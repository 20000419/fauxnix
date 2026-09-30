import { describe, expect, it } from 'vitest';
import { awkTextCases, parityFiles, sortTextCases } from './awk-sort-parity.fixtures.js';
import { canRunOracle, normalizeNewlines, resolveGitBash, runCorpus } from './differential/run.js';

// Keep the established 270-case identity corpus untouched. These supplementary
// checks independently verify every new golden expectation against Git Bash.
describe.skipIf(!canRunOracle())('awk/sort supplementary GNU oracle', () => {
  it('matches the golden text and GNU reference for every new supported case', async () => {
    const cases = [...awkTextCases, ...sortTextCases];
    const result = await runCorpus({
      bashPath: resolveGitBash()!,
      corpus: {
        gate: { targetCases: cases.length, identity: 1, knownMismatchIds: [], note: 'Supplementary exact-text checks' },
        files: parityFiles,
        cases: cases.map(([cmd], index) => ({ id: `awk-sort-parity-${index + 1}`, cmd })),
      },
    });
    for (const [index, actual] of result.results.entries()) {
      const context = JSON.stringify(actual);
      expect(actual.identical, context).toBe(true);
      expect(actual.bash.exitCode, context).toBe(0);
      expect(actual.bash.stderr, context).toBe('');
      expect(normalizeNewlines(actual.bash.stdout), context).toBe(normalizeNewlines(cases[index][1]));
    }
    expect(result.total).toBe(cases.length);
  }, 180000);
});
