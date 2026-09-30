import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// These checks inspect generated PowerShell only; they do not execute file,
// archive, or permission-changing commands on the host.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('archive option parsing matches the declared supported grammar', () => {
  it.each([
    ['unzip -dout archive.zip', 'unzip -d out archive.zip'],
    ['unzip -qd out archive.zip', 'unzip -q -d out archive.zip'],
    ['unzip -qodout archive.zip', 'unzip -qo -d out archive.zip'],
    ['unzip -dlogs archive.zip', 'unzip -d logs archive.zip'],
    ['unzip -d-- archive.zip', 'unzip -d -- archive.zip'],
    ['unzip -dout -dlast archive.zip', 'unzip -d last archive.zip'],
    ['unzip --directory=out archive.zip', 'unzip -d out archive.zip'],
    ['unzip --directory="$OUTPUT" archive.zip', 'unzip -d "$OUTPUT" archive.zip'],
    ['unzip -qd"$OUTPUT" archive.zip', 'unzip -q -d "$OUTPUT" archive.zip'],
    ['unzip "-d$OUTPUT" archive.zip', 'unzip -d "$OUTPUT" archive.zip'],
    ["unzip '--directory=/tmp' archive.zip", "unzip -d '/tmp' archive.zip"],
  ])('preserves the directory value in %s', (combined, separate) => {
    expect(bodyOf(combined)).toBe(bodyOf(separate));
  });

  it('keeps unzip flag-looking archive names after the option terminator', () => {
    const body = bodyOf('unzip -- -log.zip');
    expect(body).toContain("$fx_arc = '-log.zip'");
    expect(body).toContain('Expand-Archive');
    expect(body).toContain('-Force:$false');
    expect(body).not.toContain('[IO.Compression.ZipFile]::OpenRead');
  });

  it('keeps zip flag-looking archive and input names after the option terminator', () => {
    const body = bodyOf('zip -q -- -archive.zip -input --exclude=literal -x');
    expect(body).toContain("$fx_arc = '-archive.zip'");
    expect(body).toContain("$fx_inputs = (@('-input') + @('--exclude=literal') + @('-x'))");
    expect(body).toContain('Compress-Archive');
  });

  it.each([
    ['gzip -1k data', 'gzip -1 -k data'],
    ['gzip -k1 data', 'gzip -k -1 data'],
    ['gzip -9c data', 'gzip -9 -c data'],
    ['gzip -c91 data', 'gzip -c -9 -1 data'],
    ['gzip -1k --best data', 'gzip -k -9 data'],
    ['gzip --best -1k data', 'gzip -k -1 data'],
    ['gunzip -9ck data.gz', 'gunzip -9 -c -k data.gz'],
    ['zcat -1t data.gz', 'zcat -1 -t data.gz'],
  ])('preserves bundled gzip flags and their order in %s', (bundled, separate) => {
    expect(bodyOf(bundled)).toBe(bodyOf(separate));
  });

  it('still rejects unknown and explicitly unsupported archive options', () => {
    for (const command of ['gzip -1f data', 'zip -x ignored archive.zip input', 'unzip -Z archive.zip']) {
      const body = bodyOf(command);
      expect(body).toContain('$script:fx_exit = 1');
      expect(body).not.toContain('Compress-Archive');
      expect(body).not.toContain('Expand-Archive');
      expect(body).not.toContain('GZipStream');
    }
  });
});

describe('file command argument and generated-literal correctness', () => {
  it.each(['basename', 'dirname'])('%s consumes its option terminator', (command) => {
    expect(bodyOf(`${command} -- /usr/bin`)).toBe(bodyOf(`${command} /usr/bin`));
    expect(bodyOf(`${command} -- -name`)).toContain("$fx_ps = (@('-name'))");
  });

  it.each([
    ['444', '$true', '$false'],
    ['0644', '$false', '$true'],
    ['+x', '$false', '$false'],
  ])('emits PowerShell booleans for chmod %s', (mode, setReadOnly, clearReadOnly) => {
    const body = bodyOf(`chmod ${mode} file`);
    expect(body).toContain(`if (${setReadOnly}) { $fx_it.Attributes = $fx_it.Attributes -bor`);
    expect(body).toContain(`elseif (${clearReadOnly}) { $fx_it.Attributes = $fx_it.Attributes -band`);
    expect(body).not.toMatch(/\b(?:if|elseif)\((?:true|false)\)/);
  });
});
