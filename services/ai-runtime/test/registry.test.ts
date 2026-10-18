// AI-02 task type registry and prompt lock, CMP-06 credibility plans, CMP-07 pre-specified thresholds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { REGISTRY, type TaskTypeDef } from '../src/registry.ts';
import { readPromptLock, promptLockProblems, promptFingerprint, PROMPT_LOCK, type PromptLock } from '../src/prompt-lock.ts';

const root = join(PROMPT_LOCK, '../../..');
const lock = readPromptLock();
const exists = (p: string) => existsSync(join(root, p));
const readEv = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const gxpTypes = Object.values(REGISTRY).filter(d => d.gxp);

test('[AI-02] every GxP task type declares intended use, risk, model, versioned prompt, validator, thresholds, plan and dataset', () => {
  assert.ok(gxpTypes.length > 0);
  const ajv = new Ajv2020({ strict: false });
  for (const d of Object.values(REGISTRY)) {
    const w = d.task_type;
    assert.ok(d.intended_use.length > 20, `${w}: intended_use`);
    assert.ok(['low', 'medium', 'high'].includes(d.risk), `${w}: risk`);
    assert.match(d.model, /^claude-[a-z0-9-]+$/, `${w}: exact model id`);
    assert.ok(d.prompt_id && Number.isInteger(d.prompt_version) && d.prompt_version >= 1, `${w}: versioned prompt`);
    assert.doesNotThrow(() => ajv.compile(d.output_schema), `${w}: validator`);
    assert.ok(d.data_classes.length > 0, `${w}: data classes`);
    assert.ok(d.thresholds.length > 0 && d.thresholds.every(t => ['>=', '<='].includes(t.op) && Number.isFinite(t.value)), `${w}: thresholds`);
    assert.ok(d.monitoring.window > 0 && d.monitoring.rules.length > 0, `${w}: monitoring rules (AI-10)`);
    assert.ok(existsSync(join(root, d.credibility_plan)) && d.credibility_plan === `docs/ai/${w}.md`, `${w}: credibility plan ${d.credibility_plan}`);
    assert.ok(exists(d.dataset) && statSync(join(root, d.dataset)).isDirectory(), `${w}: dataset folder ${d.dataset}`);
    assert.ok(readdirSync(join(root, d.dataset)).some(f => f.endsWith('.json')), `${w}: dataset has no case`);
    if (['extraction', 'classification'].includes(d.category)) assert.ok(d.citation, `${w}: extraction/classification must declare citation (AI-04)`);
  }
});

test('[AI-02] each registered prompt version is locked by the hash of its rendered system prompt and output schema', () => {
  assert.deepEqual(promptLockProblems(REGISTRY, lock, exists, readEv), []);
  assert.deepEqual(Object.values(lock.prompts).map(p => p.task_type).sort(), Object.keys(REGISTRY).sort(), 'prompt-lock.json lists a task type that is not registered');
});

test('[AI-02] changing the prompt text or the schema without a new prompt_version fails the gate', () => {
  const def = REGISTRY['protocol.appendix.draft']!;
  const edited: TaskTypeDef = { ...def, render: i => ({ ...def.render(i), system: def.render(i).system + ' Be concise.' }) };
  assert.match(promptLockProblems({ x: edited }, lock, exists, readEv).join('\n'), /system prompt changed without a new prompt_version/);
  const schema: TaskTypeDef = { ...def, output_schema: { ...def.output_schema, description: 'x' } };
  assert.match(promptLockProblems({ x: schema }, lock, exists, readEv).join('\n'), /output schema changed/);
  const dependsOnInput: TaskTypeDef = { ...def, render: i => ({ system: JSON.stringify(i), user: '' }) };
  assert.match(promptLockProblems({ x: dependsOnInput }, lock, exists, readEv).join('\n'), /depends on the input/);
});

