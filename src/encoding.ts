import iconv from 'iconv-lite';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * How PowerShell decodes native tool output mid-pipeline. PS 5.1 has a single
 * console-encoding knob, so GBK-native admin tools (ipconfig, tasklist, ...)
 * and UTF-8-native dev tools (node, curl) cannot both decode cleanly:
 *   utf8 (default) — dev tools exact; localized admin tools mojibake
 *   ansi            — admin tools exact; dev tools' non-ASCII mojibake
 * File reads are unaffected (fx-read byte-sniffs per file).
 */
export type NativeEncodingPref = 'utf8' | 'gbk';

export function resolveNativePref(): NativeEncodingPref {
  return process.env.FAUXNIX_NATIVE_ENCODING === 'ansi' ? 'gbk' : 'utf8';
}

/**
 * Decode process output per the resolved preference. UTF-8 mode sniffs
 * strictly first (so genuine UTF-8 never falls back); GBK mode trusts the
 * setting (GBK decoding is lenient and cannot be validity-tested).
 */
export function decodeOutput(buf: Buffer, prefer: NativeEncodingPref = 'utf8'): string {
  if (buf.length === 0) return '';
  if (prefer === 'gbk') {
    let s = iconv.decode(buf, 'gbk');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }
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
