import { describe, expect, it } from 'vitest';
import { clipUtf8 } from '../src/encoding.js';

function reference(text: string, limit: number) {
  let prefix = '';
  for (const codepoint of text) {
    if (Buffer.byteLength(prefix + codepoint, 'utf8') > limit) break;
    prefix += codepoint;
  }
  return { text: prefix, truncated: prefix !== text };
}

describe('UTF-8 output budget boundaries', () => {
  it.each(['', 'ascii', '你好', '🙂🙃', 'aé你🙂z', '\ud800x\udfff', '\ud800\ud800\udfff'])
    ('matches the whole-codepoint reference for %j at every budget', (text) => {
      for (let limit = 0; limit <= Buffer.byteLength(text, 'utf8') + 1; limit++) {
        expect(clipUtf8(text, limit)).toEqual(reference(text, limit));
      }
    });

  it('matches mixed Unicode prefixes across deterministic generated cases', () => {
    const alphabet = ['a', 'é', '你', '🙂', '\n', '\ud800', '\udfff'];
    let seed = 1;
    for (let sample = 0; sample < 500; sample++) {
      let text = '';
      for (let i = 0; i < 12; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        text += alphabet[seed % alphabet.length];
      }
      for (let limit = 0; limit <= Buffer.byteLength(text, 'utf8') + 1; limit++) {
        expect(clipUtf8(text, limit)).toEqual(reference(text, limit));
      }
    }
  });

  it('retains a large near-budget prefix without splitting its final character', () => {
    const text = 'x'.repeat(1024 * 1024) + '🙂';
    expect(clipUtf8(text, 1024 * 1024 + 3)).toEqual({ text: text.slice(0, -2), truncated: true });
  });
});
