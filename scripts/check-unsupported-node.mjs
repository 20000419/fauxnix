import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const major = Number(process.versions.node.split('.')[0]);
assert.ok(major === 18 || major === 20, 'run this negative gate under Node 18 or 20');
const cli = spawnSync(process.execPath, ['dist/index.js', '--version'], { cwd: root, encoding: 'utf8' });
assert.ifError(cli.error);
assert.equal(cli.status, 1);
assert.equal(cli.stdout, '');
assert.match(cli.stderr, /Node\.js >=22\.20\.0 is required; found v(?:18|20)\./);

// The supported-version build already exists. Ignore lifecycle scripts so an
// unrelated build failure cannot masquerade as engine-policy enforcement.
const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['ci', '--engine-strict', '--ignore-scripts', '--no-audit', '--no-fund'],
  { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
assert.ifError(install.error);
assert.notEqual(install.status, 0);
assert.match(install.stderr, /EBADENGINE/);
assert.match(install.stderr, /fauxnix-cli/);
console.log(`unsupported Node ${process.versions.node}: CLI and engine-strict install correctly rejected`);
