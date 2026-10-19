// CMP-05 (0026): critical-to-quality factors, RBQM risks, KRI/QTL breach detection, reconstruction of an arm's decisions,
// service provider oversight. Every case runs in a rolled-back transaction, as an API role with JWT claims.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const person = (sub, roles) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user' });
const ops = () => person('demo|ops', ['platform_ops_manager']);
const qa = () => person('demo|qa', ['qa_auditor']);
const AS = (claims, reason) => ({ role: 'authenticated', claims, ...(reason ? { reason } : {}) });

test('[CMP-05] CtQ factors, risks and limits are kept per platform or arm by quality roles; author and time from the server', async () => {
  await tx(c, async () => {
    const f = (await c.query(`insert into core.ctq_factor(platform_id, arm_id, code, title, category, rationale, created_by)
      values ($1, $2, 'CTQ-ARM-A-PK', 'PK sampling windows', 'data_reliability', 'Dose finding depends on PK', 'someone-else') returning *`,
    [I.platform, I.arms['ARM-A']])).rows[0];
    assert.equal(f.created_by, 'demo|ops', 'author from the token, not from the caller');
    const r = (await c.query(`insert into core.quality_risk(platform_id, arm_id, ctq_factor_id, code, description, likelihood, impact, detectability,
      controls, owner_role) values ($1, $2, $3, 'RISK-PK', 'PK samples outside window', 3, 4, 2, 'Visit window alerts', 'ctm') returning *`,
    [I.platform, I.arms['ARM-A'], f.id])).rows[0];
    assert.equal(r.risk_score, 24, 'risk score = likelihood x impact x detectability');
    assert.equal(r.status, 'open');
  }, AS(ops()));
  // agents, apps and other roles cannot maintain the register
  for (const claims of [person('demo|cra', ['cra']), { ...ops(), actor_type: 'agent', sub: 'agent:protocol-author' }]) {
    await tx(c, async () => {
      await rejects(c.query(`insert into core.ctq_factor(platform_id, code, title, category, rationale) values ($1, 'CTQ-X', 'x', 'other', 'x')`,
        [I.platform]), /maintained by a person with role/);
    }, AS(claims));
  }
  // an arm of another platform is refused; scores stay within 1..5
  await tx(c, async () => {
    const other = (await c.query(`insert into core.platform(code, title, therapeutic_area, lead_operator_id)
      select 'PLAT-T05', 'other', 'x', lead_operator_id from core.platform where id = $1 returning id`, [I.platform])).rows[0].id;
    await c.query('savepoint s');
    await rejects(c.query(`insert into core.ctq_factor(platform_id, arm_id, code, title, category, rationale) values ($1, $2, 'CTQ-X', 'x', 'other', 'x')`,
      [other, I.arms['ARM-A']]), /does not belong to platform/);
    await c.query('rollback to savepoint s');
    const f = (await c.query("select id from core.ctq_factor where platform_id = $1 and code = 'CTQ-ELIG'", [I.platform])).rows[0].id;
    await rejects(c.query(`insert into core.quality_risk(platform_id, ctq_factor_id, code, description, likelihood, impact, detectability, controls, owner_role)
      values ($1, $2, 'R-6', 'x', 6, 1, 1, 'x', 'ctm')`, [I.platform, f]), /check/);
  });
});

test('[CMP-05] risk status changes follow the state machine, need a change reason and are audited; no delete', async () => {
  await tx(c, async () => {
    const id = (await c.query("select id from core.quality_risk where platform_id = $1 and code = 'RISK-ELIG'", [I.platform])).rows[0].id;
    await c.query('savepoint s');
    await rejects(c.query("update core.quality_risk set status = 'mitigated' where id = $1", [id]), /change reason required/);
    await c.query('rollback to savepoint s');
    await c.query("select set_config('trialops.change_reason', 'Checklist rolled out to all sites', true)");
    await c.query("update core.quality_risk set status = 'mitigated', likelihood = 1 where id = $1", [id]);
    await c.query('reset role');
    const a = (await c.query("select action, reason, new_row->>'risk_score' score from core.audit_event where table_name = 'quality_risk' and record_id = $1 order by seq desc limit 1", [id])).rows[0];
    await c.query('set local role authenticated');
    assert.deepEqual([a.action, a.reason, a.score], ['UPDATE', 'Checklist rolled out to all sites', '12']);
    await c.query("update core.quality_risk set status = 'void' where id = $1", [id]);
    await c.query('savepoint t');
    await rejects(c.query("update core.quality_risk set status = 'open' where id = $1", [id]), /void quality_risk is closed/);
    await c.query('rollback to savepoint t');
    await rejects(c.query('delete from core.quality_risk where id = $1', [id]), /permission denied|physical delete/);
  }, AS(ops()));
});

