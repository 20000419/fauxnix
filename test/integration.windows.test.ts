/**
 * Integration tests — execute translated commands through real Windows
 * PowerShell 5.1. Skipped automatically on non-Windows platforms.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
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
    mkdirSync(join(dir, 'grep-tree', 'src'), { recursive: true });
    mkdirSync(join(dir, 'grep-tree', 'vendor'), { recursive: true });
    mkdirSync(join(dir, 'grep-tree', 'generated'), { recursive: true });
    writeFileSync(join(dir, 'grep-tree', 'keep.ts'), 'token keep\n', 'utf8');
    writeFileSync(join(dir, 'grep-tree', 'notes.md'), 'token notes\n', 'utf8');
    writeFileSync(join(dir, 'grep-tree', 'skip.test.ts'), 'token test\n', 'utf8');
    writeFileSync(join(dir, 'grep-tree', 'explicit.txt'), 'token explicit\n', 'utf8');
    writeFileSync(join(dir, 'grep-tree', 'src', 'nested.ts'), 'token nested\n', 'utf8');
    writeFileSync(join(dir, 'grep-tree', 'vendor', 'vendor.ts'), 'token vendor\n', 'utf8');
    writeFileSync(join(dir, 'grep-tree', 'generated', 'generated.md'), 'token generated\n', 'utf8');

    mkdirSync(join(dir, 'find-depth', 'level-one', 'level-two'), { recursive: true });
    writeFileSync(join(dir, 'find-depth', 'root.txt'), 'root\n', 'utf8');
    writeFileSync(join(dir, 'find-depth', 'level-one', 'child.txt'), 'child\n', 'utf8');
    writeFileSync(
      join(dir, 'find-depth', 'level-one', 'level-two', 'grandchild.txt'),
      'grandchild\n',
      'utf8',
    );
    mkdirSync(join(dir, 'find-bool', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'find-bool', 'keep.ts'), 'keep\n', 'utf8');
    writeFileSync(join(dir, 'find-bool', 'drop.log'), 'drop\n', 'utf8');
    writeFileSync(join(dir, 'find-bool', 'sub', 'a.ts'), 'a\n', 'utf8');
    writeFileSync(join(dir, 'find-bool', 'sub', 'b.log'), 'b\n', 'utf8');
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
    const t0 = Date.now();
    const r = await session.run(translateCommandList(parseCommand(cmd)));
    if (process.env.FX_TRACE) {
      console.error(`[trace ${((Date.now() - t0) / 1000).toFixed(1)}s] ${cmd.slice(0, 70)} => ${r.exitCode}`);
      appendFileSync(join(tmpdir(), 'fx-trace.log'), cmd + '\x1e');
    }
    return r;
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

  it('grep -rn recursively searches instead of treating bundled flags as an include glob', async () => {
    const r = await run('grep -rn token grep-tree');
    const stdout = r.stdout.replaceAll('\\', '/');
    expect(r.exitCode).toBe(0);
    expect(stdout).toMatch(/grep-tree\/keep\.ts:1:token keep/);
    expect(stdout).toMatch(/grep-tree\/src\/nested\.ts:1:token nested/);
  });

  it('grep applies repeated include, exclude, and exclude-dir filters', async () => {
    const r = await run(
      "grep -rn --include='*.ts' --include '*.md' --exclude='*.test.ts' --exclude notes.md --exclude-dir=vendor --exclude-dir generated token grep-tree",
    );
    const stdout = r.stdout.replaceAll('\\', '/');
    expect(r.exitCode).toBe(0);
    expect(stdout).toMatch(/grep-tree\/keep\.ts:1:token keep/);
    expect(stdout).toMatch(/grep-tree\/src\/nested\.ts:1:token nested/);
    expect(stdout).not.toContain('notes.md');
    expect(stdout).not.toContain('skip.test.ts');
    expect(stdout).not.toContain('/vendor/');
    expect(stdout).not.toContain('/generated/');
  });

  it('grep exclusions apply to explicit file and directory operands', async () => {
    const file = await run(
      "grep -n --exclude='grep-tree/*.txt' token grep-tree/explicit.txt",
    );
    expect(file.exitCode).toBe(1);
    expect(file.stdout).toBe('');
    expect(file.stderr).toBe('');

    const directory = await run(
      "grep -rn --exclude-dir='grep-tree/vendor/' token grep-tree/vendor",
    );
    expect(directory.exitCode).toBe(1);
    expect(directory.stdout).toBe('');
    expect(directory.stderr).toBe('');
  });

  it('grep uses the last matching include or exclude rule', async () => {
    const included = await run(
      "grep -n --exclude='*.txt' --include=explicit.txt token grep-tree/explicit.txt",
    );
    expect(included.exitCode).toBe(0);
    expect(included.stdout).toContain('token explicit');

    const excluded = await run(
      "grep -n --include='*.txt' --exclude=explicit.txt token grep-tree/explicit.txt",
    );
    expect(excluded.exitCode).toBe(1);
    expect(excluded.stdout).toBe('');
  });

  it('pipeline: cat | grep | sort', async () => {
    const r = await run('cat fruits.txt | grep -i apple | sort');
    expect(r.stdout.split(/\r?\n/).filter(Boolean)).toEqual(['apple', 'apple pie']);
  });

  it('pipeline exit status comes from the last stage (pipefail off)', async () => {
    expect((await run('false | true')).exitCode).toBe(0);
    expect((await run('true | false')).exitCode).toBe(1);
  });

  it('pipeline exit status controls following && and || lists', async () => {
    const andResult = await run('grep NO fruits.txt | head -1 && echo AFTER');
    expect(andResult.stdout.trim()).toBe('AFTER');
    expect(andResult.exitCode).toBe(0);

    const ignoredFailure = await run('false | true || echo FALLBACK');
    expect(ignoredFailure.stdout.trim()).toBe('');
    expect(ignoredFailure.exitCode).toBe(0);

    const lastStageFailure = await run('true | false || echo FALLBACK');
    expect(lastStageFailure.stdout.trim()).toBe('FALLBACK');
    expect(lastStageFailure.exitCode).toBe(0);
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
    expect((await run('head --lines=1 fruits.txt')).stdout.trim()).toBe('apple');
    expect((await run('tail -1 fruits.txt')).stdout.trim()).toBe('cherry');
    expect((await run('tail --lines=1 fruits.txt')).stdout.trim()).toBe('cherry');
    expect((await run('wc -l fruits.txt')).stdout.trim()).toMatch(/4/);
    expect((await run('wc -l < fruits.txt')).stdout.trim()).toBe('4');
  });

  it('grep -m1 stops after the first match', async () => {
    const r = await run('grep -m1 apple fruits.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('apple');
    const all = await run('grep apple fruits.txt');
    expect(all.stdout.trim().split(/\r?\n/)).toEqual(['apple', 'apple pie']);
    const viaE = await run('grep -e apple fruits.txt');
    expect(viaE.exitCode).toBe(0);
    expect(viaE.stdout.trim().split(/\r?\n/)).toEqual(['apple', 'apple pie']);
  });

  it('du --max-depth=0 prints only the root', async () => {
    const deep = await run('du find-depth');
    const shallow = await run('du --max-depth=0 find-depth');
    expect(shallow.exitCode).toBe(0);
    const rows = shallow.stdout.split(/\r?\n/).filter(Boolean);
    expect(rows.length).toBe(1);
    expect(rows[0]).toContain('find-depth');
    expect(deep.stdout.split(/\r?\n/).filter(Boolean).length).toBeGreaterThan(1);
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
  }, 420000);

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
  }, 60000);

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

  it('find applies maxdepth and mindepth from root depth zero', async () => {
    const paths = async (cmd: string) => {
      const r = await run(cmd);
      expect(r.exitCode).toBe(0);
      return r.stdout.split(/\r?\n/).filter(Boolean).sort();
    };

    expect(await paths('find find-depth -maxdepth 0')).toEqual(['find-depth']);
    expect(await paths('find find-depth -maxdepth 1')).toEqual([
      'find-depth',
      'find-depth/level-one',
      'find-depth/root.txt',
    ]);
    expect(await paths('find find-depth -mindepth 1 -maxdepth 1')).toEqual([
      'find-depth/level-one',
      'find-depth/root.txt',
    ]);
    expect(await paths('find find-depth -mindepth 2 -maxdepth 2')).toEqual([
      'find-depth/level-one/child.txt',
      'find-depth/level-one/level-two',
    ]);
    expect(await paths('find find-depth -mindepth 3')).toEqual([
      'find-depth/level-one/level-two/grandchild.txt',
    ]);
  });

  it('find rejects missing and invalid depth arguments', () => {
    expect(() => translateCommandList(parseCommand('find find-depth -maxdepth'))).toThrow(
      "find: missing argument to '-maxdepth'",
    );
    for (const value of ['nope', '-1']) {
      expect(() =>
        translateCommandList(parseCommand(`find find-depth -mindepth ${value}`)),
      ).toThrow(
        `find: expected a non-negative decimal integer argument to -mindepth, but got '${value}'`,
      );
    }
  });

  it('find ! / -o compose instead of ignoring operators', async () => {
    const paths = async (cmd: string) => {
      const r = await run(cmd);
      expect(r.exitCode).toBe(0);
      return r.stdout.split(/\r?\n/).filter(Boolean).sort();
    };
    expect(await paths("find find-bool -name '*.ts'")).toEqual([
      'find-bool/keep.ts',
      'find-bool/sub/a.ts',
    ]);
    const negated = await paths("find find-bool ! -name '*.ts'");
    expect(negated).toContain('find-bool');
    expect(negated).toContain('find-bool/drop.log');
    expect(negated).toContain('find-bool/sub');
    expect(negated).toContain('find-bool/sub/b.log');
    expect(negated).not.toContain('find-bool/keep.ts');
    expect(negated).not.toContain('find-bool/sub/a.ts');
    expect(await paths("find find-bool -name '*.ts' -o -name '*.log'")).toEqual([
      'find-bool/drop.log',
      'find-bool/keep.ts',
      'find-bool/sub/a.ts',
      'find-bool/sub/b.log',
    ]);
    expect(await paths("find find-bool -name '*.ts' -name '*.log'")).toEqual([]);
  });

  it('find ! -name -delete removes the negated set, not the named set', async () => {
    const root = join(dir, 'find-del-not');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'keep.ts'), 'keep\n', 'utf8');
    writeFileSync(join(root, 'drop.log'), 'drop\n', 'utf8');
    writeFileSync(join(root, 'sub', 'a.ts'), 'a\n', 'utf8');
    writeFileSync(join(root, 'sub', 'b.log'), 'b\n', 'utf8');
    const r = await run("find find-del-not ! -name '*.ts' -delete");
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(root, 'keep.ts'))).toBe(true);
    expect(existsSync(join(root, 'sub', 'a.ts'))).toBe(true);
    expect(existsSync(join(root, 'drop.log'))).toBe(false);
    expect(existsSync(join(root, 'sub', 'b.log'))).toBe(false);
  });

  it('find -name a -o -name b -delete follows GNU AND/OR precedence', async () => {
    const root = join(dir, 'find-del-or');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'keep.ts'), 'keep\n', 'utf8');
    writeFileSync(join(root, 'drop.log'), 'drop\n', 'utf8');
    const footgun = await run("find find-del-or -name '*.log' -o -name '*.ts' -delete");
    expect(footgun.exitCode).toBe(0);
    expect(existsSync(join(root, 'drop.log'))).toBe(true);
    expect(existsSync(join(root, 'keep.ts'))).toBe(false);

    const groupedRoot = join(dir, 'find-del-group');
    mkdirSync(groupedRoot, { recursive: true });
    writeFileSync(join(groupedRoot, 'keep.ts'), 'keep\n', 'utf8');
    writeFileSync(join(groupedRoot, 'drop.log'), 'drop\n', 'utf8');
    const grouped = await run("find find-del-group \\( -name '*.log' -o -name '*.ts' \\) -delete");
    expect(grouped.exitCode).toBe(0);
    expect(existsSync(join(groupedRoot, 'keep.ts'))).toBe(false);
    expect(existsSync(join(groupedRoot, 'drop.log'))).toBe(false);
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

  it('source reads NAME=VALUE files into the session', async () => {
    writeFileSync(join(dir, 'dotenv.env'), 'FOO=bar\n# c\nexport BAZ=qux\nQUOT=\"hi\"\n', 'utf8');
    expect((await run('source dotenv.env; echo $FOO $BAZ $QUOT')).stdout.trim()).toBe('bar qux hi');
    await run('unset FOO BAZ QUOT');
  });

  it('read -r stores a line from a pipe into the session', async () => {
    expect((await run("printf 'hello\\n' | read -r X; echo $X")).stdout.trim()).toBe('hello');
    expect((await run("printf 'a b c\\n' | read A B; echo $A $B")).stdout.trim()).toBe('a b c');
    await run('unset X A B');
  });

  it('set -e fails loudly instead of no-op', async () => {
    const r = await run('set -e');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/set -e\/-u\/-x is not supported/);
    expect((await run('set --')).exitCode).toBe(0);
  });

  it('env -i fails loudly instead of keeping inherited secrets', async () => {
    const r = await run('env -i echo hi');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/env -i\/--ignore-environment is not supported/);
    expect(r.stdout.trim()).toBe('');
  });

  it('${name:-word} and ${name:+word} follow bash empty/unset rules', async () => {
    expect((await run('unset X; echo ${X:-def}')).stdout.trim()).toBe('def');
    expect((await run('X=; echo ${X:-def}; unset X')).stdout.trim()).toBe('def');
    expect((await run('X=hi; echo ${X:-def}; unset X')).stdout.trim()).toBe('hi');
    expect((await run('X=hi; echo ${X:+on}; unset X')).stdout.trim()).toBe('on');
    expect((await run('unset X; echo [${X:+on}]')).stdout.trim()).toBe('[]');
    const miss = await run('unset X; echo ${X:?missing}');
    expect(miss.exitCode).toBe(1);
    expect(miss.stderr).toMatch(/X: missing/);
  });

  it('${#name} is string length and ${#name[@]} is element count', async () => {
    expect((await run('X=abcd; echo ${#X}; unset X')).stdout.trim()).toBe('4');
    expect((await run('[[ abc =~ ^a(.)c$ ]]; echo ${#BASH_REMATCH[@]}')).stdout.trim()).toBe('2');
    expect((await run('unset Z; echo ${#Z}')).stdout.trim()).toBe('0');
  });

  it('if/then/else/fi follows the test exit code', async () => {
    expect((await run('if true; then echo YES; fi')).stdout.trim()).toBe('YES');
    expect((await run('if false; then echo YES; else echo NO; fi')).stdout.trim()).toBe('NO');
    expect((await run('if true; then echo A; else echo B; fi')).stdout.trim()).toBe('A');
    expect((await run('if false; then echo YES; fi')).stdout.trim()).toBe('');
  });

  it('elif takes the first true branch and keeps compound exit status', async () => {
    expect((await run('if false; then echo A; elif true; then echo B; else echo C; fi')).stdout.trim()).toBe('B');
    expect((await run('if false; then echo A; elif false; then echo B; else echo C; fi')).stdout.trim()).toBe('C');
    expect((await run('if false; then echo A; elif false; then echo B; elif true; then echo C; fi')).stdout.trim()).toBe('C');
    const taken = await run('if false; then false; elif true; then true; fi');
    expect(taken.exitCode).toBe(0);
    const missed = await run('if false; then echo A; elif false; then echo B; fi');
    expect(missed.exitCode).toBe(0);
    expect(missed.stdout.trim()).toBe('');
  });

  it('for x in words; do ...; done iterates in the same session', async () => {
    expect((await run('for x in a b c; do echo $x; done')).stdout.trim()).toBe('a\nb\nc');
    expect((await run('for x in 1 2; do echo n$x; done; echo z$x')).stdout.trim()).toBe(
      'n1\nn2\nz2',
    );
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

  it('word-level $((...)) evaluates through fx-arith', async () => {
    expect((await run('echo $((1+1))')).stdout.trim()).toBe('2');
    expect((await run('x=3; echo $((x+1))')).stdout.trim()).toBe('4');
    expect((await run('x=3; echo $(($x+1))')).stdout.trim()).toBe('4');
    expect((await run('echo "$((2*3))"')).stdout.trim()).toBe('6');
    expect((await run('echo $(())')).stdout.trim()).toBe('0');
    const step = await run('i=3; i=$((i+1)); echo $i');
    expect(step.exitCode).toBe(0);
    expect(step.stdout.trim()).toBe('4');
    const bad = await run('echo $((1+))');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/integer expression expected/);
  });

  it('prewarm hides host boot from the first echo hi', async () => {
    const extra = new FauxnixSession();
    try {
      await extra.prewarm();
      const t0 = Date.now();
      const r = await extra.run(translateCommandList(parseCommand('echo hi')));
      const ms = Date.now() - t0;
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('hi');
      // after #138's structured-results bootstrap the first frame measures
      // 0.6-0.9s loaded; the claim under test is "prewarm beats the ~1.1s
      // cold spawn", not a specific latency (first-frame regression tracked
      // in its own issue)
      expect(ms).toBeLessThan(1100);
    } finally {
      await extra.dispose();
    }
  }, 30000);

  it('15x echo hi on a warm host is far below the 1.25s spawn baseline', async () => {
    const extra = new FauxnixSession();
    try {
      const warm = await extra.run(translateCommandList(parseCommand('echo hi')));
      expect(warm.stdout.trim()).toBe('hi');
      const times: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = Date.now();
        const r = await extra.run(translateCommandList(parseCommand('echo hi')));
        times.push(Date.now() - t0);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe('hi');
      }
      const sorted = [...times].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)]!;
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      // Maintainer baseline after #114: 1.25s/cmd, dominated by powershell.exe spawn.
      // A persistent host must beat that by a lot, not 5%.
      expect(p50).toBeLessThan(250);
      expect(mean).toBeLessThan(400);
      expect(Math.max(...times)).toBeLessThan(1250);
    } finally {
      await extra.dispose();
    }
  }, 60000);

  it('executor timeout stops later segments before output or side effects', async () => {
    const extra = new FauxnixSession();
    const marker = join(dir, 'timeout-later-segment.txt');
    rmSync(marker, { force: true });
    try {
      const r = await extra.run(
        translateCommandList(
          parseCommand('sleep 5; echo should-not-run; touch "' + marker + '"'),
        ),
        { timeoutMs: 800 },
      );
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toMatch(/timed out/);
      expect(r.stdout).not.toContain('should-not-run');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await extra.dispose();
      rmSync(marker, { force: true });
    }
  }, 30000);

  it('executor timeout is one deadline across all segments', async () => {
    const extra = new FauxnixSession();
    try {
      await extra.prewarm();
      const r = await extra.run(
        translateCommandList(
          parseCommand('sleep 1; echo before-deadline; sleep 5; echo after-deadline'),
        ),
        // wide margins for cold CI runners: segment 1 must finish inside the
        // budget even with ~2s host overhead, segment 3 must blow it by a lot
        { timeoutMs: 3500 },
      );
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toMatch(/timed out/);
      expect(r.stdout.trim()).toBe('before-deadline');
    } finally {
      await extra.dispose();
    }
  }, 30000);

  it('executor timeout 124 leaves the same session usable', async () => {
    const extra = new FauxnixSession();
    try {
      const r = await extra.run(translateCommandList(parseCommand('sleep 5')), { timeoutMs: 800 });
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toMatch(/timed out/);
      const next = await extra.run(translateCommandList(parseCommand('echo after-timeout')));
      expect(next.exitCode).toBe(0);
      expect(next.stdout.trim()).toBe('after-timeout');
    } finally {
      await extra.dispose();
    }
  }, 30000);

  it('adds a default PATHEXT only when no case variant is present', async () => {
    const extra = new FauxnixSession();
    const overrides = extra.env as Record<string, string | undefined>;
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === 'PATHEXT') overrides[key] = undefined;
    }
    try {
      const fallbackEnv = extra.childEnv();
      expect(fallbackEnv.PATHEXT).toBe('.COM;.EXE;.BAT;.CMD');

      extra.env.PathExt = '.EXPLICIT';
      const explicitEnv = extra.childEnv();
      const pathExtKeys = Object.keys(explicitEnv).filter((key) => key.toUpperCase() === 'PATHEXT');
      expect(pathExtKeys).toEqual(['PathExt']);
      expect(explicitEnv.PathExt).toBe('.EXPLICIT');
    } finally {
      await extra.dispose();
    }
  });

  it('runs an extensionless native executable when the official MCP environment omits PATHEXT', async () => {
    const inheritedEnv = getDefaultEnvironment();
    expect(Object.keys(inheritedEnv).some((key) => key.toUpperCase() === 'PATHEXT')).toBe(false);

    const extra = new FauxnixSession();
    const overrides = extra.env as Record<string, string | undefined>;
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase() === 'PATHEXT') overrides[key] = undefined;
    }
    try {
      await extra.prewarm();
      const result = await extra.run(translateCommandList(parseCommand('node --version')));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/m);
      expect(result.stderr).toBe('');
    } finally {
      await extra.dispose();
    }
  }, 30000);

  it('cp -n does not overwrite an existing dest', async () => {
    writeFileSync(join(dir, 'cp-n-src.txt'), 'SRC\n', 'utf8');
    writeFileSync(join(dir, 'cp-n-dst.txt'), 'DST\n', 'utf8');
    const r = await run('cp -n cp-n-src.txt cp-n-dst.txt');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'cp-n-dst.txt'), 'utf8')).toBe('DST\n');
  });

  it('cp without -n overwrites dest', async () => {
    writeFileSync(join(dir, 'cp-ow-src.txt'), 'SRC\n', 'utf8');
    writeFileSync(join(dir, 'cp-ow-dst.txt'), 'DST\n', 'utf8');
    const r = await run('cp cp-ow-src.txt cp-ow-dst.txt');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'cp-ow-dst.txt'), 'utf8')).toBe('SRC\n');
  });

  it('mv -n leaves both files when dest exists', async () => {
    writeFileSync(join(dir, 'mv-n-src.txt'), 'SRC\n', 'utf8');
    writeFileSync(join(dir, 'mv-n-dst.txt'), 'DST\n', 'utf8');
    const r = await run('mv -n mv-n-src.txt mv-n-dst.txt');
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, 'mv-n-src.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'mv-n-dst.txt'), 'utf8')).toBe('DST\n');
  });

  it('touch -c does not create a missing file; plain touch does', async () => {
    expect(existsSync(join(dir, 'touch-c-missing.txt'))).toBe(false);
    const skipped = await run('touch -c touch-c-missing.txt');
    expect(skipped.exitCode).toBe(0);
    expect(existsSync(join(dir, 'touch-c-missing.txt'))).toBe(false);
    const created = await run('touch touch-create.txt');
    expect(created.exitCode).toBe(0);
    expect(existsSync(join(dir, 'touch-create.txt'))).toBe(true);
  });

  it('tee --append appends instead of truncating', async () => {
    writeFileSync(join(dir, 'tee-app.txt'), 'A', 'utf8');
    const r = await run('printf B | tee --append tee-app.txt');
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'tee-app.txt'), 'utf8')).toBe('AB');
  });

  it('cp unknown option fails before copying', async () => {
    writeFileSync(join(dir, 'cp-z-src.txt'), 'SRC\n', 'utf8');
    writeFileSync(join(dir, 'cp-z-dst.txt'), 'DST\n', 'utf8');
    const r = await run('cp -z cp-z-src.txt cp-z-dst.txt');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid option -- 'z'");
    expect(readFileSync(join(dir, 'cp-z-dst.txt'), 'utf8')).toBe('DST\n');
  });
  it('v2 host truncates stdout at the per-run budget', async () => {
    const extra = new FauxnixSession();
    try {
      await extra.prewarm();
      const r = await extra.run(translateCommandList(parseCommand('printf AAAAAAAAAA')), {
        stdoutLimit: 4,
      });
      expect(r.truncated).toBe(true);
      expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThanOrEqual(4);
      const hi = await extra.run(translateCommandList(parseCommand('echo hi')));
      expect(hi.exitCode).toBe(0);
      expect(hi.stdout.trim()).toBe('hi');
    } finally {
      await extra.dispose();
    }
  }, 30000);

  it('whitespace-only stdout is preserved', async () => {
    const r = await run("printf '   '");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('   ');
    expect(r.cancelled).toBe(false);
    expect(r.timedOut).toBe(false);
  });

  it('native stderr is returned once and does not leak into the next command', async () => {
    const noisy = await run(`node -e "process.stderr.write('E'.repeat(4096)); process.exit(7)"`);
    expect(noisy.exitCode).toBe(7);
    expect(noisy.stderr).toContain('E'.repeat(64));
    expect(noisy.stderr.split('E').length - 1).toBeGreaterThanOrEqual(4096);
    const next = await run('echo hi');
    expect(next.exitCode).toBe(0);
    expect(next.stdout.trim()).toBe('hi');
    expect(next.stderr).not.toContain('E'.repeat(64));
  });

  it('AbortSignal cancel unblocks the next request without running later segments', async () => {
    const extra = new FauxnixSession();
    try {
      await extra.prewarm();
      const ac = new AbortController();
      const pending = extra.run(
        translateCommandList(parseCommand('sleep 5; echo should-not-run')),
        { timeoutMs: 30_000, signal: ac.signal },
      );
      await new Promise((r) => setTimeout(r, 250));
      ac.abort();
      const cancelled = await pending;
      expect(cancelled.cancelled).toBe(true);
      expect(cancelled.exitCode).toBe(130);
      expect(cancelled.stdout).not.toContain('should-not-run');
      const next = await extra.run(translateCommandList(parseCommand('echo after-cancel')));
      expect(next.exitCode).toBe(0);
      expect(next.stdout.trim()).toBe('after-cancel');
    } finally {
      await extra.dispose();
    }
  }, 30000);

  it('concurrent reset leaves one usable session', async () => {
    const extra = new FauxnixSession();
    try {
      await extra.prewarm();
      await Promise.all([extra.reset(), extra.reset(), extra.reset()]);
      const r = await extra.run(translateCommandList(parseCommand('echo x')));
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('x');
    } finally {
      await extra.dispose();
    }
  }, 30000);
});
