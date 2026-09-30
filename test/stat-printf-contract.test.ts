import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('stat --printf text output generation', () => {
  it('aggregates operands and uses the established terminal-aware writer once', () => {
    const body = bodyOf("stat --printf='%s' a b");
    expect(body).toContain('$fx_stat_out = New-Object System.Text.StringBuilder');
    expect(body).toContain('[void]$fx_stat_out.Append($fx_o)');
    expect(body.match(/fx-write \(\$fx_stat_out.ToString\(\)\) \$fx_term/g)).toHaveLength(1);
    expect(body).toContain('if ($script:fx_csub) { $s; return }');
    expect(body).toContain('[Console]::Out.Write($s)');
    expect(body).not.toContain('$script:fx_exit = 0');
  });

  it('uses the final alias to choose newline and escape behavior', () => {
    expect(bodyOf("stat -c first --printf='%s' a")).toBe(bodyOf("stat --printf='%s' a"));
    expect(bodyOf("stat --printf=first -c '%s' a")).toBe(bodyOf("stat -c '%s' a"));
    expect(bodyOf("stat --printf='%s' --format=last a")).not.toContain('$fx_stat_out');
  });

  it('decodes escape tokens once without turning escaped percents into directives', () => {
    const body = bodyOf(String.raw`stat --printf='\x25s|\045s|%%s\n' a`);
    expect(body).toContain("$fx_o = '' + [string][char]37 + 's|' + [string][char]37 + 's|' + '%' + 's' + [string][char]10 + ''");
  });

  it('represents NUL as a character expression instead of embedding it in source', () => {
    const body = bodyOf(String.raw`stat --printf='%s\0' a`);
    expect(body).toContain('[string][char]0');
    expect(body).not.toContain('\0');
  });

  it.each([String.raw`\200`, String.raw`\377`, String.raw`\x80`, String.raw`\xFF`])(
    'rejects unsupported byte escape %s before stat output', (escape) => {
      const body = bodyOf(`stat --printf='prefix${escape}%s' a`);
      expect(body).toContain('non-ASCII numeric byte escapes are not supported');
      expect(body).toContain('$script:fx_exit = 1');
      expect(body).not.toContain('Get-Item');
      expect(body).not.toContain('fx-write');
    },
  );

  it('does not decode escapes in the newline-terminated format options', () => {
    const body = bodyOf(String.raw`stat -c '%s\n\377' a`);
    expect(body).toContain("[string]$fx_size + '\\n\\377'");
    expect(body).not.toContain('non-ASCII numeric byte escapes');
    expect(body).not.toContain('$fx_stat_out');
  });
});
