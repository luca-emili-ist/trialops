// AI-07 tool registry AUTO/CONFIRM/BLOCK and AI-08 internal policy engine with signed Agent Decision Records (0025).
// Scripted tests (risk high): the evidence is this file's output in test-results.xml (see docs/compliance/evidence).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider, DEMO_SPONSOR_DOCUMENTS } from '@trialops/ai-runtime';
import { startApi, platformId, type Api } from './_helpers.ts';
import { decisionSigner, decisionSignerFromEnv, verifyDecisionChain, type DecisionChainRow } from '../src/lib/decision-signing.ts';
import { generateSealKey } from '../src/lib/audit-seal.ts';
import { evaluate, invokeTool, RULES, type ToolEntry } from '../src/lib/policy-engine.ts';
import type { Db } from '../src/db.ts';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Services } from '../src/route.ts';

const key = generateSealKey();
const signer = decisionSigner(key.privateKeyPem);
const ai = createAiRuntime({ provider: replayProvider() });
let api: Api; let plat: string; let merid: string;
before(async () => {
  api = await startApi({ ai, decisions: signer });
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
const runAgent = async (taskId: string) => {
  const { job } = await api.job('POST', `/v1/tasks/${taskId}/run-agent`, { as: 'demo|ops' });
  assert.equal(job.status, 'completed', JSON.stringify(job));
  return job.result;
};
const setMode = (tool: string, mode: string, reason = `set ${tool} to ${mode} for the test`) =>
  api.call('POST', `/v1/ai/tools/${tool}/mode`, { as: 'demo|admin', reason, body: { platform_id: plat, mode } });
const decisions = async (q = '') => {
  const r = await api.call('GET', `/v1/ai/decisions?platform_id=${plat}${q}`, { as: 'demo|qa' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.items as any[];
};
const generated = async (armId: string) =>
  (await api.admin.query("select count(*)::int n from core.task where arm_id = $1 and assignee_kind = 'role'", [armId])).rows[0].n;

test('[AI-07] the registry lists every tool with mode, effect, agents and version; unregistered tools are BLOCK', async () => {
  assert.equal((await api.call('GET', `/v1/ai/tools?platform_id=${plat}`, { as: 'demo|cra' })).status, 403);
  const r = await api.call('GET', `/v1/ai/tools?platform_id=${plat}`, { as: 'demo|qa' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.default_for_unregistered, 'BLOCK');
  const t = Object.fromEntries(r.body.items.map((i: any) => [i.tool, i]));
  assert.deepEqual(Object.keys(t).sort(), ['onboarding.tasks.create', 'protocol.appendix.propose', 'protocol.appendix.write']);
  assert.deepEqual([t['protocol.appendix.propose'].mode, t['protocol.appendix.propose'].effect, t['protocol.appendix.propose'].agents], ['AUTO', 'proposal', ['protocol-author']]);
  assert.deepEqual([t['onboarding.tasks.create'].mode, t['onboarding.tasks.create'].effect], ['AUTO', 'operational_write']);
  assert.deepEqual([t['protocol.appendix.write'].mode, t['protocol.appendix.write'].effect, t['protocol.appendix.write'].executor], ['BLOCK', 'gxp_write', false]);
  for (const i of r.body.items) assert.deepEqual([i.scope, i.version], ['default', 1]);
  assert.equal((await api.call('GET', `/v1/ai/tools/free.shell/versions?platform_id=${plat}`, { as: 'demo|qa' })).status, 404);
});

test('[AI-07] only a platform admin changes a mode, with a reason; a GxP write is never AUTO; every change is a new audited version', async () => {
  const body = { platform_id: plat, mode: 'CONFIRM' };
  assert.equal((await api.call('POST', '/v1/ai/tools/onboarding.tasks.create/mode', { as: 'demo|admin', body })).status, 400, 'reason required');
  assert.equal((await api.call('POST', '/v1/ai/tools/onboarding.tasks.create/mode', { as: 'demo|ops', reason: 'x', body })).status, 403);
  assert.equal((await api.call('POST', '/v1/ai/tools/onboarding.tasks.create/mode', { as: 'demo|admin', reason: 'x', body: { ...body, mode: 'SOMETIMES' } })).status, 400);
  const gxp = await setMode('protocol.appendix.write', 'AUTO');
  assert.equal(gxp.status, 422);
  assert.match(gxp.body.error.message, /GxP write tool can never be AUTO/);
  const unknown = await setMode('free.shell', 'AUTO');
  assert.equal(unknown.status, 422);
  assert.match(unknown.body.error.message, /not registered/);
  const r = await setMode('onboarding.tasks.create', 'CONFIRM', 'planner output must be confirmed during the pilot');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.mode, r.body.version, r.body.platform_id, r.body.changed_by], ['CONFIRM', 1, plat, 'demo|admin']);
  const again = await setMode('onboarding.tasks.create', 'CONFIRM', 'no change');
  assert.equal(again.body.version, 1, 'same mode: nothing recorded');
  const v = await api.call('GET', `/v1/ai/tools/onboarding.tasks.create/versions?platform_id=${plat}`, { as: 'demo|qa' });
  assert.deepEqual(v.body.items.map((i: any) => [i.scope, i.version, i.mode]), [['default', 1, 'AUTO'], ['platform', 1, 'CONFIRM']]);
  const audit = (await api.admin.query(`select action, actor_sub, reason, new_row->>'mode' mode from core.audit_event
    where table_name = 'ai_tool' and new_row->>'platform_id' = $1 order by seq`, [plat])).rows;
  assert.deepEqual(audit, [{ action: 'INSERT', actor_sub: 'demo|admin', reason: 'planner output must be confirmed during the pilot', mode: 'CONFIRM' }]);
});

test('[AI-07][AI-08] CONFIRM: the planner leaves a pending action; nothing runs until a person with a confirm role confirms it', async () => {
  const w = await wizard('ARM-G1');
  const res = await runAgent(w.agent_tasks[1]!.id);
  assert.deepEqual([res.decision, res.tasks_created, res.rule_ids], ['REVIEW', 0, ['AI07-MODE-CONFIRM']]);
  assert.ok(res.pending_action_id);
  assert.equal(await generated(w.arm.id), 0);
  const task = (await api.call('GET', `/v1/tasks/${w.agent_tasks[1]!.id}`, { as: 'demo|ops' })).body;
  assert.equal(task.state, 'waiting_review');
  assert.equal(task.outputs.pending_action_id, res.pending_action_id);
  const list = await api.call('GET', `/v1/ai/pending-actions?platform_id=${plat}`, { as: 'demo|ops' });
  const p = list.body.items.find((i: any) => i.id === res.pending_action_id);
  assert.deepEqual([p.status, p.tool, p.agent_id, p.can_confirm, p.confirm_roles], ['pending', 'onboarding.tasks.create', 'onboarding-planner', true,
    ['platform_admin', 'platform_ops_manager']]);
  const path = `/v1/ai/pending-actions/${res.pending_action_id}/decide`;
  assert.equal((await api.call('POST', path, { as: 'demo|ops', body: { decision: 'confirm' } })).status, 400, 'reason required');
  const cra = await api.call('POST', path, { as: 'demo|cra', reason: 'x', body: { decision: 'confirm' } });
  assert.equal(cra.status, 403);
  assert.match(cra.body.error.message, /requires one of: platform_admin, platform_ops_manager/);
  const ok = await api.call('POST', path, { as: 'demo|ops', reason: 'plan checked against the arm', body: { decision: 'confirm' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.decision, ok.body.rule_ids, ok.body.pending_action.status, ok.body.pending_action.decided_by, ok.body.result.tasks_created],
    ['ALLOW', ['AI07-HUMAN-CONFIRMED'], 'executed', 'demo|ops', 9]);
  assert.equal(await generated(w.arm.id), 9);
  const done = (await api.call('GET', `/v1/tasks/${w.agent_tasks[1]!.id}`, { as: 'demo|ops' })).body;
  assert.deepEqual([done.state, done.outputs.decision, done.outputs.decided_by], ['completed', 'accepted', 'demo|ops']);
  assert.equal((await api.call('POST', path, { as: 'demo|ops', reason: 'again', body: { decision: 'confirm' } })).status, 409);
  // the two decisions of this action: the agent's REVIEW and the person's ALLOW, signed, with the same inputs hash
  const d = (await api.call('GET', `/v1/ai/pending-actions/${res.pending_action_id}`, { as: 'demo|ops' })).body.decisions;
  assert.deepEqual(d.map((x: any) => [x.decision, x.actor_sub, x.actor_type, x.signature_status, x.key_id]),
    [['REVIEW', 'agent:onboarding-planner', 'agent', 'signed', signer.keyId], ['ALLOW', 'demo|ops', 'user', 'signed', signer.keyId]]);
  assert.equal(d[0].inputs_sha256, d[1].inputs_sha256);
  assert.deepEqual([d[0].model, d[0].prompt_id, d[0].prompt_version, d[0].tool_mode], ['claude-opus-5-5', 'onboarding-planner', '1', 'CONFIRM']);
  const audit = (await api.admin.query(`select action, actor_sub, reason, new_row->>'status' status from core.audit_event
    where table_name = 'ai_pending_action' and record_id = $1 order by seq`, [res.pending_action_id])).rows;
  assert.deepEqual(audit.map(a => [a.action, a.actor_sub, a.status]), [['INSERT', 'agent:onboarding-planner', 'pending'], ['UPDATE', 'demo|ops', 'executed']]);
  assert.equal(audit[1].reason, 'plan checked against the arm');
});

test('[AI-07][AI-08] a rejected pending action runs nothing and is recorded as BLOCK by the person', async () => {
  const w = await wizard('ARM-G2');
  const res = await runAgent(w.agent_tasks[1]!.id);
  const r = await api.call('POST', `/v1/tasks/${w.agent_tasks[1]!.id}/confirm-plan`, { as: 'demo|admin', reason: 'sites not yet selected',
    body: { decision: 'reject' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.task.state, r.body.tasks_created, r.body.pending_action.status, r.body.decision], ['rejected', 0, 'rejected', 'BLOCK']);
  assert.equal(await generated(w.arm.id), 0);
  const d = await decisions(`&task_id=${w.agent_tasks[1]!.id}`);
  assert.deepEqual(d.map(x => [x.decision, x.rule_ids]).reverse(), [['REVIEW', ['AI07-MODE-CONFIRM']], ['BLOCK', ['AI07-HUMAN-REJECTED']]]);
  const ledger = (await api.admin.query('select review_decision from core.ai_request where id = $1', [res.ai_request_id])).rows[0];
  assert.equal(ledger.review_decision, 'rejected');
});

test('[AI-07][AI-08] a tool set to BLOCK after the request is refused even when a person confirms', async () => {
  const w = await wizard('ARM-G3');
  const res = await runAgent(w.agent_tasks[1]!.id);
  assert.equal((await setMode('onboarding.tasks.create', 'BLOCK', 'planner suspended pending investigation')).status, 200);
  const r = await api.call('POST', `/v1/ai/pending-actions/${res.pending_action_id}/decide`, { as: 'demo|ops', reason: 'looks fine',
    body: { decision: 'confirm' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.decision, r.body.rule_ids, r.body.pending_action.status], ['BLOCK', ['AI07-MODE-BLOCK'], 'blocked']);
  assert.equal(await generated(w.arm.id), 0);
  // BLOCK at the agent's call: the job ends, nothing is created, the task says why
  const w2 = await wizard('ARM-G4');
  const res2 = await runAgent(w2.agent_tasks[1]!.id);
  assert.deepEqual([res2.outcome, res2.decision, res2.rule_ids, res2.pending_action_id], ['blocked', 'BLOCK', ['AI07-MODE-BLOCK'], null]);
  const t = (await api.call('GET', `/v1/tasks/${w2.agent_tasks[1]!.id}`, { as: 'demo|ops' })).body;
  assert.deepEqual([t.state, t.outputs.blocked, t.outputs.decision_record_id], ['in_progress', true, res2.decision_record_id]);
  assert.equal(await generated(w2.arm.id), 0);
  assert.equal((await setMode('onboarding.tasks.create', 'AUTO', 'investigation closed, planner back to automatic')).body.version, 3);
});

test('[AI-07][AI-08] AUTO: the agent acts and every call leaves an ALLOW record with model, prompt version and AI request', async () => {
  const w = await wizard('ARM-G5');
  const plan = await runAgent(w.agent_tasks[1]!.id);
  assert.deepEqual([plan.decision, plan.tasks_created, plan.rule_ids], ['ALLOW', 9, ['AI07-MODE-AUTO']]);
  const draft = await runAgent(w.agent_tasks[0]!.id);
  assert.deepEqual([draft.decision, draft.outcome], ['ALLOW', 'success']);
  const t = (await api.call('GET', `/v1/tasks/${w.agent_tasks[0]!.id}`, { as: 'demo|ops' })).body;
  assert.equal(t.state, 'waiting_review', 'the proposal still waits for review and signature (AI-05)');
  const d = (await decisions(`&task_id=${w.agent_tasks[0]!.id}`))[0];
  assert.deepEqual([d.tool, d.decision, d.agent_id, d.ai_request_id, d.model, d.prompt_id, d.prompt_version, d.signature_status],
    ['protocol.appendix.propose', 'ALLOW', 'protocol-author', draft.ai_request_id, 'claude-opus-5-5', 'protocol-author', '2', 'signed']);
  assert.match(d.rationale, /^trialops-policy\/1: /);
  // the record is in the audit trail too (0015) and cannot be changed
  const audit = (await api.admin.query("select count(*)::int n from core.audit_event where table_name = 'agent_decision_record' and record_id = $1", [d.id])).rows[0];
  assert.equal(audit.n, 1);
  await assert.rejects(api.admin.query("update core.agent_decision_record set decision = 'BLOCK' where id = $1", [d.id]), /append-only/);
  // suggestion-only (AI-10) turns an AUTO write into REVIEW
  assert.equal((await api.call('POST', '/v1/ai/monitoring/mode', { as: 'demo|admin', reason: 'watch the planner',
    body: { platform_id: plat, task_type: 'arm.onboarding.plan', mode: 'suggestion_only' } })).status, 200);
  const w2 = await wizard('ARM-G6');
  const s = await runAgent(w2.agent_tasks[1]!.id);
  assert.deepEqual([s.decision, s.rule_ids, s.suggestion_only], ['REVIEW', ['AI10-SUGGESTION-ONLY'], true]);
  const c = await api.call('POST', `/v1/tasks/${w2.agent_tasks[1]!.id}/confirm-plan`, { as: 'demo|ops', reason: 'checked', body: { decision: 'accept' } });
  assert.deepEqual([c.status, c.body.tasks_created, c.body.pending_action.status], [200, 9, 'executed']);
  await api.call('POST', '/v1/ai/monitoring/mode', { as: 'demo|admin', reason: 'back to normal after review',
    body: { platform_id: plat, task_type: 'arm.onboarding.plan', mode: 'normal' } });
});

test('[AI-07][AI-08] unregistered tools, BLOCK tools and tools of another agent are refused and recorded; people cannot invoke tools', async () => {
  const w = await wizard('ARM-G7');
  const services = { ai, decisions: signer } as Services;
  const asAgent = async <T>(agent: string, fn: (db: Db) => Promise<T>, actorType = 'agent'): Promise<T> => {
    await api.admin.query('begin');
    try {
      await api.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: actorType === 'agent' ? `agent:${agent}` : agent,
        actor_type: actorType, roles: actorType === 'agent' ? [] : ['platform_admin'], platform_ids: [plat], arm_scopes: '*', site_scopes: '*', blinding: 'blinded' })]);
      await api.admin.query('set local role authenticated');
      const out = await fn(api.admin as unknown as Db);
      await api.admin.query('commit');
      return out;
    } catch (e) { await api.admin.query('rollback'); throw e; }
  };
  const call = (tool: string, agent = 'protocol-author') => ({ agentId: agent, tool, platformId: plat, armId: w.arm.id, taskId: w.agent_tasks[0]!.id,
    args: { task_id: w.agent_tasks[0]!.id, sections: { synopsis: 'x' } } });
  const u = await asAgent('protocol-author', db => invokeTool(db, services, call('protocol.appendix.delete_all')));
  assert.deepEqual([u.decision, u.rule_ids, u.result], ['BLOCK', ['AI07-UNREGISTERED'], null]);
  const g = await asAgent('protocol-author', db => invokeTool(db, services, call('protocol.appendix.write')));
  assert.deepEqual([g.decision, g.rule_ids], ['BLOCK', ['AI07-MODE-BLOCK']]);
  const o = await asAgent('protocol-author', db => invokeTool(db, services, call('onboarding.tasks.create')));
  assert.deepEqual([o.decision, o.rule_ids], ['BLOCK', ['AI07-AGENT-NOT-ALLOWED']]);
  await assert.rejects(asAgent('demo|admin', db => invokeTool(db, services, call('protocol.appendix.propose')), 'user'), /invoked by agents/);
  const d = await decisions('&decision=BLOCK&tool=protocol.appendix.delete_all');
  assert.deepEqual([d.length, d[0].tool_version_id, d[0].tool_mode, d[0].signature_status], [1, null, null, 'signed']);
  const appendix = (await api.admin.query('select usdm from core.arm_appendix_version where arm_id = $1', [w.arm.id])).rows[0];
  assert.deepEqual(appendix.usdm, {}, 'nothing written');
  // nobody writes a decision record directly
  await api.admin.query('begin');
  await api.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'agent:protocol-author', actor_type: 'agent', platform_ids: [plat] })]);
  await api.admin.query('set local role authenticated');
  await assert.rejects(api.admin.query(`insert into core.agent_decision_record(agent_id, tool, platform_id, request, decision, policies_applied, rationale, record_sha256)
    values ('protocol-author', 'x', $1, '{}', 'ALLOW', '{x}', 'x', repeat('0', 64))`, [plat]), /permission denied/);
  await api.admin.query('rollback');
});

