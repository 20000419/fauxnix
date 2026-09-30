import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/parser.js';
import { PURE_TRANSLATION, translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

// Static code-generation checks. No generated mutation command is executed.
function bodyOf(command: string): string {
  return translateCommandList(parseCommand(command), PURE_TRANSLATION)[0].body;
}

describe('file and archive cmdlet failures enter their declared catch blocks', () => {
  it('mv rejects resolved source/destination aliases before removing the destination', () => {
    const body = bodyOf('mv source.txt ./source.txt');
    const source = body.indexOf('$fx_sourcePath = (Resolve-Path -LiteralPath $fx_g -ErrorAction Stop).ProviderPath');
    const target = body.indexOf('$fx_targetPath = (Resolve-Path -LiteralPath $fx_target -ErrorAction Stop).ProviderPath');
    const equality = body.indexOf("if ($fx_sourcePath.TrimEnd([char[]]'\\/') -eq $fx_targetPath.TrimEnd([char[]]'\\/'))");
    const failure = body.indexOf('are the same file');
    const removal = body.indexOf('Remove-Item -LiteralPath $fx_target');
    expect(source).toBeGreaterThan(-1);
    expect(target).toBeGreaterThan(source);
    expect(equality).toBeGreaterThan(target);
    expect(failure).toBeGreaterThan(equality);
    expect(removal).toBeGreaterThan(failure);
    expect(body.slice(failure, removal)).toContain('$script:fx_exit = 1; continue');
  });

  it.each([
    ['cp source destination', 'Copy-Item'],
    ['mv source destination', 'Move-Item'],
    ['mv source destination', 'Remove-Item'],
    ['rm file', 'Remove-Item'],
    ['mkdir directory', 'New-Item'],
    ['rmdir directory', 'Remove-Item'],
    ['touch file', 'New-Item'],
    ['mktemp -d', 'New-Item'],
    ['ln target link', 'New-Item'],
    ['gzip file', 'Remove-Item'],
    ['gunzip file.gz', 'Remove-Item'],
    ['zip archive file', 'Move-Item'],
  ])('%s makes %s errors terminating before reporting success', (command, cmdlet) => {
    const operations = bodyOf(command).split('\n').filter((line) => line.includes(`${cmdlet} -`));
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) expect(operation).toContain('-ErrorAction Stop');
  });
});
