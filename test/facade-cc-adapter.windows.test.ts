import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const onWindows = process.platform === 'win32';

// Replays of the REAL Claude Code scaffolding captured 2026-10-05 with
// FAUXNIX_FACADE_TRACE (see docs/rfc-bash-facade.md). The harness wraps every
// Bash tool call in this plumbing; the facade adapter must execute the payload,
// honor the export prefix, and write the cwd marker exactly like bash's && chain.
function facade(args: string[]) {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return spawnSync(process.execPath, [tsx, 'src/index.ts', 'facade', ...args], {
    encoding: 'utf8',
    timeout: 90_000,
  });
}

describe.skipIf(!onWindows)('facade Claude Code adapter (RFC #224)', { timeout: 180_000 }, () => {
  it('executes the payload of the captured command wrapper and writes the POSIX cwd marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-ccwrap-'));
    const markerWin = join(dir, 'claude-test-cwd');
    const markerPosix = '/' + markerWin.slice(0, 1).toLowerCase() + markerWin.slice(2).replaceAll('\\', '/');
    try {
      const wrapper =
        `source ${markerPosix}-snap.sh 2>/dev/null || true && ` +
        `export TEMP='${tmpdir()}' TMP='${tmpdir()}' && ` +
        `shopt -u extglob 2>/dev/null || true && ` +
        `{ \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && ` +
        `eval 'echo adapter-e2e; cd src' < /dev/null && pwd -P >| ${markerPosix}`;
      // -lc exercises combined-flag parsing on the same call as the wrapper
      const r = facade(['-lc', wrapper]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('adapter-e2e');
      expect(existsSync(markerWin)).toBe(true);
      expect(readFileSync(markerWin, 'utf8')).toMatch(/^\/[a-z]\/.*\n$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates payload failure without writing the cwd marker (bash && semantics)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-ccfail-'));
    const markerWin = join(dir, 'claude-test-cwd');
    const markerPosix = '/' + markerWin.slice(0, 1).toLowerCase() + markerWin.slice(2).replaceAll('\\', '/');
    try {
      const wrapper =
        `export TEMP='${tmpdir()}' && shopt -u extglob 2>/dev/null || true && ` +
        `{ \\builtin unalias -- 'unsetenv'; } >/dev/null 2>&1 || true && ` +
        `eval 'exit 3' < /dev/null && pwd -P >| ${markerPosix}`;
      const r = facade(['-c', '-l', wrapper]);
      expect(r.status).toBe(3);
      expect(existsSync(markerWin)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers the shell-snapshot bootstrap with a valid stub snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fx-ccsnap-'));
    const snap = join(dir, 'snapshot-bash-test.sh');
    try {
      const script =
        `SNAPSHOT_FILE='${snap}'\n` +
        `echo "# Snapshot file" >| "$SNAPSHOT_FILE"\n` +
        `cat >> "$SNAPSHOT_FILE" << 'RIPGREP_FUNC_END'\nfunction rg { x }\nRIPGREP_FUNC_END`;
      const r = facade(['-c', '-l', script]);
      expect(r.status).toBe(0);
      const stub = readFileSync(snap, 'utf8');
      expect(stub).toContain('# Snapshot file');
      expect(stub).toContain('fauxnix facade');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
