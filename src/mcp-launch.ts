import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export type McpLaunchTuple = { command: string; args: string[] };

/**
 * Spawn-safe launch form for every harness config (#252): the absolute Node
 * executable plus this installation's absolute built entry. A bare
 * `fauxnix` command is an extension-less npm shim on Windows — MCP clients
 * that spawn the server directly via CreateProcess cannot execute it. The
 * absolute tuple is immune to PATH and shim-resolution differences on every
 * platform.
 */
export function resolveMcpLaunchTuple():
  | { ok: true; value: McpLaunchTuple }
  | { ok: false; reason: string } {
  const command = process.execPath;
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  if (!isAbsolute(command) || !existsSync(command)) {
    return {
      ok: false,
      reason: 'cannot locate the Node.js executable; reinstall Node.js, then retry `fauxnix install`',
    };
  }
  if (!isAbsolute(entry) || !existsSync(entry)) {
    return {
      ok: false,
      reason: `cannot locate the built fauxnix entry at ${entry}; run \`npm run build\` or reinstall fauxnix-cli, then retry \`fauxnix install\``,
    };
  }
  return { ok: true, value: { command, args: [entry, 'mcp'] } };
}

export function sameMcpLaunchTuple(value: unknown, expected: McpLaunchTuple): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.command === expected.command &&
    Array.isArray(rec.args) &&
    rec.args.length === expected.args.length &&
    rec.args.every((part, index) => part === expected.args[index])
  );
}

/** The pre-#252 config form: `{ command: "fauxnix", args: ["mcp"] }`. */
export function isLegacyFauxnixCommand(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  return rec.command === 'fauxnix' || (Array.isArray(rec.command) && rec.command[0] === 'fauxnix');
}
