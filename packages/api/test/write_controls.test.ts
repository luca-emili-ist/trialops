// Write controls (0024): idempotent writes and optimistic concurrency (APP-DT-02), provenance of app-written data (APP-DT-05).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startApi, platformId, sign, type Api } from './_helpers.ts';

let api: Api; let plat: string; let appToken: string; let siteId: string; let armId: string;
const APP_ID = 'ist.simulation-ta1';
const PROV = { 'x-source-record-id': 'SIM-INV-0001', 'x-source-version': '3', 'x-transformation-id': 'ta1-map@1.0.0' };

before(async () => {
  api = await startApi();
  plat = await platformId(api.admin);
  // an installed app acting with a ctm role on this platform (token as issued for app service accounts)
  appToken = await sign({ sub: `app|${APP_ID}`, actor_type: 'app', app_id: APP_ID, platform_ids: [plat], arm_scopes: '*', site_scopes: '*', roles: ['ctm'] });
  siteId = (await api.admin.query("select id from core.site where platform_id = $1 and site_number = '101'", [plat])).rows[0].id;
  armId = (await api.admin.query("select id from core.arm where platform_id = $1 and status = 'active' order by code limit 1", [plat])).rows[0].id;
});
after(async () => api.close());

interface Res { status: number; headers: Headers; body: any }
async function req(method: string, path: string, opts: { token?: string; as?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const token = opts.token ?? (opts.as ? await api.tokenFor(opts.as) : undefined);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(api.url + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const count = async (sql: string, args: unknown[]) => (await api.admin.query(sql, args)).rows[0].n as number;
const investigators = (name: string) => count('select count(*)::int n from core.site_investigator where full_name = $1', [name]);
const appWrite = (name: string, key: string | undefined, extra: Record<string, string> = PROV) =>
  req('POST', `/v1/sites/${siteId}/investigators`, { token: appToken, body: { full_name: name, investigator_role: 'sub' },
    headers: { ...extra, ...(key ? { 'idempotency-key': key } : {}) } });

test('[APP-DT-02] an app write without Idempotency-Key, or with a malformed one, is refused and writes nothing', async () => {
  const r = await appWrite('Dr. No Key', undefined);
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'idempotency_key_required');
  assert.equal((await appWrite('Dr. No Key', 'short')).body.error.code, 'invalid_idempotency_key');
  assert.equal((await appWrite('Dr. No Key', 'bad key with spaces!')).status, 400);
  assert.equal(await investigators('Dr. No Key'), 0);
});

test('[APP-DT-02] a retried app write with the same key returns the stored response and is applied once', async () => {
  const key = randomUUID();
  const first = await appWrite('Dr. Retry Once', key);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.headers.get('idempotent-replayed'), null);
  const again = await appWrite('Dr. Retry Once', key);
  assert.equal(again.status, 201);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(again.body, first.body);
  assert.equal(await investigators('Dr. Retry Once'), 1);
});

test('[APP-DT-02] the same key with a different request is refused (422) and the first write stands', async () => {
  const key = randomUUID();
  assert.equal((await appWrite('Dr. Key Owner', key)).status, 201);
  const other = await appWrite('Dr. Key Thief', key);
  assert.equal(other.status, 422);
  assert.equal(other.body.error.code, 'idempotency_key_reused');
  assert.equal(await investigators('Dr. Key Thief'), 0);
  // a different path with the same key is a different request too
  const elsewhere = await req('POST', `/v1/sites/${siteId}/certifications`, { token: appToken, body: { kind: 'GCP' }, headers: { ...PROV, 'idempotency-key': key } });
  assert.equal(elsewhere.status, 422);
});

test('[APP-DT-02] concurrent duplicates with one key: one write, both answers identical', async () => {
  const key = randomUUID();
  const [a, b] = await Promise.all([appWrite('Dr. Concurrent', key), appWrite('Dr. Concurrent', key)]);
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.deepEqual(a.body, b.body);
  assert.equal(await investigators('Dr. Concurrent'), 1);
});

test('[APP-DT-02] people may omit the key; keys are scoped to the caller', async () => {
  const body = { full_name: 'Dr. Person Write', investigator_role: 'sub' };
  assert.equal((await req('POST', `/v1/sites/${siteId}/investigators`, { as: 'demo|ctm', body })).status, 201);
  const key = randomUUID();
  const mine = await req('POST', `/v1/sites/${siteId}/investigators`, { as: 'demo|ctm', body: { ...body, full_name: 'Dr. Scoped' }, headers: { 'idempotency-key': key } });
  const theirs = await req('POST', `/v1/sites/${siteId}/investigators`, { as: 'demo|ops', body: { ...body, full_name: 'Dr. Scoped' }, headers: { 'idempotency-key': key } });
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);
  assert.equal(theirs.headers.get('idempotent-replayed'), null, 'another caller never receives my stored response');
  assert.notEqual(mine.body.id, theirs.body.id);
  // the replay cache is closed to the API roles
  const denied = await api.admin.query(`begin; set local role authenticated; select count(*) from core.idempotency_record`).catch(e => e);
  await api.admin.query('rollback');
  assert.match(String(denied.message), /permission denied/);
});

