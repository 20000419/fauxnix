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

/**
 * Convert PowerShell-host CRLF line endings to LF without destroying
 * intentional CR/CRLF from exact writers (`fx-write`, `printf`, `echo -n`).
 *
 * The console host terminates each Write-Output object with CRLF and a
 * final newline. Exact writers do not. So we only rewrite when every LF
 * is part of a CRLF pair *and* the buffer ends with a newline.
 */
export function normalizeHostNewlines(s: string): string {
  if (s.length === 0 || !s.includes('\n')) return s;
  if (!s.endsWith('\n')) return s;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n' && (i === 0 || s[i - 1] !== '\r')) return s;
  }
  return s.replace(/\r\n/g, '\n');
}

/** Encode a PowerShell script for -EncodedCommand (UTF-16LE base64). */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Keep the longest whole-codepoint prefix within a caller's UTF-8 byte budget. */
export function clipUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= limit) return { text, truncated: false };

  // Captures normally exceed the caller budget by at most one codepoint.
  // Trim that small suffix rather than walking megabytes of retained output.
  // For a small budget, use the forward path instead; neither path allocates
  // another full UTF-8 buffer or splits a surrogate pair.
  if (total - limit <= limit) {
    let used = total;
    let end = text.length;
    while (used > limit && end > 0) {
      const last = text.charCodeAt(end - 1);
      const previous = end > 1 ? text.charCodeAt(end - 2) : 0;
      if (last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
        used -= 4;
        end -= 2;
      } else {
        // Lone surrogates encode as a three-byte replacement character,
        // but retain their original JS spelling just as the forward path does.
        used -= last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
        end--;
      }
    }
    return { text: text.slice(0, end), truncated: true };
  }

  let used = 0;
  let end = 0;
  for (const codepoint of text) {
    const value = codepoint.codePointAt(0)!;
    const size = value < 0x80 ? 1 : value < 0x800 ? 2 : value < 0x10000 ? 3 : 4;
    if (used + size > limit) break;
    used += size;
    end += codepoint.length;
  }
  return { text: text.slice(0, end), truncated: true };
}
