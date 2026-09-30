import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('gzip default output preservation', () => {
  it('creates compression output exclusively and never truncates a destination', () => {
    const body = bodyOf('gzip input');
    expect(body).toContain('[IO.File]::Open($dst, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)');
    expect(body).toContain("if (-not (fx-gz-write-new $fx_o ($fx_f + '.gz'))) { continue }");
    expect(body).not.toContain("[IO.File]::WriteAllBytes($fx_f + '.gz'");
  });

  it('installs staged decompression output with a non-overwriting move', () => {
    const body = bodyOf('gunzip input.gz');
    expect(body).toContain('[IO.File]::Move($fx_tmp, $fx_full)');
    expect(body).not.toContain('[IO.File]::Replace');
    expect(body).toContain('if (-not (fx-gz-stream-file $fx_f $fx_out)) { continue }');
  });

  it('cleans up compression and staging files only after this operation created them', () => {
    const body = bodyOf('gzip input');
    expect(body).toContain('if ($fx_owned -and [IO.File]::Exists($dst)) { [IO.File]::Delete($dst) }');
    expect(body).toContain('if ($fx_tmpOwned -and [IO.File]::Exists($fx_tmp)) { [IO.File]::Delete($fx_tmp) }');
  });

  it('keeps an earlier hard error when a later operand warns about an existing output', () => {
    expect(bodyOf('gzip missing input')).toContain('if ($script:fx_exit -ne 1) { $script:fx_exit = 2 }');
  });

  it('keeps an earlier hard error when a later decompression operand has an unknown suffix', () => {
    const body = bodyOf('gunzip missing.gz unknown.data');
    const warning = body.indexOf('unknown suffix -- ignored');
    const end = body.indexOf('continue', warning);
    expect(body.slice(warning, end)).toContain('if ($script:fx_exit -ne 1) { $script:fx_exit = 2 }');
  });

  it('retains GNU success for an unchanged already-suffixed compression input', () => {
    const body = bodyOf('gzip existing.gz');
    const diagnostic = body.indexOf('already has .gz suffix -- unchanged');
    const end = body.indexOf('continue', diagnostic);
    expect(body.slice(diagnostic, end)).not.toContain('$script:fx_exit');
  });

  it.each(['gzip input', 'gzip -k input', 'gunzip input.gz', 'gzip -dk input.gz'])(
    'deletes no source until a complete output operation succeeds for %s', (command) => {
      const body = bodyOf(command);
      const guard = body.lastIndexOf('if (-not (fx-gz-');
      const remove = body.lastIndexOf('Remove-Item -LiteralPath $fx_f');
      expect(guard).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(guard);
      expect(body.slice(guard, remove)).toContain('{ continue }');
    },
  );

  it('continues to reject --force instead of widening overwrite behavior', () => {
    const body = bodyOf('gzip --force input');
    expect(body).toContain('not supported by fauxnix');
    expect(body).not.toContain('GZipStream');
  });
});
