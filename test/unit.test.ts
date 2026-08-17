import { describe, expect, it } from 'vitest';
import { FauxnixParseError, isUnquotedLiteral, wordToString } from '../src/ast.js';
import { parseCommand as parse, tokenize } from '../src/parser.js';
import {
  exprOfWord,
  normalizeLiteralPath,
  pathExpr,
  splatSpec,
  translateCommandList,
  varExpr,
  wrapScript,
} from '../src/translator.js';
import { parseWords, psStr } from '../src/registry.js';
import { decodeOutput, encodeCommand, normalizeHostNewlines } from '../src/encoding.js';
import { normalizeStderr } from '../src/errors.js';
import '../src/commands/install-all.js';

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

  it('parses ${name[index]} subscripts', () => {
    const cmd = parse('echo ${BASH_REMATCH[1]} ${PATH[0]} ${x[@]}').segments[0].pipeline.commands[0];
    expect(cmd.args[0]).toEqual([{ kind: 'Var', name: 'BASH_REMATCH', index: '1' }]);
    expect(cmd.args[1]).toEqual([{ kind: 'Var', name: 'PATH', index: '0' }]);
    expect(cmd.args[2]).toEqual([{ kind: 'Var', name: 'x', index: '@' }]);
  });

  it('detects [@] splat through surrounding quotes', () => {
    const cmd = parse('printf x pre"${a[@]}"post').segments[0].pipeline.commands[0];
    expect(splatSpec(cmd.args[1])).toEqual({ name: 'a', prefix: 'pre', suffix: 'post' });
  });

  it('does not splat quoted ${name[*]}', () => {
    const cmd = parse('printf x "${a[*]}"').segments[0].pipeline.commands[0];
    expect(splatSpec(cmd.args[1])).toBeNull();
  });

  it('splats unquoted ${name[*]}', () => {
    const cmd = parse('printf x ${a[*]}').segments[0].pipeline.commands[0];
    expect(splatSpec(cmd.args[1])).toEqual({ name: 'a', prefix: '', suffix: '' });
  });

  it('indexes ${name[0]} through fx-subget, not $env:', () => {
    expect(varExpr('bash_rematch', '0')).toContain('fx-subget');
    expect(varExpr('bash_rematch', '0')).not.toMatch(/\$env:bash_rematch/i);
    expect(varExpr('PWD', '0')).toContain('fx-subget');
  });

  it('rejects heredocs with a helpful message', () => {
    expect(() => parse('cat <<EOF')).toThrow(FauxnixParseError);
    expect(() => parse('cat <<EOF')).toThrow(/heredoc/);
  });

  it('rejects backticks', () => {
    expect(() => parse('echo `date`')).toThrow(/backtick/);
  });

  it('rejects tokens after the closing ]]', () => {
    expect(() => parse('[[ x ]] junk ; echo BAD')).toThrow(/unexpected token/);
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

  it('does not fold | after == into a glob pattern', () => {
    expect(() => parse('[[ a == a|b ]]')).toThrow(/unexpected token/);
  });

  it('folds | inside an extglob on the == operand', () => {
    const cmd = parse('[[ foo == @(foo|bar) ]]').segments[0].pipeline.commands[0];
    const args = cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join(''));
    expect(args).toEqual(['foo', '==', '@(foo|bar)', ']]']);
  });

  it('keeps regex grouping parentheses on the =~ operand', () => {
    const cmd = parse('[[ ab =~ (ab) ]]').segments[0].pipeline.commands[0];
    expect(
      cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['ab', '=~', '(ab)', ']]']);
  });

  it('splits attached grouping parens but keeps extglob parens', () => {
    const grouped = parse('[[ ("" && "") || "" ]]').segments[0].pipeline.commands[0];
    expect(isUnquotedLiteral(grouped.args[0], '(')).toBe(true);
    expect(grouped.args[1][0].kind).toBe('DoubleQuoted');
    expect(isUnquotedLiteral(grouped.args[2], '&&')).toBe(true);
    expect(grouped.args[3][0].kind).toBe('DoubleQuoted');
    expect(isUnquotedLiteral(grouped.args[4], ')')).toBe(true);
    expect(isUnquotedLiteral(grouped.args[5], '||')).toBe(true);
    expect(grouped.args[6][0].kind).toBe('DoubleQuoted');
    const ext = parse('[[ foo == @(foo|bar) ]]').segments[0].pipeline.commands[0];
    expect(
      ext.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['foo', '==', '@(foo|bar)', ']]']);
  });

  it('folds | inside +( ) and !( ) extglobs', () => {
    const plus = parse('[[ foo == +(foo|bar) ]]').segments[0].pipeline.commands[0];
    expect(
      plus.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['foo', '==', '+(foo|bar)', ']]']);
    const bang = parse('[[ xyz == !(foo|bar) ]]').segments[0].pipeline.commands[0];
    expect(
      bang.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['xyz', '==', '!(foo|bar)', ']]']);
  });

  it('keeps tight || after =~ as regex, not a boolean or', () => {
    const cmd = parse('[[ z =~ a|| ]]').segments[0].pipeline.commands[0];
    const args = cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join(''));
    expect(args).toEqual(['z', '=~', 'a||', ']]']);
  });

  it('accepts a leading | on the =~ operand', () => {
    const cmd = parse('[[ x =~ |x ]]').segments[0].pipeline.commands[0];
    const args = cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join(''));
    expect(args).toEqual(['x', '=~', '|x', ']]']);
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

  it('does not fold tight && after =~ into the regex', () => {
    const cmd = parse('[[ aXXb =~ a&&b ]]').segments[0].pipeline.commands[0];
    expect(
      cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['aXXb', '=~', 'a', '&&', 'b', ']]']);
  });

  it('rejects an unterminated extglob so later segments cannot run', () => {
    expect(() => parse('[[ foo == @(foo ]]; echo BAD')).toThrow(/syntax error/);
  });

  it('rejects an unmatched literal regex open before any list segment can run', () => {
    expect(() => parse('echo BAD; [[ x =~ ( ]]')).toThrow(/conditional expression|end of file/);
    expect(() => parse('echo BAD; [[ x =~ \\( ]]')).not.toThrow();
    expect(() => parse("echo BAD; [[ x =~ '(' ]]")).not.toThrow();
    expect(() => parse('echo BAD; [[ x =~ $re ]]')).not.toThrow();
    expect(() => parse("[[ 'a&b' =~ a&b ]]")).toThrow(/unexpected token/);
    expect(() => parse("[[ 'a&b' == a&b ]]")).toThrow(/unexpected token/);
    expect(() => parse('[[ a&b ]]')).toThrow(/unexpected token/);
    expect(() => parse('[[ x =~ (a&b) ]]')).not.toThrow();
  });

  it('emits the explicit-env fallback used for case-preserved Windows entries', () => {
    const script = translateCommandList(parse('[[ $PATH == x ]]'))[0].script;
    expect(script).toContain('[Environment]::GetEnvironmentVariable');
    expect(script).toContain('FAUXNIX_SETVARS');
    const arith = translateCommandList(parse('[[ PATH -eq 5 ]]'))[0].script;
    expect(arith).toContain('fx-aget');
    expect(arith).toContain('[Environment]::GetEnvironmentVariable');
  });

  it('does not treat quoted @( as an extglob', () => {
    const cmd = parse("[[ '@(' == '@(' ]]").segments[0].pipeline.commands[0];
    expect(cmd.args).toHaveLength(4);
  });

  it('rejects a semicolon after && inside [[ ]]', () => {
    expect(() => parse('[[ x &&; y ]]')).toThrow(/missing/);
  });

  it('accepts a newline after && inside [[ ]] but not after a bare operand', () => {
    const list = parse('[[ -f file &&\n -r file ]]');
    expect(list.segments).toHaveLength(1);
    const inner = list.segments[0].pipeline.commands[0].args.map((w) =>
      w.map((p) => ('text' in p ? p.text : '')).join(''),
    );
    expect(inner).toEqual(['-f', 'file', '&&', '-r', 'file', ']]']);
    expect(parse('[[ x == x\n ]]').segments).toHaveLength(1);
    expect(parse('[[ -n x\n ]]').segments).toHaveLength(1);
    expect(() => parse('[[ x\n ]]; echo BAD')).toThrow(/missing/);
    expect(parse('[[\n -f file ]]').segments).toHaveLength(1);
    expect(parse('[[ !\n -f missing ]]').segments).toHaveLength(1);
    expect(parse('[[ (\n x == x ) ]]').segments).toHaveLength(1);
    expect(() => parse("[[ 'foo(bar)' == foo(bar) ]]")).toThrow(/unexpected token/);
    expect(() => parse('[[ foo(bar) ]]')).toThrow(/unexpected token/);
    expect(() => parse('[[ foo(bar == "foo(bar" ]]')).toThrow(/unexpected token/);
    expect(() => parse('[[ 2>&1 ]]; echo BAD')).toThrow(/unexpected token/);
    expect(() => parse('[[ x =~ x) ]]; echo BAD')).toThrow(/unexpected token/);
  });

  it('keeps spaces inside a grouped =~ / extglob operand', () => {
    const re = parse("[[ ' x ' =~ ( x ) ]]").segments[0].pipeline.commands[0];
    expect(re.args.map(wordToString)).toEqual([' x ', '=~', '( x )', ']]']);
    const ext = parse("[[ 'bar baz' == @(foo|bar baz) ]]").segments[0].pipeline.commands[0];
    expect(ext.args.map(wordToString)).toEqual(['bar baz', '==', '@(foo|bar baz)', ']]']);
    const grouped = parse('[[ ( x =~ ( x ) ) ]]').segments[0].pipeline.commands[0];
    expect(grouped.args.map(wordToString)).toEqual(['(', 'x', '=~', '( x )', ')', ']]']);
    const tight = parse('[[ ( x =~ ( x)) ]]').segments[0].pipeline.commands[0];
    expect(tight.args.map(wordToString)).toEqual(['(', 'x', '=~', '( x)', ')', ']]']);
    const spacedAlt = parse("[[ 'a c' =~ (a | b)c ]]").segments[0].pipeline.commands[0];
    expect(spacedAlt.args.map(wordToString)).toEqual(['a c', '=~', '(a | b)c', ']]']);
    const spacedExt = parse("[[ 'x ' == @(x | y) ]]").segments[0].pipeline.commands[0];
    expect(spacedExt.args.map(wordToString)).toEqual(['x ', '==', '@(x | y)', ']]']);
  });

  it('keeps regex-balanced parens inside a grouped =~', () => {
    const cmd = parse('[[ ( x =~ (x) ) ]]').segments[0].pipeline.commands[0];
    expect(
      cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['(', 'x', '=~', '(x)', ')', ']]']);
  });

  it('peels a grouping close attached to a =~ operand', () => {
    const cmd = parse('[[ ( x =~ x) ]]').segments[0].pipeline.commands[0];
    expect(
      cmd.args.map((w) => w.map((p) => ('text' in p ? p.text : '')).join('')),
    ).toEqual(['(', 'x', '=~', 'x', ')', ']]']);
  });

  it('treats newline after && inside [[ ]] as whitespace', () => {
    const list = parse('[[ -f a &&\n -f b ]]');
    expect(list.segments).toHaveLength(1);
    const inner = list.segments[0].pipeline.commands[0].args.map((w) =>
      w.map((p) => ('text' in p ? p.text : '')).join(''),
    );
    expect(inner).toEqual(['-f', 'a', '&&', '-f', 'b', ']]']);
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

  it('scopes VAR=value prefixes and evaluates values before applying them', () => {
    const leak = translateCommandList(parse('FOO=bar echo x'))[0].script;
    expect(leak).toContain('try {');
    expect(leak).toContain('finally {');
    expect(leak).toMatch(/Remove-Item -LiteralPath 'Env:\\FOO'/);
    const both = translateCommandList(parse('A=1 B=$A echo x'))[0].script;
    const evalB = both.indexOf('$env:A');
    const applyA = both.indexOf('$env:A =');
    // `$env:A` in the B value is captured before `$env:A =` applies A=1
    expect(evalB).toBeGreaterThan(-1);
    expect(applyA).toBeGreaterThan(evalB);
    const exported = translateCommandList(parse('FOO=bar export FOO'))[0].script;
    expect(exported).toContain('$env:FOO =');
    expect(exported).not.toMatch(/\$fx_ek\d+/);
    const dyn = translateCommandList(parse('FOO=bar export "$NAME"'))[0].script;
    expect(dyn).toMatch(/\$fx_ek\d+/);
    const once = translateCommandList(parse('T=x export X=$(echo once)'))[0].script;
    expect(once).not.toMatch(/\$fx_ek\d+/);
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

  it('normalizeHostNewlines strips PS-host CRLF but keeps exact payloads', () => {
    expect(normalizeHostNewlines('apple\r\nBanana\r\n')).toBe('apple\nBanana\n');
    expect(normalizeHostNewlines('a\r\nb')).toBe('a\r\nb');
    expect(normalizeHostNewlines('a\r\nb\n')).toBe('a\r\nb\n');
    expect(normalizeHostNewlines('abc')).toBe('abc');
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
