import { readFileSync } from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

// The SEA launcher bundle has no package.json next to its executable; the
// launcher build injects the version as a banner global instead.
const bundled = (globalThis as Record<string, unknown>).__FAUXNIX_VERSION__;
let version: unknown = bundled;
if (typeof version !== 'string') {
  // src/ and dist/ are both one level below the package root, so package.json is
  // the runtime source of truth in development and in the published tarball.
  const metadata = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageMetadata;
  version = metadata.version;
}

if (typeof version !== 'string' || version.length === 0) {
  throw new Error('fauxnix: package.json does not contain a valid version');
}

export const packageVersion: string = version;
