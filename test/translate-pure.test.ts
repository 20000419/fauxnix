import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

import { readFileSync } from 'node:fs';
import { runCli } from '../src/cli.js';
import { translateToolResult } from '../src/mcp.js';
import { parseCommand } from '../src/parser.js';
import {
  EXECUTE_TRANSLATION,
  PURE_SED_FILE_MESSAGE,
  PURE_TRANSLATION,
  translateCommandList,
} from '../src/translator.js';
import '../src/commands/install-all.js';

const readFileSpy = vi.mocked(readFileSync);

describe('side-effect-free translation', () => {
  beforeEach(() => {
    readFileSpy.mockClear();
  });

  it.each([
    'sed -frules.sed input.txt',
    'sed -f rules.sed input.txt',
    "sed -f '\\\\server\\share\\rules.sed' input.txt",
    'sed -f CON input.txt',
    'echo "$(sed -f rules.sed input.txt)"',
    'env sed -f rules.sed input.txt',
    'command sed -f rules.sed input.txt',
    'timeout 1 sed -f rules.sed input.txt',
    'echo "$(env sed -f rules.sed input.txt)"',
    '[[ "$(env sed -f rules.sed input.txt)" == x ]]',
    'echo $(( $(env sed -f rules.sed input.txt) + 1 ))',
    'for x in "$(env sed -f rules.sed input.txt)"; do echo $x; done',
    'case "$(env sed -f rules.sed input.txt)" in x) echo x;; esac',
    'export X="$(env sed -f rules.sed input.txt)"',
  ])('rejects %s before reading the script operand', (command) => {
    expect(() => translateCommandList(parseCommand(command), PURE_TRANSLATION)).toThrow(
      PURE_SED_FILE_MESSAGE,
    );
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('keeps -- operands and regular -e translation side-effect free', () => {
    expect(() =>
      translateCommandList(parseCommand("sed -- 's/f/x/' -f"), PURE_TRANSLATION),
    ).not.toThrow();
    expect(() =>
      translateCommandList(parseCommand("sed -e 's/a/b/' input.txt"), PURE_TRANSLATION),
    ).not.toThrow();
    expect(() =>
      translateCommandList(parseCommand('command -v sed -f'), PURE_TRANSLATION),
    ).not.toThrow();
    expect(() =>
      translateCommandList(parseCommand('env -i sed -f rules.sed'), PURE_TRANSLATION),
    ).not.toThrow();
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('uses pure translation in the CLI and MCP entry points', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try {
      await expect(
        runCli(['translate', 'echo "$(env sed -f rules.sed input.txt)"']),
      ).rejects.toThrow(PURE_SED_FILE_MESSAGE);
    } finally {
      console.log = originalLog;
    }
    const result = translateToolResult('echo "$(timeout 1 sed -frules.sed input.txt)"');
    expect(result).toMatchObject({ isError: true });
    expect(result.content[0].text).toBe(PURE_SED_FILE_MESSAGE);
    expect(logs).toEqual([]);
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('keeps executable translation able to load a sed script file', () => {
    readFileSpy.mockImplementationOnce(() => 's/a/b/');
    expect(() =>
      translateCommandList(parseCommand('sed -f rules.sed input.txt'), EXECUTE_TRANSLATION),
    ).not.toThrow();
    expect(readFileSpy).toHaveBeenCalledWith('rules.sed', 'utf8');
  });
});