test('[AI-08] the policy rules are deterministic and ordered: unregistered, perimeter, BLOCK, agent, executor, person, GxP, AI-10, mode', () => {
  const e = (over: Partial<ToolEntry> = {}): ToolEntry => ({ id: 'i', platform_id: null, tool: 't', effect: 'operational_write', risk_level: 'low',
    agents: ['a'], confirm_roles: ['platform_admin'], mode: 'AUTO', version: 1, version_id: 'v', ...over });
  const base = { agentId: 'a', inPerimeter: true, hasExecutor: true };
  const cases: [Parameters<typeof evaluate>[0], string, string][] = [
    [{ ...base, entry: null }, 'BLOCK', 'AI07-UNREGISTERED'],
    [{ ...base, entry: e(), inPerimeter: false }, 'BLOCK', 'AI08-PERIMETER'],
    [{ ...base, entry: e({ mode: 'BLOCK' }), human: 'confirm' }, 'BLOCK', 'AI07-MODE-BLOCK'],
    [{ ...base, entry: e({ agents: ['b'] }) }, 'BLOCK', 'AI07-AGENT-NOT-ALLOWED'],
    [{ ...base, entry: e(), hasExecutor: false }, 'BLOCK', 'AI08-NO-EXECUTOR'],
    [{ ...base, entry: e({ mode: 'CONFIRM' }), human: 'reject' }, 'BLOCK', 'AI07-HUMAN-REJECTED'],
    [{ ...base, entry: e({ mode: 'CONFIRM' }), human: 'confirm' }, 'ALLOW', 'AI07-HUMAN-CONFIRMED'],
    [{ ...base, entry: e({ effect: 'gxp_write' }) }, 'REVIEW', 'AI07-GXP-NEVER-AUTO'],
    [{ ...base, entry: e(), taskTypeMode: 'suggestion_only' }, 'REVIEW', 'AI10-SUGGESTION-ONLY'],
    [{ ...base, entry: e({ effect: 'proposal' }), taskTypeMode: 'suggestion_only' }, 'ALLOW', 'AI07-MODE-AUTO'],
    [{ ...base, entry: e({ mode: 'CONFIRM' }) }, 'REVIEW', 'AI07-MODE-CONFIRM'],
    [{ ...base, entry: e() }, 'ALLOW', 'AI07-MODE-AUTO'],
  ];
  for (const [input, decision, rule] of cases) {
    const v = evaluate(input);
    assert.deepEqual([v.decision, v.rule_ids], [decision, [rule]], JSON.stringify(input));
    assert.equal(v.rationale, `trialops-policy/1: ${RULES[rule as keyof typeof RULES]}`);
    assert.deepEqual(evaluate(input), v, 'same input, same decision');
  }
});

