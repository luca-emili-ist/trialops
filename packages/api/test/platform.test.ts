import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, sign, platformId, type Api } from './_helpers.ts';

let api: Api; let plat: string;
before(async () => { api = await startApi(); plat = await platformId(api.admin); });
after(async () => api.close());

test('[IAM-02] requests without a valid bearer token are refused', async () => {
  assert.equal((await api.call('GET', '/v1/platforms')).status, 401);
  assert.equal((await api.call('GET', '/v1/platforms', { token: 'not-a-jwt' })).status, 401);
  const forged = await sign({ sub: 'demo|ctm' });
  const bad = forged.slice(0, -4) + (forged.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal((await api.call('GET', '/v1/platforms', { token: bad })).status, 401);
});

test('[APP-ID-02][IAM-02] /v1/me returns the perimeter and roles carried by the token', async () => {
  const r = await api.call('GET', '/v1/me', { as: 'demo|arden' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sub, 'demo|arden');
  assert.deepEqual(r.body.roles, ['arm_sponsor_lead']);
  assert.deepEqual(r.body.platform_ids, [plat]);
  assert.equal(r.body.blinding, 'blinded');
  assert.equal(r.body.person.full_name, 'Nora Patel');
});

test('[IAM-02] a user outside the platform sees no platform', async () => {
  const r = await api.call('GET', '/v1/platforms', { as: 'nobody' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
  assert.equal((await api.call('GET', `/v1/platforms/${plat}`, { as: 'nobody' })).status, 404);
});

test('[IAM-03] the platform overview shows a sponsor only its own arm', async () => {
  const ops = await api.call('GET', `/v1/platforms/${plat}`, { as: 'demo|ops' });
  assert.equal(ops.status, 200);
  assert.deepEqual(ops.body.arms.map((a: { code: string }) => a.code), ['ARM-A', 'ARM-B', 'ARM-C', 'CTRL']);
  assert.equal(ops.body.sites.n, 6);
  assert.equal(ops.body.enrollment.identified, 240);
  const sponsor = await api.call('GET', `/v1/platforms/${plat}`, { as: 'demo|arden' });
  assert.deepEqual(sponsor.body.arms.map((a: { code: string }) => a.code), ['ARM-A']);
});

test('[IAM-07] an agent token is never unblinded, even if it claims so', async () => {
  const token = await sign({ sub: 'agent:protocol-author', actor_type: 'agent', blinding: 'unblinded', platform_ids: [plat], arm_scopes: '*', site_scopes: '*' });
  const r = await api.call('GET', '/v1/me', { token });
  assert.equal(r.body.blinding, 'blinded');
});

test('[APP-DT-01] the OpenAPI 3.1 document is generated from the route registry', async () => {
  const r = await api.call('GET', '/v1/openapi.json');
  assert.equal(r.status, 200);
  assert.equal(r.body.openapi, '3.1.0');
  assert.ok(r.body.paths['/v1/platforms/{id}'].get);
  assert.deepEqual(r.body.paths['/v1/me'].get['x-requirements'], ['APP-ID-02', 'IAM-02']);
});
