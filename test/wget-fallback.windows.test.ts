/** Offline integration coverage for wget's curl.exe fallback on real PowerShell. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FauxnixSession } from '../src/executor.js';
import { parseCommand } from '../src/parser.js';
import { translateCommandList } from '../src/translator.js';
import '../src/commands/install-all.js';

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const systemCurl = join(systemRoot, 'System32', 'curl.exe');
const hasPs =
  process.platform === 'win32' &&
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], { shell: false }).status === 0;

describe.skipIf(!hasPs || !existsSync(systemCurl))(
  'wget curl fallback (real PowerShell, local fixture)',
  { timeout: 30000 },
  () => {
    let dir: string;
    let session: FauxnixSession;
    let server: Server;
    let port: number;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'fauxnix-wget-'));
      copyFileSync(systemCurl, join(dir, 'curl.exe'));

      server = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('local wget fixture\n');
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '0.0.0.0', () => resolve());
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('fixture server has no TCP port');
      port = address.port;

      session = new FauxnixSession();
      await run(`cd '${dir.replaceAll("'", "'\\''")}'`);
      // An isolated PATH makes the branch choice deterministic: curl.exe is
      // available, while a separately installed wget.exe cannot intercept it.
      await run(`export PATH='${dir.replaceAll("'", "'\\''")}'`);
    }, 60000);

    afterAll(async () => {
      if (session) await session.dispose();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    async function run(command: string) {
      return session.run(translateCommandList(parseCommand(command)));
    }

    it('writes the response to the decoded final basename, not the URL path', async () => {
      const localHost = hostname();
      const result = await run(
        `wget -q 'http://${localHost}:${port}/nested/report%20one.txt?download=1#part'`,
      );

      expect(result.exitCode).toBe(0);
      const output = join(dir, 'report one.txt');
      expect(existsSync(output)).toBe(true);
      expect(readFileSync(output, 'utf8')).toBe('local wget fixture\n');
      expect(existsSync(join(dir, 'nested'))).toBe(false);
    });
  },
);
