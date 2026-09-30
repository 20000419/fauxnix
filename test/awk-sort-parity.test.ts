import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { translateCommandList } from '../src/translator.js';
import { awkTextCases, sortTextCases } from './awk-sort-parity.fixtures.js';
import '../src/commands/install-all.js';

const body = (command: string) => translateCommandList(parseCommand(command))[0].body;

describe('awk/sort parity compilation', () => {
  it.each([...awkTextCases, ...sortTextCases])('compiles the supported golden command %s', (command) => {
    expect(() => translateCommandList(parseCommand(command))).not.toThrow();
  });

  it('streams terminal fragments and buffers only pipeline/substitution text', () => {
    const script = body(String.raw`awk '{printf "%s:", $1; print $2}' nums.txt`);
    expect(script).toContain('$fx_awk_out = New-Object System.Text.StringBuilder');
    expect(script).toContain('$fx_awk_buffered = $script:fx_csub -or -not $fx_term');
    expect(script).toContain('if ($fx_awk_buffered) { $fx_awk_out = New-Object System.Text.StringBuilder }');
    expect(script).toContain('else { [Console]::Out.Write([string]$s) }');
    expect(script).toContain(' + [string][char]10)');
    expect(script).toContain('fx-write ($fx_awk_out.ToString()) $fx_term');
    expect(body("awk '{print $1}' nums.txt")).not.toContain('$fx_awk_out');
    expect(body("awk 'BEGIN {printf \"literal\"}'")).toContain('-f @()');
  });

  it.each([
    String.raw`awk '{printf "%s:", $1; printf "%s\n", $2}' nums.txt`,
    String.raw`awk 'BEGIN {print "start"} {printf "%s", $1} END {print "end"}' nums.txt`,
  ])('never mixes immediate and deferred direct writes for %s', (command) => {
    const script = body(command);
    const start = script.indexOf('function fx-awk-write($s) {');
    const helper = script.slice(start, script.indexOf('\n}', start) + 2);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(helper).toContain('else { [Console]::Out.Write([string]$s) }');
    expect(helper).not.toContain('fx-write ');
    expect(helper).not.toContain('Write-Output');
  });

  it('keeps native case-fold sorting and orders only equal-fold runs for last-resort ties', () => {
    const script = body('sort -f mixed-case.txt');
    expect(script).toContain('[array]::Sort($fx_arr, [System.StringComparer]::OrdinalIgnoreCase)');
    expect(script).toContain('[array]::Sort($fx_arr, $fx_start, ($fx_end - $fx_start), [System.StringComparer]::Ordinal)');
    expect(script).not.toContain('function fx-msort');
    expect(script).not.toContain('fx-keyof');
  });

  it('selects the first case-fold-equivalent representative before native unique sorting', () => {
    const script = body('sort -fu mixed-case.txt');
    expect(script).toContain('System.Collections.Generic.HashSet[string] ([System.StringComparer]::OrdinalIgnoreCase)');
    expect(script).toContain('if ($fx_seen.Add([string]$fx_l))');
    expect(script.indexOf('$fx_seen.Add')).toBeLessThan(script.indexOf('[array]::Sort'));
    expect(script).not.toContain('$fx_start');
    expect(script).not.toContain('function fx-msort');
  });

  it('preserves the existing key extraction for numeric and blank-only modes', () => {
    expect(body('sort -n nums.txt')).toContain('fx-numkey (fx-keyof $x 1 2147483647)');
    expect(body('sort -b nums.txt')).toContain("(fx-keyof $x 1 2147483647)");
  });

  it.each(['sort -s mixed-case.txt', 'sort -fs mixed-case.txt', 'sort --stable mixed-case.txt'])(
    'continues to reject the unsupported stable option in %s', (command) => {
      const script = body(command);
      expect(script).toMatch(/invalid option|unrecognized option/);
      expect(script).not.toContain('function fx-msort');
    },
  );
});
