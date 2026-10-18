// VAL-03 / CLAUDE.md rule 4: a migration that reached main is never edited, renamed or removed; new ones are new files
// db/migrations/NNNN_name.sql with a unique number.
// Usage: node scripts/migration-check.mjs [--base <ref>] [--repo <dir>]
//   The reference is the merge-base of <ref> (default origin/main, else main) and HEAD: every migration file present there
//   must be byte-identical in the working tree. On a push to main, CI passes the previous main commit as --base.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = 'db/migrations';
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * base, head: Map file name -> content. Returns the list of violations (empty = ok).
 * A file of base must exist in head with the same content; head names must be well formed with unique numbers.
 */
export function checkMigrations(base, head) {
  const errors = [];
  for (const [name, content] of base) {
    if (!head.has(name)) errors.push(`${name}: removed or renamed after it reached main`);
    else if (head.get(name) !== content) errors.push(`${name}: modified after it reached main (write a new migration instead)`);
  }
  const byNumber = new Map();
  for (const name of head.keys()) {
    const m = NAME.exec(name);
    if (!m) { errors.push(`${name}: name must be NNNN_lowercase_name.sql`); continue; }
    if (byNumber.has(m[1])) errors.push(`${name}: number ${m[1]} already used by ${byNumber.get(m[1])}`);
    else byNumber.set(m[1], name);
  }
  return errors;
}

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
const refExists = (repo, ref) => { try { git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; } };

/** Migration files at a commit. */
export function migrationsAt(repo, ref) {
  const out = new Map();
  const list = git(repo, ['ls-tree', '--name-only', `${ref}:${MIGRATIONS_DIR}`]).split('\n').filter(f => f.endsWith('.sql'));
  for (const f of list) out.set(f, git(repo, ['show', `${ref}:${MIGRATIONS_DIR}/${f}`]));
  return out;
}

/** Migration files in the working tree (uncommitted edits are checked too). */
export function migrationsInTree(repo) {
  const dir = join(repo, MIGRATIONS_DIR);
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter(x => x.endsWith('.sql'))) out.set(f, readFileSync(join(dir, f), 'utf8'));
  return out;
}

export function run({ repo, base }) {
  const candidates = base && !/^0+$/.test(base) ? [base] : ['origin/main', 'main'];
  const ref = candidates.find(r => refExists(repo, r));
  if (!ref) return { ok: false, errors: [`cannot find the base ref (${candidates.join(', ')}): fetch the full history (fetch-depth: 0)`] };
  const mergeBase = git(repo, ['merge-base', ref, 'HEAD']).trim();
  const errors = checkMigrations(migrationsAt(repo, mergeBase), migrationsInTree(repo));
  return { ok: errors.length === 0, errors, ref, mergeBase };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const repo = resolve(arg('--repo') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const r = run({ repo, base: arg('--base') || process.env.TRIALOPS_MIGRATION_BASE });
  if (r.ok) console.log(`migrations: unchanged since ${r.ref} (${r.mergeBase.slice(0, 7)}), names and numbers ok`);
  else { console.error('migrations: rule 4 violated (VAL-03)'); for (const e of r.errors) console.error('  ' + e); process.exitCode = 1; }
}
