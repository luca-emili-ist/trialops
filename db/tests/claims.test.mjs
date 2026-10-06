import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, ids } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());
const hook = async (sub) => (await c.query("select core.custom_access_token_hook($1::jsonb) e",
  [JSON.stringify({ user_id: sub, claims: { sub, role: 'authenticated' } })])).rows[0].e.claims;

test('[APP-ID-02][IAM-02] sponsor token gets only its own arm', async () => {
  const cl = await hook('demo|arden');
  assert.deepEqual(cl.platform_ids, [I.platform]);
  assert.equal(cl.blinding, 'blinded');
  assert.deepEqual(cl.arm_scopes, [I.arms['ARM-A']]);
});
test('[APP-ID-02][IAM-02] site PI token is restricted to its site', async () => {
  const cl = await hook('demo|pi101');
  assert.deepEqual(cl.site_scopes, [I.sites[0]]);
});
test('[APP-ID-02][IAM-04] only SAC members receive an unblinded token', async () => {
  assert.equal((await hook('demo|sac')).blinding, 'unblinded');
  assert.equal((await hook('demo|ctm')).blinding, 'blinded');
});
test('[APP-ID-02] unknown users get no platform', async () => {
  assert.deepEqual((await hook('nobody')).platform_ids, []);
});
