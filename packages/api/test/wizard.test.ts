import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider } from '@trialops/ai-runtime';
import { startApi, sign, platformId, DEMO_PASSWORD, type Api } from './_helpers.ts';

let api: Api; let plat: string; let merid: string;
let arm: any; let draftTask: any; let planTask: any;
before(async () => {
  api = await startApi({ ai: createAiRuntime({ provider: replayProvider() }) });
  plat = await platformId(api.admin);
  merid = (await api.admin.query("select id from core.organization where name = 'Meridian Pharma'")).rows[0].id;
});
after(async () => api.close());

const docs = [{ ref: 'SPONSOR-BRIEF-D', title: 'Sponsor briefing (synthetic)', text: 'The recommended phase 2 dose is 40 mg once daily.' }];
const wizard = (code: string) => api.call('POST', `/v1/platforms/${plat}/arm-wizard`, { as: 'demo|ops',
  body: { arm: { code, name: `MRD-12 (${code})`, sponsor_org_id: merid, intervention_type: 'drug', has_prior_human_data: true }, sponsor_documents: docs } });

test('[M01-02] the wizard creates a draft arm, an empty appendix draft and one task per agent', async () => {
  assert.equal((await api.call('POST', `/v1/platforms/${plat}/arm-wizard`, { as: 'demo|arden',
    body: { arm: { code: 'ARM-X', name: 'x', intervention_type: 'drug' } } })).status, 403);
  const r = await wizard('ARM-D');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  arm = r.body.arm;
  assert.equal(arm.status, 'draft');
  assert.equal(r.body.appendix_version.status, 'draft');
  [draftTask, planTask] = r.body.agent_tasks;
  assert.deepEqual([draftTask.assignee, draftTask.gxp_impact, draftTask.state], ['agent:protocol-author', true, 'assigned']);
  assert.deepEqual([planTask.assignee, planTask.gxp_impact, planTask.state], ['agent:onboarding-planner', false, 'assigned']);
});

test('[M01-02][IAM-07] the Protocol author works under its own identity and leaves a proposal waiting for review', async () => {
  const r = await api.call('POST', `/v1/tasks/${draftTask.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.outcome, 'success');
  const t = (await api.call('GET', `/v1/tasks/${draftTask.id}`, { as: 'demo|ops' })).body;
  assert.equal(t.state, 'waiting_review');
  assert.deepEqual(t.events.map((e: any) => [e.to_state, e.actor_type]),
    [['assigned', 'user'], ['in_progress', 'agent'], ['waiting_review', 'agent']]);
  const ledger = (await api.admin.query('select requested_by, task_id from core.ai_request where id = $1', [r.body.ai_request_id])).rows[0];
  assert.deepEqual(ledger, { requested_by: 'agent:protocol-author', task_id: draftTask.id });
  const appendix = (await api.admin.query('select usdm from core.arm_appendix_version where arm_id = $1', [arm.id])).rows[0];
  assert.deepEqual(appendix.usdm, {}, 'the proposal must not touch the appendix before review');
});

test('[M01-02] the Onboarding planner creates the operational tasks automatically', async () => {
  const r = await api.call('POST', `/v1/tasks/${planTask.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tasks_created, 9);
  const tasks = (await api.call('GET', `/v1/platforms/${plat}/tasks?arm_id=${arm.id}`, { as: 'demo|ops' })).body.items;
  const areas = new Set(tasks.filter((t: any) => t.assignee_kind === 'role').map((t: any) => t.type.split('.')[0]));
  for (const a of ['contract', 'irb', 'ind', 'supply', 'edc', 'site', 'training']) assert.ok(areas.has(a), `missing ${a}`);
  assert.equal(tasks.filter((t: any) => t.type === 'site.activation.start' && t.site_id).length, 3);
  const plan = (await api.call('GET', `/v1/tasks/${planTask.id}`, { as: 'demo|ops' })).body;
  assert.equal(plan.state, 'completed');
  assert.equal(plan.outputs.checklist.length, 7);
  const mine = (await api.call('GET', `/v1/platforms/${plat}/tasks?mine=true&arm_id=${arm.id}`, { as: 'demo|reg' })).body.items;
  assert.deepEqual([...new Set(mine.map((t: any) => t.assignee))], ['regulatory_lead']);
});

test('[AI-05] the reviewer sees the diff and the cited sources before deciding', async () => {
  const d = await api.call('GET', `/v1/tasks/${draftTask.id}/proposal-diff`, { as: 'demo|ops' });
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.sections.map((s: any) => [s.section, s.change]),
    [['endpoints', 'added'], ['interventions', 'added'], ['objectives', 'added'], ['population', 'added'], ['schedule', 'added'], ['synopsis', 'added']]);
  assert.ok(d.body.sources.every((s: any) => s.ref && s.quote));
});

