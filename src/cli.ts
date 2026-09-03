import { spawn } from 'node:child_process';
import { FauxnixSession } from './executor.js';
import { parseCommand } from './parser.js';
import {
  EXECUTE_TRANSLATION,
  PURE_TRANSLATION,
  translateCommandList,
} from './translator.js';
import { listCommandsJson, registeredNames, specsMarkdown } from './registry.js';
import { encodeCommand } from './encoding.js';
import { startMcpServer } from './mcp.js';
import { collectDoctorReport } from './doctor.js';
import { runInstall } from './install.js';
import { packageVersion } from './version.js';
import {
  POWERSHELL_ARGS,
  powerShellDisplay,
  powerShellMissingMessage,
  resolvePowerShell,
} from './powershell.js';
import './commands/install-all.js';

export const USAGE = `fauxnix — run Linux-style commands on Windows via PowerShell translation

Usage:
  fauxnix "ls -la | head -5"        translate + execute a bash-style command
  fauxnix -c "cmd"                   same as above
  fauxnix translate "cmd"            show the PowerShell translation only
  fauxnix mcp                        start the MCP stdio server (for agent harnesses)
  fauxnix list                       list translated commands
  fauxnix list --json                same list as machine-readable capability metadata
  fauxnix list --markdown            CommandSpec tables (same text as docs/command-specs.md)
  fauxnix check                      verify the local PowerShell environment
  fauxnix doctor                     check + encoding, harness config, MCP readiness
  fauxnix install --claude|--codex|--opencode|--kimi|--qwen
  fauxnix --version

Notes:
  FAUXNIX_PS=pwsh selects the opt-in PowerShell 7 host (5.1 is the default).
  Unknown commands (git, node, npm, python, cargo, ...) pass through and run natively.`;

export async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0) {
    console.log(USAGE);
    return;
  }

  const [verb, ...rest] = argv;

  if (verb === '--version' || verb === '-v') {
    console.log(`fauxnix ${packageVersion}`);
    return;
  }

  if (verb === 'list') {
    if (rest[0] === '--json') {
      console.log(JSON.stringify(listCommandsJson(), null, 2));
      return;
    }
    if (rest[0] === '--markdown') {
      console.log(specsMarkdown());
      return;
    }
    const names = registeredNames();
    console.log(names.length + ' translated commands:');
    for (const n of names) console.log('  ' + n);
    console.log('\nAnything else (git, node, npm, python, cargo, ...) is passed through natively.');
    return;
  }

  if (verb === 'check') {
    await runCheck();
    return;
  }

  if (verb === 'doctor') {
    await runDoctor();
    return;
  }

  if (verb === 'install') {
    const result = runInstall(rest);
    for (const line of result.lines) console.log(line);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (verb === 'mcp') {
    await startMcpServer();
    return;
  }

  if (verb === 'translate') {
    const cmd = rest.join(' ');
    const list = parseCommand(cmd);
    const plans = translateCommandList(list, PURE_TRANSLATION);
    console.log(plans.map((p) => p.script).join('\n# ---- next segment ----\n'));
    return;
  }

  const cmd = verb === '-c' || verb === '-e' ? rest.join(' ') : argv.join(' ');
  if (!cmd.trim()) {
    console.log(USAGE);
    return;
  }

  const list = parseCommand(cmd);
  const plans = translateCommandList(list, EXECUTE_TRANSLATION);
  const session = new FauxnixSession();
  const result = await session.run(plans);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  await session.dispose();
  process.exit(result.exitCode);
}

async function runDoctor(): Promise<void> {
  const checkOk = await runCheck();
  const report = await collectDoctorReport();
  for (const line of report.lines) console.log(line);
  if (!checkOk || !report.ok) process.exitCode = 1;
}

export async function runCheck(): Promise<boolean> {
  const selection = resolvePowerShell();
  console.log('powershell : ' + powerShellDisplay(selection));
  if (selection.error) {
    console.error('status     : FAILED');
    console.error(selection.error);
    process.exitCode = 1;
    return false;
  }

  const probeCmd =
    '[Console]::Out.WriteLine($PSVersionTable.PSVersion.ToString()); ' +
    '[Console]::Out.WriteLine([string]$PSVersionTable.PSEdition)';
  const probe = spawn(
    selection.executable,
    [...POWERSHELL_ARGS, '-EncodedCommand', encodeCommand(probeCmd)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let out = '';
  let err = '';
  probe.stdout.on('data', (d) => (out += d.toString('utf8')));
  probe.stderr.on('data', (d) => (err += d.toString('utf8')));
  const outcome = await new Promise<{ code: number; error?: NodeJS.ErrnoException }>((resolve) => {
    let settled = false;
    const done = (value: { code: number; error?: NodeJS.ErrnoException }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    probe.once('error', (error: NodeJS.ErrnoException) => done({ code: 127, error }));
    probe.once('close', (code) => done({ code: code ?? 1 }));
  });
  if (outcome.error) {
    console.error('status     : FAILED');
    if (outcome.error.code === 'ENOENT') {
      console.error(powerShellMissingMessage(selection).trimEnd());
    } else {
      console.error(`fauxnix: failed to start ${selection.executable}: ${outcome.error.message}`);
    }
    process.exitCode = 1;
    return false;
  }
  if (outcome.code !== 0) {
    console.error(`status     : FAILED to run ${selection.executable}`);
    if (err.trim()) console.error(err.trim());
    process.exitCode = 1;
    return false;
  }

  const lines = out.trim().split(/\r?\n/);
  const version = lines[0] ?? '';
  const edition = lines[1] ?? '';
  console.log('version    : ' + version);
  console.log('edition    : ' + edition);
  if (edition !== selection.expectedEdition) {
    console.error(
      `status     : FAILED: ${selection.executable} reported ${edition || 'no edition'}; ` +
        `expected ${selection.expectedEdition}`,
    );
    process.exitCode = 1;
    return false;
  }
  console.log('commands   : ' + registeredNames().length + ' translated, others pass through');
  console.log('status     : OK');
  return true;
}
