/** Use the selected real PowerShell parser as well as execution: TS cannot parse PS. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { POWERSHELL_ARGS, resolvePowerShell } from '../src/powershell.js';
import { PURE_TRANSLATION, translateCommandList, wrapScript } from '../src/translator.js';
import '../src/commands/install-all.js';

const selection = resolvePowerShell();
const runnable = process.platform === 'win32' && !selection.error &&
  spawnSync(selection.executable, ['-NoProfile', '-Command', 'exit 0']).status === 0;

const cases: [string, string][] = [
  [String.raw`printf '%s' "$(printf '%s' \))"`, ')'],
  [String.raw`printf '%s' "$(printf '%s' \()"`, '('],
  [String.raw`printf '%s' "$(printf '%s' '\')"`, '\\'],
  [String.raw`printf '%s' "$(printf '%s' '"')"`, '"'],
  [String.raw`printf '%s' "$(printf '%s' "'")"`, "'"],
  [String.raw`printf '%s' "left'$(printf '%s' \))'right"`, "left')'right"],
  [String.raw`printf '%s' left$(printf '%s' \))right`, 'left)right'],
  [String.raw`printf '%s' "$(printf '%s' \()$(printf '%s' \))"`, '()'],
  [String.raw`printf '%s' "$(printf '%s' "$(printf '%s' \))")"`, ')'],
  [String.raw`printf '<%s>' "$(false)"`, '<>'],
  [String.raw`printf '<%s>' "$(false)"; printf ':%s' "$?"`, '<>:0'],
  [String.raw`ASSIGNED="$(false)"; printf '%s' "$?"`, '1'],
  [String.raw`printf '<%s>' "$(printf 'a\nb\n\n')"`, '<a\nb>'],
  // Preserve the existing unquoted IFS approximation: one space-joined argument.
  [String.raw`printf '<%s>' left$(printf 'a\nb\n')right`, '<lefta bright>'],
  [String.raw`X=left$(printf 'a\nb\n')right; printf '<%s>' "$X"`, '<lefta\nbright>'],
  [String.raw`A=("$(printf '%s' \))" "two words" "$(false)"); printf '<%s>' "${'${A[@]}'}"`, '<)><two words><>'],
  [String.raw`A=(one "two words"); printf '<%s>' "${'${A[*]}'}$(printf '%s' \))"`, '<one two words)>'],
  [String.raw`printf '%s' "$(( $(printf '%s' 4) + 1 ))"`, '5'],
];

describe.skipIf(!runnable)('command substitution PowerShell regression', { timeout: 30000 }, () => {
  let directory: string;
  let parserPath: string;
  let session: FauxnixSession;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fauxnix-command-substitution-'));
    parserPath = join(directory, 'parse-only.ps1');
    writeFileSync(parserPath, [
      '\uFEFF$failed = $false',
      'foreach ($file in $args) {',
      '  $tokens = $null; $errors = $null',
      '  [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)',
      '  foreach ($problem in $errors) {',
      '    $failed = $true',
      "    [Console]::Error.WriteLine(('{0}:{1}:{2}: {3} ({4})' -f $file, $problem.Extent.StartLineNumber, $problem.Extent.StartColumnNumber, $problem.Message, $problem.ErrorId))",
      '  }',
      '}',
      'if ($failed) { exit 1 }',
    ].join('\n'));
    session = new FauxnixSession();
  });
  afterAll(async () => {
    await session?.dispose();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each(cases)('parses generated host and spawn scripts without executing: %s', (command) => {
    const files: string[] = [];
    for (const [index, plan] of translateCommandList(parseCommand(command), PURE_TRANSLATION).entries()) {
      for (const [mode, script] of [
        ['host', wrapScript(plan.body, { mode: 'host' })],
        ['spawn', plan.script],
      ]) {
        const path = join(directory, `${index}-${mode}.ps1`);
        writeFileSync(path, '\uFEFF' + script);
        files.push(path);
      }
    }
    const parsed = spawnSync(selection.executable, [...POWERSHELL_ARGS, '-File', parserPath, ...files], {
      encoding: 'utf8', timeout: 30000,
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.status, parsed.stderr || parsed.stdout).toBe(0);
    expect(parsed.stderr).toBe('');
  });

  it.each(cases)('preserves substitution output: %s', async (command, stdout) => {
    const result = await session.run(translateCommandList(parseCommand(command)), { cwd: directory });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.replace(/\r\n/g, '\n')).toBe(stdout);
  });
});
