import { delimiter, resolve } from 'node:path';

/**
 * Build an environment for nested npm commands run from npm lifecycle hooks.
 * An outer `npm publish --dry-run` exports npm_config_dry_run; inheriting it
 * would turn package-smoke's real `npm ci` and `npm pack` checks into no-ops.
 */
export function npmChildEnvironment(packageRoot, source = process.env) {
  const environment = { ...source };

  for (const key of Object.keys(environment)) {
    const normalized = key.toLowerCase().replaceAll('-', '_');
    if (normalized === 'npm_config_dry_run' || normalized === 'npm_config_dryrun') {
      delete environment[key];
    }
  }

  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const projectBin = resolve(packageRoot, 'node_modules', '.bin');
  environment[pathKey] = (environment[pathKey] ?? '')
    .split(delimiter)
    .filter((entry) => entry && resolve(entry) !== projectBin)
    .join(delimiter);

  return environment;
}
