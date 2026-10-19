// NFR-06: the same code serves one data region per deployment (TRIALOPS_DEPLOYMENT_REGION). Real API, real database.
// The synthetic platform PLAT-001 keeps its data in the US; an EU platform is added to the throw-away clone where needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, platformId, type Api } from './_helpers.ts';
import { regionFromEnv, requestedPlatforms } from '../src/lib/region.ts';
import { catalogue } from '../src/routes/apps.ts';

const apis: Api[] = [];
after(async () => { for (const a of apis) await a.close(); });
async function api(region: 'EU' | 'US' | 'JP' | null): Promise<Api> { const a = await startApi({ region }); apis.push(a); return a; }
async function euPlatform(a: Api): Promise<string> {
  const lead = (await a.admin.query("select lead_operator_id id from core.platform where code = 'PLAT-001'")).rows[0].id;
  return (await a.admin.query(`insert into core.platform(code, title, therapeutic_area, lead_operator_id, status, data_region)
    values ('PLAT-EU1', 'Synthetic EU platform', 'Disease Y (fictitious)', $1, 'active', 'EU') returning id`, [lead])).rows[0].id;
}
const refusals = async (a: Api) => (await a.admin.query('select * from core.region_access_refusal order by occurred_at')).rows;

test('[NFR-06] TRIALOPS_DEPLOYMENT_REGION is EU, US or JP; anything else stops the start-up; the platforms of a request are found', () => {
  assert.equal(regionFromEnv({}), null);
  assert.equal(regionFromEnv({ TRIALOPS_DEPLOYMENT_REGION: ' jp ' }), 'JP');
  assert.throws(() => regionFromEnv({ TRIALOPS_DEPLOYMENT_REGION: 'APAC' }), /EU, US or JP/);
  const id = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(requestedPlatforms('/v1/platforms/:id/tasks', { id }, {}, undefined), [id]);
  assert.deepEqual(requestedPlatforms('/v1/ai/monitoring', {}, { platform_id: id.toUpperCase() }, undefined), [id]);
  assert.deepEqual(requestedPlatforms('/v1/change-requests', {}, {}, { platform_id: id }), [id]);
  assert.deepEqual(requestedPlatforms('/v1/arms/:id', { id }, {}, { platform_id: 'not-a-uuid' }), []);
});

test('[NFR-06] an EU deployment does not serve a US platform: explicit requests refused (403) and recorded, the perimeter is narrowed', async () => {
  const a = await api('EU');
  const plat = await platformId(a.admin);
  const health = await a.call('GET', '/v1/health');
  assert.deepEqual(health.body, { status: 'ok', region: { deployment_region: 'EU', database_region: null, ok: true, problem: null } });
  const ov = await a.call('GET', `/v1/platforms/${plat}`, { as: 'demo|admin' });
  assert.equal(ov.status, 403, JSON.stringify(ov.body));
  assert.equal(ov.body.error.code, 'wrong_region');
  assert.match(ov.body.error.message, /platform PLAT-001 keeps its data in US; this deployment serves EU\. Use the US deployment/);
  const tasks = await a.call('GET', `/v1/platforms/${plat}/tasks`, { as: 'demo|cra' });
  assert.equal(tasks.status, 403);
  const r = await refusals(a);
  assert.deepEqual(r.map(x => [x.actor_sub, x.deployment_region, x.platform_region, x.method]), [['demo|admin', 'EU', 'US', 'GET'], ['demo|cra', 'EU', 'US', 'GET']]);
  assert.equal(r[0].path, `/v1/platforms/${plat}`);
  assert.equal(r[0].platform_id, plat);
  // nothing of the US platform is visible through any other route either: the token perimeter is narrowed to the EU platforms
  assert.deepEqual((await a.call('GET', '/v1/platforms', { as: 'demo|admin' })).body.items, []);
  const me = await a.call('GET', '/v1/me', { as: 'demo|admin' });
  assert.deepEqual([me.body.platform_ids, me.body.deployment_region], [[], 'EU']);
  const arm = (await a.admin.query("select id from core.arm where platform_id = $1 and code = 'ARM-A'", [plat])).rows[0].id;
  assert.equal((await a.call('GET', `/v1/arms/${arm}`, { as: 'demo|admin' })).status, 404, 'records of the US platform are hidden by RLS');
  // a write naming the US platform in its body is refused before anything is written
  const cr = await a.call('POST', '/v1/change-requests', { as: 'demo|cra', body: { platform_id: plat, page_code: 'TRO-001', kind: 'change', request: 'synthetic cross-region request' } });
  assert.equal(cr.status, 403);
  assert.equal((await a.admin.query('select count(*)::int n from core.change_request where request = $1', ['synthetic cross-region request'])).rows[0].n, 0);
  const audit = (await a.admin.query("select count(*)::int n from core.audit_event where table_name = 'region_access_refusal'")).rows[0].n;
  assert.equal(audit, 3, 'every refusal is in the audit trail');
  const list = await a.call('GET', '/v1/region/refusals', { as: 'demo|qa' });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 3);
  assert.equal((await a.call('GET', '/v1/region/refusals', { as: 'demo|cra' })).status, 403);
});

