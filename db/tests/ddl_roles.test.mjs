import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, rejects } from './_helpers.mjs';
let c;
before(async () => { c = await db(); });
after(async () => c.end());

const RUNTIME_ROLES = ['anon', 'authenticated', 'app_service', 'unblinded', 'auth_service', 'audit_sealer', 'trialops_api'];

test('[CMP-12] DDL on core and sac_enclave is recorded with login, role and statement; the log is append-only', async () => {
  await tx(c, async () => {
    assert.equal((await c.query('select core.ddl_audit_active() a')).rows[0].a, true);
    await c.query('create table core.ddl_probe (id int)');
    await c.query('alter table core.ddl_probe add column note text');
    await c.query('drop table core.ddl_probe');
    await c.query('create table public.not_audited_probe (id int)');
    const r = (await c.query(`select event, command_tag, object_identity, login_role, statement from core.ddl_event
      where object_identity like '%probe%' and object_type = 'table' order by id`)).rows;
    assert.deepEqual(r.map(x => [x.event, x.command_tag]), [['ddl_command_end', 'CREATE TABLE'], ['ddl_command_end', 'ALTER TABLE'],
      ['sql_drop', 'DROP TABLE']]);
    assert.ok(r.every(x => x.object_identity.startsWith('core.') && x.login_role && x.statement));
    await c.query('savepoint s');
    await rejects(c.query('delete from core.ddl_event'), /append-only/);
    await c.query('rollback to savepoint s');
  });
});

test('[CMP-12] runtime roles are segregated from admin: no superuser, no DDL, no ownership, no RLS bypass', async () => {
  for (const role of RUNTIME_ROLES) {
    const r = (await c.query(`select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication,
        has_schema_privilege($1, 'core', 'CREATE') core_create, has_schema_privilege($1, 'sac_enclave', 'CREATE') enclave_create,
        (select count(*)::int from pg_class cl join pg_namespace n on n.oid = cl.relnamespace join pg_roles o on o.oid = cl.relowner
          where o.rolname = $1 and n.nspname in ('core', 'sac_enclave')) owns
      from pg_roles where rolname = $1`, [role])).rows[0];
    assert.ok(r, `${role} exists`);
    assert.deepEqual(r, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false,
      core_create: false, enclave_create: false, owns: 0 }, role);
  }
  const member = (await c.query(`select array_agg(g.rolname::text order by g.rolname) m from pg_auth_members am join pg_roles g on g.oid = am.roleid
    join pg_roles u on u.oid = am.member where u.rolname = 'trialops_api'`)).rows[0].m;
  assert.deepEqual(member, ['anon', 'app_service', 'auth_service', 'authenticated'], 'the API login is never unblinded nor sealer');
});

test('[CMP-12] the admin role review is for QA auditors and platform admins', async () => {
  await tx(c, async () => {
    const r = (await c.query('select * from core.db_role_review()')).rows;
    assert.ok(r.some(x => x.superuser || x.owns_objects > 0), 'owner/admin listed');
    assert.ok(!r.some(x => ['authenticated', 'app_service', 'trialops_api'].includes(x.role_name)));
  }, { role: 'authenticated', claims: { sub: 'demo|qa', roles: ['qa_auditor'] } });
  await tx(c, async () => {
    await rejects(c.query('select * from core.db_role_review()'), /qa_auditor or platform_admin/);
  }, { role: 'authenticated', claims: { sub: 'demo|ctm' } });
});
