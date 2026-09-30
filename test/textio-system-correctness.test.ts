import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('head supported count parsing', () => {
  it.each([
    ['head -qn2 input.txt', 'head -q -n2 input.txt'],
    ['head -vn 2 input.txt', 'head -v -n 2 input.txt'],
    ['head -qc-2 input.txt', 'head -q -c -2 input.txt'],
  ])('keeps count values in %s', (bundled, separate) => {
    expect(bodyOf(bundled)).toBe(bodyOf(separate));
  });

  it.each([
    ['head -c1 -n2 input.txt', 'head -n2 input.txt'],
    ['head --bytes=1 --lines=2 input.txt', 'head -n2 input.txt'],
    ['head -n1 -c2 input.txt', 'head -c2 input.txt'],
    ['head -c1 -2 input.txt', 'head -n2 input.txt'],
  ])('uses the final count mode in %s', (repeated, final) => {
    expect(bodyOf(repeated)).toBe(bodyOf(final));
  });

  it.each(['-n', '-c', '--lines', '--bytes'])('normalizes decimal counts for %s', (option) => {
    expect(bodyOf(`head ${option} +0002 input.txt`)).toBe(bodyOf(`head ${option} 2 input.txt`));
    expect(bodyOf(`head ${option} -0002 input.txt`)).toBe(bodyOf(`head ${option} -2 input.txt`));
    expect(bodyOf(`head ${option} 2147483647 input.txt`)).toContain('$fx_count = [int](2147483647)');
  });

  it.each([
    'head -n 2147483648 input.txt',
    'head -c -2147483648 input.txt',
    'head --bytes=999999999999999999999999999999 input.txt',
    'head -n invalid -n2 input.txt',
    'head -qninvalid input.txt',
    'head --lines= --lines=2 input.txt',
  ])('fails invalid or unrepresentable counts in %s', (command) => {
    const body = bodyOf(command);
    expect(body).toContain('head: invalid number of');
    expect(body).toContain('$script:fx_exit = 1');
    expect(body).not.toContain('function fx-read');
  });

  it.each(['-n', '-c'])('keeps negative zero distinct for %s', (option) => {
    expect(bodyOf(`head ${option} -0 input.txt`)).toContain('$fx_dropLast = $true');
    expect(bodyOf(`head ${option} 0 input.txt`)).toContain('$fx_dropLast = $false');
  });
});

describe('ordered text option toggles', () => {
  it.each(['head', 'tail'])('%s uses the last header option', (command) => {
    for (const prefix of ['-vq', '-v -q', '--verbose --quiet', '--verbose --silent']) {
      expect(bodyOf(`${command} ${prefix} -n1 input.txt`)).toBe(bodyOf(`${command} -q -n1 input.txt`));
    }
    for (const prefix of ['-qv', '-q -v', '--quiet --verbose']) {
      expect(bodyOf(`${command} ${prefix} -n1 input.txt`)).toBe(bodyOf(`${command} -v -n1 input.txt`));
    }
  });

  it.each(['-Ee', '-nEe', '-eEe'])('echo processes the bundle %s left to right', (option) => {
    expect(bodyOf(`echo ${option} text`)).toContain('$fx_s = fx-unesq $fx_s');
  });

  it.each(['-eE', '-neE', '-EeE'])('echo disables escapes at the end of %s', (option) => {
    expect(bodyOf(`echo ${option} text`)).not.toContain('$fx_s = fx-unesq $fx_s');
  });

  it('printf consumes only the first option separator', () => {
    expect(bodyOf('printf -- --')).toContain("$fx_fmt = '--'");
    expect(bodyOf('printf -- -- --')).toContain("$fx_av = (@('--'))");
  });
});

describe('base64 existing wrap option validation', () => {
  it.each(['base64 -w', 'base64 --wrap'])('rejects a missing wrap value: %s', (command) => {
    expect(bodyOf(command)).toContain('base64: option requires an argument');
  });

  it.each(['-1', 'abc', '1.5', '2147483648', '999999999999999999999999999999'])('rejects invalid wrap %s', (value) => {
    const body = bodyOf(`base64 --wrap=${value}`);
    expect(body).toContain('base64: invalid wrap size');
    expect(body).not.toContain('FromBase64String');
    expect(body).not.toContain('ToBase64String');
  });

  it('keeps aliases in argv order and validates earlier values', () => {
    expect(bodyOf('base64 -w4 --wrap=8')).toBe(bodyOf('base64 -w8'));
    expect(bodyOf('base64 --wrap=4 -w8')).toBe(bodyOf('base64 -w8'));
    expect(bodyOf('base64 -w0008')).toBe(bodyOf('base64 -w8'));
    expect(bodyOf('base64 --wrap=bad -w0')).toContain('base64: invalid wrap size');
  });
});

describe('date option values', () => {
  it.each([
    'date -u -d @0 -d @1 +%s',
    'date -u --date=@0 --date=@1 +%s',
    'date -d @0 -ud@1 +%s',
    'date -u --date @0 -d@1 +%s',
  ])('uses the final date value in %s', (command) => {
    expect(bodyOf(command)).toBe(bodyOf('date -u -d @1 +%s'));
  });
});

describe('Unicode character counts', () => {
  it('counts surrogate pairs once for wc -m, on both stdin and file paths', () => {
    const body = bodyOf('wc -m input.txt -');
    expect(body).toContain('[char]::IsHighSurrogate');
    expect(body).toContain('[char]::IsLowSurrogate');
    expect(body.match(/\(fx-charcount \$fx_txt\)/g)).toHaveLength(2);
  });
});
