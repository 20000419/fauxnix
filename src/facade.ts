import { appendFileSync, writeFileSync } from 'node:fs';
import { parseCommand } from './parser.js';
import { translateCommandList, EXECUTE_TRANSLATION } from './translator.js';
import { FauxnixSession } from './executor.js';
import { packageVersion } from './version.js';

/**
 * Experimental native-shell facade (RFC: docs/rfc-bash-facade.md).
 *
 * Implements the bash process contract so a harness can point its built-in
 * Bash tool at fauxnix instead of a real bash.exe:
 *   - one-shot:   facade -c "<script>" [name arg1 ...]   ($0/$1 from operands)
 *   - persistent: stdin blocks wrapped in <bash-input>...</bash-input>;
 *                 each block runs in one resident session (cwd/env persist)
 *                 and is answered with its output plus a <bash-exit>N line.
 *
 * Disclosure rule from the RFC: --version always identifies fauxnix.
 */

const MARKER_RE = /<bash-input>([\s\S]*?)<\/bash-input>/;

const VERSION_LINE =
  'GNU bash, version 5.2.0(1)-release (fauxnix facade ' + packageVersion + ')\n';

async function runScript(
  session: FauxnixSession,
  script: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const plans = translateCommandList(parseCommand(script), EXECUTE_TRANSLATION);
  const result = await session.run(plans);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

function bashQuote(word: string): string {
  return "'" + word.replaceAll("'", `'\\''`) + "'";
}

/**
 * Claude Code's Bash tool wraps every command in private scaffolding,
 * captured from a live session (2026-10-05; see docs/rfc-bash-facade.md):
 *
 *   export TEMP='..' TMP='..' && shopt -u extglob 2>/dev/null || true &&
 *   { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; }
 *     >/dev/null 2>&1 || true && eval 'PAYLOAD' < /dev/null &&
 *   pwd -P >| /c/.../claude-XXXX-cwd
 *
 * plus a shell-snapshot bootstrap built with heredocs and function
 * definitions. The scaffolding is harness plumbing, not user bash: the
 * facade applies the export prefix, executes the payload, and writes the
 * cwd marker itself (only on success, matching bash's `&&` chain). Pattern
 * drift falls through to plain translation and fails loud — visible in the
 * FAUXNIX_FACADE_TRACE capture, never silently wrong.
 */
const CC_SNAPSHOT_RE = /^SNAPSHOT_FILE='([^']+)'[\s\S]*RIPGREP_FUNC_END/;
const CC_COMMAND_RE =
  /^(?:source \S+ 2>\/dev\/null \|\| true &&\s*)?(export\s+[^\n]*?)\s*&&\s*shopt -u extglob[\s\S]*?&& eval '([\s\S]*?)' < \/dev\/null && pwd -P >\| (\S+)\s*$/;

function toPosixPath(p: string): string {
  const s = p.replaceAll('\\', '/');
  const m = /^([A-Za-z]):(\/.*)?$/.exec(s);
  return m ? '/' + m[1]!.toLowerCase() + (m[2] ?? '') : s;
}

function fromPosixPath(p: string): string {
  const m = /^\/([A-Za-z])(\/.*)?$/.exec(p);
  return m ? m[1]!.toUpperCase() + ':' + (m[2] ?? '').replaceAll('/', '\\') : p;
}

