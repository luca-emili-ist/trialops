import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());
const sponsorA = () => ({ sub: 'demo|arden', platform_ids: [I.platform], arm_scopes: [I.arms['ARM-A']], site_scopes: '*' });

test('[IAM-02] a user without the platform claim sees no platform data', async () => {
  await tx(c, async () => {
    assert.equal((await c.query('select count(*) n from core.arm')).rows[0].n, '0');
    assert.equal((await c.query('select count(*) n from core.subject_blinded')).rows[0].n, '0');
  }, { role: 'authenticated', claims: { sub: 'x', platform_ids: [] } });
});

test('[IAM-03] a sponsor sees only its own arm, its contracts and its documents', async () => {
  await tx(c, async () => {
    const arms = (await c.query('select code from core.arm order by code')).rows.map(r => r.code);
    assert.deepEqual(arms, ['ARM-A']);
    const contractArms = new Set((await c.query("select arm_id from core.contract where arm_id is not null")).rows.map(r => r.arm_id));
    assert.deepEqual([...contractArms], [I.arms['ARM-A']]);
    const docs = (await c.query("select count(*) n from core.document where arm_id is not null and arm_id <> $1", [I.arms['ARM-A']])).rows[0].n;
    assert.equal(docs, '0');
  }, { role: 'authenticated', claims: sponsorA() });
});

test('[IAM-03] a sponsor cannot write into another arm', async () => {
  await tx(c, async () => {
    await rejects(c.query("insert into core.task(platform_id, arm_id, type, title, assignee_kind, assignee) values ($1,$2,'x','x','role','ctm')",
      [I.platform, I.arms['ARM-B']]), /row-level security/);
  }, { role: 'authenticated', claims: sponsorA() });
});

test('[IAM-04] blinded users never see arm allocation', async () => {
  await tx(c, async () => {
    const r = (await c.query('select count(*) filter (where arm_id is not null) n from core.subject_blinded')).rows[0].n;
    assert.equal(r, '0');
    await c.query('savepoint s');
    await rejects(c.query('select arm_id from core.subject limit 1'), /permission denied/);
    await c.query('rollback to savepoint s');
    await rejects(c.query('select * from sac_enclave.subject_allocation limit 1'), /permission denied/);
  }, { role: 'authenticated', claims: { sub: 'demo|ctm', platform_ids: '*', arm_scopes: '*', site_scopes: '*' } });
});

test('[IAM-04][CMP-13] the SAC unblinded role can read allocation, only through the logged enclave function', async () => {
  await tx(c, async () => {
    const n = (await c.query("select count(*) n from sac_enclave.read_allocation($1, 'interim analysis IA1') where arm_id is not null",
      [I.platform])).rows[0].n;
    assert.ok(Number(n) > 0);
    await rejects(c.query('select * from sac_enclave.subject_allocation limit 1'), /permission denied/);
  }, { role: 'unblinded', claims: { sub: 'demo|sac', blinding: 'unblinded' } });
});

test('[IAM-07][AI-11] an agent identity is never unblinded, even with the claim', async () => {
  await tx(c, async () => {
    const r = (await c.query('select count(*) filter (where arm_id is not null) n from core.subject_blinded')).rows[0].n;
    assert.equal(r, '0');
  }, { role: 'authenticated', claims: { sub: 'agent:deviation-detector', actor_type: 'agent', blinding: 'unblinded', platform_ids: '*', arm_scopes: '*', site_scopes: '*' } });
});

test('[IAM-02] site staff see only their site', async () => {
  await tx(c, async () => {
    const sites = (await c.query('select distinct site_id from core.subject_blinded')).rows.map(r => r.site_id);
    assert.deepEqual(sites, [I.sites[0]]);
  }, { role: 'authenticated', claims: { sub: 'demo|pi101', platform_ids: [I.platform], arm_scopes: '*', site_scopes: [I.sites[0]] } });
});
