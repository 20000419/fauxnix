import { describe, expect, it } from 'vitest';
import { PS_IOERR_FN } from '../src/commands/files.js';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Generated-code checks; fx-ioerr itself is executed in io-errors.windows.test.ts.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('accurate rm/touch error reasons', () => {
  it('rm reports the mapped reason, falling back to the previous text', () => {
    const body = bodyOf('rm -rf dir');
    expect(body).toContain('function fx-ioerr($e, [string]$fallback)');
    expect(body).toContain(`"rm: cannot remove '" + $fx_g + "': " + (fx-ioerr $_ 'Permission denied')`);
  });

  it('touch keeps its previous texts as deterministic fallbacks', () => {
    const body = bodyOf('touch f');
    expect(body).toContain("(fx-ioerr $_ 'Permission denied')");
    expect(body).toContain("(fx-ioerr $_ 'No such file or directory')");
    expect(body).toContain('Get-Item -LiteralPath $fx_f -Force -ErrorAction Stop');
  });

  it('never surfaces the localized .NET message', () => {
    expect(PS_IOERR_FN).not.toContain('.Message');
    expect(PS_IOERR_FN).toContain('return $fallback');
  });

  it('walks the InnerException chain and only decodes Win32-facility HResults', () => {
    expect(PS_IOERR_FN).toContain('$x = $x.InnerException');
    expect(PS_IOERR_FN).not.toContain('-isnot [IO.IOException]');
    expect(PS_IOERR_FN).toContain('-ne 0x8007) { return $null }');
  });

  it('maps the Win32 codes coreutils users actually see', () => {
    for (const [code, text] of [
      ['5', 'Permission denied'],
      ['19', 'Read-only file system'],
      ['80, 183', 'File exists'],
      ['112', 'No space left on device'],
      ['123', 'Invalid argument'],
      ['145', 'Directory not empty'],
      ['206', 'File name too long'],
      ['267', 'Not a directory'],
    ]) {
      expect(PS_IOERR_FN).toMatch(new RegExp(`${code.replace(/, /g, ', ')}[^\\n]*'${text}'`));
    }
  });
});
