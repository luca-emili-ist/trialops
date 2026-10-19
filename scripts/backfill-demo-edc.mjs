// Backfills the native EDC demo data of migration 0027 (EDC-01, EDC-03, EDC-04, EDC-05, EDC-12) into a database seeded
// before 0027, e.g. the remote demo: the rows of db/seed/seed-edc.mjs (codelists, protocol visits, CRF library, a few visits,
// values and queries at site 101). Synthetic only (DM-05). Idempotent: does nothing when the EDC library is already there.
// Apply migration 0027 first. Usage: DATABASE_URL=... node scripts/backfill-demo-edc.mjs [--dry-run]
import pg from 'pg';
import { seedEdc } from '../db/seed/seed-edc.mjs';
import { supabaseSsl } from './pg-ssl.mjs';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const dry = process.argv.includes('--dry-run');
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? undefined : supabaseSsl });
await c.connect();
await c.query('begin');
try {
  if (!(await c.query("select 1 from public.schema_migrations where name = '0027_edc_native.sql'")).rowCount) {
    throw new Error('migration 0027_edc_native.sql is not applied: apply it first');
  }
  const plat = (await c.query("select id from core.platform where code = 'PLAT-001'")).rows[0];
  if (!plat) throw new Error('PLAT-001 not found: this script only backfills the demo platform');
  if ((await c.query("select 1 from core.crf_form where platform_id = $1 and oid = 'F.VS'", [plat.id])).rowCount) {
    console.log('backfill: EDC demo data already present, nothing to do');
    await c.query('rollback'); await c.end(); process.exit(0);
  }
  await c.query("select set_config('trialops.actor', 'system:backfill-demo-edc', true)");
  await c.query("select set_config('trialops.change_reason', 'synthetic demo backfill after migration 0027 (EDC)', true)");
  await seedEdc(c);
  const n = (await c.query(`select (select count(*) from core.crf_version where platform_id = $1)::int versions,
    (select count(*) from core.item_value where platform_id = $1)::int item_values, (select count(*) from core.edc_query where platform_id = $1)::int queries,
    (select count(*) from core.event_outbox where type = 'visit.completed' and platform_id = $1)::int visits_completed`, [plat.id])).rows[0];
  console.log('backfill: EDC demo rows', n);
  await c.query(dry ? 'rollback' : 'commit');
  console.log(dry ? 'backfill: dry run, rolled back' : 'backfill: committed');
} catch (e) {
  await c.query('rollback'); console.error('backfill FAILED:', e.message); process.exitCode = 1;
}
await c.end();
