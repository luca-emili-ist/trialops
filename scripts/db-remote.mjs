// Applies migrations (db/migrations, then db/supabase) and optionally the synthetic seed to a remote database, e.g. the
// Supabase project. DATABASE_URL must be given by the caller (never stored in the repo). Synthetic data only (DM-05).
// Usage: DATABASE_URL=... node scripts/db-remote.mjs status|migrate|seed
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { supabaseSsl } from './pg-ssl.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] || 'status';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: supabaseSsl });
await c.connect();
await c.query('create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz default now())');
await c.query('alter table public.schema_migrations enable row level security'); // never readable via the API
const done = new Set((await c.query('select name from public.schema_migrations')).rows.map(r => r.name));
const files = [
  ...readdirSync(join(root, 'db/migrations')).filter(f => f.endsWith('.sql')).sort().map(f => ['db/migrations', f]),
  ...readdirSync(join(root, 'db/supabase')).filter(f => f.endsWith('.sql')).sort().map(f => ['db/supabase', f]),
];
const key = ([dir, f]) => (dir === 'db/supabase' ? `supabase/${f}` : f);
const pending = files.filter(x => !done.has(key(x)));
console.log(`applied ${done.size}, pending ${pending.length}${pending.length ? ': ' + pending.map(key).join(', ') : ''}`);
if (cmd === 'migrate' || cmd === 'seed') {
  for (const x of pending) {
    try {
      await c.query('begin'); await c.query(readFileSync(join(root, ...x), 'utf8'));
      await c.query('insert into public.schema_migrations(name) values ($1)', [key(x)]); await c.query('commit');
      console.log('applied', key(x));
    } catch (e) { await c.query('rollback'); console.error('FAILED', key(x), e.message); process.exit(1); }
  }
}
await c.end();
if (cmd === 'seed') {
  const r = spawnSync(process.execPath, [join(root, 'db/seed/seed-demo.mjs')], { stdio: 'inherit', env: { ...process.env, PGSSLMODE: 'no-verify' } });
  process.exit(r.status ?? 1);
}
