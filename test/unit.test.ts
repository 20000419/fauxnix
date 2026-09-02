import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, USAGE } from '../src/cli.js';
import { collectDoctorReport } from '../src/doctor.js';
import { kimiConfigPath, qwenConfigPath, runInstall } from '../src/install.js';
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
import {
  normalizeStderr,
  PYTHON3_WINDOWS_HINT,
  SH_SCRIPT_WINDOWS_HINT,
} from '../src/errors.js';
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

  it('translates multi-segment command substitution (C-4)', () => {
    expect(() => translateCommandList(parse('echo $(echo a; echo b)'))).not.toThrow();
    const body = translateCommandList(parse('echo $(echo a; echo b)'))[0].body;
    expect(body).toContain('fx-csub');
    expect(body).toContain("'a'");
    expect(body).toContain("'b'");
    expect(body).toContain('-split [string][char]10');
    const quoted = exprOfWord(
      parse('echo "$(echo a; echo b)"').segments[0].pipeline.commands[0].args[0],
    );
    expect(quoted).toContain('fx-csub');
    expect(quoted).toContain("'a'");
    expect(quoted).toContain("'b'");
    expect(quoted).not.toContain('-split [string][char]10');
    const andBody = translateCommandList(parse('echo $(true && echo y)'))[0].body;
    expect(andBody).toContain('fx-csub');
    expect(andBody).toContain('if ($script:fx_exit -eq 0)');
    expect(andBody).toContain("'y'");
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

  it('python3 --version fx-native miss hints python/py and exits 127 (no alias)', () => {
    const plan = translateCommandList(parse('python3 --version'))[0];
    expect(plan.body).toContain("fx-native 'python3' $fx_na");
    expect(plan.body).not.toContain("fx-native 'python' $fx_na");
    expect(plan.script).toContain("if ($fx_n -eq 'python3' -or $fx_n -eq 'python3.exe')");
    expect(plan.script).toContain(PYTHON3_WINDOWS_HINT);
    expect(plan.script).toContain('$script:fx_exit = 127');
    const exe = translateCommandList(parse('python3.exe --version'))[0];
    expect(exe.body).toContain("fx-native 'python3.exe' $fx_na");
    expect(exe.script).toContain(PYTHON3_WINDOWS_HINT);
  });

  it('foo.sh fx-native miss includes the .sh Windows hint and 127', () => {
    const plan = translateCommandList(parse('foo.sh'))[0];
    expect(plan.body).toContain("fx-native 'foo.sh' $fx_na");
    expect(plan.script).toContain("$fx_n -like '*.sh'");
    expect(plan.script).toContain(SH_SCRIPT_WINDOWS_HINT);
    expect(plan.script).toContain('$script:fx_exit = 127');
  });

  it('python --version still uses fx-native (not rewritten to python3)', () => {
    const plan = translateCommandList(parse('python --version'))[0];
    expect(plan.body).toContain("fx-native 'python' $fx_na");
    expect(plan.script).toContain('function fx-native');
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

  it('rejects stdout redirect on a non-last pipeline stage', () => {
    const msg =
      'fauxnix: stdout redirect on a non-last pipeline stage is not supported yet; write the file in a previous list segment (cmd >f; cat f) or wait for per-stage fds (#157)';
    const bad = [
      'echo hi >f | cat',
      'echo hi >>f | cat',
      'echo hi &>f | cat',
      'echo hi &>>f | cat',
      'echo hi >/dev/null | cat',
      'echo hi | cat >mid | wc -l',
    ];
    for (const cmd of bad) {
      expect(() => translateCommandList(parse(cmd)), cmd).toThrow(FauxnixParseError);
      expect(() => translateCommandList(parse(cmd)), cmd).toThrow(msg);
    }
  });

  it('allows last-stage stdout redirect and does not reject 2> on a non-last stage', () => {
    const single = translateCommandList(parse('echo hi >f'))[0];
    expect(single.outputRedirects).toEqual([{ op: '>', target: 'f' }]);
    const disc = translateCommandList(parse('echo hi >/dev/null'))[0];
    expect(disc.outputRedirects).toEqual([{ op: '>', target: '/dev/null' }]);
    const last = translateCommandList(parse('echo hi | cat >f'))[0];
    expect(last.outputRedirects).toEqual([{ op: '>', target: 'f' }]);
    expect(() => translateCommandList(parse('echo hi 2>e | cat'))).not.toThrow();
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

  it('appends python3 / .sh hints on not-recognized rewrites', () => {
    expect(normalizeStderr("The term 'python3' is not recognized as a name of a cmdlet")).toBe(
      'bash: python3: command not found' + PYTHON3_WINDOWS_HINT,
    );
    expect(normalizeStderr("The term 'foo.sh' is not recognized as a name of a cmdlet")).toBe(
      'bash: foo.sh: command not found' + SH_SCRIPT_WINDOWS_HINT,
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

  it('ls --color=auto is an implemented no-op; still lists; -Z still fails loud', () => {
    const color = bodyOf('ls --color=auto');
    expect(color).not.toContain('invalid option');
    expect(color).not.toContain('unrecognized option');
    expect(color).toContain('Get-ChildItem');
    expect(color).not.toContain('\u001b');
    expect(color).not.toContain('[0;');
    expect(bodyOf('ls -Z')).toContain("invalid option -- ''Z''");
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

describe('CommandSpec text-filters leftovers (#143)', () => {
  const bodyOf = (cmd: string): string => translateCommandList(parse(cmd))[0].body;

  it('sort/uniq/cut/tr are spec\'d; sed/awk/egrep stay unspec\'d', () => {
    expect(lookupSpec('sort')).toBeTruthy();
    expect(lookupSpec('uniq')).toBeTruthy();
    expect(lookupSpec('cut')).toBeTruthy();
    expect(lookupSpec('tr')).toBeTruthy();
    expect(lookupSpec('sed')).toBeUndefined();
    expect(lookupSpec('awk')).toBeUndefined();
    expect(lookupSpec('egrep')).toBeUndefined();
    expect(lookupSpec('find')).toBeUndefined();
  });

  it('sort -z is unsupported; unknown flags fail usage', () => {
    const z = bodyOf('sort -z');
    expect(z).toContain("option ''-z'' is not supported by fauxnix");
    expect(z).toContain('NUL-terminated records');
    expect(z).toContain('$script:fx_exit = 2');
    expect(z).toContain("Try ''sort --help'' for more information.");
    expect(z).not.toContain('[array]::Sort');
    const unknown = bodyOf('sort -Q');
    expect(unknown).toContain("invalid option -- ''Q''");
    expect(unknown).not.toContain('[array]::Sort');
  });

  it('implemented sort -n/-r/-k and longs still compile', () => {
    expect(bodyOf('sort -n f')).toContain('fx-numkey');
    expect(bodyOf('sort -n f')).not.toContain('invalid option');
    expect(bodyOf('sort --numeric-sort f')).toContain('fx-numkey');
    expect(bodyOf('sort -r f')).toContain('[array]::Reverse');
    expect(bodyOf('sort --reverse f')).toContain('[array]::Reverse');
    expect(bodyOf('sort -k 2 f')).toContain('fx-keyof');
    expect(bodyOf('sort -nr f')).toContain('fx-numkey');
  });

  it('uniq -c/-d/-u/-i still compile; unknown flags fail', () => {
    expect(bodyOf('uniq -c f')).toContain("'{0,7} {1}'");
    expect(bodyOf('uniq -c f')).not.toContain('invalid option');
    expect(bodyOf('uniq -d f')).toContain('if ($c -gt 1)');
    expect(bodyOf('uniq -u f')).toContain('if ($c -eq 1)');
    expect(bodyOf('uniq -i f')).toContain('.ToLower()');
    expect(bodyOf('uniq -z f')).toContain("invalid option -- ''z''");
    expect(bodyOf('uniq -z f')).not.toContain('fx-uemit');
  });

  it('cut -d -f / -c still compile; unknown flags fail', () => {
    const fields = bodyOf("cut -d, -f1 f");
    expect(fields).toContain('.Split([char]44)');
    expect(fields).not.toContain('invalid option');
    expect(bodyOf('cut -c1-2 f')).toContain('.ToCharArray()');
    expect(bodyOf('cut --complement -f1 f')).toContain('-not (');
    expect(bodyOf('cut -z -f1 f')).toContain("invalid option -- ''z''");
    expect(bodyOf('cut -z -f1 f')).not.toContain('.Split');
  });

  it('tr -d/-s still compile; -c is unsupported', () => {
    const del = bodyOf('tr -d a');
    expect(del).toContain('$fx_dl.ContainsKey');
    expect(del).not.toContain('invalid option');
    expect(bodyOf('tr -s a')).toContain('$fx_sq.ContainsKey');
    const complement = bodyOf('tr -c a b');
    expect(complement).toContain("option ''-c'' is not supported by fauxnix");
    expect(complement).toContain('complement');
    expect(complement).not.toContain('$fx_map');
    expect(bodyOf('tr --complement a b')).toContain('not supported by fauxnix');
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

  it('find -exec fails loud with -delete / grep -r, not xargs rm', () => {
    const body = bodyOf("find . -name '*.log' -exec rm {} +");
    expect(body).toContain('-exec is not supported by fauxnix');
    expect(body).toContain('-delete');
    expect(body).toContain('grep -r');
    expect(body).not.toContain('xargs rm');
    expect(body).toContain('$script:fx_exit = 1');
  });
});

describe('xargs -0', () => {
  it('fails loud instead of silently ignoring -0', () => {
    const body = translateCommandList(parse('xargs -0 rm'))[0].body;
    expect(body).toContain('xargs: -0 is not supported by fauxnix');
    expect(body).toContain('$script:fx_exit = 1');
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

describe('cli doctor', () => {
  it('USAGE lists doctor', async () => {
    expect(USAGE).toMatch(/fauxnix doctor/);
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toContain("verb === 'doctor'");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
    try {
      await runCli([]);
    } finally {
      console.log = orig;
    }
    expect(lines.join('\n')).toContain('fauxnix doctor');
  });

  it('collectDoctorReport does not throw when no harness configs exist', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-doctor-'));
    try {
      const report = await collectDoctorReport({
        home: dir,
        cwd: dir,
        env: {},
        nodeVersion: 'v20.11.0',
      });
      const text = report.lines.join('\n');
      expect(text).toContain('UTF-8 default');
      expect(text).toContain('FAUXNIX_NATIVE_ENCODING=unset → utf8 (default)');
      expect(text).toMatch(/claude\s+: not detected — see README/);
      expect(text).toMatch(/codex\s+: not detected — see README/);
      expect(text).toMatch(/opencode\s+: not detected — see README/);
      expect(text).toContain('start with: fauxnix mcp');
      expect(text).toContain('module loads');
      expect(text).toContain('v20.11.0');
      expect(report.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports encoding override and Node/MCP failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-doctor-'));
    try {
      const ansi = await collectDoctorReport({
        home: dir,
        cwd: dir,
        env: { FAUXNIX_NATIVE_ENCODING: 'ansi' },
        nodeVersion: 'v22.0.0',
      });
      expect(ansi.lines.join('\n')).toContain('ansi → GBK-native admin tools');
      expect(ansi.ok).toBe(true);

      const oldNode = await collectDoctorReport({
        home: dir,
        cwd: dir,
        env: {},
        nodeVersion: 'v16.20.0',
        loadMcp: async () => ({ startMcpServer: async () => {} }),
      });
      expect(oldNode.ok).toBe(false);
      expect(oldNode.lines.join('\n')).toContain('FAILED (requires >=18)');

      const badMcp = await collectDoctorReport({
        home: dir,
        cwd: dir,
        env: {},
        nodeVersion: 'v20.0.0',
        loadMcp: async () => {
          throw new Error('boom');
        },
      });
      expect(badMcp.ok).toBe(false);
      expect(badMcp.lines.join('\n')).toContain('FAILED to load: boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects harness configs conservatively', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-doctor-'));
    try {
      const empty = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(empty.lines.join('\n')).toMatch(/claude\s+: not detected — see README/);

      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({
          notes: 'I cloned fauxnix',
          projects: { 'C:\\repos\\fauxnix': { allowedTools: ['Bash'] } },
        }),
      );
      const mention = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(mention.lines.join('\n')).toContain('fauxnix MCP not listed');
      expect(mention.lines.join('\n')).not.toContain('fauxnix MCP configured');

      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({
          projects: {
            'C:\\work\\app': { mcpServers: { fauxnix: { command: 'fauxnix', args: ['mcp'] } } },
          },
        }),
      );
      const claudeLocal = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(claudeLocal.lines.join('\n')).toMatch(/claude\s+: fauxnix MCP configured/);

      writeFileSync(
        join(dir, '.claude.json'),
        JSON.stringify({ mcpServers: { fauxnix: { command: 'fauxnix', args: ['mcp'] } } }),
      );
      const claude = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(claude.lines.join('\n')).toMatch(/claude\s+: fauxnix MCP configured/);

      const homeDir = join(dir, 'home');
      const cwdDir = join(dir, 'cwd');
      mkdirSync(homeDir);
      mkdirSync(cwdDir);
      writeFileSync(
        join(cwdDir, '.claude.json'),
        JSON.stringify({ mcpServers: { fauxnix: { command: 'fauxnix', args: ['mcp'] } } }),
      );
      const cwdClaude = await collectDoctorReport({
        home: homeDir,
        cwd: cwdDir,
        env: {},
        nodeVersion: 'v20.0.0',
      });
      expect(cwdClaude.lines.join('\n')).toMatch(/claude\s+: not detected — see README/);

      rmSync(join(dir, '.claude.json'));
      writeFileSync(
        join(dir, '.mcp.json'),
        JSON.stringify({ mcpServers: { fauxnix: { command: 'fauxnix', args: ['mcp'] } } }),
      );
      const project = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(project.lines.join('\n')).toMatch(/claude\s+: fauxnix MCP configured/);
      expect(project.lines.join('\n')).toContain('.mcp.json');

      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ name: 'unrelated', fauxnix: true }));
      const unrelatedMcp = await collectDoctorReport({
        home: dir,
        cwd: dir,
        env: {},
        nodeVersion: 'v20.0.0',
      });
      expect(unrelatedMcp.lines.join('\n')).toMatch(/claude\s+: not detected — see README/);

      mkdirSync(join(dir, '.codex'));
      writeFileSync(join(dir, '.codex', 'config.toml'), '[model]\nmodel = "gpt-5"\n');
      const codexBare = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(codexBare.lines.join('\n')).toContain('codex mcp add fauxnix');

      writeFileSync(
        join(dir, '.codex', 'config.toml'),
        '[mcp_servers.fauxnix]\ncommand = "fauxnix"\nargs = ["mcp"]\n',
      );
      const codex = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(codex.lines.join('\n')).toMatch(/codex\s+: fauxnix MCP configured/);

      mkdirSync(join(dir, '.config', 'opencode'), { recursive: true });
      writeFileSync(
        join(dir, '.config', 'opencode', 'opencode.json'),
        JSON.stringify({ mcp: { fauxnix: { type: 'local', command: ['fauxnix', 'mcp'] } } }),
      );
      const opencode = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(opencode.lines.join('\n')).toMatch(/opencode\s+: fauxnix MCP configured/);

      writeFileSync(
        join(dir, '.config', 'opencode', 'opencode.json'),
        JSON.stringify({
          mcp: { servers: { fauxnix: { type: 'local', command: ['fauxnix', 'mcp'] } } },
        }),
      );
      const opencodeV2 = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(opencodeV2.lines.join('\n')).toMatch(/opencode\s+: fauxnix MCP configured/);

      rmSync(join(dir, '.config'), { recursive: true, force: true });
      writeFileSync(
        join(dir, 'opencode.json'),
        JSON.stringify({ mcp: { fauxnix: { type: 'local', command: ['fauxnix', 'mcp'] } } }),
      );
      const cwdOnly = await collectDoctorReport({ home: dir, cwd: dir, env: {}, nodeVersion: 'v20.0.0' });
      expect(cwdOnly.lines.join('\n')).toMatch(/opencode\s+: not detected — see README/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cli install', () => {
  it('USAGE lists install', async () => {
    expect(USAGE).toMatch(/fauxnix install --claude/);
    expect(USAGE).toContain('--codex');
    expect(USAGE).toContain('--opencode');
    expect(USAGE).toContain('--kimi');
    expect(USAGE).toContain('--qwen');
    const src = readFileSync('src/cli.ts', 'utf8');
    expect(src).toContain("verb === 'install'");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
    try {
      await runCli([]);
    } finally {
      console.log = orig;
    }
    expect(lines.join('\n')).toContain('fauxnix install');
  });

  it('runCli install without flags prints usage and does not write', async () => {
    const lines: string[] = [];
    const orig = console.log;
    const prev = process.exitCode;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    };
    process.exitCode = undefined;
    try {
      await runCli(['install']);
      expect(process.exitCode).toBe(1);
    } finally {
      console.log = orig;
      process.exitCode = prev;
    }
    expect(lines.join('\n')).toContain('--claude');
    expect(lines.join('\n')).toContain('select a harness');
  });
});

describe('install harness config', () => {
  function opts(dir: string, env: NodeJS.ProcessEnv = {}) {
    return { home: dir, cwd: dir, env };
  }

  async function doctorText(dir: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
    const report = await collectDoctorReport({
      home: dir,
      cwd: dir,
      env,
      nodeVersion: 'v20.0.0',
    });
    return report.lines.join('\n');
  }

  it('rejects unknown flags and --help without writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    expect(dir).not.toBe(homedir());
    try {
      const bad = runInstall(['--nope'], opts(dir));
      expect(bad.ok).toBe(false);
      expect(bad.lines.join('\n')).toContain('unknown harness: --nope');
      expect(existsSync(join(dir, '.claude.json'))).toBe(false);

      const help = runInstall(['--help'], opts(dir));
      expect(help.ok).toBe(true);
      expect(help.lines.join('\n')).toContain('fauxnix install --claude');
      expect(existsSync(join(dir, '.claude.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes Claude user config, preserves unrelated keys, and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    expect(dir).not.toBe(homedir());
    try {
      const claudePath = join(dir, '.claude.json');
      writeFileSync(
        claudePath,
        JSON.stringify(
          {
            theme: 'dark',
            projects: { 'C:\\work\\app': { allowedTools: ['Bash'] } },
            mcpServers: { github: { command: 'npx' } },
          },
          null,
          2,
        ),
      );
      const r = runInstall(['--claude'], opts(dir));
      expect(r.ok).toBe(true);
      expect(r.lines[0]).toContain('patched');
      expect(r.lines[0]).toContain(claudePath);
      const data = JSON.parse(readFileSync(claudePath, 'utf8')) as {
        theme: string;
        projects: unknown;
        mcpServers: Record<string, unknown>;
      };
      expect(data.theme).toBe('dark');
      expect(data.projects).toEqual({ 'C:\\work\\app': { allowedTools: ['Bash'] } });
      expect(data.mcpServers.github).toEqual({ command: 'npx' });
      expect(data.mcpServers.fauxnix).toEqual({ command: 'fauxnix', args: ['mcp'] });
      expect(await doctorText(dir)).toMatch(/claude\s+: fauxnix MCP configured/);

      const before = readFileSync(claudePath, 'utf8');
      const again = runInstall(['--claude'], opts(dir));
      expect(again.ok).toBe(true);
      expect(again.lines[0]).toContain('already configured');
      expect(readFileSync(claudePath, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Claude config and respects CLAUDE_CONFIG_DIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      const created = runInstall(['--claude'], opts(dir));
      expect(created.ok).toBe(true);
      expect(created.lines[0]).toContain('created');
      expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))).toEqual({
        mcpServers: { fauxnix: { command: 'fauxnix', args: ['mcp'] } },
      });

      const cfgDir = join(dir, 'custom-claude');
      const env = { CLAUDE_CONFIG_DIR: cfgDir };
      const custom = runInstall(['--claude'], opts(dir, env));
      expect(custom.ok).toBe(true);
      expect(existsSync(join(cfgDir, '.claude.json'))).toBe(true);
      expect(custom.lines[0]).toContain(join(cfgDir, '.claude.json'));
      expect(await doctorText(dir, env)).toMatch(/claude\s+: fauxnix MCP configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite invalid Claude JSON or a non-object mcpServers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      const claudePath = join(dir, '.claude.json');
      writeFileSync(claudePath, '{ not json');
      const bad = runInstall(['--claude'], opts(dir));
      expect(bad.ok).toBe(false);
      expect(bad.lines[0]).toContain('not valid JSON');
      expect(readFileSync(claudePath, 'utf8')).toBe('{ not json');

      writeFileSync(claudePath, JSON.stringify({ mcpServers: ['nope'] }));
      const wrong = runInstall(['--claude'], opts(dir));
      expect(wrong.ok).toBe(false);
      expect(wrong.lines[0]).toContain('mcpServers is not an object');
      expect(JSON.parse(readFileSync(claudePath, 'utf8'))).toEqual({ mcpServers: ['nope'] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write project .mcp.json for Claude', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ keep: true }));
      const r = runInstall(['--claude'], opts(dir));
      expect(r.ok).toBe(true);
      expect(existsSync(join(dir, '.claude.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8'))).toEqual({ keep: true });
      expect(await doctorText(dir)).toMatch(/claude\s+: fauxnix MCP configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends Codex TOML without rewriting comments and is idempotent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      mkdirSync(join(dir, '.codex'));
      const path = join(dir, '.codex', 'config.toml');
      writeFileSync(path, '# keep me\r\n[model]\r\nmodel = "gpt-5"\r\n');
      const r = runInstall(['--codex'], opts(dir));
      expect(r.ok).toBe(true);
      expect(r.lines[0]).toContain('patched');
      const out = readFileSync(path, 'utf8');
      expect(out.startsWith('# keep me')).toBe(true);
      expect(out).toContain('[model]');
      expect(out).toContain('model = "gpt-5"');
      expect(out).toContain('[mcp_servers.fauxnix]');
      expect(out).toContain('command = "fauxnix"');
      expect(out).toContain('args = ["mcp"]');
      expect(await doctorText(dir)).toMatch(/codex\s+: fauxnix MCP configured/);

      const before = readFileSync(path, 'utf8');
      const again = runInstall(['--codex'], opts(dir));
      expect(again.lines[0]).toContain('already configured');
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates Codex config and respects CODEX_HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      const created = runInstall(['--codex'], opts(dir));
      expect(created.ok).toBe(true);
      expect(created.lines[0]).toContain('created');
      expect(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8')).toContain(
        '[mcp_servers.fauxnix]',
      );

      const home = join(dir, 'my-codex');
      const env = { CODEX_HOME: home };
      const custom = runInstall(['--codex'], opts(dir, env));
      expect(custom.ok).toBe(true);
      expect(existsSync(join(home, 'config.toml'))).toBe(true);
      expect(await doctorText(dir, env)).toMatch(/codex\s+: fauxnix MCP configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes OpenCode mcp.fauxnix, nested servers, and respects XDG_CONFIG_HOME', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      const path = join(dir, '.config', 'opencode', 'opencode.json');
      mkdirSync(join(dir, '.config', 'opencode'), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          model: 'x',
          mcp: { github: { type: 'remote', url: 'https://example' } },
        }),
      );
      const r = runInstall(['--opencode'], opts(dir));
      expect(r.ok).toBe(true);
      expect(r.lines[0]).toContain('patched');
      const data = JSON.parse(readFileSync(path, 'utf8')) as {
        $schema: string;
        model: string;
        mcp: Record<string, unknown>;
      };
      expect(data.$schema).toBe('https://opencode.ai/config.json');
      expect(data.model).toBe('x');
      expect(data.mcp.github).toEqual({ type: 'remote', url: 'https://example' });
      expect(data.mcp.fauxnix).toEqual({ type: 'local', command: ['fauxnix', 'mcp'] });
      expect(await doctorText(dir)).toMatch(/opencode\s+: fauxnix MCP configured/);

      const nestedDir = join(dir, 'xdg');
      const nestedPath = join(nestedDir, 'opencode', 'opencode.json');
      mkdirSync(join(nestedDir, 'opencode'), { recursive: true });
      writeFileSync(
        nestedPath,
        JSON.stringify({
          mcp: { servers: { github: { type: 'local', command: ['npx'] } } },
        }),
      );
      const env = { XDG_CONFIG_HOME: nestedDir };
      const nested = runInstall(['--opencode'], opts(dir, env));
      expect(nested.ok).toBe(true);
      const nestedData = JSON.parse(readFileSync(nestedPath, 'utf8')) as {
        mcp: { servers: Record<string, unknown> };
      };
      expect(nestedData.mcp.servers.github).toEqual({ type: 'local', command: ['npx'] });
      expect(nestedData.mcp.servers.fauxnix).toEqual({
        type: 'local',
        command: ['fauxnix', 'mcp'],
      });
      expect(await doctorText(dir, env)).toMatch(/opencode\s+: fauxnix MCP configured/);

      writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ keep: true }));
      const cwdFile = readFileSync(join(dir, 'opencode.json'), 'utf8');
      runInstall(['--opencode'], opts(dir));
      expect(readFileSync(join(dir, 'opencode.json'), 'utf8')).toBe(cwdFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes Kimi ~/.kimi-code/mcp.json and Qwen ~/.qwen/settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      const kimiPath = kimiConfigPath(dir, {});
      mkdirSync(join(dir, '.kimi-code'));
      writeFileSync(
        kimiPath,
        JSON.stringify({ mcpServers: { other: { command: 'npx' } } }, null, 2),
      );
      const kimi = runInstall(['--kimi'], opts(dir));
      expect(kimi.ok).toBe(true);
      expect(kimi.lines[0]).toContain('patched');
      const kimiData = JSON.parse(readFileSync(kimiPath, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(kimiData.mcpServers.other).toEqual({ command: 'npx' });
      expect(kimiData.mcpServers.fauxnix).toEqual({ command: 'fauxnix', args: ['mcp'] });

      const qwenPath = qwenConfigPath(dir, {});
      mkdirSync(join(dir, '.qwen'));
      writeFileSync(
        qwenPath,
        JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'npx' } } }, null, 2),
      );
      const qwen = runInstall(['--qwen'], opts(dir));
      expect(qwen.ok).toBe(true);
      const qwenData = JSON.parse(readFileSync(qwenPath, 'utf8')) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(qwenData.theme).toBe('dark');
      expect(qwenData.mcpServers.other).toEqual({ command: 'npx' });
      expect(qwenData.mcpServers.fauxnix).toEqual({ command: 'fauxnix', args: ['mcp'] });

      const kimiHome = join(dir, 'kimi-home');
      const kimiEnv = { KIMI_CODE_HOME: kimiHome };
      const custom = runInstall(['--kimi'], opts(dir, kimiEnv));
      expect(custom.ok).toBe(true);
      expect(existsSync(join(kimiHome, 'mcp.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('installs multiple harnesses in one invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fauxnix-install-'));
    try {
      const r = runInstall(['--claude', '--codex', '--opencode', '--kimi', '--qwen'], opts(dir));
      expect(r.ok).toBe(true);
      expect(r.lines).toHaveLength(5);
      expect(r.lines.every((l) => l.includes('created'))).toBe(true);
      expect(existsSync(join(dir, '.claude.json'))).toBe(true);
      expect(existsSync(join(dir, '.codex', 'config.toml'))).toBe(true);
      expect(existsSync(join(dir, '.config', 'opencode', 'opencode.json'))).toBe(true);
      expect(existsSync(join(dir, '.kimi-code', 'mcp.json'))).toBe(true);
      expect(existsSync(join(dir, '.qwen', 'settings.json'))).toBe(true);
      const text = await doctorText(dir);
      expect(text).toMatch(/claude\s+: fauxnix MCP configured/);
      expect(text).toMatch(/codex\s+: fauxnix MCP configured/);
      expect(text).toMatch(/opencode\s+: fauxnix MCP configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'win32')('cli doctor spawn', () => {
  it('node src/index.ts doctor does not throw', () => {
    const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    expect(existsSync(tsx)).toBe(true);
    const r = spawnSync(process.execPath, [tsx, 'src/index.ts', 'doctor'], {
      encoding: 'utf8',
      timeout: 30000,
      env: process.env,
    });
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain('powershell');
    expect(r.stdout).toContain('encoding');
    expect(r.stdout).toContain('FAUXNIX_NATIVE_ENCODING');
    expect(r.stdout).toContain('start with: fauxnix mcp');
    expect(r.stdout).toMatch(/claude\s+:/);
    expect(r.stdout).toMatch(/codex\s+:/);
    expect(r.stdout).toMatch(/opencode\s+:/);
    expect(r.status).toBe(0);
  }, 30000);
});
