import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAiRuntime, replayProvider, REGISTRY, type Provider } from '../src/index.ts';
import { readModelLock, readDataset, runRegression, MODEL_LOCK, type RegressionEvidence } from '../src/regression.ts';

const root = join(MODEL_LOCK, '../../..');
const lock = readModelLock();

test('[AI-03] every task type is pinned in model-lock.json to the model of the registry', () => {
  for (const [taskType, def] of Object.entries(REGISTRY)) {
    const approvals = lock.task_types[taskType]?.approvals ?? [];
    assert.ok(approvals.length > 0, `${taskType} has no approval in model-lock.json`);
    assert.equal(approvals.at(-1)!.model, def.model, `${taskType}: registry model differs from the last approval in model-lock.json`);
    for (const a of approvals) assert.match(a.approved_on, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.deepEqual(Object.keys(lock.task_types).sort(), Object.keys(REGISTRY).sort(), 'model-lock.json lists a task type that is not registered');
});

test('[AI-03] a model change is a change request with a passing live regression on the test dataset', () => {
  for (const [taskType, { approvals }] of Object.entries(lock.task_types)) {
    approvals.forEach((a, i) => {
      if (i === 0) return;                                   // the first pin has nothing to regress against
      const where = `${taskType} approval ${i} (${a.model})`;
      assert.ok(a.change_request, `${where}: change_request missing`);
      assert.ok(a.approved_by, `${where}: approved_by missing`);
      assert.ok(a.regression_evidence && existsSync(join(root, a.regression_evidence)), `${where}: regression evidence missing`);
      const ev = JSON.parse(readFileSync(join(root, a.regression_evidence!), 'utf8')) as RegressionEvidence;
      assert.equal(ev.task_type, taskType);
      assert.equal(ev.model, a.model, `${where}: evidence is for another model`);
      assert.equal(ev.previous_model, approvals[i - 1]!.model, `${where}: evidence does not compare with the previous model`);
      assert.equal(ev.mode, 'live', `${where}: replay evidence does not prove anything about a model`);
      assert.equal(ev.passed, true, `${where}: regression failed`);
    });
  }
});

test('[AI-03] the provider must answer with the pinned model: drift is recorded and blocked', async () => {
  const rows: unknown[][] = [];
  const db = { query: async (_s: string, p: unknown[] = []) => { rows.push(p); return { rows: [{ id: 'req-1' }] }; } };
  const output = (await replayProvider().call({ task_type: 'arm.onboarding.plan' } as never)).output;
  const drifting: Provider = { name: 'anthropic', accepts: ['INTERNAL'], call: async () => ({ output, model: 'claude-opus-9-9', input_tokens: 1, output_tokens: 1 }) };
  const r = await createAiRuntime({ provider: drifting }).run({ task_type: 'arm.onboarding.plan', data_class: 'INTERNAL', input: {} }, { db });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.output, null);
  assert.match(r.error ?? '', /model drift/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]![7], 'claude-opus-9-9');               // model_version: what the provider actually answered with
  assert.equal(rows[0]![16], 'blocked');
});

test('[AI-03] the regression harness runs the dataset and refuses to call replay evidence live', async () => {
  for (const taskType of Object.keys(REGISTRY)) assert.ok(readDataset(taskType).length > 0, `${taskType} has no test dataset`);
  const ev = await runRegression({ task_type: 'arm.onboarding.plan', model: 'claude-opus-5-5', provider: replayProvider() });
  assert.equal(ev.mode, 'replay');
  assert.equal(ev.previous_model, 'claude-opus-5-5');
  assert.equal(ev.cases.length, readDataset('arm.onboarding.plan').length);
  assert.equal(ev.passed, true);
  assert.match(ev.dataset_sha256, /^[0-9a-f]{64}$/);
});
