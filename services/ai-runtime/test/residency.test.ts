// NFR-06 / CMP-08: platform data goes to an external AI provider only when the service provider registry allows it for
// the platform region (core.provider_allowed, 0026); a region-pinned deployment refuses an unregistered provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAiRuntime, replayProvider, type Provider } from '../src/index.ts';

const plan = JSON.parse(JSON.stringify((await replayProvider().call({ task_type: 'arm.onboarding.plan' } as never)).output));
const req = { task_type: 'arm.onboarding.plan', data_class: 'INTERNAL' as const, input: { arm: 'ARM-D' }, platform_id: 'p1' };

/** Ledger and registry stand-in: answers core.provider_allowed with `allowed` and records every statement. */
function fakeDb(allowed: boolean) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return { calls, query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: [sql.includes('provider_allowed') ? { ok: allowed } : { id: `req-${calls.length}` }] };
  } };
}
function provider(): Provider & { called: number } {
  const p = { name: 'anthropic', accepts: ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL_SPONSOR', 'CLINICAL_PSEUDONYMIZED'] as Provider['accepts'], called: 0,
    async call() { p.called++; return { output: plan, model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 10 }; } };
  return p;
}

test('[NFR-06][CMP-08] a provider the registry does not allow for the platform region is never called; the refusal is in the ledger', async () => {
  const p = provider(); const db = fakeDb(false);
  const r = await createAiRuntime({ provider: p, region: 'EU', providerCode: 'demo-ai-provider' }).run(req, { db });
  assert.equal(r.outcome, 'blocked');
  assert.match(r.error!, /operational data of this platform may not go to provider demo-ai-provider/);
  assert.equal(p.called, 0);
  const check = db.calls.find(c => c.sql.includes('core.provider_allowed'))!;
  assert.deepEqual(check.params, ['p1', 'demo-ai-provider', 'operational']);
  assert.equal(db.calls.filter(c => c.sql.includes('insert into core.ai_request')).at(-1)!.params[16], 'blocked');
});

test('[NFR-06][CMP-08] an allowed provider is called; the category follows the data class', async () => {
  const p = provider(); const db = fakeDb(true);
  const r = await createAiRuntime({ provider: p, region: 'US', providerCode: 'demo-ai-provider' }).run(req, { db });
  assert.equal(r.outcome, 'success');
  assert.equal(p.called, 1);
  assert.deepEqual(db.calls.find(c => c.sql.includes('provider_allowed'))!.params[2], 'operational');
});

test('[NFR-06] a region-pinned deployment refuses an AI provider that is not registered as a service provider', async () => {
  const p = provider(); const db = fakeDb(true);
  const r = await createAiRuntime({ provider: p, region: 'JP', providerCode: null }).run(req, { db });
  assert.equal(r.outcome, 'blocked');
  assert.match(r.error!, /not registered as a service provider of the JP deployment/);
  assert.equal(p.called, 0);
});

test('[NFR-06] replay answers never leave the deployment: no registry check; unpinned without a provider code keeps the old behaviour', async () => {
  const db = fakeDb(false);
  const r = await createAiRuntime({ provider: replayProvider(), region: 'EU', providerCode: 'demo-ai-provider' }).run(req, { db });
  assert.equal(r.outcome, 'success');
  assert.ok(!db.calls.some(c => c.sql.includes('provider_allowed')));
  const p = provider();
  assert.equal((await createAiRuntime({ provider: p, region: null, providerCode: null }).run(req, { db: fakeDb(false) })).outcome, 'success');
  assert.equal((await createAiRuntime({ provider: p, region: 'EU', providerCode: 'x' }).run({ ...req, platform_id: undefined }, { db: fakeDb(false) })).outcome,
    'success', 'a request without a platform carries no platform data');
});
