import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import sectionsSchema from '@trialops/schemas/protocol-sections.schema.json' with { type: 'json' };
import { createAiRuntime, replayProvider, REGISTRY, type Provider, type ProviderResult } from '../src/index.ts';

/** In-memory ledger standing in for core.ai_request. */
function fakeDb() {
  const rows: unknown[][] = [];
  return { rows, query: async (_sql: string, params: unknown[] = []) => { rows.push(params); return { rows: [{ id: `req-${rows.length}` }] }; } };
}
const live = (r: Partial<ProviderResult> | Error): Provider => ({
  name: 'anthropic', accepts: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL_SPONSOR', 'CLINICAL_PSEUDONYMIZED'],
  call: async () => { if (r instanceof Error) throw r; return { output: null, model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, ...r }; },
});
const req = { task_type: 'arm.onboarding.plan', data_class: 'INTERNAL' as const, input: { arm: 'ARM-D' }, platform_id: 'p1' };
const plan = JSON.parse(JSON.stringify((await replayProvider().call({ task_type: 'arm.onboarding.plan' } as never)).output));

test('[AI-01] only registered task types run; the caller never chooses the model', async () => {
  const rt = createAiRuntime({ provider: live({ output: plan }) });
  await assert.rejects(rt.run({ ...req, task_type: 'free.chat' }, { db: fakeDb() }), /not registered/);
  await assert.rejects(rt.run({ ...req, data_class: 'CLINICAL_PSEUDONYMIZED' }, { db: fakeDb() }), /not approved/);
});

test('[AI-06] every call writes one ledger row with model, prompt version, hashes, tokens, cost and outcome', async () => {
  const db = fakeDb();
  const r = await createAiRuntime({ provider: live({ output: plan }), usdToEur: 1 }).run(req, { db });
  assert.equal(r.outcome, 'success');
  assert.equal(db.rows.length, 1);
  const [platform, , , taskType, dataClass, provider, model, modelVersion, promptId, promptVersion, inHash, outHash, inTok, outTok, cost, , outcome] = db.rows[0]!;
  assert.deepEqual([platform, taskType, dataClass, provider, model, modelVersion, promptId, promptVersion, inTok, outTok, outcome],
    ['p1', 'arm.onboarding.plan', 'INTERNAL', 'anthropic', 'claude-opus-5-5', 'claude-opus-5-5', 'onboarding-planner', 1, 1000, 500, 'success']);
  assert.match(String(inHash), /^[0-9a-f]{64}$/);
  assert.match(String(outHash), /^[0-9a-f]{64}$/);
  assert.equal(cost, (1000 * 4 + 500 * 20) / 1e6);
});

test('[AI-06] failures are recorded too: invalid output, refusal, provider error', async () => {
  for (const [provider, outcome] of [[live({ output: { tasks: 'nope' } }), 'validation_failed'], [live({ refusal: 'cyber' }), 'blocked'],
    [live(new Error('connection reset')), 'error']] as const) {
    const db = fakeDb();
    const r = await createAiRuntime({ provider }).run(req, { db });
    assert.equal(r.outcome, outcome);
    assert.equal(r.output, null);
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0]![16], outcome);
  }
});

test('[AI-01][AI-11] STRICT_LOCAL data never reaches a cloud provider', async () => {
  const strict = { ...REGISTRY['arm.onboarding.plan']!, data_classes: ['STRICT_LOCAL' as const] };
  let called = false;
  const provider: Provider = { ...live({ output: plan }), call: async () => { called = true; return { output: plan, model: 'x', input_tokens: 0, output_tokens: 0 }; } };
  const db = fakeDb();
  const r = await createAiRuntime({ provider, registry: { 'arm.onboarding.plan': strict } }).run({ ...req, data_class: 'STRICT_LOCAL' }, { db });
  assert.equal(r.outcome, 'blocked');
  assert.equal(called, false);
  assert.equal(db.rows.length, 1);
});

test('[AI-01] replay mode answers from recorded responses that satisfy the registered schemas', async () => {
  const ajv = new Ajv2020({ strict: false }); addFormats.default(ajv);
  const db = fakeDb();
  const rt = createAiRuntime({ provider: replayProvider() });
  for (const task_type of Object.keys(REGISTRY)) {
    const r = await rt.run({ task_type, data_class: 'CONFIDENTIAL_SPONSOR', input: {} }, { db });
    assert.equal(r.outcome, 'success', `${task_type}: ${r.error}`);
    assert.equal(r.provider, 'replay');
  }
  const draft = await rt.run({ task_type: 'protocol.appendix.draft', data_class: 'CONFIDENTIAL_SPONSOR', input: {} }, { db });
  const validSections = ajv.compile(sectionsSchema);
  assert.ok(validSections((draft.output as { sections: unknown }).sections), ajv.errorsText(validSections.errors));
});
