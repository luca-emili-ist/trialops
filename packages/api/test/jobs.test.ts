// AI jobs (0014) with a recording dispatcher standing in for the Netlify background function: the test plays the worker
// by calling POST /v1/ai/jobs/{id}/execute exactly as netlify/functions/ai-worker-background.mts does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider } from '@trialops/ai-runtime';
import { startApi, platformId, type Api } from './_helpers.ts';

let api: Api; let plat: string; let merid: string; let task: any; let job: any;
const dispatched: { id: string; authorization?: string }[] = [];
let failDispatch = false;
before(async () => {
  api = await startApi({ ai: createAiRuntime({ provider: replayProvider() }), jobs: { async dispatch(id, h) {
    if (failDispatch) throw new Error('worker answered 401');
    dispatched.push({ id, authorization: h.authorization });
  } } });
  plat = await platformId(api.admin);
  merid = (await api.admin.query("select id from core.organization where name = 'Meridian Pharma'")).rows[0].id;
  const w = await api.call('POST', `/v1/platforms/${plat}/arm-wizard`, { as: 'demo|ops',
    body: { arm: { code: 'ARM-J', name: 'MRD-12 (ARM-J)', sponsor_org_id: merid, intervention_type: 'drug', has_prior_human_data: true },
      sponsor_documents: [{ ref: 'SPONSOR-BRIEF-D', title: 'Sponsor briefing (synthetic)', text: 'The dose is 40 mg once daily.' }] } });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  task = w.body.agent_tasks[0];
});
after(async () => api.close());

const ledgerRows = async () => (await api.admin.query('select count(*)::int n from core.ai_request')).rows[0].n;

