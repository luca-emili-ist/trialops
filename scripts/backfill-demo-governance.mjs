// Backfills the governance demo data of migration 0026 (CMP-05, CMP-08, VAL-04) into a database seeded before 0026,
// e.g. the remote demo: data region of PLAT-001, publisher/data_residency in the manifest of the pending L2 app, and the
// rows of db/seed/seed-governance.mjs. Synthetic only (DM-05). Idempotent: does nothing when the rows are already there.
// Usage: DATABASE_URL=... node scripts/backfill-demo-governance.mjs [--dry-run]
import pg from 'pg';
import { seedGovernance } from '../db/seed/seed-governance.mjs';
import { supabaseSsl } from './pg-ssl.mjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const dry = process.argv.includes('--dry-run');
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? undefined : supabaseSsl });
await c.connect();
await c.query('begin');
try {
  const plat = (await c.query("select id, data_region from core.platform where code = 'PLAT-001'")).rows[0];
  if (!plat) throw new Error('PLAT-001 not found: this script only backfills the demo platform');
  if ((await c.query("select 1 from core.service_provider where code = 'demo-db-hosting'")).rowCount) {
    console.log('backfill: governance demo data already present, nothing to do');
    await c.query('rollback'); await c.end(); process.exit(0);
  }
  await c.query("select set_config('trialops.actor', 'system:backfill-demo-governance', true)");
  await c.query("select set_config('trialops.change_reason', 'synthetic demo backfill after migration 0026 (CMP-05, CMP-08, VAL-04)', true)");
  const org = Object.fromEntries((await c.query(
    "select case name when 'Northfield Clinical Institute' then 'lead' when 'InSilicoTrials Technologies' then 'ist' end k, id from core.organization where name in ('Northfield Clinical Institute', 'InSilicoTrials Technologies')"
  )).rows.map(r => [r.k, r.id]));
  if (!org.ist || !org.lead) throw new Error('demo organizations not found');
  // Manifest first: once the region is set, activating the app checks data_residency (CMP-08).
  const app = await c.query(`update core.app_installation
      set manifest = manifest || '{"publisher": "InSilicoTrials Technologies", "data_residency": ["EU", "US"]}'::jsonb
    where platform_id = $1 and app_id = 'ist.simulation-ta1' and version = '1.4.0' and not (manifest ? 'data_residency')`, [plat.id]);
  if (!plat.data_region) await c.query("update core.platform set data_region = 'US' where id = $1", [plat.id]);
  await seedGovernance(c, plat.id, org);
  const gate = (await c.query("select ok, problems from core.app_validation_gate('ist.simulation-ta1', '1.4.0', 'L2')")).rows[0];
  console.log(`backfill: manifest updated ${app.rowCount}, region ${plat.data_region || 'US (set)'}, VAL-04 gate ok=${gate.ok}`, gate.problems);
  if (!gate.ok) throw new Error('VAL-04 gate still failing after the backfill');
  await c.query(dry ? 'rollback' : 'commit');
  console.log(dry ? 'backfill: dry run, rolled back' : 'backfill: committed');
} catch (e) {
  await c.query('rollback'); console.error('backfill FAILED:', e.message); process.exitCode = 1;
}
await c.end();
