import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const prereleaseIdentifier = String.raw`(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)`;
const semverPattern = new RegExp(
  String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)` +
    String.raw`(?:-${prereleaseIdentifier}(?:\.${prereleaseIdentifier})*)?` +
    String.raw`(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
);

function readJson(path, label, problems) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function runGit(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      `git ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}` +
        `${detail ? `: ${detail}` : ''}`,
    );
  }

  return result.stdout.trim();
}

export function checkRelease(root = packageRoot, { requireTag = false } = {}) {
  const problems = [];
  const metadata = readJson(resolve(root, 'package.json'), 'package.json', problems);
  const lock = readJson(resolve(root, 'package-lock.json'), 'package-lock.json', problems);
  const version = metadata?.version;

  if (typeof version !== 'string' || !semverPattern.test(version)) {
    problems.push(`package.json version must be valid SemVer (found ${JSON.stringify(version)})`);
  }

  if (lock && version) {
    if (lock.version !== version) {
      problems.push(
        `package-lock.json version ${JSON.stringify(lock.version)} does not match package.json ${version}`,
      );
    }
    if (lock.packages?.['']?.version !== version) {
      problems.push(
        `package-lock.json root package version ${JSON.stringify(lock.packages?.['']?.version)} ` +
          `does not match package.json ${version}`,
      );
    }
  }

  try {
    const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
    const firstHeading = changelog.split(/\r?\n/).find((line) => line.startsWith('## '));
    const firstEntry = firstHeading?.match(/^## v([^\s]+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (!firstEntry) {
      problems.push('CHANGELOG.md must start with a "## vX.Y.Z — YYYY-MM-DD" release entry');
    } else if (version && firstEntry[1] !== version) {
      problems.push(
        `first CHANGELOG.md release is v${firstEntry[1]}, but package.json is ${version}`,
      );
    }
  } catch (error) {
    problems.push(`CHANGELOG.md could not be read: ${error.message}`);
  }

  if (requireTag && typeof version === 'string' && semverPattern.test(version)) {
    try {
      const dirty = runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
      if (dirty) {
        problems.push('release worktree is not clean');
      }

      const head = runGit(root, ['rev-parse', 'HEAD']);
      const expectedTag = `v${version}`;
      let tagCommit = null;
      try {
        tagCommit = runGit(root, ['rev-parse', `${expectedTag}^{commit}`]);
      } catch {
        problems.push(`required release tag ${expectedTag} does not exist`);
      }

      if (tagCommit && tagCommit !== head) {
        problems.push(`release tag ${expectedTag} does not point at HEAD ${head}`);
      }

      const tagsAtHead = [];
      const releaseTags = runGit(root, ['tag', '--list', 'v*'])
        .split(/\r?\n/)
        .filter((tag) => semverPattern.test(tag.slice(1)));
      for (const tag of releaseTags) {
        if (runGit(root, ['rev-parse', `${tag}^{commit}`]) === head) tagsAtHead.push(tag);
      }
      if (tagsAtHead.length !== 1 || tagsAtHead[0] !== expectedTag) {
        problems.push(
          `HEAD must have exactly one SemVer release tag (${expectedTag}); found ` +
            (tagsAtHead.length ? tagsAtHead.join(', ') : 'none'),
        );
      }
    } catch (error) {
      problems.push(`strict tag check failed: ${error.message}`);
    }
  }

  return { problems, version };
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--require-tag');
  if (unknown.length) {
    console.error(`release-check: unknown argument(s): ${unknown.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  const requireTag = args.includes('--require-tag');
  const { problems, version } = checkRelease(packageRoot, { requireTag });
  if (problems.length) {
    for (const problem of problems) console.error(`release-check: ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `release check passed: fauxnix-cli v${version} ` +
      (requireTag ? '(metadata, changelog, clean tagged commit)' : '(metadata and changelog)'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
