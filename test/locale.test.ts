import { describe, expect, it } from 'vitest';
import { decodeOutput } from '../src/encoding.js';
import { normalizeStderr } from '../src/errors.js';

interface LocaleCase {
  name: string;
  stderrByLocale: Record<'en-US' | 'zh-CN', string>;
  expected: string;
}

const localeCases: LocaleCase[] = [
  {
    name: 'command not found with a source prefix',
    stderrByLocale: {
      'en-US':
        "& : The term 'fauxnix-no-such-command' is not recognized as the name of a cmdlet, function, script file, or operable program.",
      'zh-CN':
        '& : 无法将“fauxnix-no-such-command”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。',
    },
    expected: 'bash: fauxnix-no-such-command: command not found',
  },
  {
    name: 'missing path',
    stderrByLocale: {
      'en-US':
        "Get-Content : Cannot find path 'C:\\fauxnix-no-such-file' because it does not exist.",
      'zh-CN': 'Get-Content : 找不到路径“C:\\fauxnix-no-such-file”，因为该路径不存在。',
    },
    expected: 'get-content: C:/fauxnix-no-such-file: No such file or directory',
  },
  {
    name: 'missing drive',
    stderrByLocale: {
      'en-US': "Get-Content : Cannot find drive. A drive with the name 'Z' does not exist.",
      'zh-CN': 'Get-Content : 找不到驱动器。名为“Z”的驱动器不存在。',
    },
    expected: 'get-content: Z: No such file or directory',
  },
  {
    name: 'access denied',
    stderrByLocale: {
      'en-US': "rm : Access to the path 'C:\\protected' is denied.",
      'zh-CN': 'rm : 对路径“C:\\protected”的访问被拒绝。',
    },
    expected: "rm: cannot remove 'C:\\protected': Permission denied",
  },
];

describe('PowerShell locale error matrix', () => {
  describe.each(localeCases)('$name', ({ stderrByLocale, expected }) => {
    it.each(Object.entries(stderrByLocale))('%s', (_locale, stderr) => {
      expect(normalizeStderr(stderr)).toBe(expected);
    });
  });

  it('decodes CP936 PowerShell stderr before applying zh-CN normalization', () => {
    // Real CP936 bytes for:
    // 无法将“foo”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。
    const stderr = Buffer.from(
      'cedeb7a8bdaba1b0666f6fa1b1cfeecab6b1f0ceaa20636d646c6574a1a2baafcafda1a2bdc5b1becec4bcfebbf2bfc9d4cbd0d0b3ccd0f2b5c4c3fbb3c6a1a3',
      'hex',
    );
    expect(normalizeStderr(decodeOutput(stderr))).toBe('bash: foo: command not found');
  });

  it('does not rewrite unrelated Chinese prose', () => {
    const stderr = '说明 : 无法将“foo”项识别为风险项。';
    expect(normalizeStderr(stderr)).toBe(stderr);
  });
});
