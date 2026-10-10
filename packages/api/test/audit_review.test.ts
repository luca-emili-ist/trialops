// CMP-10 audit trail review API, CMP-11 signature manifestation, CMP-09 AI provenance of accepted content.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider } from '@trialops/ai-runtime';
import { startApi, platformId, DEMO_PASSWORD, type Api } from './_helpers.ts';

let api: Api; let plat: string; let siteId: string; let oldCapacity: number;
before(async () => {
  api = await startApi({ ai: createAiRuntime({ provider: replayProvider() }) });
  plat = await platformId(api.admin);
  const s = (await api.admin.query("select id, declared_capacity_per_month c from core.site where platform_id = $1 order by site_number limit 1", [plat])).rows[0];
  siteId = s.id; oldCapacity = Number(s.c);
  // a known change with a reason, made as a person, to find in the review and in the export
  await api.admin.query('begin');
  await api.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'demo|ops' })]);
  await api.admin.query("select set_config('trialops.change_reason', 'capacity re-assessed, \"Q3\"', true)");
  await api.admin.query('update core.site set declared_capacity_per_month = $2 where id = $1', [siteId, oldCapacity + 1]);
  await api.admin.query('commit');
});
after(async () => api.close());

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

test('[CMP-10] QA lists the audit trail newest first with keyset pagination', async () => {
  const p1 = await api.call('GET', '/v1/audit-events?limit=5', { as: 'demo|qa' });
  assert.equal(p1.status, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.items.length, 5);
  assert.ok(p1.body.items.every((r: any, i: number, a: any[]) => i === 0 || a[i - 1].seq > r.seq));
  assert.ok(p1.body.next_before);
  const p2 = await api.call('GET', `/v1/audit-events?limit=5&before=${p1.body.next_before}`, { as: 'demo|qa' });
  assert.ok(p2.body.items[0].seq < p1.body.items[4].seq);
  assert.match(p1.body.items[0].occurred_at, ISO_UTC);
  const admin = await api.call('GET', '/v1/audit-events?limit=1', { as: 'demo|admin' });
  assert.equal(admin.status, 200);
});

