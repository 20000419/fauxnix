import { describe, expect, it } from 'vitest';
import { FauxnixParseError, SimpleCommand, wordToString } from '../src/ast.js';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function simpleCommand(input: string): SimpleCommand {
  const command = parseCommand(input).segments[0].pipeline.commands[0];
  if (command.kind !== 'SimpleCommand') throw new Error('expected a simple command');
  return command;
}

describe('supported shell quoting and continuation', () => {
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