test('[AI-05][APP-TK-04] an agent cannot accept its own proposal', async () => {
  const agent = await sign({ sub: 'agent:protocol-author', actor_type: 'agent', email: 'a@x', roles: ['platform_ops_manager'],
    platform_ids: [plat], arm_scopes: '*', site_scopes: '*' });
  const r = await api.call('POST', `/v1/tasks/${draftTask.id}/review`, { token: agent, reason: 'self', body: { decision: 'accept', password: DEMO_PASSWORD } });
  assert.equal(r.status, 403);
});

test('[AI-05][CMP-02] a person accepts with a signature: the appendix gets the content and goes to review', async () => {
  const bad = await api.call('POST', `/v1/tasks/${draftTask.id}/review`, { as: 'demo|ops', reason: 'reviewed', body: { decision: 'accept', password: 'x' } });
  assert.equal(bad.status, 401);
  const r = await api.call('POST', `/v1/tasks/${draftTask.id}/review`, { as: 'demo|ops', reason: 'proposal reviewed against sponsor brief',
    body: { decision: 'accept', password: DEMO_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.task.state, 'completed');
  assert.equal(r.body.signature.target_hash.length, 64);
  assert.equal(r.body.appendix_version.status, 'in_review');
  assert.equal(r.body.appendix_version.usdm.objectives[0].id, 'OBJ1');
  const ledger = (await api.admin.query("select review_decision, reviewer_sub from core.ai_request where task_type = 'protocol.appendix.draft' and task_id = $1",
    [draftTask.id])).rows[0];
  assert.deepEqual(ledger, { review_decision: 'accepted', reviewer_sub: 'demo|ops' });
});

test('[M01-02][IAM-05] another person approves the appendix and the arm is ready within one working day', async () => {
  const appendixId = draftTask.inputs.appendix_version_id;
  const r = await api.call('POST', `/v1/appendix-versions/${appendixId}/approve`, { as: 'demo|reg', reason: 'appendix approved', body: { password: DEMO_PASSWORD } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await api.call('POST', `/v1/arms/${arm.id}/status`, { as: 'demo|ops', reason: 'appendix approved', body: { to: 'approved' } });
  assert.equal(a.body.status, 'approved');
  const hours = (Date.parse(a.body.updated_at) - Date.parse(arm.created_at)) / 36e5;
  assert.ok(hours < 8, `onboarding to approval took ${hours} h`);
});

test('[AI-05] edits and rejections are recorded and measured per task type', async () => {
  const e = (await wizard('ARM-E')).body;
  await api.call('POST', `/v1/tasks/${e.agent_tasks[0].id}/run-agent`, { as: 'demo|ops' });
  const proposal = (await api.call('GET', `/v1/tasks/${e.agent_tasks[0].id}`, { as: 'demo|ops' })).body.outputs.proposal.sections;
  const edited = { ...proposal, synopsis: { ...proposal.synopsis, phase: 'phase2_3' } };
  const er = await api.call('POST', `/v1/tasks/${e.agent_tasks[0].id}/review`, { as: 'demo|ops', reason: 'phase corrected',
    body: { decision: 'edit', sections: edited, password: DEMO_PASSWORD } });
  assert.equal(er.status, 200, JSON.stringify(er.body));
  assert.deepEqual(er.body.task.outputs.edits.map((x: any) => x.section), ['synopsis']);
  const f = (await wizard('ARM-F')).body;
  await api.call('POST', `/v1/tasks/${f.agent_tasks[0].id}/run-agent`, { as: 'demo|ops' });
  const rr = await api.call('POST', `/v1/tasks/${f.agent_tasks[0].id}/review`, { as: 'demo|ops', reason: 'not consistent with sponsor plan',
    body: { decision: 'reject', password: DEMO_PASSWORD } });
  assert.equal(rr.body.task.state, 'rejected');
  assert.equal(rr.body.appendix_version.status, 'draft');
  const stats = (await api.call('GET', `/v1/platforms/${plat}/ai-review-stats`, { as: 'demo|qa' })).body.items
    .find((s: any) => s.task_type === 'protocol.appendix.draft');
  assert.deepEqual([stats.calls, stats.accepted, stats.edited, stats.rejected], [3, 1, 1, 1]);
});
