// Builds dist/facade-sea.cjs: the self-contained facade bundle that the
// bash.exe launcher injects via Node SEA (see src/facade-launch.ts).
// Runs as part of `npm run build`; esbuild stays a devDependency because
// the published package ships the prebuilt bundle.
import { existsSync, readFileSync } from 'node:fs';

if (!existsSync('src/facade-main.ts')) {
  // Packed installs have no source tree and already ship dist/facade-sea.cjs;
  // prepare-time rebuild must not fail there (package-smoke gate).
  process.exit(0);
}

const { build } = await import('esbuild');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const banner =
  `globalThis.__FAUXNIX_VERSION__=${JSON.stringify(pkg.version)};` +
  `globalThis.__FAUXNIX_ENGINES_NODE__=${JSON.stringify(pkg.engines.node)};`;

await build({
  entryPoints: ['src/facade-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/facade-sea.cjs',
  banner: { js: banner },
  sourcemap: false,
  logLevel: 'warning',
});
