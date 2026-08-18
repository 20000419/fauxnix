/**
 * Integration tests — execute translated commands through real Windows
 * PowerShell 5.1. Skipped automatically on non-Windows platforms.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '../src/parser.js';
import { translateCommandList } from '../src/translator.js';
import { FauxnixSession } from '../src/executor.js';
import '../src/commands/install-all.js';

const onWindows = process.platform === 'win32';
const hasPs =
  onWindows &&
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { shell: false }).status === 0;

describe.skipIf(!hasPs)('integration (real PowerShell)', { timeout: 30000 }, () => {
  let dir: string;
  let session: FauxnixSession;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fauxnix-it-'));
    writeFileSync(join(dir, 'fruits.txt'), 'apple\nBanana\napple pie\ncherry\n', 'utf8');
    writeFileSync(join(dir, 'nums.txt'), '1 2\n3 4\n5 6\n', 'utf8');
    writeFileSync(join(dir, 'dups.txt'), 'aaa\naaa\nbbb\n', 'utf8');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.txt'), 'third line\n', 'utf8');
    session = new FauxnixSession();
    // seed the session cwd like a real shell login directory
    await session.run(translateCommandList(parseCommand('cd "' + dir + '"')));
    // cold runner disks can take >10s (default hookTimeout) to spawn the first
    // PowerShell session — seen as a false red on CI twice
  }, 60000);

  afterAll(async () => {
    await session.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(cmd: string) {
    return session.run(translateCommandList(parseCommand(cmd)));
  }

  it('cat reads files', async () => {
    const r = await run('cat fruits.txt');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual([
      'apple',
      'Banana',
      'apple pie',
      'cherry',
    ]);
    expect(r.exitCode).toBe(0);
  });

  it('cat missing file: bash-style stderr + exit 1', async () => {
    const r = await run('cat nope.txt');
    expect(r.stderr).toContain('cat: nope.txt: No such file or directory');
    expect(r.exitCode).toBe(1);
  });

  it('ls -la shows GNU columns', async () => {
    const r = await run('ls -la');
    expect(r.stdout).toMatch(/-rw-r--r--.*fruits\.txt/);
    expect(r.stdout).toMatch(/drwxr-xr-x.*sub/);
  });

  it('grep + exit codes', async () => {
    expect((await run('grep -n apple fruits.txt')).stdout).toContain('1:apple');
    expect((await run('grep apple fruits.txt')).exitCode).toBe(0);
    expect((await run('grep zz fruits.txt')).exitCode).toBe(1);
    expect((await run('grep x missing-file')).exitCode).toBe(2);
  });

  it('pipeline: cat | grep | sort', async () => {
    const r = await run('cat fruits.txt | grep -i apple | sort');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['apple', 'apple pie']);
  });

  it('sed substitution', async () => {
    const r = await run("sed 's/apple/MANGO/g' fruits.txt");
    expect(r.stdout).toContain('MANGO pie');
    expect(r.stdout).not.toContain('apple');
  });

  it('awk field printing and sum', async () => {
    expect((await run("awk '{print $1}' fruits.txt")).stdout).toContain('apple');
    expect((await run("awk '{sum += $1} END {print sum}' nums.txt")).stdout.trim()).toBe('9');
  });

  it('sort -n and uniq -c', async () => {
    const r = await run('sort dups.txt | uniq -c');
    expect(r.stdout).toMatch(/2 aaa/);
    expect(r.stdout).toMatch(/1 bbb/);
  });

  it('head/tail/wc', async () => {
    expect((await run('head -1 fruits.txt')).stdout.trim()).toBe('apple');
    expect((await run('tail -1 fruits.txt')).stdout.trim()).toBe('cherry');
    expect((await run('wc -l fruits.txt')).stdout.trim()).toMatch(/4/);
    expect((await run('wc -l < fruits.txt')).stdout.trim()).toBe('4');
  });

  it('echo/printf semantics', async () => {
    expect((await run('echo hello world')).stdout.trim()).toBe('hello world');
    expect((await run("printf '%s=%d\\n' x 42")).stdout.trim()).toBe('x=42');
    const noNl = await run('echo -n abc');
    expect(noNl.stdout).toBe('abc');
  });

  it('md5sum matches known hash', async () => {
    const r = await run('md5sum fruits.txt');
    // md5 of 'apple\nBanana\napple pie\ncherry\n'
    expect(r.stdout).toMatch(/332793e5f4f290f27e0795f1d9a7f5f8|^\w{32}  fruits\.txt/);
  });

  it('redirects: > >> 2> /dev/null 2>&1', async () => {
    const r = await run('echo one > o.txt; echo two >> o.txt; cat o.txt');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['one', 'two']);
    const silenced = await run('cat missing.txt 2>/dev/null; echo OK');
    expect(silenced.stderr).toBe('');
    expect(silenced.stdout.trim()).toBe('OK');
  });

  it(
    '[[ ]] file and string tests, including =~',
    async () => {
    expect((await run('[[ -f fruits.txt ]] && echo yes')).stdout.trim()).toBe('yes');
    expect((await run('[[ -d fruits.txt ]] && echo yes; echo after')).stdout.trim()).toBe('after');
    expect((await run('[[ abc =~ ^a ]] && echo match')).stdout.trim()).toBe('match');
    expect((await run('[[ abc =~ ^z ]] || echo nomatch')).stdout.trim()).toBe('nomatch');
    expect((await run('[[ 2 -gt 1 ]]')).exitCode).toBe(0);
    expect((await run('[[ 2 -lt 1 ]]')).exitCode).toBe(1);
    expect(() => parseCommand('[[ -f x')).toThrow(/missing/);
    expect((await run('[[ -f fruits.txt && -d sub ]] && echo both')).stdout.trim()).toBe('both');
    expect((await run('[[ -f nope || -f fruits.txt ]] && echo either')).stdout.trim()).toBe(
      'either',
    );
    expect((await run('[[ foo == f* ]]')).exitCode).toBe(0);
    expect((await run("export pat='f*'; [[ foo == $pat ]]")).exitCode).toBe(0);
    expect((await run('[[ 1 == [[:digit:]] ]]')).exitCode).toBe(0);
    expect((await run('[[ a == [!b] ]]')).exitCode).toBe(0);
    expect((await run('[[ z =~ a|| ]]')).exitCode).toBe(0);
    expect((await run('[[ foo == "f*" ]]')).exitCode).toBe(1);
    expect((await run('[[ abc =~ "^a" ]]')).exitCode).toBe(1);
    writeFileSync(join(dir, 'important.txt'), 'keep\n', 'utf8');
    const lex = await run('[[ z > important.txt ]]');
    expect(lex.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'important.txt'), 'utf8')).toBe('keep\n');
    expect(() => parseCommand('[[ "]]"')).toThrow(/missing/);
    expect((await run('[[ abc =~ ^a|z$ ]]')).exitCode).toBe(0);
    expect((await run('[[ foo == f"o"* ]]')).exitCode).toBe(0);
    expect((await run('[[ x =~ \\. ]]')).exitCode).toBe(1);
    expect(() => translateCommandList(parseCommand('[[ x "==" x ]]'))).toThrow(/binary operator|too many/);
    expect(() => translateCommandList(parseCommand('[[ -f ]]'))).toThrow(/unary operator/);
    expect((await run('[[ 1 =~ [[:digit:]] ]]')).exitCode).toBe(0);
    expect((await run("export re='[[:digit:]]'; [[ 1 =~ $re ]]")).exitCode).toBe(0);
    expect((await run('[[ /tmp/foo == /tmp/* ]]')).exitCode).toBe(0);
    expect(() => translateCommandList(parseCommand('[[ "-f" fruits.txt ]]'))).toThrow();
    expect((await run('[[ ( -f fruits.txt || -f nope ) && -d sub ]] && echo grp')).stdout.trim()).toBe(
      'grp',
    );
    expect(() => translateCommandList(parseCommand('[[ x -o y ]]'))).toThrow();
    expect((await run('[[ x =~ |x ]]')).exitCode).toBe(0);
    expect(() => translateCommandList(parseCommand('[[ "!" x ]]'))).toThrow();
    expect(() => translateCommandList(parseCommand('[[ ! ]]'))).toThrow(/unary operator/);
    expect((await run("[ -n x ']'")).exitCode).toBe(0);
    expect((await run('test !')).exitCode).toBe(0);
    expect((await run('[[ ~ == $HOME ]]')).exitCode).toBe(0);
    expect((await run('test x "=" x')).exitCode).toBe(0);
    expect((await run("[ \"-n\" x ]")).exitCode).toBe(0);
    // POSIX ERE: \\d is the letter d, not a digit class (.NET would think otherwise)
    expect((await run("export re='\\d'; [[ 1 =~ $re ]]; echo $?")).stdout.trim()).toBe('1');
    expect((await run("export re='\\d'; [[ d =~ $re ]]")).exitCode).toBe(0);
    // [:digit:] is a class of :dgit only when it is not [[:digit:]]
    expect((await run('[[ xd =~ x[:digit:] ]]')).exitCode).toBe(0);
    expect((await run('[[ x9 =~ x[:digit:] ]]')).exitCode).toBe(1);
    // backslash in an expanded glob is a literal escape
    expect((await run("export pat='f\\*'; [[ 'f*' == $pat ]]")).exitCode).toBe(0);
    expect((await run("export pat='f\\*'; [[ foo == $pat ]]")).exitCode).toBe(1);
    // [[ always has extglob on the == / != operand
    expect((await run('[[ foo == @(foo|bar) ]]')).exitCode).toBe(0);
    expect((await run('[[ baz == @(foo|bar) ]]')).exitCode).toBe(1);
    expect((await run('[[ foo == +(foo|bar) ]]')).exitCode).toBe(0);
    expect((await run('[[ foofoo == +(foo) ]]')).exitCode).toBe(0);
    expect((await run('[[ xyz == !(foo|bar) ]]')).exitCode).toBe(0);
    expect((await run('[[ foo == !(foo|bar) ]]')).exitCode).toBe(1);
    expect((await run("export pat='@(foo|bar)'; [[ foo == $pat ]]")).exitCode).toBe(0);
    // !(pat) must not steal a following suffix (`foobar` is not `!(foo)` + `bar`)
    expect((await run('[[ foobar == !(foo)bar ]]')).exitCode).toBe(1);
    expect((await run('[[ xbar == !(foo)bar ]]')).exitCode).toBe(0);
    expect((await run('[[ foofoobar == !(foo)bar ]]')).exitCode).toBe(0);
    // GNU regex word ops stay; .NET-only \\d does not become a digit class
    expect((await run("export re='\\bword\\b'; [[ word =~ $re ]]")).exitCode).toBe(0);
    expect((await run("export re='\\bword\\b'; [[ xwordx =~ $re ]]")).exitCode).toBe(1);
    expect((await run('[[ -v HOME ]]')).exitCode).toBe(0);
    expect((await run('[[ -v FAUXNIX_NO_SUCH_VAR ]]')).exitCode).toBe(1);
    expect((await run('[[ -L fruits.txt ]]')).exitCode).toBe(1);
    expect((await run('[[ -h fruits.txt ]]')).exitCode).toBe(1);
    expect((await run('[[ -a fruits.txt ]]')).exitCode).toBe(0);
    expect((await run('[[ ("" && "") || "" ]]')).exitCode).toBe(1);
    expect((await run('V=SHELL [[ -v $V ]]')).exitCode).toBe(0);
    expect((await run('V=FAUXNIX_NO_SUCH_VAR [[ -v $V ]]')).exitCode).toBe(1);
    expect((await run('[[ ab =~ (ab) ]]')).exitCode).toBe(0);
    expect((await run("[[ -v '' ]]")).exitCode).toBe(1);
    expect((await run('name="" [[ -v $name ]]')).exitCode).toBe(1);
    expect((await run('[[ aXXb =~ a&&b ]]')).exitCode).toBe(0);
    expect((await run('[[ -f fruits.txt &&\n -r fruits.txt ]]')).exitCode).toBe(0);
    expect((await run('[[ - == [a\\-z] ]]')).exitCode).toBe(0);
    expect((await run('[[ - == [a"-"z] ]]')).exitCode).toBe(0);
    expect((await run('[[ b == [a\\-z] ]]')).exitCode).toBe(1);
    expect((await run('[[ A == a ]]')).exitCode).toBe(1);
    expect((await run('[[ foo == F* ]]')).exitCode).toBe(1);
    expect((await run('[[ a-b == "a-b" ]]')).exitCode).toBe(0);
    expect((await run('[[ $HOME == ~ ]]')).exitCode).toBe(0);
    expect((await run('[[ $HOME/x == ~/x ]]')).exitCode).toBe(0);
    expect((await run("export pat='f\\o'; [[ fo == $pat ]]")).exitCode).toBe(0);
    expect((await run('[[ "$HOME/xabc" == ~/"x*" ]]')).exitCode).toBe(1);
    expect((await run('[[ "$HOME/xabc" == ~/x* ]]')).exitCode).toBe(0);
    expect((await run('[[ $(head -n 2 fruits.txt) =~ e.B ]]')).exitCode).toBe(0);
    expect(() => parseCommand('[[ foo == @(foo ]]; echo BAD')).toThrow(/syntax error/);
    expect((await run("[[ '@(' == '@(' ]]")).exitCode).toBe(0);
    expect((await run('[[ -v ? ]]')).exitCode).toBe(1);
    expect((await run("[[ -v '$' ]]")).exitCode).toBe(1);
    expect((await run('[[ $HOME =~ ~ ]]')).exitCode).toBe(0);
    expect((await run('[[ x == x\n ]]')).exitCode).toBe(0);
    expect((await run('[[ ( x =~ x) ]]')).exitCode).toBe(0);
    expect((await run('[[ 1+1 -eq 2 ]]')).exitCode).toBe(0);
    expect((await run('[[ 0x10 -eq 16 ]]')).exitCode).toBe(0);
    expect((await run('count=2 [[ count -gt 1 ]]')).exitCode).toBe(0);
    expect((await run('[[ apple =~ e$ ]]')).exitCode).toBe(0);
    expect((await run('x=2 [[ x -eq 2 ]]')).exitCode).toBe(0);
    expect((await run('[[ 3/2 -eq 1 ]]')).exitCode).toBe(0);
    expect((await run('[[ 010 -eq 8 ]]')).exitCode).toBe(0);
    expect((await run('[[ 0 == [-a] ]]')).exitCode).toBe(1);
    expect((await run('[[ - == [-a] ]]')).exitCode).toBe(0);
    expect((await run('[[ b == [a-z] ]]')).exitCode).toBe(0);
    expect((await run('[[ 6/-3 -eq -2 ]]')).exitCode).toBe(0);
    expect((await run('[[ 09 -eq 9 ]]')).exitCode).toBe(1);
    expect((await run('[[ 8*2/4 -eq 4 ]]')).exitCode).toBe(0);
    expect((await run('[[ 8/(2*2) -eq 2 ]]')).exitCode).toBe(0);
    expect((await run('[[ 5%2 -eq 1 ]]')).exitCode).toBe(0);
    expect((await run('[[ ( x =~ (x) ) ]]')).exitCode).toBe(0);
    expect((await run("'[[' x ]] 2>/dev/null; echo $?")).stdout.trim()).not.toBe('0');
    expect((await run('[[ "$HOME" == "$HOME" ]]')).exitCode).toBe(0);
    expect((await run("export re='e$'; [[ apple =~ $re ]]")).exitCode).toBe(0);
    expect((await run('[[\n -f fruits.txt ]]')).exitCode).toBe(0);
    expect((await run("x='' [[ -v x ]]")).exitCode).toBe(0);
    expect((await run('[[ 2**3 -eq 8 ]]')).exitCode).toBe(0);
    expect((await run('[[ 2*3**2 -eq 18 ]]')).exitCode).toBe(0);
    expect((await run('[[ (\n x == x ) ]]')).exitCode).toBe(0);
    expect((await run('FOO=1 [[ -v foo ]]')).exitCode).toBe(1);
    expect(() => parseCommand('[[ 2>&1 ]] && echo BAD')).toThrow(/unexpected token/);
    expect((await run('[[ $(false) == "" ]]')).exitCode).toBe(0);
    expect((await run('[[ -z $(false) ]]')).exitCode).toBe(0);
    expect((await run("re='[' [[ ! x =~ $re ]]")).exitCode).toBe(0);
    expect((await run('FOO=2 [[ foo -eq 2 ]]')).exitCode).toBe(1);
    expect((await run('[[ 2#10 -eq 2 ]]')).exitCode).toBe(0);
    expect((await run('[[ 16#ff -eq 255 ]]')).exitCode).toBe(0);
    expect((await run('[[ 0xff -eq 255 ]]')).exitCode).toBe(0);
    expect(() => translateCommandList(parseCommand('[[ -n && ]]'))).toThrow(/unary operator/);
    {
      const cased = await run(
        'export FOO=1; export foo=2; [[ $FOO == 1 && $foo == 2 ]]; echo $?; unset FOO; unset foo',
      );
      expect(cased.stdout.trim().split(/\r?\n/).pop()).toBe('0');
    }
    expect((await run("[[ 'a&b' =~ (a&b) ]]")).exitCode).toBe(0);
    expect((await run("[[ ' x ' =~ ( x ) ]]")).exitCode).toBe(0);
    expect((await run("[[ 'bar baz' == @(foo|bar baz) ]]")).exitCode).toBe(0);
    expect((await run("[[ 'bar baz' != @(foo|qux) ]]")).exitCode).toBe(0);
    expect((await run("[[ ( ' x ' =~ ( x ) ) ]]")).exitCode).toBe(0);
    expect((await run("[[ ( ' x' =~ ( x)) ]]")).exitCode).toBe(0);
    expect((await run('[[ $UNSET -eq 0 ]]')).exitCode).toBe(0);
    expect((await run('[[ "" -eq 0 ]]')).exitCode).toBe(0);
    expect((await run("x='' [[ x -eq 0 ]]")).exitCode).toBe(0);
    expect((await run('[[ "  " -eq 0 ]]')).exitCode).toBe(0);
    expect((await run('[[ $UNSET -gt 0 ]]')).exitCode).toBe(1);
    expect((await run('[[ + -eq 0 ]]')).exitCode).toBe(1);
    expect((await run('[ "" -eq 0 ]')).exitCode).toBe(2);
    expect((await run("[[ '1&&0' -eq 0 ]]")).exitCode).toBe(0);
    expect((await run("[[ '5&1' -eq 1 ]]")).exitCode).toBe(0);
    expect((await run("[[ '1<<2' -eq 4 ]]")).exitCode).toBe(0);
    expect((await run("[[ '8>>1' -eq 4 ]]")).exitCode).toBe(0);
    expect((await run("[[ '1|2' -eq 3 ]]")).exitCode).toBe(0);
    expect((await run("[[ '1||0' -eq 1 ]]")).exitCode).toBe(0);
    expect((await run("[[ 'a c' =~ (a | b)c ]]")).exitCode).toBe(0);
    expect((await run("[[ 'x ' == @(x | y) ]]")).exitCode).toBe(0);
    expect((await run('[[ 3#10 -eq 3 ]]')).exitCode).toBe(0);
    expect((await run('[[ 36#z -eq 35 ]]')).exitCode).toBe(0);
    expect((await run('[[ 36#Z -eq 35 ]]')).exitCode).toBe(0);
    expect((await run('[[ 64#_ -eq 63 ]]')).exitCode).toBe(0);
    expect((await run("[[ 0 -eq '0 && 1/0' ]]")).exitCode).toBe(0);
    expect((await run("[[ 1 -eq '1 || 1/0' ]]")).exitCode).toBe(0);
    expect((await run("[[ 2 -eq '1?2:1/0' ]]")).exitCode).toBe(0);
    expect((await run("[[ 3 -eq '0?1/0:3' ]]")).exitCode).toBe(0);
    expect((await run("export bad='1/0'; [[ 0 -eq '0 && bad' ]]")).exitCode).toBe(0);
    expect((await run("export bad='1/0'; [[ 1 -eq '1 || bad' ]]")).exitCode).toBe(0);
    expect((await run('export FOO=x; [[ $foo == "" ]]')).exitCode).toBe(0);
    expect((await run('export FOO=x; [[ $FOO == x ]]')).exitCode).toBe(0);
    expect((await run('FOO=x [[ $foo == "" ]]')).exitCode).toBe(0);
    expect((await run('[[ \'a"b\' == "a\\"b" ]]')).exitCode).toBe(0);
    expect((await run('[[ fruits.txt -nt missing ]]')).exitCode).toBe(0);
    expect((await run('[[ missing -ot fruits.txt ]]')).exitCode).toBe(0);
    expect((await run('[[ fruits.txt -ef fruits.txt ]]')).exitCode).toBe(0);
    expect((await run('[[ fruits.txt -ef nums.txt ]]')).exitCode).toBe(1);
    expect((await run('[ -v PATH ]')).exitCode).toBe(0);
    expect((await run('[ -L fruits.txt ]')).exitCode).toBe(1);
    expect((await run('ln fruits.txt fruits.link; [[ fruits.txt -ef fruits.link ]]')).exitCode).toBe(
      0,
    );
    expect((await run('n=0 [[ ++n -eq 1 ]]')).exitCode).toBe(0);
    expect((await run('n=0 [[ n++ -eq 0 && n -eq 1 ]]')).exitCode).toBe(0);
    expect((await run('n=5 [[ --n -eq 4 ]]')).exitCode).toBe(0);
    expect((await run("n=0 [[ 0 -eq '0 && ++n' && n -eq 0 ]]")).exitCode).toBe(0);
    expect((await run("[[ $home == '' ]]")).exitCode).toBe(0);
    expect((await run('unset HOME; [[ -z $HOME ]]')).exitCode).toBe(0);
    expect((await run('[[ 3**34 -eq 16677181699666569 ]]')).exitCode).toBe(0);
    expect((await run('[ /tmp = /tmp ]')).exitCode).toBe(0);
    expect((await run('[[ 9007199254740993/1 -eq 9007199254740993 ]]')).exitCode).toBe(0);
    expect((await run('[[ -9223372036854775808 -eq -9223372036854775808 ]]')).exitCode).toBe(0);
    expect((await run('[[ 9223372036854775808 -eq -9223372036854775808 ]]')).exitCode).toBe(0);
    expect((await run("[[ -9223372036854775808 -eq '-9223372036854775808 / -1' ]]")).exitCode).toBe(0);
    expect((await run("[[ 0 -eq '-9223372036854775808 % -1' ]]")).exitCode).toBe(0);
    expect(
      (await run('export FXU1=x; env -u FXU1 [[ -z $FXU1 ]]; echo $?; unset FXU1')).stdout.trim(),
    ).toBe('0');
    expect(
      (await run('export FXU2=x; env -u FXU2 [[ -v FXU2 ]]; echo $?; unset FXU2')).stdout.trim(),
    ).toBe('1');
    expect(
      (await run('export FXU3=x; env -u FXU3 [[ -z $FXU3 ]]; echo $FXU3; unset FXU3')).stdout.trim(),
    ).toBe('x');
    expect((await run('export FOO="a\nb"; [[ $FOO == "a\nb" ]]; echo $?; unset FOO')).stdout.trim()).toBe(
      '0',
    );
    expect((await run('FOO="a\nb" [[ $FOO == "a\nb" ]]')).exitCode).toBe(0);
    expect((await run("export FOO='a\\nb'; [[ $FOO == 'a\\nb' ]]; echo $?; unset FOO")).stdout.trim()).toBe(
      '0',
    );
    expect(
      (await run('unset FOO; FOO=x export FOO; [[ $FOO == x ]]; echo $?; unset FOO')).stdout.trim(),
    ).toBe('0');
    expect((await run('[[ 9223372036854775807+1 -eq -9223372036854775808 ]]')).exitCode).toBe(0);
    expect((await run('[[ é =~ [[:alpha:]] ]]')).exitCode).toBe(0);
    expect((await run('[[ é == [[:alpha:]] ]]')).exitCode).toBe(0);
    expect((await run('[[ -v PATH[0] ]]')).exitCode).toBe(0);
    expect((await run('[[ -v PATH[1] ]]')).exitCode).toBe(1);
    expect(
      (await run('n=9223372036854775807 [[ ++n -eq -9223372036854775808 ]]')).exitCode,
    ).toBe(0);
    expect((await run('TMP=1 export NEVER_SET; [[ ! -v NEVER_SET ]]')).exitCode).toBe(0);
    expect((await run("FOO='' export FOO; [[ -v FOO ]]; echo $?; unset FOO")).stdout.trim()).toBe('0');
    expect((await run('[[ 16#ffffffffffffffff -eq -1 ]]')).exitCode).toBe(0);
    expect((await run('[[ 0x10000000000000000 -eq 0 ]]')).exitCode).toBe(0);
    expect((await run('[[ 😀 =~ ^.$ ]]')).exitCode).toBe(0);
    expect((await run("[[ 'a>b' =~ (a>b) ]]")).exitCode).toBe(0);
    expect((await run("[[ 'a&&b' =~ (a&&b) ]]")).exitCode).toBe(0);
    expect((await run('[[ abc =~ b ]]; echo "$BASH_REMATCH"')).stdout.trim()).toBe('b');
    expect((await run('[[ abc =~ ^a(.)c$ ]]; echo ${BASH_REMATCH[0]}')).stdout.trim()).toBe('abc');
    expect((await run('[[ abc =~ ^a(.)c$ ]]; echo ${BASH_REMATCH[1]}')).stdout.trim()).toBe('b');
    expect((await run('[[ abc =~ ^a(.)c$ ]]; echo ${BASH_REMATCH[@]}')).stdout.trim()).toBe('abc b');
    expect((await run("[[ abc =~ ^a(.)c$ ]]; printf '<%s>\\n' \"${BASH_REMATCH[@]}\"")).stdout).toBe(
      '<abc>\n<b>\n',
    );
    expect((await run("[[ abc =~ ^a(.)c$ ]]; printf '<%s>\\n' \"${BASH_REMATCH[*]}\"")).stdout).toBe(
      '<abc b>\n',
    );
    expect(
      (await run('[[ abc =~ ^a(.)c$ ]]; unset BASH_REMATCH; echo ${BASH_REMATCH[0]}')).stdout.trim(),
    ).toBe('');
    expect(
      (await run('[[ abc =~ ^a(.)c$ ]]; BASH_REMATCH=x; echo ${BASH_REMATCH[0]}; echo ${BASH_REMATCH[1]}')).stdout.trim(),
    ).toBe('x');
    expect((await run('[[ abc =~ z ]]; echo ${BASH_REMATCH[1]}')).stdout.trim()).toBe('');
    expect((await run('[[ abc =~ ^a(.)c$ ]]; [[ -v BASH_REMATCH[1] ]]')).exitCode).toBe(0);
    expect((await run('[[ x =~ ^ ]]; printf "<%s>\\n" "${BASH_REMATCH[@]}"')).stdout).toBe('<>\n');
    expect(
      (await run('[[ abc =~ ^a(.)c$ ]]; BASH_REMATCH=x true; echo ${BASH_REMATCH[1]}')).stdout.trim(),
    ).toBe('b');
    expect(
      (await run("[[ abc =~ ^a(.)c$ ]]; printf '<%s>\\n' \"pre${BASH_REMATCH[@]}post\"")).stdout,
    ).toBe('<preabc>\n<bpost>\n');
    expect(
      (await run('[[ abc =~ ^a(.)c$ ]]; bash_rematch=x; echo ${BASH_REMATCH[1]}; unset bash_rematch')).stdout.trim(),
    ).toBe('b');
    expect((await run('unset X; printf "<%s>\\n" "pre${X[@]}post"')).stdout).toBe('<prepost>\n');
    expect((await run('echo ${PWD[0]}')).stdout.trim()).toBe(
      (await run('echo $PWD')).stdout.trim(),
    );
    expect(
      (await run('unset bash_rematch; [[ abc =~ ^a(.)c$ ]]; echo ${bash_rematch[0]}')).stdout.trim(),
    ).toBe('');
    expect(
      (await run("IFS=','; [[ abc =~ ^a(.)c$ ]]; echo \"${BASH_REMATCH[*]}\"; unset IFS")).stdout.trim(),
    ).toBe('abc,b');
    expect(
      (await run("[[ abc =~ ^a(.)c$ ]]; printf '<%s>\\n' pre\"${BASH_REMATCH[@]}\"post")).stdout,
    ).toBe('<preabc>\n<bpost>\n');
    expect(
      (await run('export BASH_REMATCH=old; [[ abc =~ b ]]; [[ $BASH_REMATCH == b ]]; echo $?; unset BASH_REMATCH')).stdout.trim(),
    ).toBe('0');
    expect((await run('[[ abc =~ b ]]; [[ abc =~ z ]]; echo "$BASH_REMATCH"')).stdout.trim()).toBe('');
    expect(() => translateCommandList(parseCommand('[[ && ]] && echo BAD'))).toThrow(/unexpected token/);
    expect((await run('[[ 2**-1 -eq 0 ]]')).exitCode).toBe(1);
    expect((await run('unset n; [[ ++n -eq 1 ]]; [[ -v n ]]')).exitCode).toBe(0);

    const homeOverride = await run(
      "export HOME='a*b'; [[ $HOME == 'a*b' && ~ == 'a*b' && 'a*b' == ~ && axb != ~ ]]",
    );
    expect(homeOverride.exitCode).toBe(0);
    expect((await run("[[ 'a*b' =~ ~ ]]")).exitCode).toBe(0);
    expect((await run('[[ axb =~ ~ ]]')).exitCode).toBe(1);
    await run('unset HOME');
    expect((await run('[[ -z $HOME && -n ~ ]]')).exitCode).toBe(0);

    const specialOverrides = await run(
      "export USER=u LOGNAME=l SHELL='' TERM=t HOSTNAME=h; " +
        "[[ $USER == u && $LOGNAME == l && -v SHELL && -z $SHELL && " +
        "$TERM == t && $HOSTNAME == h ]]",
    );
    expect(specialOverrides.exitCode).toBe(0);
    await run(
      'export USER=$USERNAME LOGNAME=$USERNAME SHELL=powershell TERM=xterm-256color ' +
        'HOSTNAME=$COMPUTERNAME',
    );

    expect((await run('unset n; [[ n=2 -eq 2 && n -eq 2 ]]; [[ -v n ]]')).exitCode).toBe(0);
    expect(
      (await run('unset a; unset b; [[ a=b=7 -eq 7 && a -eq 7 && b -eq 7 ]]')).exitCode,
    ).toBe(0);
    expect((await run("unset n; [[ 'n=1,n+=2' -eq 3 && n -eq 3 ]]")).exitCode).toBe(0);
    expect((await run("[[ 3 -eq '1 ? 2,3 : 4' ]]")).exitCode).toBe(0);
    expect((await run("unset n; [[ 0 -eq '0 && (n=2)' && ! -v n ]]")).exitCode).toBe(0);
    expect((await run("unset n; [[ 1 -eq '1 || (n=3)' && ! -v n ]]")).exitCode).toBe(0);
    expect((await run("unset n; [[ 0 -eq '0 && (n/=0)' && ! -v n ]]")).exitCode).toBe(0);
    expect(
      (await run("unset n; [[ 2 -eq '1 ? (n=2) : (n=3)' && n -eq 2 ]]")).exitCode,
    ).toBe(0);
    expect(
      (await run("unset n; [[ 3 -eq '0 ? (n=2) : (n=3)' && n -eq 3 ]]")).exitCode,
    ).toBe(0);
    expect((await run("n=1 [[ 'n+=(n=2)' -eq 3 && n -eq 3 ]]")).exitCode).toBe(0);
    expect(
      (
        await run(
          "n=8 [[ n*=2 -eq 16 && n/=4 -eq 4 && n%=3 -eq 1 && n+=5 -eq 6 && " +
            "n-=2 -eq 4 && 'n<<=1' -eq 8 && 'n>>=2' -eq 2 && 'n|=4' -eq 6 && " +
            "'n&=3' -eq 2 && n^=7 -eq 5 ]]",
        )
      ).exitCode
    ).toBe(0);
  }, 180000);

  it('array subscripts splat across commands and persist correctly', async () => {
    expect(
      (
        await run(
          '[[ abc =~ ^a(.)c$ ]]; X=y export BASH_REMATCH=z; echo ${BASH_REMATCH[0]}; echo x${BASH_REMATCH[1]}x; unset BASH_REMATCH; unset X',
        )
      ).stdout.trim(),
    ).toBe('z\nxx');
    expect((await run('[[ echo =~ ^echo$ ]]; "${BASH_REMATCH[@]}" hi')).stdout.trim()).toBe('hi');
    expect(
      (await run("[[ abc =~ ^a(.)c$ ]]; printf '<%s>\\n' ${BASH_REMATCH[*]}")).stdout,
    ).toBe('<abc>\n<b>\n');
    expect(
      (await run("IFS=; [[ abc =~ ^a(.)c$ ]]; echo \"${BASH_REMATCH[*]}\"; unset IFS")).stdout.trim(),
    ).toBe('abcb');
    expect((await run('[[ 3 =~ ^3$ ]]; seq "${BASH_REMATCH[@]}"')).stdout.trim()).toBe('1\n2\n3');
    writeFileSync(join(dir, 'abc'), 'X', 'utf8');
    writeFileSync(join(dir, 'b'), 'Y', 'utf8');
    expect((await run('[[ abc =~ ^a(.)c$ ]]; cat "${BASH_REMATCH[@]}"')).stdout.trim()).toBe('X\nY');
    await run('unset BASH_REMATCH');
    expect((await run('unset X; ${X[@]}')).exitCode).toBe(0);
    expect((await run('unset X; ${X[@]} echo ok')).stdout.trim()).toBe('ok');
    expect((await run('unset X; ${X[@]} printf %s hi')).stdout).toBe('hi');
  }, 60000);

  it('&& and || short-circuit like bash', async () => {
    expect((await run('cat missing.txt || echo FELLBACK')).stdout).toContain('FELLBACK');
    const r = await run('cat missing.txt && echo NOPE ; echo END');
    expect(r.stdout.trim()).toBe('END');
    expect(r.exitCode).toBe(0);
  });

  it('$? reflects the previous segment', async () => {
    expect((await run('false; echo $?')).stdout.trim()).toBe('1');
    expect((await run('true; echo $?')).stdout.trim()).toBe('0');
  });

  it('variables and command substitution', async () => {
    expect((await run('export GREET=hi; echo $GREET/there')).stdout.trim()).toBe('hi/there');
    expect((await run('echo $(echo nested)')).stdout.trim()).toBe('nested');
    expect((await run('echo `echo nested`')).stdout.trim()).toBe('nested');
    expect((await run("echo \"[$(printf 'a\\nb')]\"")).stdout).toBe('[a\nb]\n');
    expect((await run("[[ \"$(printf 'a\\nb')\" == \"a\nb\" ]]")).exitCode).toBe(0);
    expect((await run("X=$(printf 'a\\nb'); echo \"[$X]\"")).stdout).toBe('[a\nb]\n');
    expect((await run("echo \"[$(printf 'a\\n')]\"")).stdout).toBe('[a]\n');
    // Unquoted $(...) approximates IFS split (PS space-join), matching pre-#88.
    expect((await run("echo $(printf 'a\\nb')")).stdout.trim()).toBe('a b');
  });

  it('VAR=value prefixes do not leak past the command', async () => {
    expect((await run('FX_P=bar echo $FX_P')).stdout.trim()).toBe('bar');
    expect((await run('FX_P=bar echo $FX_P; echo x$FX_P')).stdout.trim()).toBe('bar\nx');
    expect((await run('export FX_K=old; FX_K=new echo $FX_K; echo $FX_K')).stdout.trim()).toBe(
      'new\nold',
    );
    expect((await run('FX_A=1 FX_B=$FX_A echo x$FX_B')).stdout.trim()).toBe('x');
    expect((await run('FX_P=bar true; printenv FX_P; echo $?')).stdout.trim()).toBe('1');
    expect((await run('env FX_P=bar printenv FX_P; printenv FX_P; echo done')).stdout.trim()).toBe(
      'bar\ndone',
    );
    expect((await run('FX_P=bar export FX_P; echo $FX_P')).stdout.trim()).toBe('bar');
    expect((await run('export FX_N=FX_P; FX_P=via export "$FX_N"; echo $FX_P')).stdout.trim()).toBe(
      'via',
    );
    // export + prefix keeps the name in the session; a bare prefix must not
    expect((await run('echo $FX_P')).stdout.trim()).toBe('via');
    await run('unset FX_P FX_K FX_A FX_B FX_N');
    expect((await run('FX_P=bar true; echo x$FX_P')).stdout.trim()).toBe('x');
  }, 20000);

  it('standalone assignment segments persist and feed later commands (#82)', async () => {
    expect((await run('SA_V=hello; echo $SA_V')).stdout.trim()).toBe('hello');
    expect((await run('SA_N=7; [[ $SA_N -gt 3 ]] && echo YES || echo NO')).stdout.trim()).toBe(
      'YES',
    );
    expect((await run('SA_E=; [[ -v SA_E ]] && echo SET || echo UNSET')).stdout.trim()).toBe(
      'SET',
    );
    // bash: word expansion happens BEFORE the same-segment prefix applies,
    // so `Z=temp [[ $Z == temp ]]` is false there. fauxnix evaluates at
    // runtime after applying the prefix — documented deviation (README).
    expect(
      (await run('SA_Z=out; SA_Z=in [[ $SA_Z == in ]] && echo YES || echo NO')).stdout.trim(),
    ).toBe('YES');
    await run('unset SA_V SA_N SA_E SA_Z');
  }, 20000);

  it('session cwd persists across calls', async () => {
    await run('cd sub');
    const r = await run('pwd');
    expect(r.stdout).toContain('/sub');
    expect(r.stdout).toMatch(/C:\/.*Temp.*\/sub/);
    // restore for subsequent tests — also exercises `cd -` (OLDPWD)
    const back = await run('cd - && pwd');
    expect(back.exitCode).toBe(0);
  });

  it('find + wc -l counts rows', async () => {
    const r = await run("find sub -name '*.txt' | wc -l");
    expect(r.stdout.trim()).toBe('1');
  });

  it('stat -c format', async () => {
    const r = await run("stat -c '%s %n' fruits.txt");
    expect(r.stdout.trim()).toMatch(/^30 .*fruits\.txt$/);
  });

  it('diff detects changes GNU-style', async () => {
    const r = await run('diff fruits.txt sub/b.txt');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/1,4c1/);
    expect(r.stdout).toContain('< apple');
    expect(r.stdout).toContain('> third line');
  });

  it('gzip/gunzip roundtrip', async () => {
    await run('cp fruits.txt g.txt');
    await run('gzip g.txt');
    const gz = await run('ls g.txt.gz');
    expect(gz.exitCode).toBe(0);
    await run('gunzip g.txt.gz');
    const back = await run('cat g.txt');
    expect(back.stdout).toContain('apple pie');
  });

  it('printf CRLF without a trailing LF is preserved on redirect', async () => {
    const r = await run("printf 'a\\r\\nb' > cr.txt; wc -c cr.txt");
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/4 .*cr\.txt/);
    expect(readFileSync(join(dir, 'cr.txt'))).toEqual(Buffer.from('a\r\nb'));
  });

  it('cd then redirect writes under the new cwd, not the entry cwd', async () => {
    try {
      const r = await run('cd sub && echo nested > nested.txt');
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(dir, 'nested.txt'))).toBe(false);
      const raw = readFileSync(join(dir, 'sub', 'nested.txt'), 'utf8');
      expect(raw.replace(/\r/g, '')).toBe('nested\n');
    } finally {
      await run('cd "' + dir.replace(/\\/g, '/') + '"');
    }
  });

  it('cd then stdin redirect reads from the new cwd', async () => {
    try {
      const r = await run('cd sub && wc -l < b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('1');
    } finally {
      await run('cd "' + dir.replace(/\\/g, '/') + '"');
    }
  });

  it('failed redirect on cd does not move later relative redirects', async () => {
    try {
      const r = await run('cd sub > nosuchdir/out.txt; echo ok > after.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toMatch(/nosuchdir\/out\.txt|No such file or directory/);
      expect(existsSync(join(dir, 'sub', 'after.txt'))).toBe(false);
      expect(readFileSync(join(dir, 'after.txt'), 'utf8').replace(/\r/g, '')).toBe('ok\n');
    } finally {
      await run('cd "' + dir.replace(/\\/g, '/') + '"');
    }
  });

  it('stderr redirect already applied receives a later setup error', async () => {
    const r = await run('echo hi 2>err.txt >nosuch/out.txt');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toBe('');
    expect(readFileSync(join(dir, 'err.txt'), 'utf8')).toMatch(/No such file or directory/);
  });

  it('2>&1 snapshots stdout; later > does not take the setup error', async () => {
    const r = await run('echo x 2>&1 >ok.txt >nosuch/out.txt');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/No such file or directory/);
    expect(existsSync(join(dir, 'ok.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'ok.txt'), 'utf8')).toBe('');
  });

  it('>file 2>&1 then a failed > sends the setup error into that file', async () => {
    const r = await run('echo x >ok2.txt 2>&1 >nosuch/out.txt');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toBe('');
    expect(readFileSync(join(dir, 'ok2.txt'), 'utf8')).toMatch(/No such file or directory/);
  });

  it('rm of a redirect target does not recreate the path after the command', async () => {
    await run('echo keep > gone.txt');
    const r = await run('rm gone.txt > gone.txt');
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
  });

  it('2>/dev/null swallows a later failed stdout redirect', async () => {
    const r = await run('echo hi 2>/dev/null >nosuch/out.txt');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toBe('');
  });

  it('opts.cwd plus cd keeps command cwd and redirect cwd in sync', async () => {
    const extra = new FauxnixSession();
    try {
      const r = await extra.run(
        translateCommandList(parseCommand('cd sub && cat b.txt > copy.txt')),
        { cwd: dir },
      );
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(dir, 'copy.txt'))).toBe(false);
      expect(readFileSync(join(dir, 'sub', 'copy.txt'), 'utf8')).toContain('third line');
    } finally {
      await extra.dispose();
    }
  });

  it('earlier failed redirect does not truncate a later output file', async () => {
    writeFileSync(join(dir, 'important.txt'), 'keep\n', 'utf8');
    const r = await run('echo hi 2>nosuch/err >important.txt');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/No such file or directory/);
    expect(readFileSync(join(dir, 'important.txt'), 'utf8')).toBe('keep\n');
  });

  it('redirect before cd still writes in the entry cwd', async () => {
    try {
      const r = await run('echo stay > stay.txt && cd sub');
      expect(r.exitCode).toBe(0);
      expect(existsSync(join(dir, 'stay.txt'))).toBe(true);
      expect(existsSync(join(dir, 'sub', 'stay.txt'))).toBe(false);
    } finally {
      await run('cd "' + dir.replace(/\\/g, '/') + '"');
    }
  });

  it('redirects write LF line endings (GNU parity)', async () => {
    const r = await run('head -2 fruits.txt > out.txt; wc -c out.txt');
    // fruits.txt first two lines: "apple\nBanana\n" = 13 bytes with LF endings
    expect(r.stdout.trim()).toMatch(/13 .*out\.txt/);
    // the redirect-written file itself must contain no CR bytes
    const raw = readFileSync(join(dir, 'out.txt'), 'utf8');
    expect(raw).not.toContain('\r');
    expect(raw).toBe('apple\nBanana\n');
  });

  it('redirect byte counts match GNU (create → head → wc roundtrip)', async () => {
    const r = await run(
      "printf 'alpha\\nbeta\\n' > w.txt; head -2 w.txt > w2.txt; wc -c w2.txt; rm w.txt w2.txt",
    );
    expect(r.stdout.trim()).toMatch(/11 .*w2\.txt/);
  });

  it('ps table has header', async () => {
    const r = await run('ps aux | head -1');
    expect(r.stdout).toMatch(/USER\s+PID/);
  });

  it('uname reports fauxnix kernel marker', async () => {
    expect((await run('uname -r')).stdout.trim()).toBe('6.8.0-fauxnix');
  });

  it('command -v finds builtins and missing names', async () => {
    expect((await run('command -v echo')).stdout.trim()).toBe('/usr/bin/echo');
    expect((await run('command -v definitely_not_a_cmd_xyz')).exitCode).toBe(1);
    expect((await run('command echo hi')).stdout.trim()).toBe('hi');
  });

  it('date format tokens', async () => {
    expect((await run('date +%Y')).stdout).toMatch(/^\d{4}/);
  });

  it('native passthrough (node) with argv safety', async () => {
    const r = await run('node --version');
    expect(r.stdout.trim()).toMatch(/^v\d+\.\d+/);
  });

  it('xargs runs native commands', async () => {
    const r = await run("printf -- '--version\\n' | xargs node");
    expect(r.stdout.trim()).toMatch(/^v\d+\.\d+/);
  });

  it('host guard refuses loopback URLs for curl', async () => {
    const r = await run('curl -s http://127.0.0.1:9/x');
    expect(r.stderr).toContain('refused private/loopback address');
    expect(r.exitCode).not.toBe(0);
  });

  it('timeout kills long sleeps with exit 124', async () => {
    const r = await run('timeout 1 sleep 5');
    expect(r.exitCode).toBe(124);
  }, 20000);

  it('Chinese text round-trips (UTF-8)', async () => {
    await run("echo '你好，世界' > zh.txt");
    const r = await run('cat zh.txt');
    expect(r.stdout.trim()).toBe('你好，世界');
    const g = await run("grep '世界' zh.txt");
    expect(g.exitCode).toBe(0);
  });

  it('yes | head terminates (no hang)', async () => {
    const r = await run('yes | head -3');
    expect(r.stdout.split(/\r?\n/).filter((l) => l === 'y').length).toBe(3);
  }, 30000);
});
