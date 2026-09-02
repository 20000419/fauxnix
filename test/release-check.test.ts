import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { npmChildEnvironment } from '../scripts/npm-child-env.mjs';

const checkerSource = fileURLToPath(new URL('../scripts/release-check.mjs', import.meta.url));
let fixture = '';

function git(args: string[]): void {
  const result = spawnSync('git', args, { cwd: fixture, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function runChecker(...args: string[]) {
  return spawnSync(process.execPath, [join(fixture, 'scripts', 'release-check.mjs'), ...args], {
    cwd: fixture,
    encoding: 'utf8',
    shell: false,
  });
}

describe('release-check', () => {
  beforeEach(() => {
    fixture = mkdtempSync(join(tmpdir(), 'fauxnix-release-check-'));
    mkdirSync(join(fixture, 'scripts'));
    copyFileSync(checkerSource, join(fixture, 'scripts', 'release-check.mjs'));
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'fauxnix-cli', version: '1.2.3' }, null, 2),
    );
    writeFileSync(
      join(fixture, 'package-lock.json'),
      JSON.stringify(
        { name: 'fauxnix-cli', version: '1.2.3', lockfileVersion: 3, packages: { '': { version: '1.2.3' } } },
        null,
        2,
      ),
    );
    writeFileSync(join(fixture, 'CHANGELOG.md'), '# Changelog\n\n## v1.2.3 — 2026-09-02\n');
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Release Check']);
    git(['config', 'user.email', 'release-check@example.invalid']);
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'fixture']);
  });

  afterEach(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('accepts matching package, lockfile, and changelog metadata', () => {
    const result = runChecker();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release check passed');
  });

  it('rejects lockfile version drift', () => {
    const lockPath = join(fixture, 'package-lock.json');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    lock.packages[''].version = '1.2.2';
    writeFileSync(lockPath, JSON.stringify(lock, null, 2));

    const result = runChecker();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('root package version "1.2.2" does not match');
  });

  it('rejects a stale changelog heading', () => {
    writeFileSync(join(fixture, 'CHANGELOG.md'), '# Changelog\n\n## v1.2.2 — 2026-09-02\n');
    const result = runChecker();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('first CHANGELOG.md release is v1.2.2');
  });

  it.each(['1.0.0-01', '1.0.0-alpha.01'])('rejects invalid SemVer %s', (version) => {
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: 'fauxnix-cli', version }, null, 2),
    );
    const lock = JSON.parse(readFileSync(join(fixture, 'package-lock.json'), 'utf8'));
    lock.version = version;
    lock.packages[''].version = version;
    writeFileSync(join(fixture, 'package-lock.json'), JSON.stringify(lock, null, 2));
    writeFileSync(join(fixture, 'CHANGELOG.md'), `# Changelog\n\n## v${version} — 2026-09-02\n`);

    const result = runChecker();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('package.json version must be valid SemVer');
  });

  it('does not inherit an outer npm publish dry-run into package-smoke child commands', () => {
    const environment = npmChildEnvironment(fixture, {
      PATH: process.env.PATH,
      npm_config_dry_run: 'true',
      'NPM_CONFIG_DRY-RUN': 'true',
      npm_config_registry: 'https://registry.npmjs.org/',
    });
    expect(environment.npm_config_dry_run).toBeUndefined();
    expect(environment['NPM_CONFIG_DRY-RUN']).toBeUndefined();
    expect(environment.npm_config_registry).toBe('https://registry.npmjs.org/');
  });

  it('requires the matching tag in strict mode', () => {
    const result = runChecker('--require-tag');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required release tag v1.2.3 does not exist');
  });

  it('accepts one matching tag on a clean commit in strict mode', () => {
    git(['tag', '-a', 'v1.2.3', '-m', 'v1.2.3']);
    const result = runChecker('--require-tag');
    expect(result.status).toBe(0);
  });

  it('rejects a dirty release worktree in strict mode', () => {
    git(['tag', 'v1.2.3']);
    writeFileSync(join(fixture, 'untracked.txt'), 'dirty');
    const result = runChecker('--require-tag');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release worktree is not clean');
  });

  it('rejects two release tags pointing at the same commit', () => {
    git(['tag', 'v1.2.2']);
    git(['tag', 'v1.2.3']);
    const result = runChecker('--require-tag');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('found v1.2.2, v1.2.3');
  });
});