test('[APP-DT-02] stored responses cannot be changed and expire after their retention', async () => {
  await assert.rejects(api.admin.query("update core.idempotency_record set response_status = 200"), /cannot be changed/);
  await assert.rejects(api.admin.query('delete from core.idempotency_record'), /cannot be changed/);
  const key = randomUUID();
  await api.admin.query(`insert into core.idempotency_record(caller, idem_key, actor_type, method, path, request_sha256, response_status,
      response_body, created_at, expires_at) values ($1, $2, 'app', 'POST', '/old', repeat('0', 64), 201, '{"old":true}',
      now() - interval '2 days', now() - interval '1 day')`, [`app|${APP_ID}@${APP_ID}`, key]);
  const fresh = await appWrite('Dr. After Expiry', key);
  assert.equal(fresh.status, 201, 'an expired key is not replayed: the write runs');
  assert.equal(fresh.headers.get('idempotent-replayed'), null);
  assert.equal(await investigators('Dr. After Expiry'), 1);
  const exp = (await api.admin.query('select extract(epoch from expires_at - created_at)::int s from core.idempotency_record where idem_key = $1', [key])).rows[0].s;
  assert.equal(exp, 24 * 3600, 'retention of a stored response: 24 h');
});

test('[APP-DT-02] GET of a versioned record returns its row_version as ETag; If-Match guards updates (412 when stale)', async () => {
  const site = await req('GET', `/v1/sites/${siteId}`, { as: 'demo|ctm' });
  assert.equal(site.headers.get('etag'), `"${site.body.row_version}"`);
  const arm = await req('GET', `/v1/arms/${armId}`, { as: 'demo|ctm' });
  const v = (await api.admin.query('select row_version from core.arm where id = $1', [armId])).rows[0].row_version;
  assert.equal(arm.headers.get('etag'), `"${v}"`);
  assert.equal(arm.headers.get('cache-control'), 'no-store');
  // conditional GET never answers 304 on a record version
  assert.equal((await req('GET', `/v1/arms/${armId}`, { as: 'demo|ctm', headers: { 'if-none-match': `"${v}"` } })).status, 200);

  const cr = await req('POST', '/v1/change-requests', { as: 'demo|admin', body: { platform_id: plat, page_code: 'TRO-010', kind: 'change', request: 'Rename the column' } });
  assert.equal(cr.status, 201, JSON.stringify(cr.body));
  const stale = await req('PATCH', `/v1/change-requests/${cr.body.id}`, { as: 'demo|admin', body: { status: 'triaged' }, headers: { 'if-match': '"7"' } });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.code, 'precondition_failed');
  const ok = await req('PATCH', `/v1/change-requests/${cr.body.id}`, { as: 'demo|admin', body: { status: 'triaged' }, headers: { 'if-match': '"1"' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.headers.get('etag'), '"2"');
  const late = await req('PATCH', `/v1/change-requests/${cr.body.id}`, { as: 'demo|admin', body: { triage_note: 'x' }, headers: { 'if-match': '"1"' } });
  assert.equal(late.status, 412, 'the second writer with the old version loses');
  assert.equal((await req('PATCH', `/v1/change-requests/${cr.body.id}`, { as: 'demo|admin', body: { triage_note: 'y' } })).status, 200, 'If-Match optional for people');
  assert.equal((await req('PATCH', `/v1/change-requests/${cr.body.id}`, { as: 'demo|admin', body: { triage_note: 'z' }, headers: { 'if-match': 'v3' } })).status, 400);
});

test('[APP-DT-02] apps must send If-Match on updates of versioned records (428), and a matching one passes', async () => {
  const org = (await api.admin.query("insert into core.organization(name, org_type, country) values ('Synthetic Site 901', 'site', 'US') returning id")).rows[0].id;
  const site = await req('POST', `/v1/platforms/${plat}/sites`, { token: appToken, body: { org_id: org, site_number: '901', country: 'US' },
    headers: { ...PROV, 'idempotency-key': randomUUID() } });
  assert.equal(site.status, 201, JSON.stringify(site.body));
  const act = await req('POST', `/v1/arms/${armId}/site-activations`, { token: appToken, body: { site_id: site.body.id },
    headers: { ...PROV, 'idempotency-key': randomUUID() } });
  assert.equal(act.status, 201, JSON.stringify(act.body));
  const step = (ifMatch?: string) => req('POST', `/v1/site-activations/${act.body.id}/steps/qualified`, { token: appToken, body: {},
    headers: { ...PROV, 'idempotency-key': randomUUID(), 'x-change-reason': 'qualification visit done', ...(ifMatch ? { 'if-match': ifMatch } : {}) } });
  const none = await step();
  assert.equal(none.status, 428);
  assert.equal(none.body.error.code, 'precondition_required');
  assert.equal((await step('"5"')).status, 412);
  const ok = await step(`"${act.body.row_version}"`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.headers.get('etag'), `"${act.body.row_version + 1}"`);
});

test('[APP-DT-05] an app write without provenance is refused and writes nothing', async () => {
  for (const drop of Object.keys(PROV)) {
    const partial = Object.fromEntries(Object.entries(PROV).filter(([k]) => k !== drop));
    const r = await appWrite('Dr. Unknown Origin', randomUUID(), partial);
    assert.equal(r.status, 422, drop);
    assert.equal(r.body.error.code, 'provenance_required');
  }
  const noApp = await sign({ sub: 'app|anonymous', actor_type: 'app', platform_ids: [plat], arm_scopes: '*', site_scopes: '*', roles: ['ctm'] });
  const r = await req('POST', `/v1/sites/${siteId}/investigators`, { token: noApp, body: { full_name: 'Dr. Unknown Origin', investigator_role: 'sub' },
    headers: { ...PROV, 'idempotency-key': randomUUID() } });
  assert.equal(r.status, 403);
  assert.equal(await investigators('Dr. Unknown Origin'), 0);
});

test('[APP-DT-05] provenance is stored on the row (source_app from the token) and is in the audit trail', async () => {
  const r = await appWrite('Dr. Traced', randomUUID(), { ...PROV, 'x-source-app': 'someone.else' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.source_app, r.body.source_record_id, r.body.source_version, r.body.transformation_id],
    [APP_ID, 'SIM-INV-0001', '3', 'ta1-map@1.0.0']);
  const audit = await req('GET', `/v1/audit-events?table=site_investigator&record_id=${r.body.id}`, { as: 'demo|qa' });
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  const ins = audit.body.items.find((e: any) => e.action === 'INSERT');
  assert.equal(ins.actor_type, 'app');
  assert.equal(ins.source_app, APP_ID);
  assert.deepEqual([ins.new_row.source_app, ins.new_row.source_record_id, ins.new_row.source_version, ins.new_row.transformation_id],
    [APP_ID, 'SIM-INV-0001', '3', 'ta1-map@1.0.0']);
});

test('[APP-DT-05] the database refuses app writes without provenance and people cannot forge or erase it', async () => {
  const c = api.admin;
  const claims = (x: object) => c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(x)]);
  await c.query('begin');
  try {
    await claims({ sub: `app|${APP_ID}`, actor_type: 'app', app_id: APP_ID, platform_ids: [plat] });
    await c.query('set local role app_service');
    await assert.rejects(c.query("insert into core.site_certification(platform_id, site_id, kind) values ($1, $2, 'GCP')", [plat, siteId]), /APP-DT-05/);
  } finally { await c.query('rollback'); }

  const row = (await c.query("select id from core.site_investigator where full_name = 'Dr. Traced'")).rows[0];
  await c.query('begin');
  try {
    await claims({ sub: 'demo|ctm', actor_type: 'user', platform_ids: [plat], arm_scopes: '*', site_scopes: '*' });
    await c.query("select set_config('trialops.change_reason', 'correct the specialty', true)");
    await c.query('set local role authenticated');
    const forged = (await c.query(`insert into core.site_certification(platform_id, site_id, kind, source_app, source_record_id)
      values ($1, $2, 'GCP', 'forged.app', 'X') returning source_app, source_record_id`, [plat, siteId])).rows[0];
    assert.deepEqual(forged, { source_app: null, source_record_id: null });
    const kept = (await c.query(`update core.site_investigator set specialty = 'oncology', source_app = null, source_version = '99'
      where id = $1 returning source_app, source_version`, [row.id])).rows[0];
    assert.deepEqual(kept, { source_app: APP_ID, source_version: '3' });
  } finally { await c.query('rollback'); }
});
