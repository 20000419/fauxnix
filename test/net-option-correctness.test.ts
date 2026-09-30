/** These tests only translate inert example URLs; no network command is run. */
import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

const url = 'https://files.example/report.txt';

function mappedArguments(command: string): string | undefined {
  return bodyOf(command).split('\n').find((line) => line.startsWith('$fx_margs = '));
}

describe('wget curl fallback output option parsing', () => {
  it.each(['-O', '-qO', '-qqO', '--output-document'])('emits an error instead of a curl call for missing %s values', (option) => {
    const body = bodyOf(`wget ${url} ${option}`);
    expect(body).toContain('wget: option requires an argument');
    expect(body).not.toContain("fx-native 'curl.exe'");
    expect(body).toContain('$script:fx_exit = 2');
    // Validation belongs to the fallback; real wget still receives its argv.
    expect(body).toContain("fx-native 'wget.exe' ([object[]]@($fx_args))");
    expect(body).toContain("fx-netguard 'wget' $fx_a");
  });

  it.each([
    '-O first.txt -O -',
    '-Ofirst.txt -O-',
    '--output-document=first.txt --output-document=-',
    '--output-document first.txt --output-document -',
  ])('uses stdout when the final output option selects it: %s', (options) => {
    expect(mappedArguments(`wget ${options} ${url}`)).toBe(`$fx_margs = @('${url}')`);
  });

  it.each([
    '-O first.txt -O second.txt',
    '-Ofirst.txt --output-document=second.txt',
    '--output-document first.txt -Osecond.txt',
    '-O- -Osecond.txt',
  ])('keeps only the final output filename: %s', (options) => {
    expect(mappedArguments(`wget ${options} ${url}`)).toBe(`$fx_margs = @('-o', 'second.txt', '${url}')`);
  });

  it('keeps unrelated arguments in order when replacing an output option', () => {
    expect(mappedArguments(`wget -O first.txt ${url} -qO-`)).toBe(`$fx_margs = @('${url}', '-s')`);
  });

  it('keeps an explicit empty output value distinct from stdout', () => {
    expect(mappedArguments(`wget --output-document= ${url}`)).toBe(`$fx_margs = @('-o', '', '${url}')`);
  });

  it('retains dynamic output expressions when replacing an earlier destination', () => {
    expect(mappedArguments(`wget -O first.txt -O "$OUTPUT" ${url}`))
      .toBe(mappedArguments(`wget -O "$OUTPUT" ${url}`));
  });
});
