import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, platformId, type Api } from './_helpers.ts';
import { evaluate } from '../src/routes/metrics.ts';

let api: Api; let plat: string;
before(async () => { api = await startApi(); plat = await platformId(api.admin); });
after(async () => api.close());

test('[M11-01] the catalogue exposes definition, formula, source events and both targets', async () => {
  const r = await api.call('GET', '/v1/metrics/definitions', { as: 'demo|ops' });
  assert.equal(r.status, 200);
  const c = r.body.items.find((m: any) => m.code === 'TA3-CONTRACT-ARM');
  assert.deepEqual([c.unit, Number(c.interim_target), Number(c.final_target)], ['days', 30, 7]);
  assert.ok(c.formula && c.source_events.includes('contract.executed'));
  assert.equal(r.body.items.length, 9);
});

test('[M11-02] values are judged against interim and final targets', () => {
  const d = { direction: 'lower_is_better', interim_target: 30, final_target: 7 };
  assert.equal(evaluate(d, 5), 'final_met');
  assert.equal(evaluate(d, 20), 'interim_met');
  assert.equal(evaluate(d, 45), 'off_target');
  assert.equal(evaluate(d, null), 'no_data');
});

test('[M11-02] per-arm onboarding metrics are computed from records and later arms are faster', async () => {
  const r = await api.call('GET', `/v1/platforms/${plat}/metrics`, { as: 'demo|ops' });
  assert.equal(r.status, 200);
  const contract = r.body.items.find((m: any) => m.code === 'TA3-CONTRACT-ARM');
  assert.deepEqual(contract.values.map((v: any) => v.arm_code), ['ARM-A', 'ARM-B', 'ARM-C']);
  const days = contract.values.map((v: any) => v.value);
  assert.ok(days[0] > days[1] && days[1] > days[2], days.join(','));
  assert.equal(contract.headline.arm_code, 'ARM-C');
  assert.equal(contract.headline.value, 10);   // seed: ARM-C addendum signed 10 days after the arm was created
  assert.equal(contract.headline.status, 'interim_met');
  const ind = r.body.items.find((m: any) => m.code === 'TA3-IND-FSD');
  assert.ok(ind.headline.value > 0);
  assert.equal(r.body.items.find((m: any) => m.code === 'TA3-COST-ARM').headline.status, 'no_data');
});

test('[M11-02] drill-down goes from a value to its source records and domain events', async () => {
  const armC = (await api.admin.query("select id from core.arm where code = 'ARM-C'")).rows[0].id;
  const r = await api.call('GET', `/v1/platforms/${plat}/metrics/TA3-CONTRACT-ARM?arm_id=${armC}`, { as: 'demo|ops' });
  assert.equal(r.status, 200);
  const v = r.body.values[0];
  assert.deepEqual(v.sources.map((s: any) => s.label), ['Arm ARM-C created', 'Arm addendum executed']);
  assert.deepEqual(v.events.map((e: any) => e.label.split(' ')[0]).sort(), ['arm.created', 'contract.executed']);
  assert.equal((await api.call('GET', `/v1/platforms/${plat}/metrics/NOPE`, { as: 'demo|ops' })).status, 404);
});

test('[IAM-03] a sponsor sees metrics and events of its own arm only', async () => {
  const r = await api.call('GET', `/v1/platforms/${plat}/metrics`, { as: 'demo|arden' });
  const contract = r.body.items.find((m: any) => m.code === 'TA3-CONTRACT-ARM');
  assert.deepEqual(contract.values.map((v: any) => v.arm_code), ['ARM-A']);
  const armB = (await api.admin.query("select id from core.arm where code = 'ARM-B'")).rows[0].id;
  const d = await api.call('GET', `/v1/platforms/${plat}/metrics/TA3-CONTRACT-ARM?arm_id=${armB}`, { as: 'demo|arden' });
  assert.deepEqual(d.body.values, []);
});