test('[AI-08] the chain verifies: contiguous, linked, hashes and Ed25519 signatures; tampering of any kind is detected', async () => {
  assert.equal((await api.call('GET', '/v1/ai/decisions/verify', { as: 'demo|ops' })).status, 403);
  const v = await api.call('GET', '/v1/ai/decisions/verify', { as: 'demo|qa' });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.deepEqual([v.body.ok, v.body.problems, v.body.unsigned, v.body.signer.key_id], [true, [], 0, signer.keyId]);
  assert.ok(v.body.records >= 12 && v.body.signed === v.body.records, JSON.stringify(v.body));
  const rows = (await api.admin.query('select id, seq, prev_record_sha256, record_sha256, signed_payload, signature_ed25519, signature_status, key_id, decided_at from core.agent_decision_record where seq is not null order by seq')).rows as DecisionChainRow[];
  const keys = { [signer.keyId!]: signer.publicKeyPem! };
  assert.equal(verifyDecisionChain(rows, keys).ok, true);
  const tamper = (i: number, change: (r: DecisionChainRow) => DecisionChainRow) => verifyDecisionChain(rows.map((r, j) => (j === i ? change({ ...r }) : r)), keys).problems;
  assert.match(tamper(2, r => ({ ...r, signed_payload: r.signed_payload.replace('"decision":"', '"decision":"X') })).join(), /record hash does not match/);
  assert.match(tamper(2, r => ({ ...r, signature_ed25519: signer.sign('something else') })).join(), /invalid signature/);
  assert.match(tamper(3, r => ({ ...r, prev_record_sha256: '1'.repeat(64) })).join(), /not linked/);
  assert.match(verifyDecisionChain(rows.filter((_, j) => j !== 4), keys).problems.join(), /sequence gap/);
  const other = generateSealKey();
  assert.match(verifyDecisionChain(rows, { [other.keyId]: other.publicKeyPem }).problems.join(), /unknown key/);
  assert.match(verifyDecisionChain(rows, { [signer.keyId!]: other.publicKeyPem }).problems.join(), /does not match its id/);
});

