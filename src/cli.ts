import { spawn } from 'node:child_process';
import { FauxnixSession } from './executor.js';
import { parseCommand } from './parser.js';
import { translateCommandList } from './translator.js';
import { listCommandsJson, registeredNames, specsMarkdown } from './registry.js';
import { encodeCommand } from './encoding.js';
import { startMcpServer } from './mcp.js';
import { collectDoctorReport } from './doctor.js';
import { packageVersion } from './version.js';
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
  fauxnix --version

Notes:
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

  if (verb === 'mcp') {
    await startMcpServer();
    return;
  }

  if (verb === 'translate') {
    const cmd = rest.join(' ');
    const list = parseCommand(cmd);
    const plans = translateCommandList(list);
    console.log(plans.map((p) => p.script).join('\n# ---- next segment ----\n'));
    return;
  }

  const cmd = verb === '-c' || verb === '-e' ? rest.join(' ') : argv.join(' ');
  if (!cmd.trim()) {
    console.log(USAGE);
    return;
  }

  const list = parseCommand(cmd);
  const plans = translateCommandList(list);
  const session = new FauxnixSession();
  const result = await session.run(plans);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  await session.dispose();
  process.exit(result.exitCode);
}

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

async function runDoctor(): Promise<void> {
  await runCheck();
  const report = await collectDoctorReport();
  for (const line of report.lines) console.log(line);
  if (!report.ok) process.exitCode = 1;
}

async function runCheck(): Promise<void> {
  console.log('powershell : powershell.exe (Windows built-in)');
  const probeCmd = '$PSVersionTable.PSVersion.ToString()';
  const probe = spawn('powershell.exe', [...PS_ARGS, '-EncodedCommand', encodeCommand(probeCmd)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  probe.on('error', (e) => {
    console.error('status     : FAILED to run powershell.exe: ' + e.message);
    process.exit(1);
  });
  let out = '';
  probe.stdout.on('data', (d) => (out += d.toString('utf8')));
  const code = await new Promise<number>((resolve) => probe.on('close', (c) => resolve(c ?? 1)));
  if (code === 0) {
    console.log('version    : ' + out.trim());
    console.log('commands   : ' + registeredNames().length + ' translated, others pass through');
    console.log('status     : OK');
  } else {
    console.error('status     : FAILED to run powershell.exe');
    process.exitCode = 1;
  }
}
