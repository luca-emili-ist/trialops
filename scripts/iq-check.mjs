// Installation qualification after every deploy (VAL-02; Annex 11 §4, EMA 2023 validation, JP CSV life cycle, 21 CFR
// 11.10(a)). Run by .github/workflows/promote.yml right after the deploy; it can also be run by hand on a deployed
// environment. Checks:
//   web.anonymous_401 / api.anonymous_401  the site and the API answer 401 to an anonymous request (Team login / auth on)
//   deploy.published                      the deploy just made is the one the site serves, in state ready
//   deploy.commit                         that deploy carries the released commit (deploy message / commit_ref)
//   deploy.files                          every file of the local build is deployed with the same SHA-1, no extra file
//   db.migrations                         the migrations applied in the database are exactly those of the repository
//   db.audit_chain                        core.iq_audit_verify() (or core.audit_verify() before 0029) finds no broken link
//   db.ddl_audit                          the DDL audit event triggers are active (CMP-12)
// The result is PASS only if every required check ran and passed. The evidence file (JSON) records the release, the
// checks and the result; the workflow uploads it as an artifact and attaches it to the GitHub release.
//
// Usage: node scripts/iq-check.mjs --url https://<site> --environment test|production --commit <sha> [--tag vX.Y.Z]
//          [--deploy-id <id> --site-id <id>] [--dist apps/web/dist] [--approvers a,b] [--run-url <url>]
//          [--require web,deploy,db] [--out <file>]
// Secrets only from the environment, never from arguments: NETLIFY_AUTH_TOKEN (deploy checks), IQ_DATABASE_URL (db checks,
// the role iq_reader of migration 0029: see docs/compliance/RELEASE_PROMOTION.md §2).
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NETLIFY_API = 'https://api.netlify.com/api/v1';
const check = (id, ok, detail, extra = {}) => ({ id, ok: Boolean(ok), detail, ...extra });

/** Anonymous requests must be refused (401) by the site and by the API. */
export async function checkAnonymous(url, fetchImpl = fetch) {
  const out = [];
  for (const [id, path] of [['web.anonymous_401', '/'], ['api.anonymous_401', '/v1/platforms']]) {
    try {
      const r = await fetchImpl(new URL(path, url).toString(), { redirect: 'manual', headers: { accept: 'application/json' } });
      out.push(check(id, r.status === 401, `GET ${path} -> ${r.status}`));
    } catch (e) {
      out.push(check(id, false, `GET ${path} failed: ${e.message}`));
    }
  }
  return out;
}