test('[CMP-10] filters by table, record, actor and period; invalid filters are refused', async () => {
  const r = await api.call('GET', `/v1/audit-events?table=site&record_id=${siteId}&actor=demo%7Cops`, { as: 'demo|qa' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items.length, 1);
  const e = r.body.items[0];
  assert.deepEqual([e.table_name, e.record_id, e.action, e.actor_sub, e.reason], ['site', siteId, 'UPDATE', 'demo|ops', 'capacity re-assessed, "Q3"']);
  assert.equal(e.changes, `declared_capacity_per_month: ${oldCapacity} → ${oldCapacity + 1}`);
  const future = await api.call('GET', `/v1/audit-events?from=${encodeURIComponent(new Date(Date.now() + 864e5).toISOString())}`, { as: 'demo|qa' });
  assert.equal(future.body.items.length, 0);
  assert.equal((await api.call('GET', '/v1/audit-events?record_id=not-a-uuid', { as: 'demo|qa' })).status, 400);
  assert.equal((await api.call('GET', '/v1/audit-events?from=yesterday', { as: 'demo|qa' })).status, 400);
});

test('[CMP-10] other roles get 403 on the audit trail and on reviews', async () => {
  for (const who of ['demo|cra', 'demo|arden', 'demo|ops', 'demo|sac']) {
    assert.equal((await api.call('GET', '/v1/audit-events', { as: who })).status, 403, who);
    assert.equal((await api.call('GET', '/v1/audit-reviews', { as: who })).status, 403, who);
    const res = await fetch(`${api.url}/v1/audit-events/export?format=csv`, { headers: { authorization: `Bearer ${await api.tokenFor(who)}` } });
    assert.equal(res.status, 403, who);
  }
  const r = await api.call('POST', '/v1/audit-reviews', { as: 'demo|cra', reason: 'x',
    body: { platform_id: plat, from_seq: 1, to_seq: 2, conclusion: 'x', password: DEMO_PASSWORD } });
  assert.equal(r.status, 403);
});

test('[CMP-10] the CSV export is readable: UTC time, actor, table, record, action, reason and old → new values', async () => {
  const res = await fetch(`${api.url}/v1/audit-events/export?format=csv&table=site&record_id=${siteId}`,
    { headers: { authorization: `Bearer ${await api.tokenFor('demo|qa')}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/csv/);
  assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="trialops-audit-trail-.*\.csv"/);
  const lines = (await res.text()).trim().split('\r\n');
  assert.equal(lines[0], '"seq","occurred_at_utc","actor","actor_type","table","record_id","action","reason","changed_fields"');
  const update = lines.find(l => l.includes('"UPDATE"'))!;
  assert.ok(update, 'the update is exported');
  assert.match(update, /^"\d+","\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z","demo\|ops","user","site","[0-9a-f-]{36}","UPDATE",/);
  assert.ok(update.includes('"capacity re-assessed, ""Q3"""'), 'reason quoted per RFC 4180');
  assert.ok(update.endsWith(`"declared_capacity_per_month: ${oldCapacity} → ${oldCapacity + 1}"`));
  assert.ok(lines.some(l => l.includes('"INSERT"')), 'the creation is exported too');
  assert.equal(Number(res.headers.get('x-row-count')), lines.length - 1);
});

test('[CMP-10][CMP-11] a review is recorded only with a review signature: name, meaning, UTC time and reason are kept', async () => {
  const latest = (await api.call('GET', '/v1/audit-events?limit=1', { as: 'demo|qa' })).body.items[0].seq;
  const body = { platform_id: plat, filters: { table: 'site' }, from_seq: 1, to_seq: latest, conclusion: 'Site changes reviewed; no anomalies.' };
  assert.equal((await api.call('POST', '/v1/audit-reviews', { as: 'demo|qa', body: { ...body, password: DEMO_PASSWORD } })).status, 400, 'reason required');
  const bad = await api.call('POST', '/v1/audit-reviews', { as: 'demo|qa', reason: 'periodic review', body: { ...body, password: 'wrong' } });
  assert.equal(bad.status, 401);
  assert.equal((await api.admin.query('select count(*)::int n from core.audit_review')).rows[0].n, 0, 'nothing kept without a signature');
  const r = await api.call('POST', '/v1/audit-reviews', { as: 'demo|qa', reason: 'Monthly audit trail review', body: { ...body, password: DEMO_PASSWORD } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'completed');
  assert.ok(r.body.row_count >= 7, `row_count ${r.body.row_count}`);
  const sig = r.body.signature;
  assert.deepEqual([sig.signer_name, sig.meaning, sig.reason, sig.auth_method, sig.target_table],
    ['Olivia Grant', 'review', 'Monthly audit trail review', 'reauth_password', 'audit_review']);
  assert.match(sig.signed_at, ISO_UTC);
  const list = await api.call('GET', `/v1/audit-reviews?platform_id=${plat}`, { as: 'demo|admin' });
  assert.equal(list.status, 200);
  assert.equal(list.body.items[0].id, r.body.id);
  assert.equal(list.body.items[0].signature.signer_name, 'Olivia Grant');
  // the review itself is in the audit trail
  const trail = await api.call('GET', `/v1/audit-events?table=audit_review&record_id=${r.body.id}`, { as: 'demo|qa' });
  assert.deepEqual(trail.body.items.map((e: any) => e.action), ['UPDATE', 'INSERT']);
});

test('[CMP-11] signatures carry their manifestation everywhere they are listed; the reason comes from the request', async () => {
  const arm = (await api.admin.query("select id from core.arm where code = 'ARM-A'")).rows[0].id;
  const versions = await api.call('GET', `/v1/arms/${arm}/appendix-versions`, { as: 'demo|reg' });
  const approved = versions.body.items.find((v: any) => v.status === 'approved');
  assert.deepEqual([approved.approved_signature.signer_name, approved.approved_signature.meaning, approved.approved_signature.auth_method],
    ['Dana Whitfield', 'approval', 'reauth_mfa']);
  assert.match(approved.approved_signature.signed_at, ISO_UTC);
  assert.equal(approved.approved_signature.reason, null, 'signatures before 0017 have no stored reason');
  const one = await api.call('GET', `/v1/appendix-versions/${approved.id}`, { as: 'demo|reg' });
  assert.equal(one.body.approved_signature.id, approved.approved_signature_id);
  const armDetail = await api.call('GET', `/v1/arms/${arm}`, { as: 'demo|reg' });
  assert.equal(armDetail.body.appendix_versions[0].approved_signature.signer_name, 'Dana Whitfield');
  const task = (await api.admin.query("select id from core.task where platform_id = $1 limit 1", [plat])).rows[0].id;
  const noReason = await api.call('POST', '/v1/signatures', { as: 'demo|reg', body: { target_table: 'task', target_id: task, meaning: 'review', password: DEMO_PASSWORD } });
  assert.equal(noReason.status, 400);
  const s = await api.call('POST', '/v1/signatures', { as: 'demo|reg', reason: 'Checked the outputs',
    body: { target_table: 'task', target_id: task, meaning: 'review', password: DEMO_PASSWORD } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual([s.body.signer_name, s.body.meaning, s.body.reason], ['Elena Rossi', 'review', 'Checked the outputs']);
  const listed = await api.call('GET', `/v1/signatures?target_id=${task}`, { as: 'demo|reg' });
  assert.equal(listed.body.items.at(-1).reason, 'Checked the outputs');
});

test('[CMP-09][CMP-11] accepted AI content keeps its provenance marker; the proposal is labelled AI-generated', async () => {
  const merid = (await api.admin.query("select id from core.organization where name = 'Meridian Pharma'")).rows[0].id;
  const w = await api.call('POST', `/v1/platforms/${plat}/arm-wizard`, { as: 'demo|ops', body: {
    arm: { code: 'ARM-P', name: 'MRD-12 (provenance)', sponsor_org_id: merid, intervention_type: 'drug', has_prior_human_data: true },
    sponsor_documents: [{ ref: 'SPONSOR-BRIEF-D', title: 'Sponsor briefing (synthetic)', text: 'The recommended phase 2 dose is 40 mg once daily.' }] } });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const draftTask = w.body.agent_tasks[0];
  const { job } = await api.job('POST', `/v1/tasks/${draftTask.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const diff = await api.call('GET', `/v1/tasks/${draftTask.id}/proposal-diff`, { as: 'demo|ops' });
  assert.equal(diff.body.ai_generated.agent, 'protocol-author');
  assert.equal(diff.body.ai_generated.ai_request_id, job.result.ai_request_id);
  assert.ok(diff.body.ai_generated.model);
  const r = await api.call('POST', `/v1/tasks/${draftTask.id}/review`, { as: 'demo|ops', reason: 'Proposal checked against the sponsor documents',
    body: { decision: 'accept', password: DEMO_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const prov = r.body.appendix_version.ai_provenance;
  assert.deepEqual([prov.ai_request_id, prov.agent, prov.reviewed_by, prov.reviewed_by_sub, prov.decision, prov.review_signature_id],
    [job.result.ai_request_id, 'protocol-author', 'Marcus Ortega', 'demo|ops', 'accepted', r.body.signature.id]);
  assert.ok(prov.model && prov.model_version);
  assert.equal(r.body.signature.reason, 'Proposal checked against the sponsor documents');
  const t = await api.call('GET', `/v1/tasks/${draftTask.id}`, { as: 'demo|ops' });
  assert.deepEqual([t.body.review_signature.signer_name, t.body.review_signature.meaning, t.body.review_signature.reason],
    ['Marcus Ortega', 'review', 'Proposal checked against the sponsor documents']);
  // immutable afterwards, whatever the API caller sends
  const v = await api.call('GET', `/v1/appendix-versions/${r.body.appendix_version.id}`, { as: 'demo|reg' });
  assert.deepEqual(v.body.ai_provenance, prov);
  const back = await api.call('POST', `/v1/appendix-versions/${v.body.id}/return`, { as: 'demo|reg', reason: 'more edits' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual(back.body.ai_provenance, prov, 'returning to draft keeps the marker');
});
