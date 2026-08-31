import { readFileSync } from 'node:fs';
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
  hostBootstrapScript,
} from '../src/translator.js';
import { listCommandsJson, lookup, lookupSpec, parseWords, psStr } from '../src/registry.js';
import { decodeOutput, encodeCommand, normalizeHostNewlines } from '../src/encoding.js';
import { normalizeStderr } from '../src/errors.js';
import { decodeHostResponse, encodeHostRequest, parseHostLine } from '../src/ps-host.js';
import { bashToolResult, formatBashText } from '../src/mcp.js';
import '../src/commands/install-all.js';
import { specsMarkdown } from '../src/registry.js';

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

  it('quoted cmdsub and assignments keep newlines; unquoted splits', () => {
    const q = parse('echo "$(printf a)"').segments[0].pipeline.commands[0];
    expect(exprOfWord(q.args[0])).toContain('fx-csub');
    expect(exprOfWord(q.args[0])).not.toContain("-join ' '");
    const u = parse('echo $(printf a)').segments[0].pipeline.commands[0];
    expect(exprOfWord(u.args[0])).toContain("-join ' '");
    const a = parse('X=$(printf a)').segments[0].pipeline.commands[0];
    expect(exprOfWord(a.assignments[0].value, { preserveCmdSub: true })).toContain('fx-csub');
    expect(exprOfWord(a.assignments[0].value, { preserveCmdSub: true })).not.toContain("-join ' '");
  });

  it('set -e is a loud usage error, not a silent no-op', () => {
    const script = translateCommandList(parse('set -e'))[0].script;
    expect(script).toMatch(/set -e\/-u\/-x is not supported/);
    expect(script).toContain('$script:fx_exit = 2');
  });

  it('parses ${name:-word} parameter defaults', () => {
    const cmd = parse('echo ${X:-def} ${Y:+on} ${Z:?err}').segments[0].pipeline.commands[0];
    expect(cmd.args[0]).toEqual([{ kind: 'Var', name: 'X', param: { op: ':-', word: 'def' } }]);
    expect(cmd.args[1]).toEqual([{ kind: 'Var', name: 'Y', param: { op: ':+', word: 'on' } }]);
    expect(cmd.args[2]).toEqual([{ kind: 'Var', name: 'Z', param: { op: ':?', word: 'err' } }]);
  });

  it('parses ${#name} and ${#name[@]}', () => {
    const cmd = parse('echo ${#X} ${#Y[@]}').segments[0].pipeline.commands[0];
    expect(cmd.args[0]).toEqual([{ kind: 'Var', name: 'X', length: true }]);
    expect(cmd.args[1]).toEqual([{ kind: 'Var', name: 'Y', index: '@', length: true }]);
  });

  it('parses if/then/else/fi as one compound command', () => {
    const list = parse('if true; then echo x; else echo y; fi');
    expect(list.segments).toHaveLength(1);
    const c = list.segments[0].pipeline.commands[0];
    expect(c.kind).toBe('If');
    if (c.kind !== 'If') return;
    expect(c.then.segments).toHaveLength(1);
    expect(c.else?.segments).toHaveLength(1);
  });

  it('parses elif as a nested If in the else branch', () => {
    const list = parse('if false; then echo a; elif true; then echo b; else echo c; fi');
    const c = list.segments[0].pipeline.commands[0];
    expect(c.kind).toBe('If');
    if (c.kind !== 'If') return;
    const inner = c.else?.segments[0].pipeline.commands[0];
    expect(inner?.kind).toBe('If');
    if (inner?.kind !== 'If') return;
    expect(inner.else?.segments).toHaveLength(1);
  });

  it('parses for name in words; do ...; done', () => {
    const list = parse('for x in a b c; do echo $x; done');
    const c = list.segments[0].pipeline.commands[0];
    expect(c.kind).toBe('For');
    if (c.kind !== 'For') return;
    expect(c.name).toBe('x');
    expect(c.words).toHaveLength(3);
  });

  it('parses ${name[index]} subscripts', () => {
    const cmd = parse('echo ${BASH_REMATCH[1]} ${PATH[0]} ${x[@]}').segments[0].pipeline.commands[0];
    expect(cmd.args[0]).toEqual([{ kind: 'Var', name: 'BASH_REMATCH', index: '1' }]);
    expect(cmd.args[1]).toEqual([{ kind: 'Var', name: 'PATH', index: '0' }]);
    expect(cmd.args[2]).toEqual([{ kind: 'Var', name: 'x', index: '@' }]);
  });

  it('registers command as a builtin', () => {
    expect(lookup('command')).toBeTypeOf('function');
  });

  it('detects [@] splat through surrounding quotes', () => {
    const cmd = parse('printf x pre"${a[@]}"post').segments[0].pipeline.commands[0];
    expect(splatSpec(cmd.args[1])).toEqual({ name: 'a', prefix: 'pre', suffix: 'post' });
  });

  it('does not splat quoted ${name[*]}', () => {
    const cmd = parse('printf x "${a[*]}"').segments[0].pipeline.commands[0];
    expect(splatSpec(cmd.args[1])).toBeNull();
  });

  it('promotes the next word when a command-position [@] is empty', () => {
    const empty = translateCommandList(parse('${X[@]}'))[0].script;
    expect(empty).toContain('if ($fx_cw.Count -eq 0)');
    expect(empty).not.toContain("bash: : command not found");
    const one = translateCommandList(parse('${X[@]} printf %s hi'))[0].script;
    expect(one).toContain('fx-printf');
    expect(one).toContain('[object[]]');
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

  it('rejects trailing && / || instead of dropping them', () => {
    expect(() => parse('echo BEFORE &&')).toThrow(/unexpected end of file after `&&'/);
    expect(() => parse('echo BEFORE ||')).toThrow(/unexpected end of file after `\\|\\|'/);
    expect(() => parse('echo a &&\n')).toThrow(/unexpected end of file after `&&'/);
    expect(() => parse('if true &&; then echo x; fi')).toThrow(/unexpected token `&&'/);
    expect(parse('echo a && echo b').segments).toHaveLength(2);
  });

  it('rejects ;; instead of treating it as extra semicolons', () => {
    expect(() => parse('echo A;; echo B')).toThrow(/unexpected token `;;'/);
    expect(() => parse('echo A; ; echo B')).toThrow(/unexpected token `;;'/);
    expect(parse('echo A; echo B').segments).toHaveLength(2);
  });

  it('env -i is a loud usage error, not a silent ignore', () => {
    const script = translateCommandList(parse('env -i echo hi'))[0].script;
    expect(script).toMatch(/env -i\/--ignore-environment is not supported/);
    expect(script).toContain('$script:fx_exit = 2');
    expect(script).not.toContain("fx-write");
  });

  it('parses word-level $((...)) as Arith, not $( (expr) )', () => {
    const cmd = parse('echo $((1+1))').segments[0].pipeline.commands[0];
    expect(cmd.kind).toBe('SimpleCommand');
    if (cmd.kind !== 'SimpleCommand') return;
    expect(cmd.args[0].some((p) => p.kind === 'Arith')).toBe(true);
    expect(wordToString(cmd.args[0])).toBe('$((1+1))');
    const quoted = parse('echo "$((x+1))"').segments[0].pipeline.commands[0];
    if (quoted.kind !== 'SimpleCommand') return;
    const dq = quoted.args[0].find((p) => p.kind === 'DoubleQuoted');
    expect(dq && dq.kind === 'DoubleQuoted' && dq.parts.some((p) => p.kind === 'Arith')).toBe(true);
    expect(() => parse('X=$((x+1))')).not.toThrow();
    expect(() => parse('echo $((1+1')).toThrow(/unclosed/);
    // space after $( is command substitution of a grouped body, not arith
    expect(() => parse('echo $( (true) )')).not.toThrow(/unclosed/);
  });

  it('parses backticks as command substitution', () => {
    const cmd = parse('echo `date +%Y`').segments[0].pipeline.commands[0];
    expect(cmd.args[0].some((p) => p.kind === 'CmdSub' && p.cmd === 'date +%Y')).toBe(true);
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

  it('host-mode wrapScript does not exit and skips helper re-emit', () => {
    const s = wrapScript('echo ${X[@]}', { mode: 'host' });
    expect(s).not.toContain('exit $script:fx_exit');
    expect(s).toContain('$script:fx_exit = 0');
    expect(s).toContain('[Environment]::CurrentDirectory');
    expect(s).not.toContain('function fx-arrload');
    expect(s).not.toContain('function fx-csub');
  });

  it('host bootstrap loads helpers and speaks JSON lines without exit', () => {
    const boot = hostBootstrapScript();
    expect(boot).toContain('function fx-arrload');
    expect(boot).toContain('function fx-csub');
    expect(boot).toContain('function fx-native');
    expect(boot).toContain('function fx-winargv');
    expect(boot).toContain('"type":"ready"');
    expect(boot).toContain('FAUXNIX_ERR_END:');
    expect(boot).toContain('maxChunkBytes');
    expect(boot).toContain('ConvertFrom-Json');
    expect(boot).toContain('MaxJsonLength');
    expect(boot).not.toContain('exit $script:fx_exit');
  });

  it('omits unused wrapScript helpers on a body that calls none of them', () => {
    const s = wrapScript('x');
    expect(s).not.toContain('function fx-arrload');
    expect(s).not.toContain('function fx-csub');
    expect(s).not.toContain('function fx-readlines');
    expect(s).not.toContain('function fx-subget');
  });

  it('emits only the wrapScript helpers a translation actually calls', () => {
    const echo = translateCommandList(parse('echo hi'))[0].script;
    expect(echo).not.toContain('function fx-arrload');
    expect(echo).not.toContain('function fx-csub');
    const splat = translateCommandList(parse('echo ${X[@]}'))[0].script;
    expect(splat).toContain('function fx-arrload');
    expect(splat).toContain('function fx-scalar0');
    expect(splat).not.toContain('function fx-csub');
    const csub = translateCommandList(parse('echo $(echo a)'))[0].script;
    expect(csub).toContain('function fx-csub');
    const stdin = translateCommandList(parse('wc -l < f.txt'))[0].script;
    expect(stdin).toContain('function fx-readlines');
    const arith = translateCommandList(parse('echo $((1+1))'))[0];
    expect(arith.body).toContain('fx-arith');
    expect(arith.script).toContain('function fx-arith');
    expect(echo).not.toContain('function fx-arith');
  });

  it('keeps grep short flag bundles separate from long-option values', () => {
    const body = translateCommandList(parse('grep -rn TODO src'))[0].body;
    expect(body).toContain("$fx_pat = 'TODO'");
    expect(body).toContain('$fx_fsel = @()');
    expect(body).toContain("foreach ($fx_o in (@('src')))");
    expect(body).toContain('$fx_recd = $true');
  });

  it('preserves repeated grep file filters in command-line order', () => {
    const body = translateCommandList(
      parse(
        "grep -r --include='*.ts' --exclude '*.test.ts' --include=*.tsx --exclude='*.snap' --exclude-dir node_modules --exclude-dir=dist token src",
      ),
    )[0].body;
    const includeTs = body.indexOf("Keep = $true; Glob = '*.ts'");
    const excludeTest = body.indexOf("Keep = $false; Glob = '*.test.ts'");
    const includeTsx = body.indexOf("Keep = $true; Glob = '*.tsx'");
    const excludeSnap = body.indexOf("Keep = $false; Glob = '*.snap'");
    expect(includeTs).toBeGreaterThan(-1);
    expect(excludeTest).toBeGreaterThan(includeTs);
    expect(includeTsx).toBeGreaterThan(excludeTest);
    expect(excludeSnap).toBeGreaterThan(includeTsx);
    expect(body).toContain("$fx_excd = @('node_modules', 'dist')");
    expect(body).toContain("foreach ($fx_o in (@('src')))");
  });

  it('reports a missing grep file-filter value', () => {
    const body = translateCommandList(parse('grep token file --exclude-dir'))[0].body;
    expect(body).toContain("grep: option ''--exclude-dir'' requires an argument");
    expect(body).toContain('$script:fx_exit = 2');
  });

  it('native passthrough uses fx-native instead of call-operator splat', () => {
    const body = translateCommandList(parse('node --version'))[0].body;
    expect(body).toContain('fx-native');
    expect(body).not.toContain('@fx_na');
    const script = translateCommandList(parse('node --version'))[0].script;
    expect(script).toContain('ReadToEndAsync');
    expect(script).not.toContain('StartNew');
    expect(script).toContain("'.cmd'");
    expect(script).toContain("if ($null -eq $argv) { $argv = @() }");
  });

  it('curl translation uses fx-native, not call-operator splat', () => {
    const plan = translateCommandList(parse('curl -s https://example.com/x'))[0];
    expect(plan.body).toContain('fx-native');
    expect(plan.body).not.toContain("& 'curl.exe' @");
    expect(plan.body.indexOf('fx-netguard')).toBeGreaterThan(-1);
    expect(plan.body.indexOf('fx-netguard')).toBeLessThan(plan.body.indexOf('fx-native'));
    expect(plan.script).toContain('function fx-native');
  });

  it('tar translation uses fx-native, not call-operator splat', () => {
    const plan = translateCommandList(parse('tar -tf a.tar'))[0];
    expect(plan.body).toContain('fx-native');
    expect(plan.body).toContain('$env:SystemRoot\\System32\\tar.exe');
    expect(plan.body).not.toContain('& $fx_tar @($fx_args)');
    expect(plan.script).toContain('function fx-native');
  });

  it('xargs native invoke uses fx-native instead of call-operator splat', () => {
    const plan = translateCommandList(parse('xargs node'))[0];
    expect(plan.body).toContain('fx-native $fx_cmd $fx_argv');
    expect(plan.body).not.toContain('@fx_argv');
    expect(plan.body).not.toContain('& $fx_cmd');
    expect(plan.body).not.toContain('$LASTEXITCODE');
    expect(plan.body).toContain("-split '[ \\t]+'");
    expect(plan.script).toContain('function fx-native');
    const n = translateCommandList(parse('xargs -n 1 node'))[0].body;
    expect(n).toContain('fx-native $fx_cmd $fx_argv');
    expect(n).toContain('$fx_j -lt 1');
    const repl = translateCommandList(parse('xargs -I {} node dump-argv.js {}'))[0].body;
    expect(repl).toContain('fx-native $fx_cmd $fx_argv');
    expect(repl).toContain(".Contains('{}')");
    expect(repl).not.toContain("-split '[ \\t]+'");
    const empty = translateCommandList(parse('xargs --no-run-if-empty node'))[0].body;
    expect(empty).toContain('$fx_args.Count -eq 0');
    expect(empty).toContain('fx-native $fx_cmd $fx_argv');
    const trace = translateCommandList(parse('xargs -t node'))[0].body;
    expect(trace).toContain('[Console]::Error.WriteLine');
    expect(trace).toContain('$true');
    const builtin = translateCommandList(parse('xargs grep'))[0].body;
    expect(builtin).toContain('xargs currently passes arguments to native commands');
  });

  it('quotes cmd metacharacters on the .cmd /c tail', () => {
    const script = translateCommandList(parse('node --version'))[0].script;
    expect(script).toContain('fx-winargv $argv $true');
    expect(script).toContain('/d /s /c "');
    expect(script).toContain("'&'");
    expect(script).toContain("'|'");
    const list = parse("./hit.cmd 'a&b'");
    expect(list.segments).toHaveLength(1);
    const body = translateCommandList(list)[0].body;
    expect(body).toContain('fx-native');
    expect(body).toContain('a&b');
  });

  it('re-splits printf-style stdin for grep and other text-filters', () => {
    const split = 'fx-splitlines $fx_it';
    const cmds = ['grep b', "sed 's/a/A/'", "awk '{print}'", 'sort', 'uniq', 'tr a b'];
    for (const cmd of cmds) {
      const body = translateCommandList(parse(cmd))[0].body;
      expect(body, cmd).toContain(split);
      expect(body, cmd).toContain('$input | ForEach-Object { [string]$_ }');
    }
    const grepHi = translateCommandList(parse('grep hi'))[0].body;
    expect(grepHi).toContain('$fx_ls = $fx_in');
  });

  it('feeds stdin for < redirects', () => {
    const plan = translateCommandList(parse('wc -l < f.txt'))[0];
    expect(plan.script).toContain('fx-readlines $env:FAUXNIX_STDIN_FILE |');
    expect(plan.stdinRedirects).toEqual([{ op: '<', target: 'f.txt' }]);
  });

  it('middle-stage < is owned by that stage, not stage zero', () => {
    const plan = translateCommandList(parse('printf x | cat < fruits.txt | head -1'))[0];
    expect(plan.stdinRedirects).toEqual([]);
    expect(plan.body).toContain('fx-readlines');
    expect(plan.body).toContain('fruits.txt');
    expect(plan.body).not.toContain('fx-readlines $env:FAUXNIX_STDIN_FILE');
  });

  it('uses functions for multi-stage pipelines (PS 5.1 rule)', () => {
    const plan = translateCommandList(parse('a | b | c'))[0];
    expect(plan.script).toMatch(/function __fx_s\d+/);
    expect(plan.script).toMatch(/__fx_s\d+ \| __fx_s\d+ \| __fx_s\d+/);
  });

  it.each([
    ['false | true', 0],
    ['true | false', 1],
  ])('isolates stage exit flags for %s (failing stage %i)', (command, failingStage) => {
    const plan = translateCommandList(parse(command))[0];
    const statusName = plan.body.match(/\$(fx_pipe_status\d+) = @\(0, 0\)/)?.[1];
    expect(statusName).toBeDefined();
    expect(plan.body).toContain(`$${statusName}[${failingStage}] = 1`);
    expect(plan.body).toContain(`$script:fx_exit = [int]$${statusName}[1]`);
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

describe('persistent PowerShell host protocol', () => {
  it('round-trips script bytes and env unsets through JSON lines', () => {
    const script = 'Write-Output "hi"\n$script:fx_exit = 0';
    const line = encodeHostRequest('abc', script, { FAUXNIX_STDIN_FILE: '', FAUXNIX_CWD: 'D:\\tmp' });
    expect(line).not.toContain('\n');
    const parsed = JSON.parse(line) as { id: string; scriptB64: string; env: Record<string, string> };
    expect(parsed.id).toBe('abc');
    expect(Buffer.from(parsed.scriptB64, 'base64').toString('utf8')).toBe(script);
    expect(parsed.env.FAUXNIX_STDIN_FILE).toBe('');
    expect(parsed.env.FAUXNIX_CWD).toBe('D:\\tmp');
  });

  it('decodes base64 stdout/stderr and the ready handshake', () => {
    const stdoutB64 = Buffer.from('hi\n', 'utf8').toString('base64');
    const stderrB64 = Buffer.from('err', 'utf8').toString('base64');
    const msg = decodeHostResponse(
      JSON.stringify({ id: 'abc', stdoutB64, stderrB64, exitCode: 2 }),
    );
    expect(msg.id).toBe('abc');
    expect(msg.stdout.toString('utf8')).toBe('hi\n');
    expect(msg.stderr.toString('utf8')).toBe('err');
    expect(msg.exitCode).toBe(2);
    expect(decodeHostResponse('{"ready":true}').ready).toBe(true);
  });

  it('encodes v2 run frames and parses v2 ready / v1 ready', () => {
    const line = encodeHostRequest('r1', 'echo', { FAUXNIX_CWD: 'D:\\tmp' }, { v: 2, stdoutLimit: 10, stderrLimit: 4 });
    const parsed = JSON.parse(line) as { v: number; type: string; stdoutLimit: number };
    expect(parsed.v).toBe(2);
    expect(parsed.type).toBe('run');
    expect(parsed.stdoutLimit).toBe(10);
    expect(parseHostLine('{"v":2,"type":"ready","capabilities":{"cancel":false}}').v2?.type).toBe(
      'ready',
    );
    expect(parseHostLine('{"ready":true}').v1Ready).toBe(true);
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

describe('bounded output flags (#130)', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;

  it('grep -m / --max-count stop after N matching lines', () => {
    expect(bodyOf('grep -m1 pat f')).toContain('$fx_mleft = 1');
    expect(bodyOf('grep --max-count=2 pat f')).toContain('$fx_mleft = 2');
    expect(bodyOf('grep pat f')).not.toContain('$fx_mleft');
  });

  it('grep -e / --regexp keep the pattern (not an unknown flag)', () => {
    expect(bodyOf('grep -e apple fruits.txt')).toContain('fx-gmatch');
    expect(bodyOf('grep -e apple fruits.txt')).toContain("$fx_pat = 'apple'");
    expect(bodyOf('grep -e apple fruits.txt')).not.toContain('invalid option');
    expect(bodyOf('grep --regexp apple fruits.txt')).toContain("$fx_pat = 'apple'");
    expect(bodyOf('grep --regexp=apple fruits.txt')).toContain("$fx_pat = 'apple'");
  });

  it('grep -e / --regexp repeats OR-accumulate (#143)', () => {
    const short = bodyOf('grep -e a -e c f');
    expect(short).toContain("$fx_pat = '(?:a)|(?:c)'");
    expect(short).toContain("foreach ($fx_o in (@('f')))");
    expect(short).not.toContain("$fx_pat = 'c'");
    expect(short).toContain('return $fx_re.IsMatch($l)');

    const longs = bodyOf('grep --regexp a --regexp=c f');
    expect(longs).toContain("$fx_pat = '(?:a)|(?:c)'");
    expect(longs).toContain("foreach ($fx_o in (@('f')))");

    const mixed = bodyOf('grep -e a --regexp=c f');
    expect(mixed).toContain("$fx_pat = '(?:a)|(?:c)'");

    const glued = bodyOf('grep -ea -ec f');
    expect(glued).toContain("$fx_pat = '(?:a)|(?:c)'");
  });

  it('grep -v -e a -e c inverts the combined OR once (#143)', () => {
    const body = bodyOf('grep -v -e a -e c f');
    expect(body).toContain("$fx_pat = '(?:a)|(?:c)'");
    expect(body).toContain('return -not ($fx_re.IsMatch($l))');
    expect(body).not.toContain('return -not ($fx_re.IsMatch($l))\n  return -not');
  });

  it('grep -F -o with multiple -e collects matches by position then length', () => {
    const body = bodyOf('grep -F -o -e a -e b');
    expect(body).toContain('$fx_needles = @(');
    expect(body).toContain('$fx_cands');
    expect(body).toContain('Sort-Object Start');
    expect(body).toContain('Descending = $true');
    expect(body).toContain('$fx_c.Start -ge $fx_end');
    expect(body).toContain('fx-emitline $fx_i ($fx_l.Substring($fx_c.Start, $fx_c.Len))');
    expect(body).not.toMatch(/foreach \(\$fx_needle in \$fx_needles\) \{[\s\S]*fx-emitline \$fx_i \(\$fx_l\.Substring\(\$p/);
  });

  it('grep -F -o single pattern still emits via position-ordered candidates', () => {
    const body = bodyOf('grep -F -o a f');
    expect(body).toContain('$fx_cands');
    expect(body).toContain('$fx_needle = ');
    expect(body).not.toContain('$fx_needles');
    expect(body).toContain('fx-emitline $fx_i ($fx_l.Substring($fx_c.Start, $fx_c.Len))');
  });

  it('grep -F -e a -e b without -o still ORs whole lines', () => {
    const body = bodyOf('grep -F -e a -e b f');
    expect(body).not.toContain('$fx_cands');
    expect(body).toContain('$fx_needles = @(');
    expect(body).toContain('.Contains($fx_needle)');
    expect(body).toContain('fx-gmatch');
  });

  it('grep with no pattern fails loud with usage', () => {
    const body = bodyOf('grep');
    expect(body).toContain('usage: grep [OPTION]... PATTERN [FILE]...');
    expect(body).toContain('$script:fx_exit = 2');
    expect(bodyOf('grep -v')).toContain('usage: grep [OPTION]... PATTERN [FILE]...');
  });

  it('head --lines and --lines=N set the count (not silently skipped)', () => {
    expect(bodyOf('head --lines=1 fruits.txt')).toContain('$fx_count = [int](1)');
    expect(bodyOf('head --lines 3 fruits.txt')).toContain('$fx_count = [int](3)');
    expect(bodyOf('head fruits.txt')).toContain('$fx_count = [int](10)');
  });

  it('head --lines=-N uses count+length (all but last N lines)', () => {
    const body = bodyOf('head --lines=-1 fruits.txt');
    expect(body).toContain('$fx_count = [int](-1)');
    expect(body).toContain('$fx_ls.Count + $fx_count');
  });

  it('head --bytes=-N uses length + negative count (not Min/clamp-to-0 first)', () => {
    const body = bodyOf('head --bytes=-1 fruits.txt');
    expect(body).toContain('$fx_count = [int](-1)');
    expect(body).toContain('$fx_txt.Length + $fx_count');
    expect(body).toMatch(/if \(\$fx_count -lt 0\)/);
    // old bug: Min(-N, length) then clamp $fx_len to 0 → empty output
    expect(body).not.toMatch(
      /\$fx_len = \[math\]::Min\(\$fx_count, \$fx_txt\.Length\)\s+if \(\$fx_len -lt 0\) \{ \$fx_len = 0 \}/,
    );
  });

  it('du --max-depth filters subdirectory rows', () => {
    expect(bodyOf('du --max-depth=0')).toContain('if ($true)');
    expect(bodyOf('du --max-depth=0')).not.toContain('$fx_ddepth');
    expect(bodyOf('du --max-depth=1')).toContain('$fx_ddepth');
    expect(bodyOf('du --max-depth=1')).toContain('-gt 1');
    expect(bodyOf('du -s --max-depth=1')).toContain('summarizing conflicts');
    expect(bodyOf('du .')).not.toContain('$fx_ddepth');
  });
});

describe('CommandSpec (#130)', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;

  it('cp -n / --no-clobber skip an existing dest instead of overwriting', () => {
    expect(bodyOf('cp -n src dst')).toContain('$true -and (Test-Path -LiteralPath $fx_target)');
    expect(bodyOf('cp --no-clobber src dst')).toContain(
      '$true -and (Test-Path -LiteralPath $fx_target)',
    );
    expect(bodyOf('cp src dst')).toContain('$false -and (Test-Path -LiteralPath $fx_target)');
  });

  it('cp rejects unknown and unsupported options before Copy-Item', () => {
    const z = bodyOf('cp -z a b');
    expect(z).toContain("invalid option -- ''z''");
    expect(z).toContain('$script:fx_exit = 1');
    expect(z).not.toContain('Copy-Item');
    expect(bodyOf('cp -i a b')).toContain("option ''-i'' is not supported by fauxnix");
    expect(bodyOf('cp --preserve a b')).toContain("unrecognized option ''--preserve''");
  });

  it('mv -n skips an existing dest', () => {
    expect(bodyOf('mv -n src dst')).toContain('$true -and (Test-Path -LiteralPath $fx_target)');
    expect(bodyOf('mv src dst')).toContain('$false -and (Test-Path -LiteralPath $fx_target)');
  });

  it('touch -c does not create missing files', () => {
    expect(bodyOf('touch -c missing')).toContain('if ($true) { continue }');
    expect(bodyOf('touch --no-create missing')).toContain('if ($true) { continue }');
    expect(bodyOf('touch missing')).toContain('if ($false) { continue }');
    expect(bodyOf('touch missing')).toContain('New-Item -ItemType File');
  });

  it('tee --append and -a append; bare tee truncates', () => {
    expect(bodyOf('tee --append out.txt')).toContain('if ($true)');
    expect(bodyOf('tee -a out.txt')).toContain('if ($true)');
    expect(bodyOf('tee out.txt')).toContain('if ($false)');
  });

  it('spec\'d rm fails loud on unknown flags', () => {
    const rm = bodyOf('rm -z x');
    expect(rm).toContain("invalid option -- ''z''");
    expect(rm).not.toContain('Remove-Item');
  });

  it('rm --verbose matches -v; tee -i is not silently ignored', () => {
    expect(bodyOf('rm --verbose x')).toContain('if ($true)');
    expect(bodyOf('rm x')).toContain('if ($false)');
    expect(bodyOf('tee -i out.txt')).toContain("invalid option -- ''i''");
  });

  it('listCommandsJson exposes migrated specs and null for legacy handlers', () => {
    const rows = listCommandsJson();
    const cp = rows.find((r) => r.name === 'cp');
    expect(cp?.spec?.effects).toEqual(['read', 'write']);
    expect(cp?.spec?.options.some((o) => o.short === 'n' && o.support === 'implemented')).toBe(
      true,
    );
    expect(rows.find((r) => r.name === 'ls')?.spec).toBeTruthy();
    expect(lookupSpec('cp')).toBeTruthy();
    expect(lookupSpec('ls')).toBeTruthy();
    expect(lookupSpec('find')).toBeUndefined();
    expect(lookup('tee')).toBeTypeOf('function');
  });
});

describe('CommandSpec files leftovers (#130)', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;

  it('ls unknown flags fail loud; --format=long still means -l', () => {
    expect(bodyOf('ls -Z')).toContain("invalid option -- ''Z''");
    expect(bodyOf('ls --format=long')).toContain("'{0} 1");
    expect(bodyOf('ls --recursive')).toContain('not supported by fauxnix');
  });

  it('chmod -R is unsupported; find stays unspec\'d so -name still compiles', () => {
    expect(bodyOf('chmod -R 644 x')).toContain('not supported by fauxnix');
    expect(bodyOf("find . -name '*.ts'")).toContain('-clike');
    expect(lookupSpec('find')).toBeUndefined();
  });

  it('mkdir --verbose and ln --symbolic are implemented longs', () => {
    expect(bodyOf('mkdir --verbose d')).toContain('if ($true)');
    expect(bodyOf('ln --symbolic a b')).toContain('SymbolicLink');
  });
});

describe('command-specs.md (#143)', () => {
  it('equals specsMarkdown() from the live registry', () => {
    const onDisk = readFileSync(new URL('../docs/command-specs.md', import.meta.url), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    expect(onDisk).toBe(specsMarkdown());
  });
});

describe('CommandSpec text-io leftovers (#143)', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;

  it('echo is spec\'d; unknown -z is a usage error with exit 2', () => {
    expect(lookupSpec('echo')).toBeTruthy();
    const z = bodyOf('echo -z');
    expect(z).toContain("invalid option -- ''z''");
    expect(z).toContain('$script:fx_exit = 2');
    expect(z).toContain("Try ''echo --help'' for more information.");
    expect(z).not.toContain('fx-write');
  });

  it('echo -n/-e/-E and bundles still compile; operands may look like flags', () => {
    expect(bodyOf('echo -n abc')).toContain('fx-write $fx_s $fx_term');
    expect(bodyOf('echo -n abc')).not.toContain('invalid option');
    expect(bodyOf('echo -e x')).toContain('$fx_s = fx-unesq $fx_s');
    expect(bodyOf('echo -ne x')).toContain('$fx_s = fx-unesq $fx_s');
    expect(bodyOf('echo -ne x')).toContain('fx-write $fx_s $fx_term');
    expect(bodyOf('echo -E x')).not.toContain('$fx_s = fx-unesq $fx_s');
    expect(bodyOf('echo hello -z')).toContain('fx-write');
    expect(bodyOf('echo hello -z')).not.toContain('invalid option');
  });

  it('printf has no option flags; --help fails loud; format operands still work', () => {
    expect(lookupSpec('printf')).toBeTruthy();
    const help = bodyOf('printf --help');
    expect(help).toContain("unrecognized option ''--help''");
    expect(help).toContain('$script:fx_exit = 2');
    expect(help).not.toContain('fx-printf');
    const z = bodyOf('printf -z');
    expect(z).toContain("invalid option -- ''z''");
    expect(bodyOf("printf '%s' -n")).toContain('fx-printf');
    expect(bodyOf("printf '%s' -n")).not.toContain('invalid option');
    expect(bodyOf("printf '%s=%d\\n' x 42")).toContain('fx-printf');
  });

  it('cat --no-such fails; implemented shorts still compile', () => {
    expect(lookupSpec('cat')).toBeTruthy();
    const unknown = bodyOf('cat --no-such');
    expect(unknown).toContain("unrecognized option ''--no-such''");
    expect(unknown).not.toContain('fx-read');
    expect(bodyOf('cat -n f')).toContain("'all'");
    expect(bodyOf('cat -n f')).not.toContain('invalid option');
    expect(bodyOf('cat -nbsETA f')).not.toContain('invalid option');
    expect(bodyOf('cat -nbsETA f')).toContain('fx-read');
  });

  it('tail --lines/-n/-c and legacy +/-N still compile; -f is unsupported', () => {
    expect(lookupSpec('tail')).toBeTruthy();
    expect(bodyOf('tail --lines=1 f')).toContain('$fx_count = [int](1)');
    expect(bodyOf('tail -n 2 f')).toContain('$fx_count = [int](2)');
    expect(bodyOf('tail -1 f')).toContain('$fx_count = [int](1)');
    expect(bodyOf('tail +1 f')).toContain('$fx_from = $true');
    expect(bodyOf('tail -c 3 f')).toContain('$fx_count = [int](3)');
    const follow = bodyOf('tail -f f');
    expect(follow).toContain("option ''-f'' is not supported by fauxnix");
    expect(follow).toContain('no persistent tty');
    expect(follow).not.toContain('fx-read');
  });

  it('wc -l/-w/-c/-m are spec\'d; find/xargs/nl stay unspec\'d', () => {
    expect(lookupSpec('wc')).toBeTruthy();
    expect(bodyOf('wc -lwm f')).not.toContain('invalid option');
    expect(bodyOf('wc -lwm f')).toContain('fx-wcline');
    expect(lookupSpec('find')).toBeUndefined();
    expect(lookupSpec('xargs')).toBeUndefined();
    expect(lookupSpec('nl')).toBeUndefined();
    expect(lookupSpec('tac')).toBeUndefined();
  });
});

describe('find predicates (#130)', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;
  const throws = (cmd: string, msg: string) => {
    expect(() => translateCommandList(parse(cmd))).toThrow(msg);
  };

  it('compiles ! and -o instead of ignoring them', () => {
    const neg = bodyOf("find . ! -name '*.ts'");
    expect(neg).toContain('-not');
    expect(neg).toContain("-clike '*.ts'");
    expect(neg).toContain('fx-find-print');
    expect(neg).not.toContain('fx-find-delete');

    const del = bodyOf("find . ! -name '*.ts' -delete");
    expect(del).toContain('-not');
    expect(del).toContain('fx-find-delete');
    expect(del).toContain('[array]::Reverse');

    const or = bodyOf("find . -name a -o -name b");
    expect(or).toContain(' -or ');
    expect(or).toContain("-clike 'a'");
    expect(or).toContain("-clike 'b'");

    const and = bodyOf("find . -name a -name b");
    expect(and).toContain(' -and ');
  });

  it('treats -delete as a primary so OR-delete keeps GNU precedence', () => {
    const footgun = bodyOf("find . -name a -o -name b -delete");
    expect(footgun).toContain(' -or ');
    expect(footgun).toContain('fx-find-delete');
    const grouped = bodyOf("find . \\( -name a -o -name b \\) -delete");
    expect(grouped).toContain(' -or ');
    expect(grouped).toContain('fx-find-delete');
  });

  it('fails loud on unknown predicates and broken expressions', () => {
    throws('find . -perm 644', "find: unknown predicate '-perm'");
    throws('find . -print0', "find: unknown predicate '-print0'");
    throws('find . -name', "find: missing argument to '-name'");
    throws('find . -type s', 'find: Unknown argument to -type: s');
    throws('find . -size xyz', "find: Invalid argument 'xyz' to -size");
    throws('find . -o -name a', "find: invalid expression; you have used a binary operator '-o' with nothing before it.");
    throws('find . -name a -o', "find: expected an expression after '-o'");
    throws("find . -name '*.ts' extra", "find: paths must precede expression: 'extra'");
  });
});

describe('hard links are not symlinks', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;
  const isLink = (v: string) =>
    `${v}.LinkType -eq 'SymbolicLink' -or ${v}.LinkType -eq 'Junction'`;

  it('ls/stat/file/find/readlink treat only SymbolicLink and Junction as links', () => {
    expect(bodyOf('ls -l')).toContain(isLink('$it'));
    expect(bodyOf('ls -F')).toContain(isLink('$it'));
    expect(bodyOf('stat -c %F x')).toContain(isLink('$fx_it'));
    expect(bodyOf('file x')).toContain(isLink('$fx_it'));
    expect(bodyOf('readlink x')).toContain(isLink('$fx_it'));
    expect(bodyOf('find . -type l')).toContain(isLink('$fx_i'));
    expect(bodyOf('find . -type l')).not.toContain('([bool]$fx_i.LinkType)');
    expect(bodyOf('ln a b')).toContain('HardLink');
    expect(bodyOf('ln -s a b')).toContain('SymbolicLink');
  });
});

describe('MCP structured results (#129)', () => {
  it('keeps whitespace-only stdout instead of collapsing to (no output)', () => {
    expect(
      formatBashText({
        stdout: '   ',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      }),
    ).toBe('   ');
    expect(
      formatBashText({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      }),
    ).toBe('(no output)');
  });

  it('exposes schemaVersion 1 and does not mark shell exit 1 as a protocol error', () => {
    const r = bashToolResult(
      {
        stdout: 'x',
        stderr: '',
        exitCode: 1,
        timedOut: false,
        cancelled: false,
        truncated: false,
      },
      'abcd1234',
      false,
    );
    expect(r.structuredContent.schemaVersion).toBe(1);
    expect(r.structuredContent.sessionId).toBe('abcd1234');
    expect(r.structuredContent.exitCode).toBe(1);
    expect(r.content[0].text).toContain('Exit code: 1');
    expect('isError' in r && r.isError).toBeFalsy();
  });
});

describe('cli check spawn error', () => {
  it('runCheck attaches an error listener so missing powershell.exe prints FAILED', () => {
    const src = readFileSync('src/cli.ts', 'utf8');
    const check = src.slice(src.indexOf('async function runCheck'));
    expect(check).toContain("probe.on('error'");
    expect(check).toMatch(/FAILED to run powershell\.exe:.*e\.message/);
    expect(check).toContain('process.exit(1)');
  });
});