/** Returns the exit code, or null when the script is not Claude Code scaffolding. */
async function tryClaudeCodeAdapter(session: FauxnixSession, script: string): Promise<number | null> {
  const snap = CC_SNAPSHOT_RE.exec(script);
  if (snap) {
    try {
      writeFileSync(
        fromPosixPath(snap[1]!),
        '# Snapshot file\n# fauxnix facade: shell state lives in the facade session, not a snapshot script\n',
      );
      return 0;
    } catch (err) {
      process.stderr.write(`fauxnix: facade: snapshot write failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  const cmd = CC_COMMAND_RE.exec(script);
  if (!cmd) return null;
  const [, exportPart, payload, markerPosix] = cmd;
  const env = await runScript(session, exportPart);
  if (env.exitCode !== 0) {
    if (env.stderr) process.stderr.write(env.stderr);
    return env.exitCode;
  }
  const r = await runScript(session, payload);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.exitCode !== 0) return r.exitCode; // bash: && chain stops, no marker
  try {
    writeFileSync(fromPosixPath(markerPosix), toPosixPath(session.cwd ?? process.cwd()) + '\n');
  } catch {
    /* the marker is best-effort bookkeeping for the harness */
  }
  return 0;
}

async function runOneShot(
  session: FauxnixSession,
  script: string,
  positionals: string[],
): Promise<number> {
  // bash -c '' is a successful no-op, distinct from a missing operand.
  if (script === '') return 0;
  // bash: trailing operands set $0, then $1.. via `set --`.
  session.env['FAUXNIX_ARG0'] = positionals[0] ?? 'bash';
  if (positionals.length > 1) {
    const r = await runScript(
      session,
      'set -- ' + positionals.slice(1).map(bashQuote).join(' '),
    );
    if (r.exitCode !== 0) {
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      return r.exitCode;
    }
  }
  const r = await runScript(session, script);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}

/** Diagnostic trace: set FAUXNIX_FACADE_TRACE to append raw argv/stdin traffic. */
function trace(kind: 'argv' | 'stdin', data: string): void {
  const file = process.env['FAUXNIX_FACADE_TRACE'];
  if (!file) return;
  try {
    appendFileSync(file, `[${kind}] ${JSON.stringify(data)}\n`, 'utf8');
  } catch {
    /* diagnostics must never break the facade */
  }
}

async function runMarkerSession(session: FauxnixSession): Promise<number> {
  await session.prewarm();
  return new Promise<number>((resolve) => {
    let buf = '';
    let queue: Promise<unknown> = Promise.resolve();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      trace('stdin', chunk);
      buf += chunk;
      let m: RegExpExecArray | null;
      while ((m = MARKER_RE.exec(buf))) {
        buf = buf.slice(m.index + m[0].length);
        const cmd = m[1]!;
        // serialize markers: a session executes one command at a time
        queue = queue.then(async () => {
          try {
            const r = await runScript(session, cmd);
            if (r.stdout) process.stdout.write(r.stdout);
            if (r.stderr) process.stderr.write(r.stderr);
            process.stdout.write(`<bash-exit>${r.exitCode}</bash-exit>\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`fauxnix: facade: ${msg}\n`);
            process.stdout.write('<bash-exit>127</bash-exit>\n');
          }
        });
      }
    });
    process.stdin.on('end', () => {
      queue.then(() => resolve(0));
    });
  });
}

/**
 * bash argv contract: options may combine and may appear between -c and the
 * command string. Observed from Claude Code: `bash -c env`, `bash -lc '...'`,
 * `bash -c -l '<script>'`. Returns null when argv is not a -c invocation.
 */
function parseDashC(argv: string[]): { script?: string; positionals: string[] } | null {
  let wantScript = false;
  let script: string | undefined;
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]!);
      break;
    }
    if (token.startsWith('-') && token.length > 1 && script === undefined) {
      for (const ch of token.slice(1)) {
        if (ch === 'c' || ch === 'e') wantScript = true;
        else if (ch !== 'l' && ch !== 'i' && ch !== 's' && ch !== 'r') return null;
      }
      continue;
    }
    if (wantScript && script === undefined) {
      script = token;
      continue;
    }
    positionals.push(token);
  }
  if (!wantScript) return null;
  return { script, positionals };
}

export async function runFacade(argv: string[]): Promise<number> {
  trace('argv', argv.join(' '));
  const session = new FauxnixSession();
  try {
    if (argv[0] === '--version') {
      process.stdout.write(VERSION_LINE);
      return 0;
    }
    const dashC = parseDashC(argv);
    if (dashC) {
      if (dashC.script === undefined) {
        process.stderr.write('bash: -c: option requires an argument\n');
        return 2;
      }
      if (dashC.positionals.length === 0) {
        const adapted = await tryClaudeCodeAdapter(session, dashC.script);
        if (adapted !== null) return adapted;
      }
      return await runOneShot(session, dashC.script, dashC.positionals);
    }    return await runMarkerSession(session);
  } catch (err) {
    // bash -c exits 2 on syntax errors; 127 covers the not-found family
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write('bash: -c: ' + msg + '\n');
    return msg.includes('not found') ? 127 : 2;
  } finally {
    await session.dispose();
  }
}