test('[AI-08] the command-line verifier checks the chain against trusted keys kept outside the database; keygen writes a new key', () => {
  const cp = (api.admin as any).connectionParameters;
  const url = `postgres://${cp.user}:${cp.password}@${cp.host}:${cp.port}/${cp.database}`;
  const dir = mkdtempSync(join(tmpdir(), 'adr-'));
  const script = new URL('../../../scripts/decision-verify.mjs', import.meta.url).pathname;
  const run = (args: string[], extra: Record<string, string> = {}) => {
    try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { env: { ...process.env, DATABASE_URL: url, ...extra }, encoding: 'utf8' }) }; }
    catch (e) { const x = e as { status: number; stdout: string }; return { code: x.status, out: x.stdout }; }
  };
  const trusted = join(dir, 'pub.json');
  writeFileSync(trusted, JSON.stringify({ [signer.keyId!]: signer.publicKeyPem }));
  const ok = run(['verify'], { TRIALOPS_DECISION_PUBKEYS: trusted });
  assert.equal(ok.code, 0, ok.out);
  assert.deepEqual([JSON.parse(ok.out).ok, JSON.parse(ok.out).trusted_keys], [true, 'file']);
  const k = run(['keygen', join(dir, 'decision.pem')]);
  const [kid, pem] = Object.entries(JSON.parse(k.out))[0] as [string, string];
  assert.match(kid, /^[0-9a-f]{16}$/);
  assert.match(readFileSync(join(dir, 'decision.pem'), 'utf8'), /BEGIN PRIVATE KEY/);
  writeFileSync(trusted, JSON.stringify({ [kid]: pem }));
  const bad = run(['verify'], { TRIALOPS_DECISION_PUBKEYS: trusted });
  assert.equal(bad.code, 1);
  assert.match(JSON.parse(bad.out).problems.join(), /unknown key/);
});

