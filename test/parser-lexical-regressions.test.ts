import { describe, expect, it } from 'vitest';
import { FauxnixParseError, SimpleCommand, wordToString } from '../src/ast.js';
import { parseCommand } from '../src/parser.js';
import { exprOfWord, literalOfWord, operandExpr, PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import { invalidForHeaders } from './parser-lexical.fixtures.js';
import '../src/commands/install-all.js';

function simpleCommand(input: string): SimpleCommand {
  const command = parseCommand(input).segments[0].pipeline.commands[0];
  if (command.kind !== 'SimpleCommand') throw new Error('expected a simple command');
  return command;
}

describe('supported shell quoting and continuation', () => {
  it.each([String.raw`\~`, String.raw`\~/docs`])('keeps escaped tilde literal in %s', (word) => {
    const argument = simpleCommand(`echo ${word}`).args[0];
    const literal = word.slice(1);
    expect(literalOfWord(argument)).toBe(literal);
    expect(exprOfWord(argument)).toBe(`'${literal}'`);
    expect(operandExpr(argument)).toBe(`'${literal}'`);
  });

  it('still expands an unescaped tilde while preserving quoted tilde', () => {
    const args = simpleCommand(`echo ~ ~/docs '~' "~"`).args;
    expect(exprOfWord(args[0])).toBe('$HOME');
    expect(exprOfWord(args[1])).toBe('"$($HOME)/docs"');
    expect(exprOfWord(args[2])).toBe("'~'");
    expect(exprOfWord(args[3])).toBe('"~"');
  });

  it.each([String.raw`\A=1`, String.raw`A\=1`, `'F'O=1`, `"F"O=1`, '$F' + 'O=1'])(
    'requires an entirely unquoted and unescaped assignment name and equals in %s', (word) => {
      const command = simpleCommand(`${word} echo wrong`);
      expect(command.assignments).toEqual([]);
      expect(command.name).not.toBeNull();
      expect(command.args.map(wordToString)).toEqual(['echo', 'wrong']);
    },
  );

  it.each([String.raw`A=\~`, String.raw`A=\~/docs`, String.raw`A=\(x\)`])(
    'preserves escaped scalar assignment values in %s', (source) => {
      const command = simpleCommand(source);
      expect(command.name).toBeNull();
      expect(command.assignments).toHaveLength(1);
      const assignment = command.assignments[0];
      expect(assignment.values).toBeUndefined();
      expect(assignment.value[0]).toMatchObject({ kind: 'Text', escaped: true });
      expect(exprOfWord(assignment.value)).toBe(`'${source.slice(2).replaceAll('\\', '')}'`);
      const body = translateCommandList(parseCommand(source), PURE_TRANSLATION)[0].body;
      expect(body).not.toContain('$HOME');
      expect(body).not.toContain('fx-arrput');
    },
  );

  it.each([
    ['for x in do; do echo "$x"; done', ['do']],
    ['for x in one do two; do echo "$x"; done', ['one', 'do', 'two']],
    ['for x in; do echo wrong; done', []],
    ['for x in do\n# body follows\n do echo "$x"; done', ['do']],
    ['for x in do;\n\n do echo "$x"; done', ['do']],
  ] as Array<[string, string[]]>)('uses the separator to end a for word list: %s', (source, words) => {
    const command = parseCommand(source).segments[0].pipeline.commands[0];
    expect(command.kind).toBe('For');
    if (command.kind !== 'For') throw new Error('expected a for command');
    expect(command.words.map(wordToString)).toEqual(words);
    const body = command.body.segments[0].pipeline.commands[0];
    expect(body.kind).toBe('SimpleCommand');
    if (body.kind !== 'SimpleCommand' || body.name === null) throw new Error('expected echo body');
    expect(wordToString(body.name)).toBe('echo');
  });

  it.each(invalidForHeaders)('rejects a missing do or extra separator after a for word list: %s', (source) => {
    expect(() => parseCommand(source)).toThrow(FauxnixParseError);
  });

  it('removes a backslash-newline inside double quotes without adding whitespace', () => {
    const continued = 'echo "first\\\nsecond"';
    const inline = 'echo "firstsecond"';
    expect(parseCommand(continued)).toEqual(parseCommand(inline));
    expect(translateCommandList(parseCommand(continued), PURE_TRANSLATION)).toEqual(
      translateCommandList(parseCommand(inline), PURE_TRANSLATION),
    );
  });

  it('preserves backslash-newline inside single quotes and ordinary quoted newlines', () => {
    expect(simpleCommand("echo 'first\\\nsecond'").args.map(wordToString)).toEqual([
      'first\\\nsecond',
    ]);
    expect(simpleCommand('echo "first\nsecond"').args.map(wordToString)).toEqual([
      'first\nsecond',
    ]);
  });

  it.each(['\\)', '\\('])('keeps escaped %s inside the command substitution', (operand) => {
    const inner = `printf '%s' ${operand}`;
    const command = simpleCommand(`echo $(${inner})`);
    expect(command.args).toEqual([[{ kind: 'CmdSub', cmd: inner }]]);
    expect(() => translateCommandList(parseCommand(`echo $(${inner})`), PURE_TRANSLATION)).not.toThrow();
  });

  it('does not treat a backslash as an escape inside single-quoted substitution text', () => {
    const inner = "printf '%s' '\\'";
    expect(simpleCommand(`echo $(${inner})`).args).toEqual([[{ kind: 'CmdSub', cmd: inner }]]);
    expect(() => translateCommandList(parseCommand(`echo $(${inner})`), PURE_TRANSLATION)).not.toThrow();
  });

  it('allows newline continuation after a pipeline operator', () => {
    const inline = parseCommand('printf a | cat | wc -l');
    const continued = parseCommand('printf a |\n\n cat |\n# next stage\n wc -l');
    expect(continued).toEqual(inline);
    expect(() => translateCommandList(continued, PURE_TRANSLATION)).not.toThrow();
  });

  it.each(['printf a |\n', 'printf a |\n; cat'])('still rejects an unfinished pipeline: %s', (input) => {
    expect(() => parseCommand(input)).toThrow(FauxnixParseError);
  });
});
