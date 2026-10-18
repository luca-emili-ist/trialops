import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider, DEMO_SPONSOR_DOCUMENTS } from '@trialops/ai-runtime';
import { startApi, platformId, type Api } from './_helpers.ts';

let api: Api; let plat: string; let merid: string;
before(async () => {
  api = await startApi({ ai: createAiRuntime({ provider: replayProvider() }) });
  plat = await platformId(api.admin);
  merid = (await api.admin.query("select id from core.organization where name = 'Meridian Pharma'")).rows[0].id;
});
after(async () => api.close());

const wizard = async (code: string) => {
  const r = await api.call('POST', `/v1/platforms/${plat}/arm-wizard`, { as: 'demo|ops', body: {
    arm: { code, name: `MRD-12 (${code})`, sponsor_org_id: merid, intervention_type: 'drug', has_prior_human_data: true },
    sponsor_documents: DEMO_SPONSOR_DOCUMENTS } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { arm: { id: string }; agent_tasks: { id: string }[] };
};
const monitoring = async (as = 'demo|qa') => {
  const r = await api.call('GET', `/v1/ai/monitoring?platform_id=${plat}`, { as });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return Object.fromEntries(r.body.items.map((i: any) => [i.task_type, i]));
};
const ledger = (task_type: string, outcome: string, extra: { tokens?: number; review?: string; error?: string } = {}) =>
  api.admin.query(`insert into core.ai_request(platform_id, task_type, data_class, provider, model, model_version, input_sha256, outcome,
      output_tokens, review_decision, reviewer_sub, validation_error)
    values ($1, $2, 'INTERNAL', 'replay', 'claude-opus-5-5', 'claude-opus-5-5', repeat('0', 64), $3, $4, $5, $6, $7)`,
    [plat, task_type, outcome, extra.tokens ?? null, extra.review ?? null, extra.review ? 'demo|ops' : null, extra.error ?? null]);

test('[AI-10] monitoring per task type is for QA auditors and platform admins, and starts in normal mode', async () => {
  assert.equal((await api.call('GET', `/v1/ai/monitoring?platform_id=${plat}`, { as: 'demo|cra' })).status, 403);
  const m = await monitoring();
  assert.deepEqual(Object.keys(m).sort(), ['arm.onboarding.plan', 'protocol.appendix.draft']);
  for (const i of Object.values(m) as any[]) {
    assert.equal(i.mode, 'normal');
    assert.equal(i.breach, false);
  }
  assert.deepEqual(m['protocol.appendix.draft'].rules.map((r: any) => [r.metric, r.max, r.min_sample]), [['edit_rate', 0.5, 20], ['unsupported_items', 0, 1]]);
});

test('[AI-10] edit rate over the last 20 reviews, unsupported items and drift are computed from the ledger and the reviews', async () => {
  for (let i = 0; i < 20; i++) await ledger('protocol.appendix.draft', 'success', { tokens: 100, review: i < 12 ? 'edited' : i < 18 ? 'accepted' : 'rejected' });
  for (let i = 0; i < 20; i++) await ledger('protocol.appendix.draft', 'success', { tokens: 300 });
  let a = (await monitoring())['protocol.appendix.draft'];
  assert.deepEqual([a.metrics.reviewed, a.metrics.edited, a.metrics.accepted, a.metrics.rejected], [20, 12, 6, 2]);
  assert.deepEqual([a.metrics.edit_rate, a.metrics.acceptance_rate, a.metrics.rejection_rate], [0.6, 0.3, 0.1]);
  assert.equal(a.drift.signal, 'drift');
  assert.equal(a.drift.output_tokens_change, 2);
  assert.deepEqual(a.rules.map((r: any) => [r.metric, r.breach]), [['edit_rate', true], ['unsupported_items', false]]);
  await ledger('protocol.appendix.draft', 'validation_failed', { error: 'citation: citation check failed (AI-04): objectives OBJ2: no source' });
  a = (await monitoring())['protocol.appendix.draft'];
  assert.equal(a.metrics.unsupported_items, 1);
  assert.equal(a.metrics.validation_failure_rate, Math.round((1 / 41) * 10000) / 10000);
  assert.deepEqual(a.rules.map((r: any) => r.breach), [true, true]);
});

test('[AI-10] evaluation sends a crossed task type to suggestion-only, audited, and the agent then flags its proposal', async () => {
  assert.equal((await api.call('POST', '/v1/ai/monitoring/evaluate', { as: 'demo|qa', body: { platform_id: plat } })).status, 403);
  const r = await api.call('POST', '/v1/ai/monitoring/evaluate', { as: 'demo|admin', body: { platform_id: plat } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.switched, ['protocol.appendix.draft']);
  const a = r.body.items.find((i: any) => i.task_type === 'protocol.appendix.draft');
  assert.equal(a.mode, 'suggestion_only');
  assert.match(a.state.reason, /AI-10 threshold crossed: edit_rate 0.6 > 0.5 \(n=20\); unsupported_items 1 > 0/);
  assert.equal(a.state.changed_by, 'demo|admin');
  const audit = (await api.admin.query(`select e.action, e.actor_sub, e.new_row->>'mode' mode from core.audit_event e
    where e.table_name = 'ai_task_type_state' order by seq`)).rows;
  assert.deepEqual(audit, [{ action: 'INSERT', actor_sub: 'demo|admin', mode: 'suggestion_only' }]);
  // metrics restart from the change of state, so the old failures do not count twice
  const after = (await monitoring())['protocol.appendix.draft'];
  assert.equal(after.metrics.calls, 0);
  const w = await wizard('ARM-M1');
  const { job } = await api.job('POST', `/v1/tasks/${w.agent_tasks[0]!.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(job.status, 'completed', JSON.stringify(job));
  const diff = await api.call('GET', `/v1/tasks/${w.agent_tasks[0]!.id}/proposal-diff`, { as: 'demo|ops' });
  assert.equal(diff.body.monitoring_mode, 'suggestion_only');
});

test('[AI-10] the planner rule: above 30% of generated tasks cancelled or reassigned it falls back to suggestion-only', async () => {
  const runPlanner = async (code: string) => {
    const w = await wizard(code);
    const { job } = await api.job('POST', `/v1/tasks/${w.agent_tasks[1]!.id}/run-agent`, { as: 'demo|ops' });
    assert.equal(job.status, 'completed', JSON.stringify(job));
    return { w, job };
  };
  const first = await runPlanner('ARM-M2');
  assert.equal(first.job.result.tasks_created, 9);
  const ids = (await api.admin.query("select id from core.task where arm_id = $1 and assignee_kind = 'role' order by created_at", [first.w.arm.id])).rows.map(r => r.id);
  await api.admin.query("update core.task set state = 'cancelled' where id = any($1)", [ids.slice(0, 4)]);
  let p = (await monitoring())['arm.onboarding.plan'];
  assert.deepEqual([p.metrics.generated_tasks, p.metrics.generated_tasks_cancelled], [9, 4]);
  assert.equal(p.rules[0].breach, false, 'below the minimum sample of 10 generated tasks');
  const second = await runPlanner('ARM-M3');
  const ids2 = (await api.admin.query("select id, assignee from core.task where arm_id = $1 and assignee_kind = 'role' order by created_at", [second.w.arm.id])).rows;
  await api.admin.query("update core.task set assignee = 'ctm' where id = $1 and assignee <> 'ctm'", [ids2.find(t => t.assignee !== 'ctm')!.id]);
  await api.admin.query("update core.task set state = 'cancelled' where id = $1", [ids2.at(-1)!.id]);
  p = (await monitoring())['arm.onboarding.plan'];
  assert.deepEqual([p.metrics.generated_tasks, p.metrics.generated_tasks_cancelled, p.metrics.generated_tasks_reassigned], [18, 5, 1]);
  assert.equal(p.metrics.generated_tasks_cancelled_or_reassigned_rate, Math.round((6 / 18) * 10000) / 10000);
  assert.equal(p.rules[0].breach, true);
  const r = await api.call('POST', '/v1/ai/monitoring/evaluate', { as: 'demo|admin', body: { platform_id: plat } });
  assert.deepEqual(r.body.switched, ['arm.onboarding.plan']);
});

test('[AI-10][AI-05] in suggestion-only the planner creates nothing: a person confirms the plan, then the tasks exist', async () => {
  const w = await wizard('ARM-M4');
  const planTask = w.agent_tasks[1]!.id;
  const { job } = await api.job('POST', `/v1/tasks/${planTask}/run-agent`, { as: 'demo|ops' });
  assert.equal(job.status, 'completed', JSON.stringify(job));
  assert.deepEqual([job.result.tasks_created, job.result.suggestion_only], [0, true]);
  const t = (await api.call('GET', `/v1/tasks/${planTask}`, { as: 'demo|ops' })).body;
  assert.equal(t.state, 'waiting_review');
  assert.equal(t.outputs.proposal.tasks.length, 9);
  const count = async () => (await api.admin.query("select count(*)::int n from core.task where arm_id = $1 and assignee_kind = 'role'", [w.arm.id])).rows[0].n;
  assert.equal(await count(), 0);
  assert.equal((await api.call('POST', `/v1/tasks/${planTask}/confirm-plan`, { as: 'demo|ops', body: { decision: 'accept' } })).status, 400, 'reason required');
  assert.equal((await api.call('POST', `/v1/tasks/${planTask}/confirm-plan`, { as: 'demo|cra', reason: 'x', body: { decision: 'accept' } })).status, 403);
  const c = await api.call('POST', `/v1/tasks/${planTask}/confirm-plan`, { as: 'demo|ops', reason: 'plan checked against the arm', body: { decision: 'accept' } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.tasks_created, 9);
  assert.equal(c.body.task.state, 'completed');
  assert.equal(await count(), 9);
  const row = (await api.admin.query('select review_decision, reviewer_sub from core.ai_request where id = $1', [t.outputs.ai_request_id])).rows[0];
  assert.deepEqual(row, { review_decision: 'accepted', reviewer_sub: 'demo|ops' });
  assert.equal((await api.call('POST', `/v1/tasks/${planTask}/confirm-plan`, { as: 'demo|ops', reason: 'again', body: { decision: 'accept' } })).status, 409);
  // a new evaluation never brings the task type back to normal by itself
  const e = await api.call('POST', '/v1/ai/monitoring/evaluate', { as: 'demo|admin', body: { platform_id: plat } });
  assert.deepEqual(e.body.switched, []);
  assert.equal(e.body.items.find((i: any) => i.task_type === 'arm.onboarding.plan').mode, 'suggestion_only');
});

test('[AI-10] back to normal only by an explicit decision of a platform admin, with a reason', async () => {
  const body = { platform_id: plat, task_type: 'arm.onboarding.plan', mode: 'normal' };
  assert.equal((await api.call('POST', '/v1/ai/monitoring/mode', { as: 'demo|admin', body })).status, 400);
  assert.equal((await api.call('POST', '/v1/ai/monitoring/mode', { as: 'demo|ops', reason: 'x', body })).status, 403);
  assert.equal((await api.call('POST', '/v1/ai/monitoring/mode', { as: 'demo|admin', reason: 'x', body: { ...body, task_type: 'free.chat' } })).status, 422);
  const r = await api.call('POST', '/v1/ai/monitoring/mode', { as: 'demo|admin', reason: 'cancellations were a data clean-up, not planner errors', body });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'normal');
  assert.equal(r.body.state.source, 'manual');
  const audit = (await api.admin.query(`select reason from core.audit_event where table_name = 'ai_task_type_state' and action = 'UPDATE' order by seq desc limit 1`)).rows[0];
  assert.equal(audit.reason, 'cancellations were a data clean-up, not planner errors');
  const w = await wizard('ARM-M5');
  const { job } = await api.job('POST', `/v1/tasks/${w.agent_tasks[1]!.id}/run-agent`, { as: 'demo|ops' });
  assert.equal(job.result.tasks_created, 9, 'normal mode: the planner creates the tasks again');
});
