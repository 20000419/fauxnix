import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Generated-code checks only (#255): nothing is deleted by this suite. The
// runtime behaviour is covered by rm-preserve-root.windows.test.ts.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

/** Value of the generated `$fx_guardroot = $true|$false` switch. */
function guardEnabled(command: string): boolean {
  const m = /^\$fx_guardroot = (\$true|\$false)$/m.exec(bodyOf(command));
  expect(m, command).not.toBeNull();
  return m![1] === '$true';
}

describe('rm preserve-root failsafe (#255)', () => {
  it('guards recursive removal of a root by default, before Remove-Item', () => {
    expect(guardEnabled('rm -rf /')).toBe(true);
    expect(guardEnabled('rm -r C:/')).toBe(true);
    const body = bodyOf('rm -rf /');
    expect(body).toContain("rm: it is dangerous to operate recursively on '/'");
    expect(body).toContain('rm: use --no-preserve-root to override this failsafe');
    expect(body.indexOf('[IO.Path]::GetPathRoot($fx_rp)')).toBeLessThan(body.indexOf('Remove-Item -LiteralPath'));
  });

  it('accepts --preserve-root and --no-preserve-root; the last one wins', () => {
    expect(guardEnabled('rm --preserve-root -rf /')).toBe(true);
    expect(guardEnabled('rm --no-preserve-root -rf /')).toBe(false);
    expect(guardEnabled('rm --no-preserve-root --preserve-root -rf /')).toBe(true);
    expect(guardEnabled('rm --preserve-root --no-preserve-root -rf /')).toBe(false);
    expect(bodyOf('rm --no-preserve-root -rf /')).not.toContain('unrecognized option');
  });

  it('rejects --preserve-root=all (cross-device check not implemented) instead of ignoring it', () => {
    const body = bodyOf('rm --preserve-root=all -rf x');
    expect(body).toContain("option ''--preserve-root'' doesn''t allow an argument");
    expect(body).not.toContain('Remove-Item');
  });

  it('does not apply the root guard to non-recursive rm', () => {
    expect(guardEnabled('rm -f file')).toBe(false);
  });

  it('fails closed when the path cannot be canonicalized', () => {
    const body = bodyOf('rm -rf dir');
    expect(body).toContain('if ($null -eq $fx_rp) {');
    expect(body).toMatch(/if \(\$null -eq \$fx_rp\) \{[^\n]*\$script:fx_exit = 1; continue \}/);
    expect(body).not.toContain('if ($null -ne $fx_rp)');
  });

  it('refuses slash-only operands ("//", "///") before Test-Path', () => {
    const body = bodyOf('rm -rf ///');
    const check = body.indexOf("$fx_s -match '^[/\\\\]+$'");
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(body.indexOf('Test-Path -LiteralPath $fx_g'));
    expect(body).toContain("\"' (same as '/')\"");
  });

  it('removes a directory symlink/junction as a link, never recursing into its target', () => {
    const body = bodyOf('rm -rf link');
    expect(body).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(body).toContain('[IO.Directory]::Delete($fx_item.FullName, $false)');
    expect(body.indexOf('ReparsePoint')).toBeLessThan(body.indexOf('Remove-Item -LiteralPath'));
  });
});

describe('rm "." / ".." refusal (#255)', () => {
  it('refuses the last component "." or "..", including drive-relative C:. / C:..', () => {
    const body = bodyOf('rm -rf ..');
    expect(body).toContain("$fx_leaf = ($fx_s -replace '^[A-Za-z]:', '')");
    expect(body).toContain("if ($fx_leaf -eq '.' -or $fx_leaf -eq '..')");
    expect(body).toContain("rm: refusing to remove '.' or '..' directory: skipping '");
    expect(body.indexOf('$fx_leaf')).toBeLessThan(body.indexOf('fx-glob $fx_f'));
  });

  it('still treats "--" operands literally', () => {
    expect(bodyOf('rm -- --no-preserve-root')).toContain("@('--no-preserve-root')");
  });

  it('keeps the existing error text (accurate reasons are a separate change)', () => {
    expect(bodyOf('rm -rf dir')).toContain("': Permission denied\"");
  });
});