/** SHA-1 of every file of a build directory, keyed by its served path (/index.html), as Netlify stores them. */
export function localFiles(dir) {
  const out = new Map();
  const walk = d => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.set('/' + relative(dir, p).split(sep).join('/'), createHash('sha1').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

/** The deploy is published, ready, carries the commit and serves exactly the local build. */
export async function checkNetlifyDeploy({ siteId, deployId, commit, token, distDir, fetchImpl = fetch }) {
  const get = async path => {
    const r = await fetchImpl(`${NETLIFY_API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Netlify API ${path} -> ${r.status}`);
    return r.json();
  };
  const out = [];
  try {
    const site = await get(`/sites/${siteId}`);
    const deploy = await get(`/deploys/${deployId}`);
    out.push(check('deploy.published', site.published_deploy?.id === deployId && deploy.state === 'ready',
      `published ${site.published_deploy?.id ?? 'none'}, this deploy ${deployId} in state ${deploy.state}`));
    const carries = deploy.commit_ref === commit || (typeof deploy.title === 'string' && deploy.title.includes(commit));
    out.push(check('deploy.commit', Boolean(commit) && carries, `commit_ref ${deploy.commit_ref ?? '-'}, message "${deploy.title ?? ''}", expected ${commit}`));
    if (distDir) {
      const remote = new Map();
      for (let page = 1; page < 1000; page++) {
        const files = await get(`/deploys/${deployId}/files?page=${page}&per_page=100`);
        for (const f of files) remote.set(f.id ?? f.path, f.sha);
        if (files.length < 100) break;
      }
      const local = localFiles(distDir);
      const missing = [...local].filter(([p, sha]) => remote.get(p) !== sha).map(([p]) => p);
      const extra = [...remote.keys()].filter(p => !local.has(p));
      out.push(check('deploy.files', missing.length === 0 && extra.length === 0,
        `${local.size} local files, ${remote.size} deployed; differing or missing: ${missing.slice(0, 10).join(', ') || 'none'}; not in the build: ${extra.slice(0, 10).join(', ') || 'none'}`,
        { files: local.size }));
    }
  } catch (e) {
    out.push(check('deploy.published', false, e.message));
  }
  return out;
}

/** Migration files of the repository, with the names scripts/db-remote.mjs records in public.schema_migrations. */
export function repoMigrations(repo = root, { includeSupabase = false } = {}) {
  const names = readdirSync(join(repo, 'db/migrations')).filter(f => f.endsWith('.sql')).sort();
  if (includeSupabase && existsSync(join(repo, 'db/supabase'))) {
    names.push(...readdirSync(join(repo, 'db/supabase')).filter(f => f.endsWith('.sql')).sort().map(f => `supabase/${f}`));
  }
  return names;
}

/** Database: migration level equal to the repository, audit chain intact, DDL audit active. */
export async function checkDatabase(client, repo = root) {
  const out = [];
  const applied = (await client.query('select name from public.schema_migrations order by name')).rows.map(r => r.name);
  const expected = repoMigrations(repo, { includeSupabase: applied.some(n => n.startsWith('supabase/')) });
  const missing = expected.filter(n => !applied.includes(n));
  const unknown = applied.filter(n => !expected.includes(n));
  out.push(check('db.migrations', missing.length === 0 && unknown.length === 0,
    `${applied.length} applied, ${expected.length} in the repository; not applied: ${missing.join(', ') || 'none'}; not in the repository: ${unknown.join(', ') || 'none'}`,
    { last: expected.filter(n => !n.startsWith('supabase/')).at(-1) }));
  // IQ_DATABASE_URL is the least-privilege role iq_reader (0029), which cannot read core.audit_event (blinding): it runs
  // the chain verification through the SECURITY DEFINER wrapper core.iq_audit_verify(). A database older than 0029 has
  // no wrapper: fall back to core.audit_verify(), which then needs a role that can read the ledger.
  const fn = (await client.query("select to_regprocedure('core.iq_audit_verify()') is not null w")).rows[0].w ? 'core.iq_audit_verify' : 'core.audit_verify';
  const broken = (await client.query(`select ${fn}() b`)).rows[0].b;
  out.push(check('db.audit_chain', broken === null, `${broken === null ? 'audit chain intact' : `audit chain broken at seq ${broken}`} (${fn})`));
  const ddl = (await client.query('select core.ddl_audit_active() a')).rows[0].a;
  out.push(check('db.ddl_audit', ddl === true, ddl ? 'DDL audit event triggers active' : 'DDL audit event triggers missing or disabled'));
  return out;
}

/** PASS only if every check passed and every required group ran. */
export function summarise(checks, required = ['web', 'deploy', 'db']) {
  const groups = new Set(checks.map(c => (c.id.startsWith('api.') ? 'web' : c.id.split('.')[0])));
  const notRun = required.filter(g => !groups.has(g));
  const failed = checks.filter(c => !c.ok).map(c => c.id);
  return { result: failed.length === 0 && notRun.length === 0 ? 'PASS' : 'FAIL', failed, not_run: notRun };
}

export async function runIq(opts, env = process.env, fetchImpl = fetch) {
  const started = new Date().toISOString();
  const checks = [];
  const skipped = [];
  if (opts.url) checks.push(...await checkAnonymous(opts.url, fetchImpl)); else skipped.push('web (no --url)');
  if (opts.siteId && opts.deployId && env.NETLIFY_AUTH_TOKEN) {
    checks.push(...await checkNetlifyDeploy({ siteId: opts.siteId, deployId: opts.deployId, commit: opts.commit, token: env.NETLIFY_AUTH_TOKEN,
      distDir: opts.dist ? resolve(opts.dist) : undefined, fetchImpl }));
  } else skipped.push('deploy (needs --site-id, --deploy-id and NETLIFY_AUTH_TOKEN)');
  if (env.IQ_DATABASE_URL) {
    const ssl = /supabase\.(co|com)/.test(env.IQ_DATABASE_URL) ? (await import('./pg-ssl.mjs')).supabaseSsl : undefined;
    const c = new pg.Client({ connectionString: env.IQ_DATABASE_URL, ssl });
    await c.connect();
    try { checks.push(...await checkDatabase(c, opts.repo ?? root)); } finally { await c.end(); }
  } else skipped.push('db (needs IQ_DATABASE_URL)');
  const summary = summarise(checks, opts.require);
  return {
    requirement: 'VAL-02', kind: 'installation_qualification', procedure: 'docs/compliance/RELEASE_PROMOTION.md',
    environment: opts.environment ?? null, url: opts.url ?? null,
    release: { tag: opts.tag ?? null, commit: opts.commit ?? null, deploy_id: opts.deployId ?? null,
      approvers: opts.approvers ? String(opts.approvers).split(',').map(s => s.trim()).filter(Boolean) : [], workflow_run: opts.runUrl ?? null },
    started_at: started, finished_at: new Date().toISOString(), checks, skipped, ...summary,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const opts = { url: arg('url'), environment: arg('environment'), commit: arg('commit'), tag: arg('tag'), deployId: arg('deploy-id'), siteId: arg('site-id'),
    dist: arg('dist'), approvers: arg('approvers'), runUrl: arg('run-url'), require: (arg('require') ?? 'web,deploy,db').split(',').filter(Boolean) };
  const evidence = await runIq(opts);
  const out = arg('out') ?? join(root, 'iq-evidence', `iq-${opts.environment ?? 'env'}-${evidence.started_at.replace(/[:.]/g, '-')}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(evidence, null, 1) + '\n');
  for (const c of evidence.checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.id}: ${c.detail}`);
  for (const s of evidence.skipped) console.log(`skip ${s}`);
  console.log(`IQ ${evidence.result} (${opts.environment ?? '-'} ${opts.tag ?? ''} ${opts.commit ?? ''}): ${out}`);
  if (evidence.result !== 'PASS') process.exitCode = 1;
}
