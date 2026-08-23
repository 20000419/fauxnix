import { readFileSync } from 'node:fs';

interface PackageMetadata {
  version?: unknown;
}

// src/ and dist/ are both one level below the package root, so package.json is
// the runtime source of truth in development and in the published tarball.
const metadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

if (typeof metadata.version !== 'string' || metadata.version.length === 0) {
  throw new Error('fauxnix: package.json does not contain a valid version');
}

export const packageVersion = metadata.version;
