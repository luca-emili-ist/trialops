import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { db } from './_helpers.mjs';
let c;
before(async () => { c = await db(); });
after(async () => c.end());

// VAL-03: migrations are rehearsed on a synthetic copy before promotion. `npm run db:reset` builds an empty database,
// applies every migration and loads the synthetic seed; here every migration from 0021 on (the ones written to be
// idempotent, listed automatically) is applied twice more on that seeded copy: no error and no change of the schema.
// Each re-run is rolled back. A remote apply after a partial failure is therefore safe.
export const IDEMPOTENT_FROM = 21;
const dir = new URL('../migrations/', import.meta.url);
export const idempotentMigrations = () => readdirSync(dir).filter(f => /^\d{4}_.+\.sql$/.test(f) && Number(f.slice(0, 4)) >= IDEMPOTENT_FROM).sort();

// Shape of the schema: columns, constraints, indexes, triggers, policies, function bodies, privileges (core, sac_enclave).
const FINGERPRINT = `
  select md5(string_agg(x, E'\\n' order by x)) from (
    select 'col ' || table_schema || '.' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') x
      from information_schema.columns where table_schema in ('core', 'sac_enclave')
    union all select 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint
      where connamespace in ('core'::regnamespace, 'sac_enclave'::regnamespace)
    union all select 'idx ' || schemaname || '.' || indexname || ' ' || indexdef from pg_indexes where schemaname in ('core', 'sac_enclave')
    union all select 'trg ' || tgrelid::regclass || ' ' || tgname || ' ' || tgenabled::text from pg_trigger t join pg_class cl on cl.oid = t.tgrelid
      where cl.relnamespace in ('core'::regnamespace, 'sac_enclave'::regnamespace) and not tgisinternal
    union all select 'pol ' || schemaname || '.' || tablename || ' ' || policyname || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '')
      from pg_policies where schemaname in ('core', 'sac_enclave')
    union all select 'fn ' || p.oid::regprocedure || ' ' || md5(p.prosrc) || ' ' || p.prosecdef::text || ' ' || coalesce(array_to_string(p.proacl, ','), '')
      from pg_proc p where p.pronamespace in ('core'::regnamespace, 'sac_enclave'::regnamespace)
    union all select 'acl ' || cl.oid::regclass || ' ' || coalesce(array_to_string(cl.relacl, ','), '') from pg_class cl
      where cl.relnamespace in ('core'::regnamespace, 'sac_enclave'::regnamespace)
    union all select 'evt ' || evtname || ' ' || evtenabled::text from pg_event_trigger
  ) s`;

test('[VAL-03] every migration from 0021 on is found and checked for idempotency', () => {
  const files = idempotentMigrations();
  assert.ok(files.includes('0021_data_access_log.sql') && files.includes('0022_audit_seal_ddl_roles.sql'), files.join(', '));
  assert.ok(files.length >= 3);
});

// 0021 and 0022 also prove the idempotency of the CMP-12/CMP-13 controls they create.
const alsoCovers = f => (/^002[12]_/.test(f) ? '[CMP-12][CMP-13]' : '');
for (const f of idempotentMigrations()) {
  test(`[VAL-03]${alsoCovers(f)} migration ${f} applied again twice on the seeded synthetic copy: no error, no schema change`, async () => {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    await c.query('begin');
    try {
      const before = (await c.query(FINGERPRINT)).rows[0].md5;
      for (let i = 0; i < 2; i++) await c.query(sql);
      assert.equal((await c.query(FINGERPRINT)).rows[0].md5, before, `${f} changed the schema when applied again`);
      assert.equal((await c.query('select core.ddl_audit_active() a')).rows[0].a, true);
      assert.equal((await c.query('select core.audit_verify() b')).rows[0].b, null, 'audit chain intact');
    } finally { await c.query('rollback'); }
  });
}

test('[VAL-03] the schema fingerprint detects a change (negative control)', async () => {
  await c.query('begin');
  try {
    const before = (await c.query(FINGERPRINT)).rows[0].md5;
    await c.query('alter table core.idempotency_record add column fingerprint_probe int');
    assert.notEqual((await c.query(FINGERPRINT)).rows[0].md5, before);
  } finally { await c.query('rollback'); }
});
