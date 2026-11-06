import { describe, expect, it } from 'vitest';
import { FauxnixParseError } from '../src/ast.js';
import { parseCommand } from '../src/parser.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const body = (command: string) => translateCommandList(parseCommand(command))[0].body;

describe('sed GNU replacement backrefs', () => {
  it('maps \\0 to the whole match', () => {
    const script = body(String.raw`sed 's/a/[\0]/'`);
    expect(script).toContain("$fx_m.Result(('[$&]'))");
    expect(script).not.toContain("Result(('[\0]'))");
  });

  it('keeps a digit after \\1 out of the group number', () => {
    const script = body(String.raw`sed -E 's/(a)/\10/'`);
    expect(script).toContain("$fx_m.Result(('${1}0'))");
    expect(script).not.toContain("$fx_m.Result(('$10'))");
  });

  it('leaves a bare group and & on the existing substitution path', () => {
    expect(body(String.raw`sed -E 's/(a)/\1/'`)).toContain("$fx_m.Result(('$1'))");
    expect(body(String.raw`sed 's/a/&/'`)).toContain("$fx_m.Result(('$&'))");
    expect(body(String.raw`sed -E 's/(a)/\1x/'`)).toContain("$fx_m.Result(('$1x'))");
  });
});

describe('awk integer printf', () => {
  it('zero-pads %05d with a numeric truncate, not a string in {0,5}', () => {
    const script = body(String.raw`awk '{printf "%05d\n", $1}'`);
    expect(script).toContain('[long][math]::Truncate((fx-num $v))');
    expect(script).not.toContain('[string][math]::Truncate');
    expect(script).toContain("(fx-awk-ifmt (fx-fld 1) 'd' '0' 5 $null)");
    expect(script).toContain("'{0}'");
    expect(script).not.toContain("'{0,5}'");
    expect(script).toContain('PadLeft($w - $prefix.Length, [char]48)');
  });

  it('carries precision and left alignment into the integer formatter', () => {
    expect(body(String.raw`awk '{printf "%.3d\n", $1}'`)).toContain(
      "(fx-awk-ifmt (fx-fld 1) 'd' '' $null 3)",
    );
    const left = body(String.raw`awk '{printf "%-5d|\n", $1}'`);
    expect(left).toContain("(fx-awk-ifmt (fx-fld 1) 'd' '-' 5 $null)");
    expect(left).toContain('PadRight($w)');
    expect(left).toContain("('|')");
  });

  it('translates %x, %X, and %o instead of rejecting them', () => {
    const hex = body(String.raw`awk '{printf "%x\n", $1}'`);
    expect(hex).toContain("(fx-awk-ifmt (fx-fld 1) 'x' '' $null $null)");
    expect(hex).toContain('[Convert]::ToString([long]$n, 16)');
    // PowerShell -eq is case-insensitive; %x must not take the %X branch.
    expect(hex).toContain("$conv -ceq 'X'");
    expect(hex).toContain("$conv -ceq 'o'");
    expect(body(String.raw`awk '{printf "%05x\n", $1}'`)).toContain(
      "(fx-awk-ifmt (fx-fld 1) 'x' '0' 5 $null)",
    );
    expect(body(String.raw`awk '{printf "%X\n", $1}'`)).toContain(
      '[Convert]::ToString([long]$n, 16).ToUpperInvariant()',
    );
    const oct = body(String.raw`awk '{printf "%o\n", $1}'`);
    expect(oct).toContain("(fx-awk-ifmt (fx-fld 1) 'o' '' $null $null)");
    expect(oct).toContain('[Convert]::ToString([long]$n, 8)');
    expect(body(String.raw`awk '{printf "%05o\n", $1}'`)).toContain(
      "(fx-awk-ifmt (fx-fld 1) 'o' '0' 5 $null)",
    );
  });

  it('treats %i as %d and still rejects conversions outside this set', () => {
    expect(body(String.raw`awk '{printf "%05i\n", $1}'`)).toContain(
      "(fx-awk-ifmt (fx-fld 1) 'd' '0' 5 $null)",
    );
    expect(() => body(String.raw`awk '{printf "%u\n", $1}'`)).toThrow(FauxnixParseError);
    expect(() => body(String.raw`awk '{printf "%q\n", $1}'`)).toThrow(/not supported yet/);
  });

  it('does not emit the integer helper for string printf', () => {
    const script = body(String.raw`awk 'BEGIN {printf "%s", "ab"}'`);
    expect(script).toContain("('{0}') -f (fx-str ('ab'))");
    expect(script).not.toContain('function fx-awk-ifmt');
    expect(script).not.toContain('[string][math]::Truncate');
  });
});
