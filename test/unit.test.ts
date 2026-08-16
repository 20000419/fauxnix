import { describe, expect, it } from 'vitest';
import { FauxnixParseError } from '../src/ast.js';
import { parseCommand as parse, tokenize } from '../src/parser.js';
import {
  exprOfWord,
  normalizeLiteralPath,
  pathExpr,
  translateCommandList,
  varExpr,
  wrapScript,
} from '../src/translator.js';
import { parseWords, psStr } from '../src/registry.js';
import { decodeOutput, encodeCommand } from '../src/encoding.js';
import { normalizeStderr } from '../src/errors.js';

/* ---------------------------- parser ---------------------------- */

describe('parser', () => {
  it('parses a simple command with args', () => {
    const list = parse('ls -la /tmp');
    expect(list.segments).toHaveLength(1);
    const cmd = list.segments[0].pipeline.commands[0];
    expect(cmd.args.map((a) => a.map((p) => ('text' in p ? p.text : '')).join(''))).toEqual([
      '-la',
      '/tmp',
    ]);
  });

  it('splits pipelines and lists', () => {
    const list = parse('a | b && c ; d || e');
    expect(list.segments.map((s) => s.op)).toEqual([';', '&&', ';', '||']);
    expect(list.segments[0].pipeline.commands).toHaveLength(2);
  });

  it('keeps quoted text literal', () => {
    const list = parse("echo 'a  b' \"c $d\"");
    const args = list.segments[0].pipeline.commands[0].args;
    expect(args).toHaveLength(2);
  });

  it('parses redirects', () => {
    const list = parse('cat f > out.txt');
    const cmd = list.segments[0].pipeline.commands[0];
    expect(cmd.redirects).toEqual([{ op: '>', target: 'out.txt' }]);
  });

  it('parses fd redirects (2>, 2>/dev/null, 2>&1)', () => {
    expect(parse('x 2> err.txt').segments[0].pipeline.commands[0].redirects[0].op).toBe('2>');
    expect(
      parse('x 2> /dev/null').segments[0].pipeline.commands[0].redirects[0].target,
    ).toBe('/dev/null');
    expect(parse('x 2>&1').segments[0].pipeline.commands[0].redirects[0].op).toBe('2>&1');
  });

  it('parses stdin redirects', () => {
    expect(parse('wc -l < f').segments[0].pipeline.commands[0].redirects[0].op).toBe('<');
  });

  it('parses assignment prefixes', () => {
    const cmd = parse('FOO=bar baz').segments[0].pipeline.commands[0];
    expect(cmd.assignments).toHaveLength(1);
    expect(cmd.assignments[0].name).toBe('FOO');
  });

  it('captures command substitution', () => {
    const cmd = parse('echo $(date +%Y)').segments[0].pipeline.commands[0];
    const parts = cmd.args[0];
    expect(parts.some((p) => p.kind === 'CmdSub' && p.cmd === 'date +%Y')).toBe(true);
  });

  it('rejects heredocs with a helpful message', () => {
    expect(() => parse('cat <<EOF')).toThrow(FauxnixParseError);
    expect(() => parse('cat <<EOF')).toThrow(/heredoc/);
  });

  it('rejects backticks', () => {
    expect(() => parse('echo `date`')).toThrow(/backtick/);
  });

  it('rejects an unclosed [[ at parse time so later ; segments cannot run', () => {
    expect(() => parse('[[ -f guard ; echo BAD')).toThrow(/missing/);
    expect(() => parse('[[ -f x')).toThrow(/missing/);
  });

  it('rejects a spaced | inside [[ ]] as a syntax error', () => {
    expect(() => parse('[[ abc =~ ^a | z$ ]]')).toThrow(/unexpected token/);
  });

  it('parses [[ ]] as a command with a closing word', () => {
    const cmd = parse('[[ -f x ]]').segments[0].pipeline.commands[0];
    expect(cmd.name.map((p) => ('text' in p ? p.text : '')).join('')).toBe('[[');
    const last = cmd.args[cmd.args.length - 1];
    expect(last.map((p) => ('text' in p ? p.text : '')).join('')).toBe(']]');
  });

  it('glues | inside [[ ]] so =~ alternation stays one operand', () => {
    const cmd = parse('[[ abc =~ ^a|z$ ]]').segments[0].pipeline.commands[0];
    expect(cmd.redirects).toHaveLength(0);
    const args = cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join(''));
    expect(args).toEqual(['abc', '=~', '^a|z$', ']]']);
  });

  it('keeps > and < inside [[ ]] as comparison operators, not redirects', () => {
    const cmd = parse('[[ z > important.txt ]]').segments[0].pipeline.commands[0];
    expect(cmd.redirects).toHaveLength(0);
    expect(
      cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['z', '>', 'important.txt', ']]']);
  });

  it('keeps && and || inside [[ ]] as arguments, not list operators', () => {
    const list = parse('[[ -f a && -f b || -f c ]] && echo ok');
    expect(list.segments).toHaveLength(2);
    const inner = list.segments[0].pipeline.commands[0].args.map((w) =>
      w.map((p) => ('text' in p ? p.text : '')).join(''),
    );
    expect(inner).toEqual(['-f', 'a', '&&', '-f', 'b', '||', '-f', 'c', ']]']);
    expect(list.segments[1].op).toBe('&&');
  });

  it('treats newlines as ;', () => {
    const list = parse('a\nb');
    expect(list.segments).toHaveLength(2);
  });
});

/* ---------------------------- translator ---------------------------- */

