import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('contains an asynchronous stdin pipe error and starts a fresh host for the next request', () => {
  const root = mkdtempSync(join(tmpdir(), 'fauxnix-host-pipe-'));
  const hostModule = new URL('../src/ps-host.ts', import.meta.url).href;
  const loader = fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url));
  // Keep the host class and real OS pipes in a subprocess: an unhandled pipe
  // error must fail this test rather than terminate the Vitest worker itself.
  const brokenHost = `
    require('node:fs').closeSync(0);
    process.stdout.write('{"ready":true}\\n');
    setTimeout(() => {}, 1500);
  `;
  const healthyHost = `
    process.stdout.write('{"ready":true}\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({id:request.id, stdoutB64:'b2s=', stderrB64:'', exitCode:0})+'\\n');
    });
  `;
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const spawn = childProcess.spawn;
    let starts = 0;
    childProcess.spawn = (_executable, _args, options) => spawn(process.execPath,
      ['-e', starts++ === 0 ? ${JSON.stringify(brokenHost)} : ${JSON.stringify(healthyHost)}], options);
    syncBuiltinESMExports();
    const { PowerShellHost } = await import(${JSON.stringify(hostModule)});
    const host = new PowerShellHost(${JSON.stringify(join(root, 'host.ps1'))}, () => ({...process.env}),
      {executable:'fixture-host', expectedEdition:'Core', configured:true});
    try {
      await host.ready();
      const failed = await host.invoke('fixture', {}, 3000);
      const recovered = await host.invoke('fixture', {}, 3000);
      console.log(JSON.stringify({failed, recovered: recovered.stdout.toString(), starts}));
    } finally { await host.stop(); }
  `;
  try {
    const result = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.failed).toMatchObject({exitCode: 1, infrastructureError: true, timedOut: false, cancelled: false});
    expect(report.recovered).toBe('ok');
    expect(report.starts).toBe(2);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}, 20000);
