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

async function runOneShot(
  session: FauxnixSession,
  script: string,
  positionals: string[],
): Promise<number> {
  // bash: trailing operands set $0, then $1.. via `set --`.
  process.env['FAUXNIX_ARG0'] = positionals[0] ?? 'bash';
  if (positionals.length > 1) {
    const r = await runScript(
      session,
      'set -- ' + positionals.slice(1).map(bashQuote).join(' '),
    );
    if (r.exitCode !== 0) return r.exitCode;
  }
  const r = await runScript(session, script);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}

async function runMarkerSession(session: FauxnixSession): Promise<number> {
  await session.prewarm();
  return new Promise<number>((resolve) => {
    let buf = '';
    let queue: Promise<unknown> = Promise.resolve();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
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
            process.stderr.write(`fauxnix: facade: ${(err as Error).message}\n`);
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

export async function runFacade(argv: string[]): Promise<number> {
  const session = new FauxnixSession();
  try {
    if (argv[0] === '--version') {
      process.stdout.write(VERSION_LINE);
      return 0;
    }
    if (argv[0] === '-c' || argv[0] === '-e') {
      const [script, ...positionals] = argv.slice(1);
      if (!script) {
        process.stderr.write('bash: -c: option requires an argument\n');
        return 2;
      }
      return await runOneShot(session, script, positionals);
    }
    return await runMarkerSession(session);
  } catch (err) {
    // bash -c exits 2 on syntax errors; 127 covers the not-found family
    const msg = (err as Error).message ?? String(err);
    process.stderr.write('bash: -c: ' + msg + '\n');
    return msg.includes('not found') ? 127 : 2;
  } finally {
    await session.dispose();
  }
}
