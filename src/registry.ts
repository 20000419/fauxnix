import { Word, wordToString } from './ast.js';

/**
 * Command registry — each Linux command maps to a PowerShell generator.
 *
 * Contract for generated code (the "Fauxnix contract"):
 *
 * 1. The generator returns a block of PowerShell *statements* (NO `& { }`
 *    wrapper, NO `exit`). The translator either embeds the block in
 *    `(& { ... })` (single command) or turns it into a generated function
 *    body chained in a pipeline (multi-command pipelines).
 * 2. Everything the block emits is a string line (Unix text-stream semantics).
 *    Never emit raw .NET objects — stringify them ("$_", [string]$x).
 * 3. Failure must NOT `exit` (that would kill sibling pipeline stages).
 *    Instead write the bash-style message to stderr and set the shared flag:
 *        [Console]::Error.WriteLine('cat: foo: No such file or directory')
 *        $script:fx_exit = 1
 *    NOTE the exact spelling: `.Error.WriteLine` with a DOT (a `::` chain
 *    resolves as a static call and throws), and `$script:` (handlers run in
 *    child scopes — plain `$fx_exit` writes stay local and are lost).
 *    The executor wrapper reads $script:fx_exit after the pipeline completes.
 * 4. Stdin = `$input` inside your block:  @($input | ForEach-Object { [string]$_ })
 *    (empty when there is no upstream). Use ctx.hasStdin to decide whether
 *    reading stdin is legal.
 * 5. Output formatting mimics GNU coreutils so agents feel at home.
 * 6. Target Windows PowerShell 5.1: no ternary, no ?? operator, no
 *    chainable null-conditional. Plain if/else everywhere.
 * 7. Blocks must be self-contained (local helper functions allowed) — they
 *    also run inside $(...) command substitutions without the wrapper preamble.
 */

export interface PipelineCtx {
  /** Position of this command inside the pipeline. */
  position: 'first' | 'middle' | 'last';
  /** True when stdin is available (piped input or `< file` redirect). */
  hasStdin: boolean;
}

export type Handler = (args: Word[], ctx: PipelineCtx) => string;

const registry = new Map<string, Handler>();

export function register(name: string, handler: Handler): void {
  registry.set(name, handler);
}

export function registerAll(mod: Record<string, Handler>): void {
  for (const [name, handler] of Object.entries(mod)) register(name, handler);
}

export function lookup(name: string): Handler | undefined {
  return registry.get(name);
}

export function registeredNames(): string[] {
  return [...registry.keys()].sort();
}

/* ------------------------------------------------------------------ */
/* Shared helpers used by command generators                           */
/* ------------------------------------------------------------------ */

