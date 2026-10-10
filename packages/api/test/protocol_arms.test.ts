import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, sign, platformId, SIGN, type Api } from './_helpers.ts';

let api: Api; let plat: string; let armId: string; let draftId: string;
before(async () => { api = await startApi(); plat = await platformId(api.admin); });
after(async () => api.close());

const objectives = [{ id: 'OBJ1', level: 'primary', text: 'Assess efficacy of ARD-404 versus shared control', endpoint_ids: ['EP1'] }];

test('[M01-04] platform operations create a draft arm; a sponsor cannot', async () => {
  const denied = await api.call('POST', `/v1/platforms/${plat}/arms`, { as: 'demo|arden', body: { code: 'ARM-D', name: 'x', intervention_type: 'drug' } });
  assert.equal(denied.status, 403);
  const r = await api.call('POST', `/v1/platforms/${plat}/arms`, { as: 'demo|ops', body: { code: 'ARM-D', name: 'ARD-404 oral', intervention_type: 'drug' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'draft');
  armId = r.body.id;
  const ev = (await api.admin.query("select type from core.event_outbox where arm_id = $1", [armId])).rows.map(x => x.type);
  assert.deepEqual(ev, ['arm.created']);
});

test('[M01-01] a draft appendix is edited section by section with validated, structured content', async () => {
  const d = await api.call('POST', `/v1/arms/${armId}/appendix-versions`, { as: 'demo|reg', body: { version_label: '1.0' } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  draftId = d.body.id;
  const noReason = await api.call('PUT', `/v1/appendix-versions/${draftId}/sections/objectives`, { as: 'demo|reg', body: { content: objectives } });
  assert.equal(noReason.status, 400);
  const ok = await api.call('PUT', `/v1/appendix-versions/${draftId}/sections/objectives`, { as: 'demo|reg', reason: 'initial objectives', body: { content: objectives } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.usdm.objectives, objectives);
  const bad = await api.call('PUT', `/v1/appendix-versions/${draftId}/sections/objectives`, { as: 'demo|reg', reason: 'x',
    body: { content: [{ id: 'OBJ1', level: 'primary-ish', text: '' }] } });
  assert.equal(bad.status, 422);
  const unknown = await api.call('PUT', `/v1/appendix-versions/${draftId}/sections/budget`, { as: 'demo|reg', reason: 'x', body: { content: {} } });
  assert.equal(unknown.status, 404);
});

test('[M01-04] an arm cannot be approved before its appendix is approved', async () => {
  const r = await api.call('POST', `/v1/arms/${armId}/status`, { as: 'demo|ops', reason: 'approve arm', body: { to: 'approved' } });
  assert.equal(r.status, 422);
  assert.match(r.body.error.message, /approved appendix/);
});

test('[DM-02] only drafts can be edited; a version in review is locked until returned', async () => {
  assert.equal((await api.call('POST', `/v1/appendix-versions/${draftId}/submit`, { as: 'demo|reg', reason: 'ready for review' })).status, 200);
  const r = await api.call('PUT', `/v1/appendix-versions/${draftId}/sections/objectives`, { as: 'demo|reg', reason: 'late edit', body: { content: objectives } });
  assert.equal(r.status, 409);
});

test('[IAM-05] the author of a version cannot approve it', async () => {
  const r = await api.call('POST', `/v1/appendix-versions/${draftId}/approve`, { as: 'demo|reg', reason: 'approve', body: SIGN });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.match(r.body.error.message, /IAM-05/);
});

test('[CMP-02][AI-05] approval needs re-authentication by a person; agents cannot sign', async () => {
  const wrong = await api.call('POST', `/v1/appendix-versions/${draftId}/approve`, { as: 'demo|admin', reason: 'approve', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  const agent = await sign({ sub: 'agent:protocol-author', actor_type: 'agent', email: 'agent@x', roles: ['platform_admin'],
    platform_ids: [plat], arm_scopes: '*', site_scopes: '*' });
  const byAgent = await api.call('POST', `/v1/appendix-versions/${draftId}/approve`, { token: agent, reason: 'approve', body: SIGN });
  assert.equal(byAgent.status, 403);
});

test('[CMP-02][DM-02] a signed approval freezes the version and emits the approval event', async () => {
  const r = await api.call('POST', `/v1/appendix-versions/${draftId}/approve`, { as: 'demo|admin', reason: 'approve appendix 1.0', body: SIGN });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'approved');
  assert.match(r.body.signature.target_hash, /^[0-9a-f]{64}$/);
  const sig = (await api.admin.query('select signer_sub, meaning, auth_method from core.signature where id = $1', [r.body.signature.id])).rows[0];
  assert.deepEqual(sig, { signer_sub: 'demo|admin', meaning: 'approval', auth_method: 'reauth_mfa' });
  const ev = (await api.admin.query("select type from core.event_outbox where subject = $1", [`arm_appendix_version/${draftId}`])).rows;
  assert.deepEqual(ev.map(x => x.type), ['arm.appendix.version.approved']);
  const frozen = await api.admin.query("select set_config('trialops.change_reason','x',false)");
  assert.ok(frozen);
  await assert.rejects(api.admin.query("update core.arm_appendix_version set usdm = '{}' where id = $1", [draftId]), /immutable/);
});

test('[M01-04] with an approved appendix the arm goes approved -> active and changes stage', async () => {
  assert.equal((await api.call('POST', `/v1/arms/${armId}/status`, { as: 'demo|ops', reason: 'appendix approved', body: { to: 'approved' } })).status, 200);
  const active = await api.call('POST', `/v1/arms/${armId}/status`, { as: 'demo|ops', reason: 'go live', body: { to: 'active' } });
  assert.equal(active.body.status, 'active');
  const st = await api.call('POST', `/v1/arms/${armId}/stage`, { as: 'demo|ops', reason: 'start', body: { to_stage: 'dose_finding' } });
  assert.equal(st.status, 200);
  const detail = await api.call('GET', `/v1/arms/${armId}`, { as: 'demo|ops' });
  assert.deepEqual(detail.body.stage_history.map((x: any) => x.to_stage), ['dose_finding']);
  assert.equal((await api.call('POST', `/v1/arms/${armId}/status`, { as: 'demo|ops', reason: 'x', body: { to: 'draft' } })).status, 400);
});

test('[M01-01] a new Master Protocol draft starts from the approved content and shows a section diff', async () => {
  const d = await api.call('POST', `/v1/platforms/${plat}/protocol-versions`, { as: 'demo|reg', body: { version_label: '1.1' } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.deepEqual(Object.keys(d.body.usdm), ['study']);
  await api.call('PUT', `/v1/protocol-versions/${d.body.id}/sections/synopsis`, { as: 'demo|reg', reason: 'add synopsis',
    body: { content: { title: 'PLAT-001 Master Protocol', phase: 'phase2' } } });
  const diff = await api.call('GET', `/v1/protocol-versions/${d.body.id}/diff`, { as: 'demo|reg' });
  assert.deepEqual(diff.body.sections.map((s: any) => [s.section, s.change]), [['synopsis', 'added']]);
});

test('[IAM-03] a sponsor cannot read another sponsor arm or its appendix', async () => {
  assert.equal((await api.call('GET', `/v1/arms/${armId}`, { as: 'demo|arden' })).status, 404);
  assert.equal((await api.call('GET', `/v1/appendix-versions/${draftId}`, { as: 'demo|arden' })).status, 404);
});
