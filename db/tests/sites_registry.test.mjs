import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, ids, tx, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());
const hook = async (sub) => (await c.query("select core.custom_access_token_hook($1::jsonb) e",
  [JSON.stringify({ user_id: sub, claims: { sub, role: 'authenticated' } })])).rows[0].e.claims;

test('[APP-ID-02] token carries sub, email, org_id and the person roles', async () => {
  const cl = await hook('demo|ctm');
  const p = (await c.query("select id, org_id, email from core.person where idp_sub='demo|ctm'")).rows[0];
  assert.equal(cl.sub, 'demo|ctm');
  assert.equal(cl.email, p.email);
  assert.equal(cl.org_id, p.org_id);
  assert.deepEqual(cl.roles, ['ctm']);
  assert.equal(cl.actor_type, 'user');
});
test('[APP-ID-02] an email already in the identity token is kept', async () => {
  const e = (await c.query("select core.custom_access_token_hook($1::jsonb) e",
    [JSON.stringify({ user_id: 'demo|ctm', claims: { sub: 'demo|ctm', email: 'ctm@idp.example' } })])).rows[0].e;
  assert.equal(e.claims.email, 'ctm@idp.example');
});
test('[APP-ID-02] unknown users get no roles', async () => {
  assert.deepEqual((await hook('nobody')).roles, []);
});
test('[M02-01] every demo site has a principal investigator, certifications and capacity', async () => {
  const r = (await c.query(`select s.site_number, s.declared_capacity_per_month cap,
      (select count(*) from core.site_investigator i where i.site_id = s.id and i.investigator_role='principal') pi,
      (select count(*) from core.site_certification x where x.site_id = s.id) certs
    from core.site s where s.platform_id = $1 order by 1`, [I.platform])).rows;
  assert.equal(r.length, 6);
  for (const x of r) { assert.equal(x.pi, '1'); assert.ok(Number(x.certs) >= 2); assert.ok(Number(x.cap) > 0); }
  const ct = (await c.query('select count(*) n from core.site_concurrent_trial where platform_id=$1', [I.platform])).rows[0].n;
  assert.ok(Number(ct) > 0);
});
test('[M02-01][IAM-02] a site PI sees only the registry of its own site', async () => {
  await tx(c, async () => {
    const r = (await c.query('select distinct site_id from core.site_investigator')).rows.map(x => x.site_id);
    assert.deepEqual(r, [I.sites[0]]);
  }, { role: 'authenticated', claims: { sub: 'demo|pi101', platform_ids: [I.platform], arm_scopes: '*', site_scopes: [I.sites[0]] } });
});
test('[M02-01][DM-03] registry changes are audited and need a reason', async () => {
  await tx(c, async () => {
    const id = (await c.query("insert into core.site_certification(platform_id, site_id, kind) values ($1,$2,'Test cert') returning id",
      [I.platform, I.sites[1]])).rows[0].id;
    const a = (await c.query("select action from core.audit_event where table_name='site_certification' and record_id=$1", [id])).rows;
    assert.deepEqual(a.map(x => x.action), ['INSERT']);
    await rejects(c.query("update core.site_certification set status='expired' where id=$1", [id]), /change reason required/);
  });
});
