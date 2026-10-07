import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider } from '@trialops/ai-runtime';
import { startApi, platformId, type Api } from './_helpers.ts';

let api: Api; let plat: string; let armB: string;
before(async () => {
  api = await startApi({ ai: createAiRuntime({ provider: replayProvider() }) });
  plat = await platformId(api.admin);
  armB = (await api.admin.query("select id from core.arm where code = 'ARM-B'")).rows[0].id;
});
after(async () => api.close());

test('[AI-01][AI-06][AI-09] POST /api/ai/tasks queues a registered task as a job and records the call in the ledger', async () => {
  const { accepted, job } = await api.job('POST', '/api/ai/tasks', { as: 'demo|ops',
    body: { task_type: 'arm.onboarding.plan', data_class: 'INTERNAL', input: { arm: 'ARM-B' }, platform_id: plat, arm_id: armB } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.status, 'queued');
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const r = { body: job.result };
  assert.equal(job.ai_request_id, r.body.ai_request_id);
  assert.equal(r.body.outcome, 'success');
  assert.ok(Array.isArray(r.body.output.tasks));
  const row = (await api.admin.query('select * from core.ai_request where id = $1', [r.body.ai_request_id])).rows[0];
  assert.equal(row.requested_by, 'demo|ops');
  assert.equal(row.provider, 'replay');
  assert.equal(row.model, 'claude-opus-5-5');
  assert.equal(row.prompt_version, 1);
  const audit = (await api.admin.query("select action from core.audit_event where table_name = 'ai_request' and record_id = $1", [row.id])).rows;
  assert.deepEqual(audit.map(a => a.action), ['INSERT']);
});

test('[AI-01] unknown task types and unapproved data classes are refused before any call', async () => {
  const before = (await api.admin.query('select (select count(*) from core.ai_request) + (select count(*) from core.ai_job) n')).rows[0].n;
  assert.equal((await api.call('POST', '/api/ai/tasks', { as: 'demo|ops', body: { task_type: 'free.chat', data_class: 'PUBLIC', input: {} } })).status, 422);
  assert.equal((await api.call('POST', '/api/ai/tasks', { as: 'demo|ops',
    body: { task_type: 'arm.onboarding.plan', data_class: 'CLINICAL_PSEUDONYMIZED', input: {} } })).status, 422);
  assert.equal((await api.admin.query('select (select count(*) from core.ai_request) + (select count(*) from core.ai_job) n')).rows[0].n, before,
    'nothing queued, nothing called');
});

test('[AI-06][IAM-03] the ledger is visible within the perimeter only', async () => {
  const ops = await api.call('GET', `/v1/platforms/${plat}/ai-requests`, { as: 'demo|ops' });
  assert.ok(ops.body.items.length >= 1);
  const sponsor = await api.call('GET', `/v1/platforms/${plat}/ai-requests`, { as: 'demo|arden' });
  assert.deepEqual(sponsor.body.items, []);
});

test('[AI-06][AI-05] a ledger row is immutable except for one human review decision', async () => {
  const id = (await api.admin.query('select id from core.ai_request limit 1')).rows[0].id;
  await api.admin.query('begin');
  await api.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'agent:x', actor_type: 'agent' })]);
  await assert.rejects(api.admin.query("update core.ai_request set review_decision = 'accepted', reviewer_sub = 'agent:x' where id = $1", [id]), /only a person/);
  await api.admin.query('rollback');
  await assert.rejects(api.admin.query("update core.ai_request set outcome = 'error' where id = $1", [id]), /immutable/);
  await api.admin.query("update core.ai_request set review_decision = 'accepted', reviewer_sub = 'demo|admin' where id = $1", [id]);
  await assert.rejects(api.admin.query("update core.ai_request set review_decision = 'rejected', reviewer_sub = 'demo|admin' where id = $1", [id]), /already recorded/);
  await assert.rejects(api.admin.query('delete from core.ai_request where id = $1', [id]), /append-only/);
});

test('[AI-01] the task type registry is published with model and prompt versions', async () => {
  const r = await api.call('GET', '/v1/ai/task-types', { as: 'demo|qa' });
  assert.deepEqual(r.body.items.map((t: any) => [t.task_type, t.model, t.prompt_version]).sort(),
    [['arm.onboarding.plan', 'claude-opus-5-5', 1], ['protocol.appendix.draft', 'claude-opus-5-5', 1]]);
});
