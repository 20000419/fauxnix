import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Generated-code checks only: no copy, move, deletion, or permission changes
// are executed by this suite.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('file operation correctness in generated PowerShell', () => {
  it.each(['cp', 'mv'])('%s validates the destination after expanding all sources', (command) => {
    const body = bodyOf(`${command} *.txt destination`);
    const expansion = body.indexOf('$fx_srcs = @($fx_srcs | ForEach-Object { fx-glob $_ })');
    const validation = body.indexOf('elseif ($fx_srcs.Count -gt 1 -and -not (Test-Path -LiteralPath $fx_dst -PathType Container))');
    const operation = body.indexOf(command === 'cp' ? 'Copy-Item -LiteralPath' : 'Move-Item -LiteralPath');
    expect(expansion).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(expansion);
    expect(operation).toBeGreaterThan(validation);
    expect(body).toContain('foreach ($fx_g in $fx_srcs)');
    expect(body).not.toContain('foreach ($fx_g in (fx-glob $fx_s))');
  });

  it('mkdir -p accepts an existing directory but still rejects a regular file', () => {
    expect(bodyOf('mkdir -p existing')).toContain(
      'if ($false -or -not (Test-Path -LiteralPath $fx_d -PathType Container))',
    );
    expect(bodyOf('mkdir existing')).toContain(
      'if ($true -or -not (Test-Path -LiteralPath $fx_d -PathType Container))',
    );
  });

  it('diff keeps case-sensitive line comparison in equality, LCS, and edit reconstruction', () => {
    const body = bodyOf('diff left.txt right.txt');
    expect(body).toContain('$fx_la[$fx_i] -cne $fx_lb[$fx_i]');
    expect(body.match(/\$fx_la\[\$fx_i\] -ceq \$fx_lb\[\$fx_j\]/g)).toHaveLength(2);
    expect(body).not.toMatch(/\$fx_la\[[^\]]+\] -(?:eq|ne) \$fx_lb/);
  });

  it('diff insertion and deletion hunks use the unchanged side\'s zero-based anchor', () => {
    const body = bodyOf('diff left.txt right.txt');
    expect(body).toContain("([string]$fx_ops[$fx_start][2]) + 'a' + (fx-dr $fx_b1 $fx_b2)");
    expect(body).toContain("(fx-dr $fx_a1 $fx_a2) + 'd' + ([string]$fx_ops[$fx_start][3])");
  });
});