/** Escape a JS string into a single-quoted PowerShell string literal. */
export function psStr(s: string): string {
  if (/[\r\n]/.test(s)) {
    return (
      '"' +
      s
        .replace(/`/g, '``')
        .replace(/"/g, '`"')
        .replace(/\$/g, '`$')
        .replace(/\r/g, '`r')
        .replace(/\n/g, '`n') +
      '"'
    );
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

/** bash-style stderr line + exit-flag, as PS statements. */
export function psErr(cmd: string, msg: string): string {
  return '[Console]::Error.WriteLine(' + psStr(cmd + ': ' + msg) + '); $script:fx_exit = 1';
}

/** bash-style stderr line with exit code 2 (serious trouble, like ls). */
export function psErr2(cmd: string, msg: string): string {
  return '[Console]::Error.WriteLine(' + psStr(cmd + ': ' + msg) + '); $script:fx_exit = 2';
}

/** Does this argument text contain glob characters? */
export function hasGlob(s: string): boolean {
  return /[*?]/.test(s);
}

/** Options parsing helper: returns { flags: Set<string>, operands: string[] } */
export interface ParsedArgs {
  flags: Set<string>;
  /** long options like --all (kept with dashes) */
  longs: Set<string>;
  operands: string[];
  /** option values consumed via -n 5 style */
  values: Map<string, string>;
}

/**
 * Parse a Unix-style argv. Supports:
 *   -a -abc (bundled) --long (with =value or following value via valueOpts)
 */
export function parseArgs(
  args: { toDisplay: string }[],
  valueOpts: Set<string> = new Set(),
): ParsedArgs {
  const flags = new Set<string>();
  const longs = new Set<string>();
  const operands: string[] = [];
  const values = new Map<string, string>();
  let i = 0;
  let onlyOperands = false;
  while (i < args.length) {
    const a = args[i].toDisplay;
    if (!onlyOperands && a === '--') {
      onlyOperands = true;
    } else if (!onlyOperands && a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        longs.add(a.slice(0, eq));
        values.set(a.slice(0, eq), a.slice(eq + 1));
      } else if (valueOpts.has(a)) {
        longs.add(a);
        if (i + 1 < args.length) {
          values.set(a, args[i + 1].toDisplay);
          i++;
        }
      } else {
        longs.add(a);
      }
    } else if (!onlyOperands && a.startsWith('-') && a.length > 1) {
      for (const c of a.slice(1)) flags.add(c);
    } else {
      operands.push(a);
    }
    i++;
  }
  return { flags, longs, operands, values };
}

/* ------------------------------------------------------------------ */
/* Word-preserving argv parsing                                        */
/* ------------------------------------------------------------------ */

export interface WordArgs {
  flags: Set<string>;
  longs: Set<string>;
  values: Map<string, string>;
  /** Options that take a value but were not followed by one. */
  missingValue: string[];
  operandWords: Word[];
}

/**
 * Parse argv while keeping operand *Words* (so they can still be translated
 * with exprOfWord / operandExpr). Supports:
 *   -a -abc --long --long=v --long v  -n 5  -n5
 * shortValues: single-char options that consume a value (e.g. ['n']).
 */
export function parseWords(
  args: Word[],
  shortValues: string[] = [],
  longValues: string[] = [],
): WordArgs {
  const flags = new Set<string>();
  const longs = new Set<string>();
  const values = new Map<string, string>();
  const missingValue: string[] = [];
  const operandWords: Word[] = [];
  let i = 0;
  let onlyOperands = false;
  while (i < args.length) {
    const t = wordToString(args[i]);
    if (!onlyOperands && t === '--') {
      onlyOperands = true;
    } else if (!onlyOperands && t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq >= 0) {
        longs.add(t.slice(0, eq));
        values.set(t.slice(0, eq), t.slice(eq + 1));
      } else if (longValues.includes(t)) {
        longs.add(t);
        if (i + 1 < args.length) {
          values.set(t, wordToString(args[i + 1]));
          i++;
        } else missingValue.push(t);
      } else {
        longs.add(t);
      }
    } else if (!onlyOperands && t.startsWith('-') && t.length > 1 && !/^-?\d/.test(t.slice(1, 2)) ) {
      // bundled short flags; a value-taking short opt consumes the rest (-n5)
      const body = t.slice(1);
      for (let c = 0; c < body.length; c++) {
        const ch = body[c];
        if (shortValues.includes(ch)) {
          // value-taking options report via `values`, not `flags`
          const rest = body.slice(c + 1);
          if (rest) {
            values.set('-' + ch, rest);
          } else if (i + 1 < args.length) {
            values.set('-' + ch, wordToString(args[i + 1]));
            i++;
          } else missingValue.push('-' + ch);
          break;
        }
        flags.add(ch);
      }
    } else {
      operandWords.push(args[i]);
    }
    i++;
  }
  return { flags, longs, values, missingValue, operandWords };
}

/* ------------------------------------------------------------------ */
/* Typed command capabilities (#130)                                   */
/* ------------------------------------------------------------------ */

export type CommandEffect = 'read' | 'write' | 'delete' | 'network' | 'process';

export type OptionSupport = 'implemented' | 'unsupported';

/** One short/long alias group. Unknown options on a spec'd command fail loud. */
export interface OptionSpec {
  /** Short flag letter without dash (e.g. `'n'`). */
  short?: string;
  /** Long option including dashes (e.g. `'--no-clobber'`). */
  long?: string;
  /** Consumes a following argument (`-n 5`, `--lines=5`). */
  takesValue?: boolean;
  support: OptionSupport;
  /** Extra phrase for unsupported options (`interactive prompt`). */
  reason?: string;
}

export interface CommandSpec {
  names: string[];
  options: OptionSpec[];
  effects: CommandEffect[];
  platform?: 'windows-ps51' | 'portable-translate';
  dispatch?: 'translated' | 'native' | 'dynamic';
  /** GNU usage/syntax exit (grep uses 2; cp/mv/rm use 1). */
  usageExit?: number;
  handler: Handler;
}

const specs = new Map<string, CommandSpec>();

/** Register a spec'd command. Unknown/unsupported options become GNU-style usage errors. */
export function registerSpec(spec: CommandSpec): void {
  for (const name of spec.names) {
    const wrapped: Handler = (args, ctx) => {
      const err = specOptionError(spec, args, name);
      if (err) return err;
      return spec.handler(args, ctx);
    };
    registry.set(name, wrapped);
    specs.set(name, spec);
  }
}

export function registerSpecs(list: CommandSpec[]): void {
  for (const spec of list) registerSpec(spec);
}

export function lookupSpec(name: string): CommandSpec | undefined {
  return specs.get(name);
}

/** Unique specs in registration order. */
export function registeredSpecs(): CommandSpec[] {
  const seen = new Set<CommandSpec>();
  const out: CommandSpec[] = [];
  for (const spec of specs.values()) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    out.push(spec);
  }
  return out;
}

