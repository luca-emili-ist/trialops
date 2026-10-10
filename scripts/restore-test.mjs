// Backup / restore test (NFR-04; Annex 11 §7, EMA 2023 backup and restore, JP ERES preservation).
// Dumps the source database, restores it into a fresh database, proves the copy is complete and untampered
// (same row counts, same last audit hash, core.audit_verify() clean on both) and writes the evidence file
// docs/compliance/evidence/restore-test-<UTC timestamp>.json. Procedure and schedule: docs/compliance/BACKUP_RESTORE.md.
//
// Usage: node scripts/restore-test.mjs --source <postgres url> --target-server <postgres url of a server to restore into>
//        [--schemas core,sac_enclave] [--keep]
// Defaults: source = local dev database, target server = the same local server. Needs pg_dump/pg_restore >= server.
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const port = Number(process.env.TRIALOPS_PGPORT || 54329);
const source = arg('source') || process.env.DATABASE_URL || `postgres://postgres:postgres@localhost:${port}/trialops`;
const targetServer = new URL(arg('target-server') || `postgres://postgres:postgres@localhost:${port}/postgres`);
const schemas = (arg('schemas') || '').split(',').filter(Boolean);
const keep = process.argv.includes('--keep');
const masked = u => { const x = new URL(u); x.password = x.password ? '***' : ''; return x.toString(); };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.error}`);
  return r.stdout;
}

async function snapshot(url) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const tables = (await c.query(`select n.nspname || '.' || cl.relname t from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
      where cl.relkind in ('r','p') and n.nspname in ('core','sac_enclave') order by 1`)).rows.map(r => r.t);
    const counts = {};
    for (const t of tables) counts[t] = Number((await c.query(`select count(*) n from ${t}`)).rows[0].n);
    const last = (await c.query('select seq, hash from core.audit_event order by seq desc limit 1')).rows[0] ?? null;
    const broken = (await c.query('select core.audit_verify() b')).rows[0].b;
    const migrations = (await c.query("select count(*) n, max(name) last from public.schema_migrations").catch(() => ({ rows: [{}] }))).rows[0];
    return { counts, last_audit: last && { seq: Number(last.seq), hash: last.hash }, audit_verify_broken_seq: broken, migrations };
  } finally { await c.end(); }
}

const started = new Date();
const work = mkdtempSync(join(tmpdir(), 'trialops-restore-'));
const dumpFile = join(work, 'backup.dump');
const restoreDb = `trialops_restore_${started.toISOString().replace(/\D/g, '').slice(0, 14)}`;
const evidence = { requirement: 'NFR-04', procedure: 'docs/compliance/BACKUP_RESTORE.md', started_at: started.toISOString(),
  source: masked(source), target: masked(new URL(`/${restoreDb}`, targetServer).toString()), pg_dump: run('pg_dump', ['--version']).trim() };
let ok = false;
try {
  const before = await snapshot(source);
  const t0 = Date.now();
  run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', ...schemas.flatMap(s => ['--schema', s]), '--file', dumpFile, source]);
  evidence.backup = { sha256: createHash('sha256').update(readFileSync(dumpFile)).digest('hex'), bytes: readFileSync(dumpFile).length,
    seconds: (Date.now() - t0) / 1000 };
  const admin = new pg.Client({ connectionString: targetServer.toString() });
  await admin.connect(); await admin.query(`create database ${restoreDb}`); await admin.end();
  const target = new URL(`/${restoreDb}`, targetServer).toString();
  const t1 = Date.now();
  run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', target, dumpFile]);
  evidence.restore = { seconds: (Date.now() - t1) / 1000 };
  const after = await snapshot(target);
  const diff = Object.keys(before.counts).filter(t => before.counts[t] !== after.counts[t]);
  evidence.checks = {
    row_counts_equal: diff.length === 0, differing_tables: diff,
    last_audit_hash_equal: JSON.stringify(before.last_audit) === JSON.stringify(after.last_audit),
    audit_chain_clean_source: before.audit_verify_broken_seq === null,
    audit_chain_clean_restored: after.audit_verify_broken_seq === null,
  };
  evidence.source_snapshot = before; evidence.tables = Object.keys(before.counts).length;
  ok = Object.values(evidence.checks).every(v => v === true || (Array.isArray(v) && v.length === 0));
  if (!keep) {
    const a = new pg.Client({ connectionString: targetServer.toString() });
    await a.connect(); await a.query(`drop database ${restoreDb} with (force)`); await a.end();
  }
} catch (e) {
  evidence.error = String(e.message || e);
} finally {
  rmSync(work, { recursive: true, force: true });
}
evidence.finished_at = new Date().toISOString();
evidence.result = ok ? 'PASS' : 'FAIL';
mkdirSync(join(root, 'docs/compliance/evidence'), { recursive: true });
const out = join(root, 'docs/compliance/evidence', `restore-test-${evidence.started_at.replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(evidence, null, 1) + '\n');
console.log(`restore test ${evidence.result}: ${out}${evidence.error ? ` (${evidence.error})` : ''}`);
if (!ok) process.exitCode = 1;
