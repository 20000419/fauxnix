import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('session-scoped $HOME (#255)', () => {
  it('resolves $HOME through the session variable machinery, not the PS automatic', () => {
    expect(bodyOf('echo "$HOME"')).toContain("(fx-scalar0 'HOME')");
    expect(bodyOf('echo "$HOME"')).not.toMatch(/\$HOME\]/);
  });

  it('falls back to the inherited environment, then the profile', () => {
    // the helper lives in the emitted wrap, not the bare body
    const script = translateCommandList(parseCommand('echo "$HOME"'), PURE_TRANSLATION)
      .map((p) => p.script).join('\n');
    expect(script).toContain("$env:HOME) { [string]$env:HOME } else { [string]$HOME }");
  });

  it('tilde expansion follows the session HOME', () => {
    expect(bodyOf('cd ~')).toContain("(fx-scalar0 'HOME')");
  });
});

describe('quote-aware glob operands (#255)', () => {
  it('keeps quoted glob characters literal via wildcard escaping', () => {
    expect(bodyOf("rm 'a*b'")).toContain("'a`*b'");
    expect(bodyOf('rm a\\*b')).toContain("'a`*b'");
  });

  it('leaves unquoted glob characters active and unchanged in shape', () => {
    expect(bodyOf('rm a*b')).toContain("'a*b'");
    expect(bodyOf('rm a*b')).not.toContain("'a`*b'");
  });

  it('escapes quoted variable expansions at runtime, keeps unquoted ones raw', () => {
    const quoted = bodyOf('rm "$d"/*.txt');
    expect(quoted).toContain('[WildcardPattern]::Escape([string]($env:d))');
    expect(quoted).toContain("'/*.txt'");
    const bare = bodyOf('rm $d/*.txt');
    expect(bare).toContain('([string]($env:d))');
    expect(bare).not.toContain('WildcardPattern]::Escape');
  });

  it('unescapes unmatched literals so error messages keep shell spelling', () => {
    const body = bodyOf("rm 'a*b'");
    expect(body).toContain('return @(fx-wclit $p)');
    expect(body).toContain("-replace '`(?=[*?[])', ''");
  });

  it('applies the same quoting awareness to cp, mv, ls, stat, file, cat and grep', () => {
    for (const cmd of ['cp ', 'mv ', 'ls ', 'stat ', 'file ']) {
      expect(bodyOf(cmd + "'x*y' z"), cmd).toContain("'x`*y'");
    }
    expect(bodyOf("cat 'x*y'")).toContain("'x`*y'");
    expect(bodyOf("grep p 'x*y'")).toContain("'x`*y'");
  });
});

describe('literal path creation (#255)', () => {
  it('mkdir creates via .NET with parent semantics, never New-Item -Path', () => {
    const parents = bodyOf('mkdir -p a/b');
    expect(parents).toContain('[void][IO.Directory]::CreateDirectory($fx_d)');
    expect(parents).not.toContain('New-Item -ItemType Directory');
    const plain = bodyOf('mkdir a/b');
    expect(plain).toContain('[IO.Directory]::CreateDirectory($fx_d)');
    expect(plain).toContain('Test-Path -LiteralPath $fx_par -PathType Container');
  });

  it('touch creates via .NET File.Create, never New-Item -Path', () => {
    const body = bodyOf('touch f');
    expect(body).toContain('$fx_nfs = [IO.File]::Create($fx_f); $fx_nfs.Close()');
    expect(body).not.toContain('New-Item -ItemType File');
  });
});
