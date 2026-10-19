// VAL-02: the installation qualification (scripts/iq-check.mjs) connects as iq_reader (migration 0029), a role that can
// run exactly the three IQ database checks and read nothing else: no audit ledger, no clinical or enclave table (rule 5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, rejects } from './_helpers.mjs';
import { checkDatabase } from '../../scripts/iq-check.mjs';

const root = new URL('../../', import.meta.url).pathname;
let c;
before(async () => { c = await db(); });
after(async () => c.end());

test('[VAL-02] iq_reader runs the three IQ queries and the IQ database checks pass with it', async () => {
  const owner = (await c.query('select count(*)::int n from public.schema_migrations')).rows[0].n;
  await tx(c, async () => {
    const names = (await c.query('select name from public.schema_migrations order by name')).rows;
    assert.equal(names.length, owner, 'iq_reader sees the whole migration ledger');
    assert.ok(names.some(r => r.name === '0029_iq_reader.sql'));
    assert.equal((await c.query('select core.iq_audit_verify() b')).rows[0].b, null);
    assert.equal((await c.query('select core.ddl_audit_active() a')).rows[0].a, true, 'pg_event_trigger is readable by a non-owner');
    const checks = await checkDatabase(c, root);
    assert.deepEqual(checks.map(x => [x.id, x.ok]), [['db.migrations', true], ['db.audit_chain', true], ['db.ddl_audit', true]], JSON.stringify(checks));
    assert.match(checks[1].detail, /core\.iq_audit_verify/, 'the IQ uses the wrapper, not the invoker function');
  }, { role: 'iq_reader' });
});

test('[VAL-02] iq_reader is denied the audit ledger, clinical tables and the enclave (blinding)', async () => {
  for (const sql of [
    'select * from core.audit_event limit 1',
    'select core.audit_verify()',                       // invoker: would read the ledger as iq_reader
    'select * from core.subject limit 1',
    'select * from core.crf_entry limit 1',
    'select * from core.adverse_event limit 1',
    'select * from sac_enclave.reidentification_key limit 1',
    "insert into public.schema_migrations(name) values ('9999_forged.sql')",
  ]) {
    await tx(c, async () => { await rejects(c.query(sql), /permission denied/); }, { role: 'iq_reader' });
  }
  // nothing readable or writable in core, sac_enclave or public except select on the migration ledger
  const tables = (await c.query(`
    select n.nspname || '.' || cl.relname t,
           has_table_privilege('iq_reader', cl.oid, 'SELECT') s,
           has_table_privilege('iq_reader', cl.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') w
      from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
     where n.nspname in ('core', 'sac_enclave', 'public') and cl.relkind in ('r', 'v', 'm', 'p', 'f')`)).rows;
  assert.deepEqual(tables.filter(x => x.s).map(x => x.t), ['public.schema_migrations']);
  assert.deepEqual(tables.filter(x => x.w).map(x => x.t), []);
  const role = (await c.query(`select rolcanlogin, rolinherit, rolsuper, rolbypassrls,
      has_schema_privilege('iq_reader', 'sac_enclave', 'USAGE') enclave,
      (select count(*)::int from pg_auth_members m join pg_roles u on u.oid = m.member where u.rolname = 'iq_reader') member_of
    from pg_roles where rolname = 'iq_reader'`)).rows[0];
  assert.deepEqual(role, { rolcanlogin: false, rolinherit: false, rolsuper: false, rolbypassrls: false, enclave: false, member_of: 0 },
    'nologin in the repository (login is set out of band), member of no role');
  // the ledger policy is for iq_reader only: the API roles still see nothing
  await tx(c, async () => {
    assert.equal((await c.query('select count(*)::int n from public.schema_migrations').catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0);
  }, { role: 'anon' });
});

test('[VAL-02] core.iq_audit_verify() returns what core.audit_verify() returns, also on a tampered ledger', async () => {
  const def = (await c.query(`select prosecdef, array_to_string(proconfig, ',') cfg, has_function_privilege('anon', oid, 'EXECUTE') anon,
      has_function_privilege('authenticated', oid, 'EXECUTE') auth from pg_proc where oid = 'core.iq_audit_verify()'::regprocedure`)).rows[0];
  assert.deepEqual(def, { prosecdef: true, cfg: 'search_path=core, public', anon: false, auth: false });
  await tx(c, async () => {
    const r = (await c.query('select core.audit_verify() a, core.iq_audit_verify() b')).rows[0];
    assert.equal(r.a, null); assert.equal(r.b, null);
    await c.query('alter table core.audit_event disable trigger audit_no_update');
    await c.query("update core.audit_event set reason = 'tampered' where seq = 5");
    const t = (await c.query('select core.audit_verify() a, core.iq_audit_verify() b')).rows[0];
    assert.equal(Number(t.a), 5); assert.equal(t.b, t.a);
    await c.query('set local role iq_reader');
    assert.equal((await c.query('select core.iq_audit_verify() b')).rows[0].b, t.a, 'iq_reader sees the broken link');
  });
});
