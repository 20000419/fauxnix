import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Generated-code checks for #257 (zip-slip hardening); nothing is extracted here.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('unzip extraction containment (#257)', () => {
  it('no longer delegates extraction to Expand-Archive', () => {
    expect(bodyOf('unzip a.zip -d out')).not.toContain('Expand-Archive');
  });

  it('validates every entry before writing anything', () => {
    const body = bodyOf('unzip a.zip -d out');
    const validate = body.indexOf('$fx_tT.StartsWith($fx_rootT, [StringComparison]::OrdinalIgnoreCase)');
    const refuse = body.indexOf("unzip: fauxnix: refusing unsafe entry '");
    const write = body.indexOf('[IO.Compression.ZipFileExtensions]::ExtractToFile(');
    expect(validate).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(validate);
    expect(write).toBeGreaterThan(refuse);
    // rooted names and drive-qualified names are rejected outright
    expect(body).toContain("if ($fx_n -match '^[\\\\/]') { $fx_why = 'absolute path' }");
    expect(body).toContain("elseif ($fx_n.IndexOf(':') -ge 0) { $fx_why = 'drive or stream name' }");
  });

  it('resolves the destination against the session location with a trailing separator', () => {
    const body = bodyOf('unzip a.zip -d out');
    expect(body).toContain('GetUnresolvedProviderPathFromPSPath([string]$fx_dir)');
    expect(body).toContain('[IO.Path]::DirectorySeparatorChar');
  });

  it('compares with a normalized trailing separator so "./" and "a/../" stay inside', () => {
    const body = bodyOf('unzip a.zip -d out');
    expect(body).toContain("$fx_tT = $fx_t.TrimEnd([char[]]@('\\', '/')) + [IO.Path]::DirectorySeparatorChar");
    expect(body).toContain("'names the destination itself'");
  });

  it('treats an unresolvable entry name as unsafe instead of aborting', () => {
    expect(bodyOf('unzip a.zip')).toContain(
      "try { $fx_t = [IO.Path]::GetFullPath([IO.Path]::Combine($fx_rootT, $fx_n)) } catch { $fx_why = 'invalid name' }",
    );
  });

  it('refuses reserved Windows device names in any path segment', () => {
    const body = bodyOf('unzip a.zip');
    expect(body).toContain("'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$'");
    expect(body).toContain("'reserved device name'");
  });

  it('refuses to write through an existing symlink/junction below the destination', () => {
    const body = bodyOf('unzip a.zip');
    const check = body.indexOf('[IO.FileAttributes]::ReparsePoint');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf('ExtractToFile('));
  });

  it('creates parent directories inside the per-entry try, after the -o check', () => {
    const body = bodyOf('unzip a.zip');
    const tryAt = body.indexOf('        try {\n          $fx_linked');
    const exists = body.indexOf('already exists (use -o to overwrite)');
    const mkParent = body.indexOf('CreateDirectory([IO.Path]::GetDirectoryName($fx_t))');
    expect(tryAt).toBeGreaterThan(-1);
    expect(exists).toBeGreaterThan(tryAt);
    expect(mkParent).toBeGreaterThan(exists);
  });

  it('loads both compression assemblies (Windows PowerShell 5.1)', () => {
    const body = bodyOf('unzip a.zip');
    expect(body).toContain('Add-Type -AssemblyName System.IO.Compression\n');
    expect(body).toContain('Add-Type -AssemblyName System.IO.Compression.FileSystem');
  });

  it('keeps -o semantics: existing files are skipped with an error unless -o is given', () => {
    expect(bodyOf('unzip a.zip')).toContain('if ((Test-Path -LiteralPath $fx_t) -and $true)');
    expect(bodyOf('unzip -o a.zip')).toContain('if ((Test-Path -LiteralPath $fx_t) -and $false)');
  });

  it('defaults the destination to the current directory and disposes the archive', () => {
    const body = bodyOf('unzip a.zip');
    expect(body).toContain("$fx_dir = '.'");
    expect(body).toContain('finally { if ($null -ne $fx_z) { $fx_z.Dispose() } }');
  });

  it('treats zero-length entries with the MS-DOS directory attribute as directories', () => {
    expect(bodyOf('unzip a.zip')).toContain('($fx_e.Length -eq 0 -and ($fx_e.ExternalAttributes -band 0x10) -ne 0)');
  });

  it('skips later duplicate/case-colliding entries without -o and lets them win with -o', () => {
    const plain = bodyOf('unzip a.zip');
    expect(plain).toContain('if ($fx_done.ContainsKey($fx_t)) {');
    expect(plain).toContain('same name as an entry already extracted');
    expect(plain).not.toContain('[IO.FileAttributes]::ReadOnly');
    const over = bodyOf('unzip -o a.zip');
    expect(over).not.toContain('$fx_done.ContainsKey');
    expect(over).toContain('-band (-bnot [IO.FileAttributes]::ReadOnly)');
  });

  it('reports a file entry that collides with an existing directory and continues', () => {
    const body = bodyOf('unzip -o a.zip');
    const dir = body.indexOf('a directory with that name exists');
    expect(dir).toBeGreaterThan(-1);
    expect(dir).toBeLessThan(body.indexOf('ExtractToFile('));
  });
});
