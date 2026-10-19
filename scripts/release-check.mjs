// Promotion gate (VAL-02): only a release tag vX.Y.Z on a commit that is already on main can be promoted, and the commit
// being built must be exactly that tag. Used by .github/workflows/promote.yml before anything is built or deployed.
// Usage: node scripts/release-check.mjs --tag vX.Y.Z [--main origin/main] [--repo <dir>]
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

/** Returns { ok, errors, commit } for the tag in repo. */
export function checkRelease({ repo, tag, main = 'origin/main' }) {
  const errors = [];
  if (!TAG.test(tag ?? '')) errors.push(`tag "${tag}" is not a release tag vMAJOR.MINOR.PATCH`);
  const commit = tag ? tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]) : null;
  if (!commit) errors.push(`tag ${tag} not found`);
  const head = tryGit(repo, ['rev-parse', 'HEAD']);
  if (commit && head !== commit) errors.push(`the checked-out commit ${head?.slice(0, 7)} is not the tag ${tag} (${commit.slice(0, 7)})`);
  const mainCommit = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${main}^{commit}`]);
  if (!mainCommit) errors.push(`${main} not found (fetch the full history)`);
  else if (commit && tryGit(repo, ['merge-base', '--is-ancestor', commit, mainCommit]) === null) {
    errors.push(`${tag} is not on ${main}: only merged, reviewed code is promoted`);
  }
  if (tryGit(repo, ['status', '--porcelain', '--untracked-files=no'])) errors.push('the working tree has local changes');
  return { ok: errors.length === 0, errors, commit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const repo = resolve(arg('repo') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const r = checkRelease({ repo, tag: arg('tag'), main: arg('main') ?? 'origin/main' });
  if (r.ok) console.log(`release ${arg('tag')} = ${r.commit} is on ${arg('main') ?? 'origin/main'}: can be promoted`);
  else { console.error('release check failed (VAL-02):'); for (const e of r.errors) console.error('  ' + e); process.exitCode = 1; }
}
