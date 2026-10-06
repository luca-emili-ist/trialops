// TrialOps dev database runner: embedded PostgreSQL, ordered migrations, seed, tests.
// Usage: node scripts/db.mjs up|reset|seed|test
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.TRIALOPS_PGDATA || join(root, '.pgdata');
const port = Number(process.env.TRIALOPS_PGPORT || 54329);
const cmd = process.argv[2] || 'up';

const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {} });

async function start() {
  if (cmd === 'reset' && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await server.initialise();
  await server.start();
  const admin = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'postgres' });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = 'trialops'");
  if (!exists.rowCount) await admin.query('create database trialops');
  await admin.end();
}

export function connString() { return `postgres://postgres:postgres@localhost:${port}/trialops`; }

async function migrate() {
  const c = new pg.Client({ connectionString: connString() });
  await c.connect();
  await c.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz default now())');
  const done = new Set((await c.query('select name from public.schema_migrations')).rows.map(r => r.name));
  const files = readdirSync(join(root, 'db/migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(root, 'db/migrations', f), 'utf8');
    try {
      await c.query('begin'); await c.query(sql);
      await c.query('insert into public.schema_migrations(name) values ($1)', [f]); await c.query('commit');
      console.log('applied', f);
    } catch (e) { await c.query('rollback'); console.error('FAILED', f, e.message, e.where || ''); process.exitCode = 1; break; }
  }
  await c.end();
}

try {
  await start();
  await migrate();
  if (process.exitCode) throw new Error('migration failed');
  if (cmd === 'seed' || cmd === 'reset') {
    const r = spawnSync(process.execPath, [join(root, 'db/seed/seed-demo.mjs')], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connString() } });
    if (r.status) process.exitCode = r.status;
  }
  if (cmd === 'test') {
    const files = readdirSync(join(root, 'db/tests')).filter(f => f.endsWith('.test.mjs')).map(f => join(root, 'db/tests', f));
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=junit', `--test-reporter-destination=${join(root, 'test-results.xml')}`, ...files],
      { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connString() } });
    if (r.status) process.exitCode = r.status;
  }
} finally {
  await server.stop();
}
