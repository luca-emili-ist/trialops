// UX-02 change requests API: suggest as any person, list open ones per page, triage and void by platform admins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, platformId, type Api } from './_helpers.ts';

let api: Api; let plat: string;
before(async () => { api = await startApi(); plat = await platformId(api.admin); });
after(async () => api.close());

const body = (extra: Record<string, unknown> = {}) => ({ platform_id: plat, page_code: 'TRO-020', component_code: 'TRO-020.C03', component_kind: 'table',
  component_text: '  Site   network  table ', dom_path: 'main > section:nth-of-type(2) > div > table', route: '#/sites', kind: 'change',
  request: 'Sort the sites by activation date', ...extra });

test('[UX-02] any person suggests a change; it is stored in their name with status new and listed as open on its page', async () => {
  const r = await api.call('POST', '/v1/change-requests', { as: 'demo|cra', body: body() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.created_by, 'demo|cra');
  assert.equal(r.body.status, 'new');
  assert.equal(r.body.component_text, 'Site network table', 'visible text collapsed');
  const open = await api.call('GET', `/v1/change-requests?platform_id=${plat}&status=open&page_code=TRO-020`, { as: 'demo|arden' });
  assert.equal(open.status, 200);
  assert.ok(open.body.items.some((x: { id: string }) => x.id === r.body.id), 'every person of the platform sees the open requests');
  const elsewhere = await api.call('GET', `/v1/change-requests?platform_id=${plat}&status=open&page_code=TRO-010`, { as: 'demo|cra' });
  assert.ok(!elsewhere.body.items.some((x: { id: string }) => x.id === r.body.id));
});

test('[UX-02] invalid codes and kinds are refused', async () => {
  assert.equal((await api.call('POST', '/v1/change-requests', { as: 'demo|cra', body: body({ page_code: 'dashboard' }) })).status, 400);
  assert.equal((await api.call('POST', '/v1/change-requests', { as: 'demo|cra', body: body({ component_code: 'TRO-020.4' }) })).status, 400);
  assert.equal((await api.call('POST', '/v1/change-requests', { as: 'demo|cra', body: body({ kind: 'wish' }) })).status, 400);
  assert.equal((await api.call('POST', '/v1/change-requests', { as: 'demo|cra', body: body({ status: 'done' }) })).status, 400, 'status is not an input');
  assert.equal((await api.call('GET', '/v1/change-requests', { as: 'demo|cra' })).status, 400, 'platform_id required');
});

test('[UX-02] only a platform admin triages and voids; the void needs a reason and the request leaves the lists', async () => {
  const id = (await api.call('POST', '/v1/change-requests', { as: 'demo|ops', body: body({ kind: 'bug', request: 'The filter row overlaps on phones' }) })).body.id;
  for (const who of ['demo|cra', 'demo|ops', 'demo|qa']) {
    assert.equal((await api.call('PATCH', `/v1/change-requests/${id}`, { as: who, body: { status: 'done' } })).status, 403, who);
    assert.equal((await api.call('POST', `/v1/change-requests/${id}/void`, { as: who, reason: 'x' })).status, 403, who);
  }
  const t = await api.call('PATCH', `/v1/change-requests/${id}`, { as: 'demo|admin', body: { status: 'in_progress', triage_note: 'Assigned to Local Dev' } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.deepEqual([t.body.status, t.body.triage_note, t.body.updated_by], ['in_progress', 'Assigned to Local Dev', 'demo|admin']);
  assert.equal((await api.call('POST', `/v1/change-requests/${id}/void`, { as: 'demo|admin' })).status, 400, 'reason required');
  assert.equal((await api.call('POST', `/v1/change-requests/${id}/void`, { as: 'demo|admin', reason: 'Fixed together with another request' })).status, 200);
  const all = await api.call('GET', `/v1/change-requests?platform_id=${plat}&status=all`, { as: 'demo|admin' });
  assert.ok(!all.body.items.some((x: { id: string }) => x.id === id), 'void requests are never listed');
  const audit = (await api.admin.query("select action, actor_sub, reason from core.audit_event where table_name = 'change_request' and record_id = $1 order by seq", [id])).rows;
  assert.deepEqual(audit.map(a => [a.action, a.actor_sub]), [['INSERT', 'demo|ops'], ['UPDATE', 'demo|admin'], ['VOID', 'demo|admin']]);
  assert.equal(audit[2].reason, 'Fixed together with another request');
  assert.equal((await api.call('PATCH', `/v1/change-requests/${id}`, { as: 'demo|admin', body: { status: 'new' } })).status, 403, 'a void request is closed');
});
