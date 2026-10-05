import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLauncher } from '../src/facade-launch.js';

const onWindows = process.platform === 'win32';
const bundle = join(process.cwd(), 'dist', 'facade-sea.cjs');
// Full launcher E2E (esbuild->SEA->postject->spawn) is opt-in like the
// differential oracle: an 85 MB node copy plus injection is heavy for the
// parallel suite. CI enables it; local runs skip unless requested.
const enabled = !!process.env.FAUXNIX_FACADE_E2E;

describe.skipIf(!onWindows || !enabled || !existsSync(bundle))(
  'facade bash.exe launcher E2E (RFC #224, opt-in)',
  { timeout: 300_000 },
  () => {
    it('built bash.exe executes the bash argv contract', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fx-launch-'));
      try {
        const exe = await buildLauncher({ FAUXNIX_FACADE_DIR: dir });
        const r = spawnSync(exe, ['-c', "printf 'launch-e2e\\n'; cd src && pwd"], {
          encoding: 'utf8',
          timeout: 60_000,
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('launch-e2e');
        expect(r.stdout).toMatch(/\/[a-z]\/.*\n$/);
        const v = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 60_000 });
        expect(v.status).toBe(0);
        expect(v.stdout).toMatch(/\(fauxnix facade [\d.]+\)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
