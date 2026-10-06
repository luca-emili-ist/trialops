import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, platformId, type Api } from './_helpers.ts';

let api: Api; let plat: string; let newSite: string; let armB: string; let act: string;
before(async () => {
  api = await startApi(); plat = await platformId(api.admin);
  armB = (await api.admin.query("select id from core.arm where code = 'ARM-B'")).rows[0].id;
});
after(async () => api.close());

test('[M02-01] the registry lists every site with PI, certifications, capacity and enrollment', async () => {
  const r = await api.call('GET', `/v1/platforms/${plat}/sites`, { as: 'demo|ctm' });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 6);
  const s106 = r.body.items.find((s: any) => s.site_number === '106');
  assert.equal(s106.pi_name, 'Dr. PI Site 106');
  assert.ok(s106.certifications >= 2);
  assert.ok(s106.declared_capacity_per_month > 0);
  assert.ok(r.body.items.every((s: any) => s.identified > 0));
});

test('[M02-01][IAM-02] a site PI sees only its own site', async () => {
  const r = await api.call('GET', `/v1/platforms/${plat}/sites`, { as: 'demo|pi101' });
  assert.deepEqual(r.body.items.map((s: any) => s.site_number), ['101']);
});

test('[M02-01] a candidate site is registered and its registry completed', async () => {
  const org = (await api.call('GET', '/v1/organizations?type=site', { as: 'demo|ctm' })).body.items[0];
  const s = await api.call('POST', `/v1/platforms/${plat}/sites`, { as: 'demo|ctm', body: { org_id: org.id, site_number: '107', country: 'US', declared_capacity_per_month: 3 } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(s.body.status, 'candidate');
  newSite = s.body.id;
  for (const [path, body] of [['investigators', { full_name: 'Dr. New PI', investigator_role: 'principal', gcp_training_valid_until: '2027-06-30' }],
    ['certifications', { kind: 'GCP inspection', valid_until: '2028-01-01' }], ['concurrent-trials', { title: 'Synthetic study', competes_for_population: true }]] as const)
    assert.equal((await api.call('POST', `/v1/sites/${newSite}/${path}`, { as: 'demo|ctm', body })).status, 201);
  const d = await api.call('GET', `/v1/sites/${newSite}`, { as: 'demo|ctm' });
  assert.equal(d.body.investigators[0].full_name, 'Dr. New PI');
  assert.equal(d.body.concurrent_trials.length, 1);
  assert.equal((await api.call('POST', `/v1/platforms/${plat}/sites`, { as: 'demo|arden', body: { org_id: org.id, site_number: '108', country: 'US' } })).status, 403);
});

test('[M02-03] activation steps are dated in order and the green light activates the site', async () => {
  const a = await api.call('POST', `/v1/arms/${armB}/site-activations`, { as: 'demo|ctm', body: { site_id: newSite } });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  act = a.body.id;
  const skip = await api.call('POST', `/v1/site-activations/${act}/steps/irb_approved`, { as: 'demo|ctm', reason: 'IRB letter received' });
  assert.equal(skip.status, 422);
  assert.match(skip.body.error.message, /needs/);
  let last: any;
  for (const step of ['qualified', 'contract_executed', 'irb_approved', 'training_done', 'green_light']) {
    last = await api.call('POST', `/v1/site-activations/${act}/steps/${step}`, { as: 'demo|ctm', reason: `${step} done` });
    assert.equal(last.status, 200, `${step}: ${JSON.stringify(last.body)}`);
  }
  assert.equal(last.body.status, 'activated');
  assert.equal(last.body.next_step, null);
  const ev = (await api.admin.query("select type from core.event_outbox where type = 'site.activated' and data->>'site_id' = $1", [newSite])).rows;
  assert.equal(ev.length, 1);
});

test('[M02-03] a step cannot be dated before the previous one', async () => {
  const a = await api.call('POST', `/v1/arms/${(await api.admin.query("select id from core.arm where code = 'ARM-C'")).rows[0].id}/site-activations`,
    { as: 'demo|ctm', body: { site_id: newSite } });
  await api.call('POST', `/v1/site-activations/${a.body.id}/steps/qualified`, { as: 'demo|ctm', reason: 'q', body: { at: '2026-10-01T00:00:00Z' } });
  const r = await api.call('POST', `/v1/site-activations/${a.body.id}/steps/contract_executed`, { as: 'demo|ctm', reason: 'c', body: { at: '2026-09-01T00:00:00Z' } });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /cannot precede/);
});

test('[M02-03] the arm view shows each site with its next step', async () => {
  const r = await api.call('GET', `/v1/arms/${armB}/site-activations`, { as: 'demo|ops' });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 7);
  assert.ok(r.body.items.every((x: any) => x.next_step === null));
});
