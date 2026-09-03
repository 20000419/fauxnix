import { describe, expect, it } from 'vitest';
import { urlFileName } from '../src/commands/net.js';
import { parseCommand } from '../src/parser.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

describe('wget fallback default output filename', () => {
  it('uses only the final URL path component', () => {
    expect(urlFileName('https://host.example/a/b')).toBe('b');
    expect(urlFileName('https://host.example/a/report.txt?download=1#top')).toBe('report.txt');
  });

  it('uses index.html for a bare URL or trailing slash', () => {
    expect(urlFileName('https://host.example')).toBe('index.html');
    expect(urlFileName('https://host.example/')).toBe('index.html');
    expect(urlFileName('https://host.example/a/../')).toBe('index.html');
  });

  it('normalises dot segments before selecting the basename', () => {
    expect(urlFileName('https://host.example/a/../b/file.txt')).toBe('file.txt');
    expect(urlFileName('https://host.example/a/%2e%2e/final')).toBe('final');
  });

  it('decodes valid percent escapes once and preserves malformed escapes', () => {
    expect(urlFileName('https://host.example/a/hello%20world.txt')).toBe('hello world.txt');
    expect(urlFileName('https://host.example/a/%252F.txt')).toBe('%2F.txt');
    expect(urlFileName('https://host.example/a/bad%ZZname')).toBe('bad%ZZname');
  });

  it('keeps decoded separators and invalid Windows characters inside one filename', () => {
    expect(urlFileName('https://host.example/a%2Fb')).toBe('a%2Fb');
    expect(urlFileName('https://host.example/a%5Cb')).toBe('a%5Cb');
    expect(urlFileName('https://host.example/%3Cbad%3E%3Aname')).toBe('%3Cbad%3E%3Aname');
    expect(urlFileName('https://host.example/C%3A')).toBe('C%3A');
  });

  it('stabilises Windows device names and trailing dots or spaces', () => {
    expect(urlFileName('https://host.example/CON')).toBe('_CON');
    expect(urlFileName('https://host.example/aux.txt')).toBe('_aux.txt');
    expect(urlFileName('https://host.example/report.')).toBe('report%2E');
    expect(urlFileName('https://host.example/report%20')).toBe('report%20');
  });

  it('keeps explicit output mapping and the native wget branch unchanged', () => {
    const body = translateCommandList(
      parseCommand('wget -O custom.bin https://host.example/a/report.txt'),
    )[0].body;
    expect(body).toContain("$fx_args = (@('-O') + @('custom.bin') + @('https://host.example/a/report.txt'))");
    expect(body).toContain("Get-Command 'wget.exe'");
    expect(body).toContain("fx-native 'wget.exe' ([object[]]@($fx_args))");
    expect(body).toContain("$fx_margs = @('-o', 'custom.bin', 'https://host.example/a/report.txt')");
    expect(body).not.toContain("'report.txt'");
  });
});
