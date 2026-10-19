// VAL-02: no direct change in test or production. Promotion only through .github/workflows/promote.yml (release tag on
// main, CI green, approval of the GitHub environment) and an installation qualification after every deploy
// (scripts/iq-check.mjs). The IQ checks are exercised here against the local database and a simulated Netlify API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { db } from './_helpers.mjs';
import { checkAnonymous, checkNetlifyDeploy, checkDatabase, summarise, runIq, repoMigrations } from '../../scripts/iq-check.mjs';
import { checkRelease } from '../../scripts/release-check.mjs';

const root = new URL('../../', import.meta.url).pathname;
const read = p => readFileSync(join(root, p), 'utf8');
let c; const tmp = [];
before(async () => { c = await db(); });
after(async () => { await c.end(); for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'trialops-val02-')); tmp.push(d); return d; };
const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('[VAL-02] the promote workflow is the only deploy path: tag on main, CI green, environment approval, then deploy and IQ', () => {
  const wf = read('.github/workflows/promote.yml');
  assert.match(wf, /^on:\n {2}workflow_dispatch:/m, 'started by hand only, never on push');
  assert.match(wf, /options: \[test, production\]/);
  assert.match(wf, /node scripts\/release-check\.mjs --tag "\$TAG" --main origin\/main/, 'only a release tag on main');
  assert.match(wf, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$SHA&status=success/, 'only a commit with a green CI run');
  assert.match(wf, /environment:\n\s+name: \$\{\{ inputs\.environment \}\}/, 'deploy job bound to the GitHub environment (required reviewers)');
  const deploy = wf.indexOf('netlify-cli@'); const iq = wf.indexOf('node scripts/iq-check.mjs');
  assert.ok(deploy > wf.indexOf('environment:\n') && iq > deploy, 'IQ runs after the deploy, inside the approved job');
  assert.match(wf, /--require web,deploy,db/, 'every IQ group is required');
  assert.match(wf, /gh release upload/, 'the release record is attached to the release');
  for (const line of wf.split('\n').filter(l => l.includes('${{ inputs.'))) {
    assert.match(line, /^\s*-?\s*(ref|name|group|[A-Z_]+):/, `inputs reach shell steps only through env: ${line.trim()}`);
  }
  // no other workflow and no npm script deploys
  for (const f of readdirSync(join(root, '.github/workflows')).filter(x => x !== 'promote.yml')) {
    assert.doesNotMatch(read(`.github/workflows/${f}`), /netlify(-cli)?[@\s][^\n]*deploy|netlify deploy/, `${f} must not deploy`);
  }
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.deepEqual(Object.entries(scripts).filter(([k, v]) => /deploy/.test(k) || /netlify\s+deploy/.test(v)), [], 'no deploy script');
});

test('[VAL-02] a release can be promoted only from a vX.Y.Z tag on main, checked out exactly', () => {
  const repo = tempDir();
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.org'); g('config', 'user.name', 'T'); g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), '1'); g('add', '.'); g('commit', '-q', '-m', 'one'); g('tag', 'v1.0.0');
  assert.deepEqual(checkRelease({ repo, tag: 'v1.0.0', main: 'main' }).errors, []);
  assert.match(checkRelease({ repo, tag: 'release-1', main: 'main' }).errors.join(), /not a release tag/);
  g('checkout', '-q', '-b', 'feature'); writeFileSync(join(repo, 'a.txt'), '2'); g('commit', '-q', '-am', 'two'); g('tag', 'v1.1.0');
  assert.match(checkRelease({ repo, tag: 'v1.1.0', main: 'main' }).errors.join(), /not on main/, 'unmerged code is never promoted');
  assert.match(checkRelease({ repo, tag: 'v1.0.0', main: 'main' }).errors.join(), /is not the tag/, 'what is built is what was tagged');
  writeFileSync(join(repo, 'a.txt'), '3');
  assert.match(checkRelease({ repo, tag: 'v1.1.0', main: 'feature' }).errors.join(), /local changes/);
});

test('[VAL-02] IQ: anonymous requests must get 401 from the site and the API', async () => {
  const ok = await checkAnonymous('https://trialops.example', async () => json(401, {}));
  assert.deepEqual(ok.map(x => [x.id, x.ok]), [['web.anonymous_401', true], ['api.anonymous_401', true]]);
  const open = await checkAnonymous('https://trialops.example', async u => json(u.endsWith('/v1/platforms') ? 401 : 200, {}));
  assert.equal(open.find(x => x.id === 'web.anonymous_401').ok, false, 'a public page fails the IQ');
  const down = await checkAnonymous('https://trialops.example', async () => { throw new Error('ECONNREFUSED'); });
  assert.ok(down.every(x => !x.ok));
});