test('[NFR-06] a US deployment serves its US platform as before and refuses an EU platform held in the same (transitional) database', async () => {
  const a = await api('US');
  const plat = await platformId(a.admin);
  const eu = await euPlatform(a);
  const token = await a.tokenFor('demo|admin', { platform_ids: [plat, eu] });
  const ok = await a.call('GET', `/v1/platforms/${plat}`, { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, 'PLAT-001');
  assert.deepEqual((await a.call('GET', '/v1/platforms', { token })).body.items.map((p: { code: string }) => p.code), ['PLAT-001']);
  assert.equal((await a.call('GET', `/v1/platforms/${eu}`, { token })).status, 403);
  assert.equal((await a.call('GET', `/v1/ai/monitoring?platform_id=${eu}`, { token })).status, 403, 'platform_id in the query');
  const region = await a.call('GET', '/v1/region', { token });
  assert.deepEqual([region.body.deployment_region, region.body.pinned, region.body.platforms.map((p: { code: string }) => p.code)], ['US', true, ['PLAT-001']]);
  assert.equal((await refusals(a)).length, 2);
});

test('[NFR-06] an API whose region differs from the region of its database serves nothing (503) and says why', async () => {
  const a = await api('EU');
  await a.admin.query("select core.set_deployment_region('US', 'synthetic test: database of the US deployment')");
  const r = await a.call('GET', '/v1/me', { as: 'demo|admin' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'region_misconfigured');
  assert.match(r.body.error.message, /this database serves US, the API is configured for EU/);
  assert.equal((await a.call('GET', '/v1/health')).body.status, 'region_misconfigured');
  const unpinned = await api(null);
  await unpinned.admin.query("select core.set_deployment_region('US')");
  assert.match((await unpinned.call('GET', '/v1/platforms', { as: 'demo|admin' })).body.error.message, /configured for no region/);
});

test('[NFR-06][CMP-08] an app whose data_residency does not cover the region is not offered and its installation is refused', async () => {
  const a = await api('JP');
  const cat = await a.call('GET', '/v1/apps/catalogue', { as: 'demo|admin' });
  assert.equal(cat.body.region, 'JP');
  assert.ok(cat.body.items.every((i: { available_in_region: boolean }) => i.available_in_region === false), 'catalogue apps keep data in EU/US only');
  // the US platform cannot be reached from the JP deployment at all; on a JP platform the request is refused by residency
  const lead = (await a.admin.query("select lead_operator_id id from core.platform where code = 'PLAT-001'")).rows[0].id;
  const jp = (await a.admin.query(`insert into core.platform(code, title, therapeutic_area, lead_operator_id, status, data_region)
    values ('PLAT-JP1', 'Synthetic JP platform', 'Disease Z (fictitious)', $1, 'active', 'JP') returning id`, [lead])).rows[0].id;
  const token = await a.tokenFor('demo|admin', { platform_ids: [jp] });
  const m = catalogue().find(x => x.app_id === 'ist.ta1-test-app')!;
  const r = await a.call('POST', `/v1/platforms/${jp}/apps`, { token, body: { manifest: m } });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'residency_mismatch');
  assert.match(r.body.error.message, /keeps its data in EU, US; this deployment keeps its data in JP/);
  const ok = await a.call('POST', `/v1/platforms/${jp}/apps`, { token, body: { manifest: { ...m, data_residency: ['JP'] } } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // unpinned API: the platform region still decides (US platform, EU-only manifest)
  const b = await api(null);
  const r2 = await b.call('POST', `/v1/platforms/${await platformId(b.admin)}/apps`, { as: 'demo|admin', body: { manifest: { ...m, data_residency: ['EU'] } } });
  assert.equal(r2.status, 422);
  assert.match(r2.body.error.message, /the platform keeps its data in US/);
});