test('[CMP-05] a value outside a quality tolerance limit is detected as a breach: GxP review task and domain event', async () => {
  await tx(c, async () => {
    const l = (await c.query("select id from core.quality_tolerance_limit where platform_id = $1 and code = 'KRI-SCREEN-FAIL'", [I.platform])).rows[0].id;
    const within = (await c.query("insert into core.qtl_observation(limit_id, platform_id, value, source, breached) values ($1, $2, 12.5, 'manual', true) returning *",
      [l, I.platform])).rows[0];
    assert.deepEqual([within.breached, within.breach_task_id, within.observed_by], [false, null, 'demo|ops'], 'breach is computed, not typed');
    const out = (await c.query("insert into core.qtl_observation(limit_id, platform_id, value, source) values ($1, $2, 55, 'manual') returning *", [l, I.platform])).rows[0];
    assert.equal(out.breached, true);
    const task = (await c.query('select type, assignee, gxp_impact, state, priority from core.task where id = $1', [out.breach_task_id])).rows[0];
    assert.deepEqual(task, { type: 'rbqm.breach.review', assignee: 'platform_ops_manager', gxp_impact: true, state: 'assigned', priority: 'high' });
    const ev = (await c.query("select data from core.event_outbox where type = 'quality.limit.breached' order by time desc limit 1")).rows[0];
    assert.equal(ev.data.code, 'KRI-SCREEN-FAIL');
    await rejects(c.query('update core.qtl_observation set value = 1 where id = $1', [out.id]), /append-only|permission denied/);
  }, AS(ops()));
});

test('[CMP-05] KRIs/QTLs are evaluated from the records (never typed) at platform level', async () => {
  await tx(c, async () => {
    const rows = (await c.query('select o.*, l.code from core.rbqm_evaluate($1) o join core.quality_tolerance_limit l on l.id = o.limit_id order by l.code', [I.platform])).rows;
    assert.deepEqual(rows.map(r => r.code), ['KRI-MAJOR-DEV', 'KRI-SCREEN-FAIL', 'QTL-SAE-OVERDUE']);
    assert.ok(rows.every(r => r.source === 'computed'));
    const sae = rows.find(r => r.code === 'QTL-SAE-OVERDUE');
    assert.equal(Number(sae.value), 0);
    assert.equal(sae.breached, false);
    // an overdue open SAE breaches the QTL at the next evaluation
    const s = (await c.query("select id, site_id from core.subject where platform_id = $1 and status = 'on_treatment' limit 1", [I.platform])).rows[0];
    await c.query('reset role');
    await c.query(`insert into core.adverse_event(platform_id, site_id, subject_id, term_verbatim, serious, onset_date, aware_at)
      values ($1, $2, $3, 'Syncope', true, current_date - 30, clock_timestamp() - interval '20 days')`, [I.platform, s.site_id, s.id]);
    await c.query('set local role authenticated');
    const again = (await c.query("select o.* from core.rbqm_evaluate($1) o join core.quality_tolerance_limit l on l.id = o.limit_id where l.code = 'QTL-SAE-OVERDUE'", [I.platform])).rows[0];
    assert.deepEqual([Number(again.value), again.breached], [1, true]);
    assert.equal((await c.query("select priority from core.task where id = $1", [again.breach_task_id])).rows[0].priority, 'urgent', 'a QTL breach is urgent');
  }, AS(ops()));
  await tx(c, async () => {
    await rejects(c.query('select * from core.rbqm_evaluate($1)', [I.platform]), /requires platform_admin/);
  }, AS(person('demo|cra', ['cra'])));
});

test('[CMP-05] the decisions and adaptations of an arm are reconstructed from audit trail, signatures, AI requests and events', async () => {
  await tx(c, async () => {
    const arm = I.arms['ARM-A'];
    // an adaptation: stage change with a reason; an AI request about the arm
    await c.query("select set_config('trialops.change_reason', 'DSMB recommendation: move to expansion', true)");
    await c.query("update core.arm set current_stage = 'expansion' where id = $1", [arm]);
    await c.query(`insert into core.ai_request(platform_id, arm_id, task_type, data_class, provider, model, model_version, input_sha256, outcome)
      values ($1, $2, 'protocol.appendix.draft', 'CONFIDENTIAL_SPONSOR', 'anthropic', 'claude-x', '2026-01-01', $3, 'success')`, [I.platform, arm, 'b'.repeat(64)]);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(qa())]);
    await c.query('set local role authenticated');
    const t = (await c.query('select * from core.arm_decision_timeline($1)', [arm])).rows;
    const sources = new Set(t.map(x => x.source));
    for (const s of ['audit', 'signature', 'ai_request', 'event']) assert.ok(sources.has(s), `timeline has ${s} entries`);
    const stage = t.find(x => x.source === 'audit' && x.record_table === 'arm' && x.reason === 'DSMB recommendation: move to expansion');
    assert.ok(stage, 'the adaptation and its reason are in the timeline');
    assert.ok(t.some(x => x.source === 'event' && x.kind === 'arm.stage.changed'));
    assert.ok(t.some(x => x.source === 'signature' && x.record_table === 'arm_appendix_version'), 'the appendix approval signature is found');
    assert.ok(!t.some(x => x.record_table === 'subject'), 'no subject rows (blinding)');
    for (let i = 1; i < t.length; i++) assert.ok(t[i - 1].at <= t[i].at, 'ordered by time');
  }, { claims: { sub: 'demo|ops', roles: ['platform_ops_manager'] } });
  for (const claims of [person('demo|ops', ['platform_ops_manager']), { ...qa(), actor_type: 'agent' }, { ...qa(), arm_scopes: [I.arms['ARM-B']] }]) {
    await tx(c, async () => {
      await rejects(c.query('select * from core.arm_decision_timeline($1)', [I.arms['ARM-A']]), /qa_auditor or platform_admin|perimeter/);
    }, AS(claims));
  }
});