test('[VAL-02] IQ: the published deploy carries the released commit and serves exactly the local build', async () => {
  const dist = tempDir();
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<html></html>');
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
  const sha1 = s => createHash('sha1').update(s).digest('hex');
  const files = [{ id: '/index.html', sha: sha1('<html></html>') }, { id: '/assets/app.js', sha: sha1('console.log(1)') }];
  const COMMIT = 'a'.repeat(40);
  const api = (over = {}) => async url => {
    const u = new URL(url);
    if (u.pathname === '/api/v1/sites/site-1') return json(200, { published_deploy: { id: over.published ?? 'dep-1' } });
    if (u.pathname === '/api/v1/deploys/dep-1') return json(200, { state: over.state ?? 'ready', title: `trialops v1.2.0 ${over.commit ?? COMMIT}` });
    if (u.pathname === '/api/v1/deploys/dep-1/files') return json(200, u.searchParams.get('page') === '1' ? (over.files ?? files) : []);
    return json(404, {});
  };
  const run = over => checkNetlifyDeploy({ siteId: 'site-1', deployId: 'dep-1', commit: COMMIT, token: 't', distDir: dist, fetchImpl: api(over) });
  assert.deepEqual((await run()).map(x => [x.id, x.ok]), [['deploy.published', true], ['deploy.commit', true], ['deploy.files', true]]);
  assert.equal((await run({ published: 'dep-0' })).find(x => x.id === 'deploy.published').ok, false, 'not the published deploy');
  assert.equal((await run({ state: 'error' })).find(x => x.id === 'deploy.published').ok, false);
  assert.equal((await run({ commit: 'b'.repeat(40) })).find(x => x.id === 'deploy.commit').ok, false, 'another commit');
  assert.equal((await run({ files: [files[0], { id: '/assets/app.js', sha: sha1('tampered') }] })).find(x => x.id === 'deploy.files').ok, false, 'a changed file');
  assert.equal((await run({ files: [...files, { id: '/debug.html', sha: sha1('x') }] })).find(x => x.id === 'deploy.files').ok, false, 'a file not in the build');
});

test('[VAL-02] IQ: the database migration level equals the repository, the audit chain is intact, DDL audit is on', async () => {
  const checks = await checkDatabase(c, root);
  assert.deepEqual(checks.map(x => [x.id, x.ok]), [['db.migrations', true], ['db.audit_chain', true], ['db.ddl_audit', true]], JSON.stringify(checks));
  assert.equal(checks[0].last, repoMigrations(root).at(-1));
  // a repository with a migration the database does not have (or the reverse) fails
  const repo = tempDir();
  mkdirSync(join(repo, 'db/migrations'), { recursive: true });
  for (const f of [...repoMigrations(root), '9999_not_applied.sql']) writeFileSync(join(repo, 'db/migrations', f), '');
  const drift = (await checkDatabase(c, repo))[0];
  assert.equal(drift.ok, false);
  assert.match(drift.detail, /not applied: 9999_not_applied\.sql/);
});

test('[VAL-02] IQ result: PASS only when every required group ran and passed; the evidence names the release and approvers', async () => {
  assert.equal(summarise([{ id: 'web.anonymous_401', ok: true }, { id: 'deploy.files', ok: true }, { id: 'db.migrations', ok: true }]).result, 'PASS');
  assert.deepEqual(summarise([{ id: 'web.anonymous_401', ok: true }]).not_run, ['deploy', 'db']);
  assert.equal(summarise([{ id: 'web.anonymous_401', ok: true }, { id: 'deploy.files', ok: false }, { id: 'db.migrations', ok: true }]).result, 'FAIL');
  // no credentials: nothing silently passes
  const e = await runIq({ url: 'https://trialops.example', environment: 'test', tag: 'v1.0.0', commit: 'c'.repeat(40), approvers: 'qa-lead, luca',
    require: ['web', 'deploy', 'db'] }, {}, async () => json(401, {}));
  assert.equal(e.result, 'FAIL');
  assert.deepEqual(e.not_run, ['deploy', 'db']);
  assert.deepEqual([e.requirement, e.environment, e.release.tag, e.release.approvers], ['VAL-02', 'test', 'v1.0.0', ['qa-lead', 'luca']]);
  assert.match(e.started_at, /Z$/, 'UTC');
  const full = await runIq({ url: 'https://trialops.example', environment: 'test', require: ['web', 'db'] },
    { IQ_DATABASE_URL: process.env.DATABASE_URL }, async () => json(401, {}));
  assert.equal(full.result, 'PASS', JSON.stringify(full.checks));
});
