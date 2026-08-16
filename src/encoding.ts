import iconv from 'iconv-lite';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * Decode process output: UTF-8 first (we force UTF-8 in the wrapper),
 * with a GBK fallback for legacy native tools that ignore the codepage.
 */
export function decodeOutput(buf: Buffer): string {
  if (buf.length === 0) return '';
  try {
    let s = strictUtf8.decode(buf);
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  } catch {
    // not valid UTF-8 — assume the console ANSI codepage (GBK on zh-CN)
    try {
      return iconv.decode(buf, 'gbk');
    } catch {
      return buf.toString('utf8');
    }
  }
}

/** Encode a PowerShell script for -EncodedCommand (UTF-16LE base64). */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}