test('[AI-08] without a signing key in production records are still written, marked unsigned and reported as an anomaly', async () => {
  assert.equal(decisionSignerFromEnv({ NETLIFY: 'true' }).mode, 'unsigned');
  assert.equal(decisionSignerFromEnv({ TRIALOPS_ENV: 'production' }).mode, 'unsigned');
  const dev = decisionSignerFromEnv({});
  assert.equal(dev.mode, 'ephemeral');
  assert.equal(decisionSignerFromEnv({}).keyId, dev.keyId, 'one ephemeral key per process');
  const configured = decisionSignerFromEnv({ NETLIFY: 'true', TRIALOPS_DECISION_SIGNING_KEY: Buffer.from(key.privateKeyPem).toString('base64') });
  assert.deepEqual([configured.mode, configured.keyId], ['configured', key.keyId]);
  assert.throws(() => decisionSigner(generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), /Ed25519/);
  const prod = await startApi({ ai, decisions: decisionSigner(null) });
  try {
    const p = await platformId(prod.admin);
    const m = await prod.call('GET', `/v1/ai/monitoring?platform_id=${p}`, { as: 'demo|qa' });
    assert.deepEqual([m.body.decision_records.signer.mode, m.body.decision_records.anomalies.length], ['unsigned', 1]);
    const w = await prod.call('POST', `/v1/platforms/${p}/arm-wizard`, { as: 'demo|ops', body: {
      arm: { code: 'ARM-U1', name: 'unsigned', sponsor_org_id: merid, intervention_type: 'drug', has_prior_human_data: true }, sponsor_documents: DEMO_SPONSOR_DOCUMENTS } });
    const { job } = await prod.job('POST', `/v1/tasks/${w.body.agent_tasks[1].id}/run-agent`, { as: 'demo|ops' });
    assert.equal(job.result.decision, 'ALLOW', JSON.stringify(job));
    const row = (await prod.admin.query('select signature_status, signature_ed25519, key_id from core.agent_decision_record where id = $1', [job.result.decision_record_id])).rows[0];
    assert.deepEqual(row, { signature_status: 'unsigned', signature_ed25519: null, key_id: null });
    const m2 = await prod.call('GET', `/v1/ai/monitoring?platform_id=${p}`, { as: 'demo|qa' });
    assert.equal(m2.body.decision_records.unsigned, 1);
    assert.match(m2.body.decision_records.anomalies.join(), /1 unsigned Agent Decision Record/);
    const v = await prod.call('GET', '/v1/ai/decisions/verify', { as: 'demo|qa' });
    assert.deepEqual([v.body.ok, v.body.unsigned, v.body.signer.mode], [false, 1, 'unsigned']);
    assert.match(v.body.problems.join(), /record 1: unsigned/);
  } finally { await prod.close(); }
});
