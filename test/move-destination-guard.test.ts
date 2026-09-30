import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Generated-code checks only. The Windows companion executes moves exclusively
// inside fresh temporary fixtures.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('mv destination preflight in generated PowerShell', () => {
  it('checks both entry types before either kind of destination removal', () => {
    const body = bodyOf('mv source destination');
    const source = body.indexOf('$fx_sourceItem = Get-Item -LiteralPath $fx_g -Force -ErrorAction Stop');
    const target = body.indexOf('$fx_targetItem = Get-Item -LiteralPath $fx_target -Force -ErrorAction Stop');
    const firstRemoval = body.indexOf('[IO.Directory]::Delete');
    expect(source).toBeGreaterThan(body.indexOf('are the same file'));
    expect(target).toBeGreaterThan(source);
    expect(firstRemoval).toBeGreaterThan(target);
    const preflight = body.slice(target, firstRemoval);
    expect(preflight).toContain('if (-not $fx_sourceItem.PSIsContainer -and $fx_targetItem.PSIsContainer)');
    expect(preflight).toContain('if ($fx_sourceItem.PSIsContainer -and -not $fx_targetItem.PSIsContainer)');
    for (const diagnostic of ['cannot overwrite directory', 'cannot overwrite non-directory', 'Directory not empty']) {
      const line = preflight.split('\n').find((entry) => entry.includes(diagnostic));
      expect(line).toContain('[Console]::Error.WriteLine');
      expect(line).toContain('$script:fx_exit = 1; continue');
    }
  });

  it('checks all directory entries and fails closed if enumeration fails', () => {
    const body = bodyOf('mv source destination');
    const enumeration = body.indexOf('if (@(Get-ChildItem -LiteralPath $fx_target -Force -ErrorAction Stop).Count -gt 0)');
    expect(enumeration).toBeGreaterThan(body.indexOf('if ($fx_targetItem.PSIsContainer)'));
    expect(body.indexOf('Directory not empty')).toBeGreaterThan(enumeration);
    expect(body.indexOf('[IO.Directory]::Delete')).toBeGreaterThan(body.indexOf('Directory not empty'));
  });

  it('removes only empty directories using a resolved path and never recurses', () => {
    const body = bodyOf('mv source destination');
    expect(body).toContain('[IO.Directory]::Delete($fx_targetPath, $false)');
    expect(body).toContain([
      '          [IO.Directory]::Delete($fx_targetPath, $false)',
      '        } else {',
      '          Remove-Item -LiteralPath $fx_target -Force -ErrorAction Stop',
      '        }',
    ].join('\n'));
    expect(body).not.toContain('-Recurse');
    expect(body.indexOf('Move-Item -LiteralPath')).toBeGreaterThan(body.indexOf('[IO.Directory]::Delete'));
    expect(body).toContain('Move-Item -LiteralPath $fx_g -Destination $fx_target -Force -ErrorAction Stop');
    expect(body).toContain('} catch { [Console]::Error.WriteLine("mv: cannot move');
  });

  it.each(['-n', '--no-clobber'])('%s still skips an existing computed target before preflight', (flag) => {
    const body = bodyOf(`mv ${flag} source destination`);
    const skip = body.indexOf('if ($true -and (Test-Path -LiteralPath $fx_target)) { continue }');
    expect(skip).toBeGreaterThan(body.indexOf('$fx_target = Join-Path'));
    expect(body.indexOf('$fx_sourcePath =')).toBeGreaterThan(skip);
    expect(body.indexOf('$fx_sourceItem =')).toBeGreaterThan(skip);
  });
});
