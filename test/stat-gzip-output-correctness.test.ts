import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Portable checks inspect generated PowerShell only. The adjacent Windows
// suite executes the same contracts against newly created local fixtures.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('stat supported format correctness', () => {
  it('expands each format directive once without rescanning inserted filenames', () => {
    const body = bodyOf("stat -c '%%s|%s|%n|%%n|%F|%%F' 'name%F%Y%%.txt'");
    expect(body).toContain("$fx_o = '' + '%' + 's|' + [string]$fx_size + '|' + $fx_g + '|' + '%' + 'n|' + $fx_ft + '|' + '%' + 'F'");
    expect(body).not.toContain(".Replace('%");
  });

  it.each(["stat -c '' item", "stat --format='' item"])(
    'keeps an explicit empty format for %s', (command) => {
      const body = bodyOf(command);
      expect(body).toContain("if ($true) {\n      $fx_o = ''");
    },
  );

  it.each([
    ['stat -c first --format=last item', 'stat --format=last item'],
    ['stat --format=first -c last item', 'stat -c last item'],
    ['stat -c first --format=middle -c last item', 'stat -c last item'],
    ["stat -c first --format='' item", "stat -c '' item"],
  ])('respects the final format option in %s', (command, expected) => {
    expect(bodyOf(command)).toBe(bodyOf(expected));
  });

  it('keeps ordinary and unsupported format text literal', () => {
    const body = bodyOf("stat -c 'constructor|toString|%q|trailing%' item");
    expect(body).toContain("$fx_o = 'constructor|toString|%q|trailing%'");
  });

  it('does not add an octal prefix to the supported %a field', () => {
    expect(bodyOf('stat -c %a item')).toContain("$fx_o = '' + $fx_mode.TrimStart('0') + ''");
  });

  it('floors epoch seconds and retains a 64-bit result beyond 2038', () => {
    expect(bodyOf('stat -c %Y item')).toContain(
      "$fx_epoch = [long][math]::Floor(($fx_it.LastWriteTime.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds)",
    );
  });
});

describe('gzip stdout suffix handling', () => {
  it.each(['gzip -dc input.data', 'gunzip -c input', 'zcat input.data'])(
    'decompresses %s without requiring an output filename suffix', (command) => {
      const body = bodyOf(command);
      expect(body).toContain('fx-gz-stream-text $fx_f $false');
      expect(body).not.toContain('unknown suffix -- ignored');
      expect(body).not.toContain('$fx_out = $fx_f.Substring');
      expect(body).not.toContain('Remove-Item');
    },
  );

  it.each(['gzip -c input.gz', 'gzip --stdout input.tgz', 'gzip --to-stdout input.gz'])(
    'compresses %s even when the source already has a gzip suffix', (command) => {
      const body = bodyOf(command);
      expect(body).toContain('fx-gz-cbytes ([IO.File]::ReadAllBytes($fx_f))');
      expect(body).not.toContain('already has .gz suffix -- unchanged');
      expect(body).not.toContain('Remove-Item');
    },
  );

  it('retains suffix checks for file-output operations', () => {
    expect(bodyOf('gunzip input.data')).toContain('unknown suffix -- ignored');
    expect(bodyOf('gunzip input.tgz')).toContain("+ '.tar'");
    expect(bodyOf('gzip input.gz')).toContain('already has .gz suffix -- unchanged');
  });

  it('still validates gzip data in test mode regardless of filename', () => {
    const body = bodyOf('gzip -t input.data');
    expect(body).toContain('[void](fx-gz-validate $fx_f $false)');
    expect(body).not.toContain('unknown suffix -- ignored');
  });
});