describe('translator', () => {
  it('maps shell variables', () => {
    expect(varExpr('HOME')).toBe('$HOME');
    expect(varExpr('PWD')).toBe('$PWD.Path');
    expect(varExpr('USER')).toBe('$env:USERNAME');
    expect(varExpr('?')).toBe('[string]$fx_prev');
  });

  it('normalizes POSIX-ish literal paths', () => {
    expect(normalizeLiteralPath('/dev/null')).toBe('NUL');
    expect(normalizeLiteralPath('/tmp')).toBe('$env:TEMP');
    expect(normalizeLiteralPath('/tmp/x/y.txt')).toBe('$env:TEMP\\x\\y.txt');
    expect(normalizeLiteralPath('/d/foo/bar')).toBe('D:\\foo\\bar');
    expect(normalizeLiteralPath('relative/file.txt')).toBe('relative/file.txt');
  });

  it('keeps $env:TEMP expansions out of single quotes', () => {
    expect(pathExpr(normalizeLiteralPath('/tmp'))).toBe('$env:TEMP');
    expect(pathExpr(normalizeLiteralPath('/tmp/x'))).toBe('($env:TEMP + \'\\x\')');
    expect(pathExpr(normalizeLiteralPath('C:\\plain'))).toBe("'C:\\plain'");
  });

  it('emits script-scope exit flag contract', () => {
    const plan = translateCommandList(parse('ls /nope'))[0];
    expect(plan.script).toContain('$script:fx_exit');
    expect(plan.script).toContain('[Console]::Error.WriteLine');
  });

  it('wraps with UTF-8 and exit propagation', () => {
    const s = wrapScript('x');
    expect(s).toContain('UTF8');
    expect(s).toContain('exit $script:fx_exit');
    expect(s).toContain('[Environment]::CurrentDirectory');
  });

  it('feeds stdin for < redirects', () => {
    const plan = translateCommandList(parse('wc -l < f.txt'))[0];
    expect(plan.script).toContain('fx-readlines $env:FAUXNIX_STDIN_FILE |');
  });

  it('uses functions for multi-stage pipelines (PS 5.1 rule)', () => {
    const plan = translateCommandList(parse('a | b | c'))[0];
    expect(plan.script).toMatch(/function __fx_s\d+/);
    expect(plan.script).toMatch(/__fx_s\d+ \| __fx_s\d+ \| __fx_s\d+/);
  });
});

/* ---------------------------- registry ---------------------------- */

describe('registry helpers', () => {
  it('psStr single-quotes and doubles embedded quotes', () => {
    expect(psStr("it's")).toBe("'it''s'");
  });

  it('parseWords splits flags, values and operands', () => {
    const words = parse('x -abc -n 5 --long=v --file g.txt operand1')
      .segments[0].pipeline.commands[0].args;
    const r = parseWords(words, ['n'], ['--file']);
    expect([...r.flags]).toEqual(['a', 'b', 'c']);
    expect(r.values.get('-n')).toBe('5');
    expect(r.values.get('--long')).toBe('v');
    expect(r.values.get('--file')).toBe('g.txt');
    expect(r.operandWords).toHaveLength(1);
  });

  it('parseWords supports glued short values (-n5)', () => {
    const words = parse('x -n5 f').segments[0].pipeline.commands[0].args;
    const r = parseWords(words, ['n']);
    expect(r.values.get('-n')).toBe('5');
  });

  it('parseWords stops option scanning after --', () => {
    const words = parse('x -- -n').segments[0].pipeline.commands[0].args;
    const r = parseWords(words, ['n']);
    expect(r.operandWords.map((w) => w.map((p) => ('text' in p ? p.text : '')).join(''))).toEqual([
      '-n',
    ]);
  });
});

/* ---------------------------- encoding / errors ---------------------------- */

describe('encoding', () => {
  it('decodes UTF-8 and strips BOM', () => {
    expect(decodeOutput(Buffer.from('\ufeffhéllo', 'utf8'))).toBe('héllo');
  });

  it('falls back to GBK for non-UTF-8 bytes', () => {
    // "中文" in GBK
    expect(decodeOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))).toBe('中文');
  });

  it('encodes -EncodedCommand as UTF-16LE base64', () => {
    expect(Buffer.from(encodeCommand('dir'), 'base64').toString('utf16le')).toBe('dir');
  });
});

describe('normalizeStderr', () => {
  it('rewrites command-not-found (en)', () => {
    expect(normalizeStderr("The term 'foo' is not recognized as a name of a cmdlet")).toBe(
      'bash: foo: command not found',
    );
  });

  it('rewrites command-not-found (zh-CN)', () => {
    expect(normalizeStderr('无法将"foo"项识别为 cmdlet、函数、脚本文件或可运行程序的名称')).toBe(
      'bash: foo: command not found',
    );
  });

  it('rewrites missing-path errors', () => {
    expect(
      normalizeStderr("cat : Cannot find path 'D:\\x\\y' because it does not exist."),
    ).toBe("cat: D:/x/y: No such file or directory");
  });

  it('unwraps CLIXML-serialized errors', () => {
    const xml =
      '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">cat: x: No such file_x000D__x000A_</S></Objs>';
    expect(normalizeStderr(xml)).toContain('cat: x: No such file');
    expect(normalizeStderr(xml)).not.toContain('CLIXML');
  });

  it('drops PS noise lines', () => {
    const out = normalizeStderr('real error\n    + CategoryInfo : ObjectNotFound: (x:String) []');
    expect(out).toBe('real error');
  });
});

/* ---------------------------- tokenizer internals ---------------------------- */

describe('tokenize', () => {
  it('tokenizes operators and words', () => {
    const toks = tokenize('a > b 2> c');
    const ops = toks.filter((t) => t.type === 'OP').map((t) => t.op);
    expect(ops).toEqual(['>', '2>']);
  });
});
