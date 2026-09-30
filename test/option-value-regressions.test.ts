import { describe, expect, it } from 'vitest';
import { wordToString } from '../src/ast.js';
import { parseCommand } from '../src/parser.js';
import { parseWords } from '../src/registry.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('ordered option-value collection', () => {
  it('keeps repeats, aliases, bundles and empty values while retaining last-value lookup', () => {
    const command = parseCommand('x -iefirst --regexp second -e third --regexp= -- -e ignored')
      .segments[0].pipeline.commands[0];
    if (command.kind !== 'SimpleCommand') throw new Error('expected a simple command');
    const result = parseWords(command.args, ['e'], ['--regexp']);
    expect(result.valueEntries).toEqual([
      { name: '-e', value: 'first' },
      { name: '--regexp', value: 'second' },
      { name: '-e', value: 'third' },
      { name: '--regexp', value: '' },
    ]);
    expect(result.values.get('-e')).toBe('third');
    expect(result.values.get('--regexp')).toBe('');
    expect([...result.flags]).toEqual(['i']);
    expect(result.operandWords.map(wordToString)).toEqual(['-e', 'ignored']);
  });

  it('records consumed option-like values once and leaves missing values separate', () => {
    const command = parseCommand('x --include --exclude=*.ts -e -- -e last --regexp')
      .segments[0].pipeline.commands[0];
    if (command.kind !== 'SimpleCommand') throw new Error('expected a simple command');
    const result = parseWords(command.args, ['e'], ['--include', '--exclude', '--regexp']);
    expect(result.valueEntries).toEqual([
      { name: '--include', value: '--exclude=*.ts' },
      { name: '-e', value: '--' },
      { name: '-e', value: 'last' },
    ]);
    expect(result.missingValue).toEqual(['--regexp']);
    expect(result.operandWords).toEqual([]);
  });
});

describe('supported option values retain their argv boundaries', () => {
  it.each([
    ['sort -nk2,2 input.txt', 'sort -n -k2,2 input.txt'],
    ['sort -rnk 2,2 -k1,1 input.txt', 'sort -rn -k2,2 -k1,1 input.txt'],
    ['sort -fk2 -bk1,1 input.txt', 'sort -fb -k2 -k1,1 input.txt'],
  ])('keeps bundled sort keys in %s', (bundled, separate) => {
    expect(bodyOf(bundled)).toBe(bodyOf(separate));
    expect(bodyOf(bundled)).toContain('fx-keyof $x 2');
  });

  it('does not turn an explicit grep pattern into a file filter', () => {
    const body = bodyOf("grep -F -e '--include=*.txt' notes.log");
    expect(body).toContain("$fx_needle = '--include=*.txt'");
    expect(body).toContain('$fx_fsel = @()');
  });

  it('does not turn a grep file-filter value into a repeated pattern', () => {
    const body = bodyOf('grep -F --include -efoo needle notes.log');
    expect(body).toContain("Keep = $true; Glob = '-efoo'");
    expect(body).toContain("$fx_needle = 'needle'");
    expect(body).toContain("foreach ($fx_o in (@('notes.log')))");
  });

  it('does not treat an option-value double dash as the end of all options', () => {
    const body = bodyOf("grep -F -e -- --include '*.txt' notes.log");
    expect(body).toContain("$fx_needle = '--'");
    expect(body).toContain("Keep = $true; Glob = '*.txt'");
  });
});
