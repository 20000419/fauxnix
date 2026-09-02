import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export type QwenLaunchTuple = { command: string; args: string[] };

export function resolveQwenLaunchTuple():
  | { ok: true; value: QwenLaunchTuple }
  | { ok: false; reason: string } {
  const command = process.execPath;
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  if (!isAbsolute(command) || !existsSync(command)) {
    return {
      ok: false,
      reason: 'cannot locate the Node.js executable; reinstall Node.js, then retry `fauxnix install --qwen`',
    };
  }
  if (!isAbsolute(entry) || !existsSync(entry)) {
    return {
      ok: false,
      reason: `cannot locate the built fauxnix entry at ${entry}; run \`npm run build\` or reinstall fauxnix-cli, then retry \`fauxnix install --qwen\``,
    };
  }
  return { ok: true, value: { command, args: [entry, 'mcp'] } };
}

export function sameQwenLaunchTuple(value: unknown, expected: QwenLaunchTuple): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.command === expected.command &&
    Array.isArray(rec.args) &&
    rec.args.length === expected.args.length &&
    rec.args.every((part, index) => part === expected.args[index])
  );
}
