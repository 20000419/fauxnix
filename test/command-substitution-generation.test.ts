import { describe, expect, it } from 'vitest';
import { Word } from '../src/ast.js';
import { parseCommand } from '../src/parser.js';
import { argListExpr, arithExpr, exprOfWord, translateCmdSub } from '../src/translator.js';
import '../src/commands/install-all.js';

function argument(command: string): Word {
  const simple = parseCommand(command).segments[0].pipeline.commands[0];
  if (simple.kind !== 'SimpleCommand') throw new Error('expected a simple command');
  return simple.args[0];
}

function substitution(inner: string, quoted: boolean): string {
  return '[string](' + translateCmdSub(inner, quoted) + ')';
}

describe('command substitution expression boundaries', () => {
  it.each(['\\)', '\\(', "'\\'", "'\"'", '"\'"'])(
    'keeps quoted substitution with %s outside expandable PowerShell strings',
    (operand) => {
      const inner = `printf '%s' ${operand}`;
      expect(exprOfWord(argument(`echo "$(${inner})"`))).toBe(substitution(inner, true));
    },
  );

  it('concatenates literal and variable runs without changing their interpolation', () => {
    const inner = "printf '%s' \\)";
    const word = argument(`echo "[$USER:$(${inner}):$HOME]"`);
    expect(exprOfWord(word)).toBe(
      '("[$($env:USERNAME):" + ' + substitution(inner, true) + ' + ":$($HOME)]")',
    );
  });

  it('keeps unquoted mixed substitution splitting and quoted interior newlines distinct', () => {
    const inner = "printf 'a\\nb\\n'";
    expect(exprOfWord(argument(`echo pre$(${inner})post`))).toBe(
      '("pre" + ' + substitution(inner, false) + ' + "post")',
    );
    expect(exprOfWord(argument(`echo "pre$(${inner})post"`))).toBe(
      '("pre" + ' + substitution(inner, true) + ' + "post")',
    );
    expect(exprOfWord(argument(`echo pre$(${inner})post`), { preserveCmdSub: true })).toBe(
      '("pre" + ' + substitution(inner, true) + ' + "post")',
    );
  });

  it('keeps adjacent substitutions separate and string-valued', () => {
    const open = "printf '%s' \\(";
    const close = "printf '%s' \\)";
    expect(exprOfWord(argument(`echo "$(${open})$(${close})"`))).toBe(
      '(' + substitution(open, true) + ' + ' + substitution(close, true) + ')',
    );
    expect(exprOfWord(argument('echo "$(false)"'))).toBe(substitution('false', true));
  });

  it('keeps nested command substitutions outside expandable strings at both levels', () => {
    const inner = "printf '%s' \\)";
    const outer = `printf '%s' "$(${inner})"`;
    const expression = exprOfWord(argument(`echo "$(${outer})"`));
    expect(expression).toBe(substitution(outer, true));
    expect(expression).toContain('$fx_av = (@(' + substitution(inner, true) + '))');
  });

  it('does not re-embed command substitution through arithmetic interpolation', () => {
    const inner = "printf '%s' 4";
    const source = argument(`echo $(( $(${inner}) + 1 ))`);
    expect(source[0].kind).toBe('Arith');
    if (source[0].kind !== 'Arith') throw new Error('expected arithmetic expansion');
    const arithmetic = arithExpr(source[0].parts);
    expect(arithmetic).toContain('(fx-arith ((" " + ' + substitution(inner, true) + ' + " + 1 ")))');
    expect(exprOfWord([{ kind: 'DoubleQuoted', parts: source }])).toBe('[string](' + arithmetic + ')');
  });

  it('preserves existing expression shapes when no command substitution is present', () => {
    expect(exprOfWord(argument('echo "[$USER:$HOME]"'))).toBe('"[$($env:USERNAME):$($HOME)]"');
    expect(exprOfWord(argument('echo ""'))).toBe('""');
    const source: Word = [{ kind: 'Text', text: '2*3' }];
    const arithmetic: Word = [{ kind: 'Arith', parts: source }];
    expect(exprOfWord([{ kind: 'DoubleQuoted', parts: arithmetic }])).toBe('"' + arithExpr(source) + '"');
    expect(argListExpr([argument('echo "${A[@]}"')])).toBe("(@(fx-arrload 'A'))");
    expect(exprOfWord(argument('echo "${A[*]}"'))).toBe('"$((fx-subget \'A\' \'*\'))"');
  });
});
