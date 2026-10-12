import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('command output regression generation', () => {
  it.each(['ls -lh first.txt', 'ls -l --human-readable first.txt', 'll -lh first.txt'])(
    '%s defines its human-size helper before using it', (command) => {
      const body = bodyOf(command);
      const helper = body.indexOf('function fx-hsize(');
      expect(helper).toBeGreaterThanOrEqual(0);
      expect(body.indexOf('fx-hsize $fx_size')).toBeGreaterThan(helper);
    },
  );

  it.each(['-cd', '-cu'])('uniq %s composes filtering and count formatting', (flags) => {
    const body = bodyOf(`uniq ${flags} dups.txt`);
    expect(body).toContain("$fx_res.Add(('{0,7} {1}' -f $c, $l))");
    if (flags.includes('d')) expect(body).toContain('if ($c -gt 1) {');
    if (flags.includes('u')) expect(body).toContain('if ($c -eq 1) {');
  });

  it('uniq -cdu emits no group when both selection filters are set', () => {
    expect(bodyOf('uniq -cdu dups.txt')).toContain('function fx-uemit($l, $c) {\n  return\n}');
  });

  it('tac reverses inside the source loop rather than concatenating all inputs first', () => {
    const body = bodyOf('tac first.txt second.txt');
    expect(body).not.toContain('$fx_all +=');
    expect(body).toContain([
      'foreach ($fx_g in $fx_srcs) {',
      "  if ($fx_g -eq '-') { $fx_ls = @($fx_in) }",
      '  else { $fx_ls = @(fx-splitlines (fx-read $fx_g)) }',
      '  for ($fx_i = $fx_ls.Count - 1; $fx_i -ge 0; $fx_i--) { $fx_ls[$fx_i] }',
      '}',
    ].join('\n'));
  });
});
