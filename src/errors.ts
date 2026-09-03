/**
 * Error normalization — make PowerShell failures look like bash failures
 * so agents can pattern-match on familiar Linux error styles.
 */

/** Missing `python3` on Windows (Mac/Linux agents emit this; do not alias). */
export const PYTHON3_WINDOWS_HINT = ' (fauxnix: try `python` or `py` on Windows)';

/** `.sh` cannot be CreateProcess'd; fx-native never emits the PS not-recognized line. */
export const SH_SCRIPT_WINDOWS_HINT = ' (fauxnix: .sh scripts cannot run natively on Windows)';

function commandNotFound(name: string): string {
  const msg = 'bash: ' + name + ': command not found';
  const base = name.replace(/^.*[/\\]/, '');
  if (/^python3(\.exe)?$/i.test(base)) return msg + PYTHON3_WINDOWS_HINT;
  if (/\.sh$/i.test(name)) return msg + SH_SCRIPT_WINDOWS_HINT;
  return msg;
}

/** Lines produced by PowerShell error formatting that bash would never show. */
const PS_NOISE = [
  /^\s*\+ CategoryInfo\s*:/,
  /^\s*\+ FullyQualifiedErrorId\s*:/,
  /^\s*\+ .*\.ps1:? line \d+/,
  /^At line:\d+ char:\d+/,
  /^所在位置 行:\d+ 字符: \d+/,
  /^\s*\+ ~+/,
  /^\s+at [\w.]+, .+ line \d+/,
  /^#< CLIXML/,
  /^<Objs /,
];

const CLIXML_MARKER = '#< CLIXML';

/** Undo .NET's CLIXML string escaping inside serialized records. */
function unescapeClixml(t: string): string {
  return t
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x000A_/g, '\n')
    .replace(/_x000D_/g, '')
    .replace(/_x0009_/g, '\t')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * When stderr is redirected, powershell.exe serializes error records as
 * CLIXML (`#< CLIXML` + XML). Unwrap the real message lines and drop
 * progress records, so agents see plain bash-style text.
 */
function extractClixml(s: string): string {
  const idx = s.indexOf(CLIXML_MARKER);
  if (idx < 0) return s;
  const plain = s.slice(0, idx).trim();
  const xml = s.slice(idx);
  const messages: string[] = [];
  // each serialized record looks like: <S S="Error">message text</S>
  for (const chunk of xml.split('<S ')) {
    const close = chunk.indexOf('</S>');
    if (close < 0) continue;
    const open = chunk.indexOf('>');
    if (open < 0 || open >= close) continue;
    const text = unescapeClixml(chunk.slice(open + 1, close));
    if (text) messages.push(text);
  }
  return plain ? plain + '\n' + messages.join('\n') : messages.join('\n');
}

export function normalizeStderr(stderr: string): string {
  const unwrapped = extractClixml(stderr);
  const lines = unwrapped.split(/\r?\n/).filter((l) => !PS_NOISE.some((re) => re.test(l)));

  const out = lines.map((line) => {
    // "The term 'x' is not recognized as a name of a cmdlet, function, ..."
    let m = line.match(/^The term '(.+?)' is not recognized/);
    if (m) return commandNotFound(m[1]);

    // zh-CN: & : 无法将“x”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。
    // Require the PowerShell-specific suffix so ordinary Chinese prose that
    // happens to contain “无法将…项识别为” is not rewritten.
    m = line.match(
      /^(?:\S+\s*:\s*)?无法将[“"'‘]?(.+?)[”"'’]?项识别为\s*cmdlet、函数、脚本文件或可运行程序的名称(?:。|$)/,
    );
    if (m) return commandNotFound(m[1]);

    // "x : The term 'y' is not recognized ..." (with source prefix)
    m = line.match(/^(\S+)\s*:\s*The term '(.+?)' is not recognized/);
    if (m) return commandNotFound(m[2]);

    // "cat : Cannot find path 'D:\x' because it does not exist."
    m = line.match(/^(\S+)\s*:\s*Cannot find path '(.+?)' because it does not exist\.?$/);
    if (m) {
      const cmd = m[1].toLowerCase();
      return (
        cmd +
        ': ' +
        m[2].replace(/\\/g, '/') +
        ': No such file or directory'
      );
    }

    // zh-CN: "Get-Content : 找不到路径“X”，因为该路径不存在。"
    m = line.match(
      /^(\S+)\s*:\s*找不到路径[“"'‘](.+?)[”"'’]，因为该路径不存在[。.]?$/,
    );
    if (m) {
      return m[1].toLowerCase() + ': ' + m[2].replace(/\\/g, '/') + ': No such file or directory';
    }

    // "cat : Cannot find drive. A drive with the name 'z' does not exist."
    m = line.match(/^(\S+)\s*:\s*Cannot find drive\..*name '(.+?)'.*$/);
    if (m) return m[1].toLowerCase() + ': ' + m[2] + ': No such file or directory';

    // zh-CN: "Get-Content : 找不到驱动器。名为“Z”的驱动器不存在。"
    m = line.match(
      /^(\S+)\s*:\s*找不到驱动器[。.]\s*名为[“"'‘](.+?)[”"'’]的驱动器不存在[。.]?$/,
    );
    if (m) return m[1].toLowerCase() + ': ' + m[2] + ': No such file or directory';

    // "rm : Cannot remove item ... Access is denied"
    m = line.match(/^(\S+)\s*:\s*(.*)Access to the path '(.+?)' is denied\.?$/);
    if (m) return m[1].toLowerCase() + ': cannot remove \'' + m[3] + '\': Permission denied';

    // zh-CN: "rm : 对路径“C:\\protected”的访问被拒绝。"
    m = line.match(
      /^(\S+)\s*:\s*对路径[“"'‘](.+?)[”"'’]的访问被拒绝[。.]?$/,
    );
    if (m) return m[1].toLowerCase() + ': cannot remove \'' + m[2] + '\': Permission denied';

    // leftover PS not-recognized lines that the rewrites above did not catch
    if (/\.sh'?/.test(line) && /is not recognized/.test(line)) {
      return line + SH_SCRIPT_WINDOWS_HINT;
    }

    return line;
  });

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