/** Markdown dump of every CommandSpec — source for docs/command-specs.md. */
export function specsMarkdown(): string {
  const lines = [
    '# Command specs',
    '',
    'Generated from `CommandSpec`. Unlisted commands still use unchecked `parseWords` (unknown flags ignored). Spec\'d commands fail loud on unknown or unsupported options.',
    '',
  ];
  for (const spec of registeredSpecs()) {
    lines.push('## `' + spec.names.join('` / `') + '`');
    lines.push('');
    lines.push('Effects: ' + spec.effects.map((e) => '`' + e + '`').join(', '));
    lines.push('');
    if (!spec.options.length) {
      lines.push('No options declared.');
    } else {
      lines.push('| Option | Value | Support |');
      lines.push('| --- | --- | --- |');
      for (const o of spec.options) {
        const names = [o.short ? '`-' + o.short + '`' : '', o.long ? '`' + o.long + '`' : '']
          .filter((s) => s !== '')
          .join(', ');
        const val = o.takesValue ? 'required' : 'flag';
        const extra = o.reason ? ' (' + o.reason + ')' : '';
        lines.push('| ' + names + ' | ' + val + ' | ' + o.support + extra + ' |');
      }
    }
    lines.push('');
  }
  const unspec = registeredNames().filter((n) => !lookupSpec(n));
  lines.push('## Unspec\'d commands');
  lines.push('');
  lines.push(unspec.map((n) => '`' + n + '`').join(', '));
  lines.push('');
  return lines.join('\n');
}

export interface ListedCommand {
  name: string;
  spec: null | {
    options: Array<{
      short?: string;
      long?: string;
      takesValue: boolean;
      support: OptionSupport;
      reason?: string;
    }>;
    effects: CommandEffect[];
    platform: 'windows-ps51' | 'portable-translate';
    dispatch: 'translated' | 'native' | 'dynamic';
  };
}

/** Capability dump for `fauxnix list --json` / MCP introspection. */
export function listCommandsJson(): ListedCommand[] {
  return registeredNames().map((name) => {
    const spec = lookupSpec(name);
    if (!spec) return { name, spec: null };
    return {
      name,
      spec: {
        options: spec.options.map((o) => ({
          ...(o.short ? { short: o.short } : {}),
          ...(o.long ? { long: o.long } : {}),
          takesValue: o.takesValue === true,
          support: o.support,
          ...(o.reason ? { reason: o.reason } : {}),
        })),
        effects: spec.effects,
        platform: spec.platform ?? 'windows-ps51',
        dispatch: spec.dispatch ?? 'translated',
      },
    };
  });
}

/**
 * Walk argv against a CommandSpec. Returns a PowerShell error script, or
 * null when every option is recognized and implemented.
 */
export function specOptionError(spec: CommandSpec, args: Word[], cmdName: string): string | null {
  const usageExit = spec.usageExit ?? 1;
  const fail = (msg: string) => optionFail(cmdName, msg, usageExit);
  const shorts = new Map<string, OptionSpec>();
  const longs = new Map<string, OptionSpec>();
  for (const o of spec.options) {
    if (o.short) shorts.set(o.short, o);
    if (o.long) longs.set(o.long, o);
  }

  let i = 0;
  let onlyOperands = false;
  while (i < args.length) {
    const t = wordToString(args[i]);
    if (onlyOperands) {
      i++;
      continue;
    }
    if (t === '--') {
      onlyOperands = true;
      i++;
      continue;
    }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq >= 0 ? t.slice(0, eq) : t;
      const opt = longs.get(name);
      if (!opt) return fail("unrecognized option '" + name + "'");
      if (opt.support === 'unsupported') {
        return fail(unsupportedMsg(opt, name));
      }
      if (!opt.takesValue && eq >= 0) {
        return fail("option '" + name + "' doesn't allow an argument");
      }
      if (opt.takesValue && eq < 0) {
        if (i + 1 < args.length) i++;
        else return fail("option '" + name + "' requires an argument");
      }
      i++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1 && !/^-?\d/.test(t.slice(1, 2))) {
      const body = t.slice(1);
      for (let c = 0; c < body.length; c++) {
        const ch = body[c];
        const opt = shorts.get(ch);
        if (!opt) return fail("invalid option -- '" + ch + "'");
        if (opt.support === 'unsupported') {
          return fail(unsupportedMsg(opt, '-' + ch));
        }
        if (opt.takesValue) {
          const rest = body.slice(c + 1);
          if (!rest) {
            if (i + 1 < args.length) i++;
            else return fail("option requires an argument -- '" + ch + "'");
          }
          break;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  return null;
}

function unsupportedMsg(opt: OptionSpec, shown: string): string {
  const reason = opt.reason ? ' (' + opt.reason + ')' : '';
  return "option '" + shown + "' is not supported by fauxnix" + reason;
}

function optionFail(cmd: string, msg: string, code = 1): string {
  return (
    '[Console]::Error.WriteLine(' +
    psStr(cmd + ': ' + msg) +
    '); [Console]::Error.WriteLine(' +
    psStr("Try '" + cmd + " --help' for more information.") +
    '); $script:fx_exit = ' +
    String(code)
  );
}
