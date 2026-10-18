// VAL-03 / rule 4: migrations already on main are never modified (scripts/migration-check.mjs), checked on fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMigrations } from '../../scripts/migration-check.mjs';

const script = new URL('../../scripts/migration-check.mjs', import.meta.url).pathname;
const m = o => new Map(Object.entries(o));

test('[VAL-03] the migration rule: files on main stay byte-identical, names are well formed, numbers unique', () => {
  const base = m({ '0001_a.sql': 'create table a();', '0002_b.sql': 'create table b();' });
  assert.deepEqual(checkMigrations(base, m({ ...Object.fromEntries(base), '0003_c.sql': 'x' })), []);
  assert.match(checkMigrations(base, m({ '0001_a.sql': 'create table a(x int);', '0002_b.sql': 'create table b();' })).join(), /0001_a.sql: modified/);
  assert.match(checkMigrations(base, m({ '0001_a.sql': 'create table a();' })).join(), /0002_b.sql: removed or renamed/);
  assert.match(checkMigrations(new Map(), m({ '0003_c.sql': 'x', '0003_d.sql': 'y' })).join(), /number 0003 already used/);
  assert.match(checkMigrations(new Map(), m({ '3_Bad Name.sql': 'x' })).join(), /name must be/);
});

test('[VAL-03] the CI check fails when a migration that reached main is changed on a branch (git fixture)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'trialops-migcheck-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...a],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const check = (...a) => {
    try { return { code: 0, out: execFileSync(process.execPath, [script, '--repo', repo, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status, out: String(e.stderr) + String(e.stdout) }; }
  };
  try {
    git('init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'db/migrations'), { recursive: true });
    writeFileSync(join(repo, 'db/migrations/0001_first.sql'), 'create table t (id int);\n');
    git('add', '.'); git('commit', '-q', '-m', 'first migration on main');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'db/migrations/0002_second.sql'), 'alter table t add column if not exists v int;\n');
    git('add', '.'); git('commit', '-q', '-m', 'new migration');
    assert.equal(check('--base', 'main').code, 0, 'a new migration file is allowed');

    writeFileSync(join(repo, 'db/migrations/0001_first.sql'), 'create table t (id bigint);\n');
    const edited = check('--base', 'main');
    assert.equal(edited.code, 1, 'an uncommitted edit of a migration on main fails');
    assert.match(edited.out, /0001_first.sql: modified after it reached main/);
    git('commit', '-q', '-am', 'edit the applied migration');
    assert.equal(check('--base', 'main').code, 1, 'a committed edit fails too');
    git('revert', '--no-edit', 'HEAD');
    assert.equal(check('--base', 'main').code, 0, 'restoring the original content passes');

    renameSync(join(repo, 'db/migrations/0001_first.sql'), join(repo, 'db/migrations/0001_renamed.sql'));
    assert.match(check('--base', 'main').out, /0001_first.sql: removed or renamed/);
    assert.match(check('--base', 'no-such-ref').out, /cannot find the base ref/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
