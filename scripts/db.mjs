// TrialOps dev database runner: embedded PostgreSQL, ordered migrations, seed, tests.
// Usage: node scripts/db.mjs up|reset|seed|test
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { testFiles } from './test-files.mjs';
import { createConnection } from 'node:net';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.TRIALOPS_PGDATA || join(root, '.pgdata');
const port = Number(process.env.TRIALOPS_PGPORT || 54329);
const cmd = process.argv[2] || 'up';

const server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'postgres', port, persistent: true, onLog: () => {} });

/** A running instance (e.g. npm run dev:api) owns the data directory: refuse instead of silently running no tests. */
const portInUse = () => new Promise(resolve => {
  const s = createConnection({ port, host: '127.0.0.1' });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
});

async function start() {
  if (await portInUse()) {
    console.error(`PostgreSQL is already running on port ${port} (is "npm run dev:api" running?). Stop it, or use another ` +
      'TRIALOPS_PGPORT and TRIALOPS_PGDATA for this command.');
    process.exit(1);
  }
  if (cmd === 'reset' && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
  if (!existsSync(join(dataDir, 'PG_VERSION'))) await server.initialise();
  await server.start();
  const admin = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'postgres' });
  await admin.connect();
  const exists = await admin.query("select 1 from pg_database where datname = 'trialops'");
  if (!exists.rowCount) await admin.query('create database trialops');
  await admin.end();
}

/**
 * Runs a child node process and resolves with its exit code. Never spawnSync here: a blocked event loop stops draining
 * the stdout/stderr pipes of the embedded Postgres; once the pipe buffer is full, the next server log line (e.g. the
 * checkpoint lines written by every CREATE/DROP DATABASE of the API tests) blocks that Postgres process for good.
 * That is what made `npm run verify` hang in CI from 2026-10-10.
 */
function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, DATABASE_URL: connString() } });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

export function connString() { return `postgres://postgres:postgres@localhost:${port}/trialops`; }

async function migrate() {
  const c = new pg.Client({ connectionString: connString() });
  await c.connect();
  await c.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz default now())');
  await c.query('alter table public.schema_migrations enable row level security'); // never readable via the API
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
    const status = await runNode([join(root, 'db/seed/seed-demo.mjs')]);
    if (status) process.exitCode = status;
  }
  if (cmd === 'test') {
    const files = testFiles(root);
    // --test-timeout: a test that never ends fails with its name instead of holding the run (CI is capped at 20 min)
    const status = await runNode(['--test', '--test-concurrency=1', '--test-timeout=120000', '--test-reporter=spec',
      '--test-reporter-destination=stdout', '--test-reporter=junit', `--test-reporter-destination=${join(root, 'test-results.xml')}`, ...files]);
    if (status) process.exitCode = status;
  }
} finally {
  await server.stop();
}
