// API of the v1 quality and privacy governance (0026): RBQM and arm decision timeline (CMP-05), service providers with
// agreements, residency and ROPA (CMP-08), and the activation gate of L2-L3 apps (VAL-04). Real API, real database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, platformId, sign, type Api } from './_helpers.ts';
import { catalogue } from '../src/routes/apps.ts';

let api: Api; let plat: string;
before(async () => { api = await startApi(); plat = await platformId(api.admin); });
after(async () => api.close());
const SHA = 'f'.repeat(64);
const YESTERDAY = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const arm = async (code: string) => (await api.admin.query('select id from core.arm where platform_id = $1 and code = $2', [plat, code])).rows[0].id as string;

test('[CMP-05] RBQM through the API: CtQ factor, risk with score, KRI breach opens a review task; other roles are refused', async () => {
  const f = await api.call('POST', `/v1/platforms/${plat}/ctq-factors`, { as: 'demo|ops', body: { code: 'CTQ-API', title: 'Primary endpoint assessment',
    category: 'data_reliability', rationale: 'Central reading of the primary endpoint' } });
  assert.equal(f.status, 201, JSON.stringify(f.body));
  assert.equal(f.body.created_by, 'demo|ops');
  const r = await api.call('POST', `/v1/platforms/${plat}/quality-risks`, { as: 'demo|qa', body: { ctq_factor_id: f.body.id, code: 'RISK-API',
    description: 'Images read locally', likelihood: 3, impact: 4, detectability: 4, controls: 'Central reader contract', owner_role: 'data_manager' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.risk_score, 48);
  assert.equal((await api.call('PATCH', `/v1/quality-risks/${r.body.id}`, { as: 'demo|qa', body: { status: 'mitigated' } })).status, 400, 'reason required');
  const m = await api.call('PATCH', `/v1/quality-risks/${r.body.id}`, { as: 'demo|qa', reason: 'Central reading in place', body: { status: 'mitigated', likelihood: 1 } });
  assert.deepEqual([m.status, m.body.status, m.body.risk_score], [200, 'mitigated', 16]);
  assert.equal((await api.call('PATCH', `/v1/quality-risks/${r.body.id}`, { as: 'demo|qa', reason: 'x', body: { status: 'nonsense' } })).status, 400);
  const l = await api.call('POST', `/v1/platforms/${plat}/quality-limits`, { as: 'demo|ops', body: { ctq_factor_id: f.body.id, risk_id: r.body.id, code: 'KRI-API',
    kind: 'KRI', metric: 'imaging.local_read_pct', description: 'Locally read images', unit: '%', upper_limit: 5 } });
  assert.equal(l.status, 201, JSON.stringify(l.body));
  const ok = await api.call('POST', `/v1/quality-limits/${l.body.id}/observations`, { as: 'demo|dm', body: { value: 2 } });
  assert.deepEqual([ok.status, ok.body.breached], [201, false]);
  const br = await api.call('POST', `/v1/quality-limits/${l.body.id}/observations`, { as: 'demo|dm', body: { value: 9, note: 'site 106 reads locally' } });
  assert.deepEqual([br.status, br.body.breached], [201, true]);
  const task = (await api.admin.query('select type, assignee, gxp_impact from core.task where id = $1', [br.body.breach_task_id])).rows[0];
  assert.deepEqual(task, { type: 'rbqm.breach.review', assignee: 'platform_ops_manager', gxp_impact: true });
  const breaches = await api.call('GET', `/v1/platforms/${plat}/quality-limits/observations?breached=true`, { as: 'demo|ctm' });
  assert.ok(breaches.body.items.some((x: any) => x.id === br.body.id));
  const ev = await api.call('POST', `/v1/platforms/${plat}/quality-limits/evaluate`, { as: 'demo|ops' });
  assert.equal(ev.status, 200, JSON.stringify(ev.body));
  assert.deepEqual(ev.body.items.map((x: any) => x.code), ['KRI-MAJOR-DEV', 'KRI-SCREEN-FAIL', 'QTL-SAE-OVERDUE']);
  const list = await api.call('GET', `/v1/platforms/${plat}/ctq-factors`, { as: 'demo|cra' });
  const api1 = list.body.items.find((x: any) => x.code === 'CTQ-API');
  assert.deepEqual([api1.risks.length, api1.limits.length], [1, 1]);
  for (const who of ['demo|cra', 'demo|arden']) {
    assert.equal((await api.call('POST', `/v1/platforms/${plat}/ctq-factors`, { as: who, body: { code: 'CTQ-NO', title: 'x', category: 'other', rationale: 'x' } })).status, 403, who);
  }
  const agent = await sign({ sub: 'agent:protocol-author', actor_type: 'agent', platform_ids: [plat], roles: ['platform_ops_manager'] });
  assert.equal((await api.call('POST', `/v1/platforms/${plat}/quality-limits/evaluate`, { token: agent })).status, 403, 'agents do not run RBQM');
});

test('[CMP-05] an inspector reconstructs the decisions and adaptations of an arm from one endpoint', async () => {
  const id = await arm('ARM-B');
  const st = await api.call('POST', `/v1/arms/${id}/stage`, { as: 'demo|ops', reason: 'DSMB: move to expansion', body: { to_stage: 'confirmatory' } });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const t = await api.call('GET', `/v1/arms/${id}/decision-timeline`, { as: 'demo|qa' });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  const sources = new Set(t.body.items.map((x: any) => x.source));
  for (const s of ['audit', 'signature', 'event']) assert.ok(sources.has(s), s);
  assert.ok(t.body.items.some((x: any) => x.record_table === 'arm_stage_transition' && x.reason === 'DSMB: move to expansion'), 'the adaptation and its reason');
  assert.ok(!t.body.items.some((x: any) => x.record_table === 'subject'), 'blinding: no subject rows');
  assert.equal((await api.call('GET', `/v1/arms/${id}/decision-timeline`, { as: 'demo|ops' })).status, 403);
  assert.equal((await api.call('GET', `/v1/arms/${id}/decision-timeline`, { as: 'demo|halv' })).status, 403);
});

test('[CMP-05][CMP-08] provider lifecycle through the API: qualification, agreements, activation, oversight status', async () => {
  const p = await api.call('POST', '/v1/service-providers', { as: 'demo|qa', body: { code: 'api-lab', name: 'Central lab (synthetic)', kind: 'laboratory',
    responsibilities: 'Safety labs', data_categories: ['pseudonymised_clinical'], processing_regions: ['US'] } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.body.status, 'proposed');
  assert.deepEqual(p.body.agreement_gaps.map((g: any) => g.kind).sort(), ['BAA', 'QUALITY_AGREEMENT']);
  const q1 = await api.call('POST', `/v1/service-providers/${p.body.id}/status`, { as: 'demo|qa', reason: 'qualified', body: { to: 'qualified' } });
  assert.equal(q1.status, 422, 'no qualification recorded yet');
  assert.equal((await api.call('POST', `/v1/service-providers/${p.body.id}/oversight`, { as: 'demo|qa', body: { kind: 'qualification',
    performed_on: YESTERDAY, outcome: 'satisfactory' } })).status, 201);
  assert.equal((await api.call('POST', `/v1/service-providers/${p.body.id}/status`, { as: 'demo|qa', reason: 'qualification audit passed', body: { to: 'qualified' } })).status, 200);
  const a1 = await api.call('POST', `/v1/service-providers/${p.body.id}/status`, { as: 'demo|qa', reason: 'go live', body: { to: 'active' } });
  assert.equal(a1.status, 422);
  assert.match(a1.body.error.message, /BAA pseudonymised_clinical\/US/);
  for (const kind of ['QUALITY_AGREEMENT', 'BAA']) {
    const ag = await api.call('POST', `/v1/service-providers/${p.body.id}/agreements`, { as: 'demo|admin', body: { kind, effective_from: '2026-01-01',
      document_ref: `dms://${kind}`, document_sha256: SHA, status: 'effective', ...(kind === 'BAA' ? { data_categories: ['pseudonymised_clinical'], regions: ['US'] } : {}) } });
    assert.equal(ag.status, 201, JSON.stringify(ag.body));
  }
  const a2 = await api.call('POST', `/v1/service-providers/${p.body.id}/status`, { as: 'demo|qa', reason: 'agreements signed', body: { to: 'active' } });
  assert.equal(a2.status, 200, JSON.stringify(a2.body));
  assert.deepEqual(a2.body.agreement_gaps, []);
  assert.equal(a2.body.oversight_status.overdue, false);
  const reg = await api.call('GET', '/v1/service-providers', { as: 'demo|cra' });
  assert.ok(reg.body.items.some((x: any) => x.code === 'api-lab' && x.status === 'active'));
  assert.equal((await api.call('POST', '/v1/service-providers', { as: 'demo|ops', body: { code: 'x-x', name: 'x', kind: 'cro', responsibilities: 'x',
    data_categories: [], processing_regions: ['US'] } })).status, 403);
  // used on the US platform with participant data: allowed (in region, BAA)
  const use = await api.call('POST', `/v1/platforms/${plat}/providers`, { as: 'demo|admin', body: { provider_id: p.body.id, data_categories: ['pseudonymised_clinical'], purpose: 'Safety labs' } });
  assert.equal(use.status, 201, JSON.stringify(use.body));
  const uses = await api.call('GET', `/v1/platforms/${plat}/providers`, { as: 'demo|admin' });
  assert.equal(uses.body.items.find((x: any) => x.code === 'api-lab').allowed_now, true);
});

test('[CMP-08] residency and ROPA through the API; the privacy check is green on the synthetic platform', async () => {
  const eu = await api.call('POST', '/v1/service-providers', { as: 'demo|qa', body: { code: 'api-eu-host', name: 'EU host (synthetic)', kind: 'hosting',
    responsibilities: 'Backups', data_categories: ['pseudonymised_clinical'], processing_regions: ['EU'], gxp_relevant: false } });
  await api.call('POST', `/v1/service-providers/${eu.body.id}/oversight`, { as: 'demo|qa', body: { kind: 'qualification', performed_on: YESTERDAY, outcome: 'satisfactory' } });
  await api.call('POST', `/v1/service-providers/${eu.body.id}/status`, { as: 'demo|qa', reason: 'qualified', body: { to: 'qualified' } });
  await api.call('POST', `/v1/service-providers/${eu.body.id}/agreements`, { as: 'demo|qa', body: { kind: 'DPA', data_categories: ['pseudonymised_clinical'],
    regions: ['EU'], effective_from: '2026-01-01', document_ref: 'dms://dpa', document_sha256: SHA, status: 'effective' } });
  assert.equal((await api.call('POST', `/v1/service-providers/${eu.body.id}/status`, { as: 'demo|qa', reason: 'DPA signed', body: { to: 'active' } })).status, 200);
  const out = await api.call('POST', `/v1/platforms/${plat}/providers`, { as: 'demo|admin', body: { provider_id: eu.body.id, data_categories: ['pseudonymised_clinical'], purpose: 'x' } });
  assert.equal(out.status, 422);
  assert.match(out.body.error.message, /data residency/);
  const moved = await api.call('POST', `/v1/platforms/${plat}/data-region`, { as: 'demo|admin', reason: 'move to EU', body: { region: 'EU' } });
  assert.equal(moved.status, 422, 'the region is set once');
  // ROPA: draft v2 by QA, approval by another person, v1 superseded
  const d = await api.call('POST', '/v1/privacy/ropa', { as: 'demo|qa', body: { code: 'ROPA-001', title: 'Platform trials', controller: 'Northfield (fictitious)',
    purpose: 'Trial conduct and oversight', legal_basis_us: 'HIPAA authorization', data_subject_categories: ['trial participants'],
    data_categories: ['pseudonymised_clinical'], recipients: ['demo-db-hosting', 'demo-ai-provider', 'api-lab', 'api-eu-host'], regions: ['US'], retention: '25 years',
    security_measures: 'Pseudonymisation, RLS, MFA, audit trail' } });
  assert.equal(d.status, 201, JSON.stringify(d.body));
  assert.equal(d.body.version, 2);
  assert.equal((await api.call('POST', `/v1/privacy/ropa/${d.body.id}/approve`, { as: 'demo|qa', reason: 'approve' })).status, 403, 'four eyes');
  const ap = await api.call('POST', `/v1/privacy/ropa/${d.body.id}/approve`, { as: 'demo|admin', reason: 'annual ROPA review' });
  assert.deepEqual([ap.status, ap.body.status, ap.body.approved_by], [200, 'approved', 'demo|admin']);
  const all = await api.call('GET', '/v1/privacy/ropa?all=true&code=ROPA-001', { as: 'demo|cra' });
  assert.deepEqual(all.body.items.map((x: any) => [x.version, x.status]), [[2, 'approved'], [1, 'superseded']]);
  const chk = await api.call('GET', `/v1/privacy/check?platform_id=${plat}`, { as: 'demo|qa' });
  assert.equal(chk.status, 200);
  assert.equal(chk.body.ok, true, JSON.stringify(chk.body.items.filter((x: any) => !x.ok)));
  assert.equal((await api.call('GET', '/v1/privacy/check', { as: 'demo|cra' })).status, 403);
});

test('[VAL-04] an L2 app is activated only after QA accepts the supplier package and the contract tests pass', async () => {
  const sim = structuredClone(catalogue().find(m => m.app_id === 'ist.simulation-ta1')!);
  sim.version = '1.5.0';
  // the seeded installation is replaced by the new version: request installation of 1.5.0
  const inst = await api.call('POST', `/v1/platforms/${plat}/apps`, { as: 'demo|admin', body: { manifest: sim } });
  assert.equal(inst.status, 201, JSON.stringify(inst.body));
  const blocked = await api.call('POST', `/v1/app-installations/${inst.body.id}/approve`, { as: 'demo|admin' });
  assert.equal(blocked.status, 422);
  assert.match(blocked.body.error.message, /VAL-04/);
  const gate0 = await api.call('GET', '/v1/apps/ist.simulation-ta1/validation?version=1.5.0&gxp_class=L2', { as: 'demo|admin' });
  assert.deepEqual([gate0.body.gate.required, gate0.body.gate.ok], [true, false]);
  const supplier = (await api.admin.query("select id from core.service_provider where code = 'ist-app-supplier'")).rows[0].id;
  const pkg = await api.call('POST', '/v1/apps/validation-packages', { as: 'demo|admin', body: { app_id: 'ist.simulation-ta1', version: '1.5.0', gxp_class: 'L2',
    provider_id: supplier, package_uri: 'https://sim.insilicotrials.example/vp/1.5.0.zip', package_sha256: SHA,
    contents: ['URS', 'risk_assessment', 'test_evidence', 'traceability', 'release_note'] } });
  assert.equal(pkg.status, 201, JSON.stringify(pkg.body));
  assert.equal((await api.call('POST', `/v1/app-validation-packages/${pkg.body.id}/review`, { as: 'demo|admin', reason: 'r', body: { outcome: 'accepted', note: 'ok' } })).status, 403,
    'only QA reviews the package');
  const rev = await api.call('POST', `/v1/app-validation-packages/${pkg.body.id}/review`, { as: 'demo|qa', reason: 'supplier package review', body: { outcome: 'accepted', note: 'Complete for L2' } });
  assert.deepEqual([rev.status, rev.body.status, rev.body.reviewed_by], [200, 'accepted', 'demo|qa']);
  const fail = await api.call('POST', '/v1/apps/contract-test-runs', { as: 'demo|qa', body: { app_id: 'ist.simulation-ta1', version: '1.5.0', suite: 'trialops-app-contract',
    suite_version: '1.0.0', passed: 40, failed: 1, evidence_uri: 'ci://sim/1.5.0/1', evidence_sha256: SHA } });
  assert.deepEqual([fail.status, fail.body.result], [201, 'fail']);
  const still = await api.call('POST', `/v1/app-installations/${inst.body.id}/approve`, { as: 'demo|admin' });
  assert.match(still.body.error.message, /latest contract test run failed/);
  await api.call('POST', '/v1/apps/contract-test-runs', { as: 'demo|qa', body: { app_id: 'ist.simulation-ta1', version: '1.5.0', suite: 'trialops-app-contract',
    suite_version: '1.0.0', passed: 41, failed: 0, evidence_uri: 'ci://sim/1.5.0/2', evidence_sha256: SHA } });
  const ok = await api.call('POST', `/v1/app-installations/${inst.body.id}/approve`, { as: 'demo|admin' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'active');
  assert.equal(ok.body.validation_package_id, pkg.body.id, 'the installation records the evidence it was activated with');
  assert.ok(ok.body.contract_test_run_id);
  const gate = await api.call('GET', '/v1/apps/ist.simulation-ta1/validation?version=1.5.0&gxp_class=L2', { as: 'demo|cra' });
  assert.deepEqual([gate.body.gate.ok, gate.body.packages.length, gate.body.contract_test_runs.length], [true, 1, 2]);
});
