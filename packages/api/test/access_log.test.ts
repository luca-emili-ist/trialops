// CMP-13 access log API: exports are recorded with the hash of the file; the log is reported to QA and admins only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startApi, type Api } from './_helpers.ts';

let api: Api;
before(async () => { api = await startApi({}); });
after(async () => api.close());

const get = async (path: string, who: string) =>
  fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${await api.tokenFor(who)}` } });

test('[CMP-13] an audit trail export is logged with actor, row count and the SHA-256 of the file', async () => {
  const res = await get('/v1/audit-events/export?format=csv&table=site', 'demo|qa');
  assert.equal(res.status, 200);
  const body = await res.text();
  const seq = Number(res.headers.get('x-access-log-seq'));
  assert.ok(seq > 0);
  const log = await api.call('GET', '/v1/access-log?kind=export', { as: 'demo|qa' });
  assert.equal(log.status, 200, JSON.stringify(log.body));
  const row = log.body.items.find((r: any) => r.seq === seq);
  assert.ok(row, 'the export is in the access log');
  assert.equal(row.actor_sub, 'demo|qa');
  assert.equal(row.object, 'core.audit_event');
  assert.equal(row.format, 'csv');
  assert.equal(row.row_count, Number(res.headers.get('x-row-count')));
  assert.equal(row.content_sha256, createHash('sha256').update(body, 'utf8').digest('hex'));
  assert.deepEqual(row.filters, { table: 'site' });
});

test('[CMP-13] the access log is for QA auditors and platform admins; exporting it is logged too', async () => {
  for (const who of ['demo|ctm', 'demo|sac']) {
    const r = await api.call('GET', '/v1/access-log', { as: who });
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.body)}`);
  }
  const res = await get('/v1/access-log/export', 'demo|admin');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /^"seq","occurred_at_utc","actor"/);
  const seq = Number(res.headers.get('x-access-log-seq'));
  const log = await api.call('GET', '/v1/access-log?kind=export', { as: 'demo|admin' });
  assert.ok(log.body.items.some((r: any) => r.seq === seq && r.object === 'core.data_access_log'));
  const bad = await api.call('GET', '/v1/access-log?kind=delete', { as: 'demo|qa' });
  assert.equal(bad.status, 400);
});