test('[AI-09][M01-02] running an agent answers 202 at once with a queued job handed to the worker', async () => {
  const r = await api.call('POST', `/v1/tasks/${task.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  job = r.body;
  assert.equal(job.status, 'queued');
  assert.equal(job.kind, 'agent_run');
  assert.equal(job.requested_by, 'demo|ops');
  assert.equal(job.task_id, task.id);
  assert.ok(Date.parse(job.deadline_at) > Date.parse(job.created_at));
  assert.deepEqual(dispatched.map(d => d.id), [job.id]);
  assert.match(dispatched[0]!.authorization!, /^Bearer /, 'the worker runs with the token of the person who asked');
  const t = (await api.call('GET', `/v1/tasks/${task.id}`, { as: 'demo|ops' })).body;
  assert.equal(t.state, 'assigned', 'nothing runs before the worker picks the job');
  const again = await api.call('POST', `/v1/tasks/${task.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(again.body.id, job.id, 'a second click returns the job already queued');
  assert.equal(dispatched.length, 1);
});

test('[AI-09][IAM-07] only the requester can have its job run; the worker runs it once, the agent under its own identity', async () => {
  const other = await api.call('POST', `/v1/ai/jobs/${job.id}/execute`, { as: 'demo|admin' });
  assert.equal(other.status, 200);
  assert.equal(other.body.status, 'queued', 'another person cannot claim the job');
  const before = await ledgerRows();
  const r = await api.call('POST', `/v1/ai/jobs/${job.id}/execute`, { as: 'demo|ops' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'completed', JSON.stringify(r.body));
  assert.equal(r.body.result.outcome, 'success');
  assert.equal(r.body.result.agent, 'agent:protocol-author');
  assert.equal(r.body.ai_request_id, r.body.result.ai_request_id);
  assert.ok(r.body.started_at && r.body.finished_at);
  const ledger = (await api.admin.query('select requested_by, task_id from core.ai_request where id = $1', [r.body.ai_request_id])).rows[0];
  assert.deepEqual(ledger, { requested_by: 'agent:protocol-author', task_id: task.id });
  assert.equal((await api.call('GET', `/v1/tasks/${task.id}`, { as: 'demo|ops' })).body.state, 'waiting_review');
  const again = await api.call('POST', `/v1/ai/jobs/${job.id}/execute`, { as: 'demo|ops' });
  assert.equal(again.body.status, 'completed');
  assert.equal(await ledgerRows(), before + 1, 'a job is run once: one model call, one ledger row');
  const polled = await api.call('GET', `/v1/ai/jobs/${job.id}`, { as: 'demo|ops' });
  assert.equal(polled.body.status, 'completed');
  assert.equal((await api.call('GET', `/v1/ai/jobs/${job.id}`, { as: 'demo|arden' })).status, 404, 'outside the perimeter');
});

test('[AI-06][AI-09] a finished job is immutable, keeps no model input and cannot be deleted', async () => {
  const row = (await api.admin.query('select request from core.ai_job where id = $1', [job.id])).rows[0];
  assert.deepEqual(row.request, { task_id: task.id });
  await assert.rejects(api.admin.query("update core.ai_job set status = 'failed', error = 'x' where id = $1", [job.id]), /cannot change/);
  await assert.rejects(api.admin.query("update core.ai_job set requested_by = 'x' where id = $1", [job.id]), /only the status/);
  await assert.rejects(api.admin.query('delete from core.ai_job where id = $1', [job.id]), /physical delete/);
  const audit = (await api.admin.query("select action from core.audit_event where table_name = 'ai_job' and record_id = $1 order by seq", [job.id])).rows;
  assert.deepEqual(audit.map(a => a.action), ['INSERT', 'UPDATE', 'UPDATE']);
});

test('[AI-01][AI-09] the model input of a direct AI task is dropped from the job when it ends', async () => {
  const r = await api.call('POST', '/api/ai/tasks', { as: 'demo|ops',
    body: { task_type: 'arm.onboarding.plan', data_class: 'INTERNAL', input: { arm: 'ARM-J' }, platform_id: plat } });
  assert.equal(r.status, 202);
  const done = await api.call('POST', `/v1/ai/jobs/${r.body.id}/execute`, { as: 'demo|ops' });
  assert.equal(done.body.status, 'completed', JSON.stringify(done.body));
  const row = (await api.admin.query('select request from core.ai_job where id = $1', [r.body.id])).rows[0];
  assert.equal(row.request.input, undefined);
  assert.equal(row.request.task_type, 'arm.onboarding.plan');
});

test('[AI-09] a job not started within max_execution_time is closed as failed and never runs', async () => {
  await api.admin.query('begin');
  await api.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'demo|ops', actor_type: 'user' })]);
  const id = (await api.admin.query(`insert into core.ai_job(kind, request, platform_id, created_at, max_execution_s)
    values ('ai_task', '{"task_type":"arm.onboarding.plan","data_class":"INTERNAL","input":{}}', $1, clock_timestamp() - interval '1 hour', 60)
    returning id`, [plat])).rows[0].id;
  await api.admin.query('commit');
  const before = await ledgerRows();
  const r = await api.call('POST', `/v1/ai/jobs/${id}/execute`, { as: 'demo|ops' });
  assert.equal(r.body.status, 'failed');
  assert.match(r.body.error, /max_execution_time/);
  assert.equal(await ledgerRows(), before);
});

test('[AI-09] a job the worker cannot receive fails visibly instead of waiting forever', async () => {
  failDispatch = true;
  try {
    const w = await api.call('POST', `/v1/platforms/${plat}/arm-wizard`, { as: 'demo|ops',
      body: { arm: { code: 'ARM-K', name: 'x', sponsor_org_id: merid, intervention_type: 'drug' } } });
    const r = await api.call('POST', `/v1/tasks/${w.body.agent_tasks[1].id}/run-agent`, { as: 'demo|ops' });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'dispatch_failed');
    const j = (await api.admin.query('select status, error from core.ai_job where task_id = $1', [w.body.agent_tasks[1].id])).rows[0];
    assert.equal(j.status, 'failed');
    assert.match(j.error, /401/);
  } finally { failDispatch = false; }
});