test('[AI-02][AI-03] a new prompt version needs change control: change request, approver and passing live regression', () => {
  const def = REGISTRY['protocol.appendix.draft']!;
  const base = lock.prompts['protocol-author']!;
  const last = base.versions.at(-1)!.version;
  const v2: TaskTypeDef = { ...def, prompt_version: last + 1, render: i => ({ ...def.render(i), system: def.render(i).system + ' next' }) };
  assert.match(promptLockProblems({ x: v2 }, lock, exists, readEv).join('\n'), new RegExp(`last locked version is ${last}`));
  const fp = promptFingerprint(v2);
  const entry = { ...base.versions[0]!, version: last + 1, ...fp, change_request: null, approved_by: null, regression_evidence: null };
  const l2: PromptLock = { prompts: { 'protocol-author': { ...base, versions: [...base.versions, entry] } } };
  const p = promptLockProblems({ x: v2 }, l2, exists, readEv).join('\n');
  assert.match(p, /needs a change request/);
  assert.match(p, /needs an approver/);
  assert.match(p, /needs regression evidence/);
  const replay = { task_type: def.task_type, mode: 'replay', passed: true };
  const withEv: PromptLock = { prompts: { 'protocol-author': { ...base, versions: [...base.versions,
    { ...entry, change_request: 'CR-1', approved_by: 'QA', regression_evidence: 'ev.json' }] } } };
  assert.match(promptLockProblems({ x: v2 }, withEv, () => true, () => replay).join('\n'), /passing live run/);
  assert.deepEqual(promptLockProblems({ x: v2 }, withEv, () => true, () => ({ ...replay, mode: 'live' })), []);
});

// ---------- credibility plans ----------
const plan = (d: TaskTypeDef) => readFileSync(join(root, d.credibility_plan), 'utf8');
function table(md: string, header: string): string[][] {
  const lines = md.split('\n');
  const i = lines.findIndex(l => l.trim().startsWith(header));
  assert.ok(i >= 0, `table "${header}" missing`);
  const rows: string[][] = [];
  for (const l of lines.slice(i + 2)) {
    if (!l.trim().startsWith('|')) break;
    rows.push(l.split('|').slice(1, -1).map(c => c.trim()));
  }
  return rows;
}

test('[CMP-06] every registered AI task type has its credibility plan with sections 1-7, and section 7 points to the AI-10 monitoring', () => {
  for (const d of Object.values(REGISTRY)) {
    const md = plan(d);
    for (let n = 1; n <= 7; n++) assert.match(md, new RegExp(`^## ${n}\\. \\S`, 'm'), `${d.task_type}: section ${n} missing`);
    assert.match(md, new RegExp(`\`${d.task_type.replace(/\./g, '\\.')}\``), `${d.task_type}: plan names its task type`);
    const s7 = md.slice(md.search(/^## 7\. /m));
    assert.match(s7, /AI-10/);
    assert.match(s7, /\/v1\/ai\/monitoring/);
    assert.match(s7, /suggestion-only/);
    assert.match(md.slice(md.search(/^## 5\. /m)), new RegExp(`docs/ai/evidence/${d.task_type.replace(/\./g, '\\.')}`), `${d.task_type}: section 5 links the evidence`);
  }
});

test('[CMP-07][AI-02] thresholds and monitoring rules in the registry are the ones pre-specified in the credibility plan', () => {
  for (const d of Object.values(REGISTRY)) {
    const md = plan(d);
    const t = table(md, '| Metric | Op | Value |').map(([metric, op, value]) => ({ metric, op, value: Number(value) }));
    assert.deepEqual(t, d.thresholds, `${d.task_type}: plan §4 thresholds differ from the registry`);
    const m = table(md, '| Monitoring rule (AI-10) | Max | Min sample |').map(([metric, max, min]) => ({ metric, max: Number(max), min_sample: Number(min) }));
    assert.deepEqual(m, d.monitoring.rules, `${d.task_type}: plan §7 monitoring rules differ from the registry`);
    assert.equal(Number(/^Window: (\d+)$/m.exec(md)?.[1]), d.monitoring.window, `${d.task_type}: monitoring window`);
  }
});