test('[CMP-05] service providers: qualification before activation, oversight activities, review due dates; overdue blocks activation', async () => {
  await tx(c, async () => {
    const p = (await c.query(`insert into core.service_provider(code, name, kind, responsibilities, data_categories, processing_regions, status)
      values ('demo-lab', 'Central lab (synthetic)', 'laboratory', 'Safety laboratory analyses', '{operational}', '{US}', 'proposed') returning *`)).rows[0];
    assert.equal(p.created_by, 'demo|qa');
    await c.query("select set_config('trialops.change_reason', 'qualification', true)");
    await c.query('savepoint s');
    await rejects(c.query("update core.service_provider set status = 'qualified' where id = $1", [p.id]), /needs a recorded qualification/);
    await c.query('rollback to savepoint s');
    await c.query("insert into core.provider_oversight_activity(provider_id, kind, performed_on, outcome) values ($1, 'qualification', current_date - 400, 'satisfactory')", [p.id]);
    await c.query("update core.service_provider set status = 'qualified' where id = $1", [p.id]);
    await c.query("insert into core.provider_agreement(provider_id, kind, effective_from, document_ref, document_sha256, status) values ($1, 'QUALITY_AGREEMENT', current_date - 400, 'doc', $2, 'effective')",
      [p.id, 'c'.repeat(64)]);
    await c.query('savepoint t');
    await rejects(c.query("update core.service_provider set status = 'active' where id = $1", [p.id]), /oversight review of provider demo-lab is overdue/);
    await c.query('rollback to savepoint t');
    await c.query("insert into core.provider_oversight_activity(provider_id, kind, performed_on, outcome, findings) values ($1, 'periodic_review', current_date, 'satisfactory_with_findings', 'TAT KPI late twice')", [p.id]);
    await c.query("update core.service_provider set status = 'active' where id = $1", [p.id]);
    const st = (await c.query("select * from core.provider_oversight_status() where code = 'demo-lab'")).rows[0];
    assert.equal(st.last_activity_kind, 'periodic_review');
    assert.equal(st.overdue, false);
    assert.ok(st.next_review_due > new Date(), 'next review one interval after the last activity');
    // an oversight record is a fact: only void; findings needed when not satisfactory; no future dates
    const o = (await c.query("select id from core.provider_oversight_activity where provider_id = $1 order by recorded_at desc limit 1", [p.id])).rows[0].id;
    await c.query('savepoint u');
    await rejects(c.query("update core.provider_oversight_activity set outcome = 'satisfactory' where id = $1", [o]), /can only be voided/);
    await c.query('rollback to savepoint u');
    await c.query('savepoint v');
    await rejects(c.query("insert into core.provider_oversight_activity(provider_id, kind, performed_on, outcome) values ($1, 'audit', current_date + 1, 'satisfactory')", [p.id]), /before it happened/);
    await c.query('rollback to savepoint v');
    await rejects(c.query("insert into core.provider_oversight_activity(provider_id, kind, performed_on, outcome) values ($1, 'audit', current_date, 'unsatisfactory')", [p.id]), /check/);
  }, AS(qa()));
  await tx(c, async () => {
    await rejects(c.query(`insert into core.service_provider(code, name, kind, responsibilities, processing_regions) values ('x-cro', 'x', 'cro', 'x', '{US}')`),
      /maintained by a person with role/);
  }, AS(ops()));
  await tx(c, async () => {
    await rejects(c.query(`insert into core.service_provider(code, name, kind, responsibilities, processing_regions, status) values ('x-cro', 'x', 'cro', 'x', '{US}', 'active')`),
      /starts as proposed/);
  }, AS(qa()));
});
