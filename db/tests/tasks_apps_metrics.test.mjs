import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const newTask = async (gxp, kind = 'agent') => (await c.query(
  `insert into core.task(platform_id, type, title, assignee_kind, assignee, gxp_impact, state)
   values ($1, 'deviation.detect', 't', $2, 'agent:deviation-detector', $3, 'assigned') returning id`, [I.platform, kind, gxp])).rows[0].id;
const sign = async (target) => (await c.query(
  `insert into core.signature(signer_sub, signer_name, meaning, target_table, target_id, target_hash, auth_method)
   values ('demo|ctm','Priya Raman','review','task',$1,'h','reauth_mfa') returning id`, [target])).rows[0].id;

test('[APP-TK-02] invalid task transitions are refused and valid ones logged', async () => {
  await tx(c, async () => {
    const t = await newTask(false);
    await c.query('savepoint s');
    await rejects(c.query("update core.task set state='created' where id=$1", [t]), /not allowed/);
    await c.query('rollback to savepoint s');
    await c.query("update core.task set state='in_progress' where id=$1", [t]);
    await c.query("update core.task set state='completed' where id=$1", [t]);
    const ev = (await c.query('select to_state from core.task_event where task_id=$1 order by id', [t])).rows.map(r => r.to_state);
    assert.deepEqual(ev, ['assigned', 'in_progress', 'completed']);
  });
});

test('[APP-TK-04][AI-05] GxP task by an agent cannot skip human review', async () => {
  await tx(c, async () => {
    const t = await newTask(true);
    await c.query("update core.task set state='in_progress' where id=$1", [t]);
    await rejects(c.query("update core.task set state='completed' where id=$1", [t]), /waiting_review/);
  });
});

test('[APP-TK-04][AI-05] an agent cannot close its own GxP task even after review', async () => {
  await tx(c, async () => {
    const t = await newTask(true);
    await c.query("update core.task set state='in_progress' where id=$1", [t]);
    await c.query("update core.task set state='waiting_review' where id=$1", [t]);
    const s = await sign(t);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'agent:x', actor_type: 'agent' })]);
    await rejects(c.query("update core.task set state='completed', review_signature_id=$2 where id=$1", [t, s]), /only a person/);
  });
});

test('[APP-TK-04] a person completes a reviewed GxP task with a signature', async () => {
  await tx(c, async () => {
    const t = await newTask(true);
    await c.query("update core.task set state='in_progress' where id=$1", [t]);
    await c.query("update core.task set state='waiting_review' where id=$1", [t]);
    await c.query('savepoint s');
    await rejects(c.query("update core.task set state='completed' where id=$1", [t]), /signature/);
    await c.query('rollback to savepoint s');
    const s = await sign(t);
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: 'demo|ctm' })]);
    await c.query("update core.task set state='completed', review_signature_id=$2 where id=$1", [t, s]);
    const e = (await c.query("select count(*) n from core.event_outbox where type='task.completed' and subject=$1", ['task/' + t])).rows[0].n;
    assert.equal(e, '1');
  });
});

test('[APP-MF-02][APP-MF-04] app scopes are granted on approval and revoked on uninstall', async () => {
  await tx(c, async () => {
    const i = (await c.query("select id from core.app_installation where app_id='ist.simulation-ta1'")).rows[0].id;
    assert.equal((await c.query("select core.app_has_scope('ist.simulation-ta1', $1, 'arm:read') ok", [I.platform])).rows[0].ok, false);
    await c.query('savepoint s');
    await rejects(c.query("update core.app_installation set status='active' where id=$1", [i]), /approver/);
    await c.query('rollback to savepoint s');
    await c.query("update core.app_installation set status='active', approved_by='demo|admin' where id=$1", [i]);
    assert.equal((await c.query("select core.app_has_scope('ist.simulation-ta1', $1, 'arm:read') ok", [I.platform])).rows[0].ok, true);
    assert.equal((await c.query("select core.app_has_scope('ist.simulation-ta1', $1, 'subject:write') ok", [I.platform])).rows[0].ok, false);
    await c.query("update core.app_installation set status='uninstalled' where id=$1", [i]);
    assert.equal((await c.query("select core.app_has_scope('ist.simulation-ta1', $1, 'arm:read') ok", [I.platform])).rows[0].ok, false);
  });
});

test('[M11-01] the SURPASS TA3 metric catalogue is loaded with interim and final targets', async () => {
  const r = (await c.query("select code, final_target from core.metric_definition where ta='TA3' order by code")).rows;
  assert.equal(r.length, 9);
  assert.equal(Number(r.find(x => x.code === 'TA3-CONTRACT-ARM').final_target), 7);
});

test('[M11-02] arm onboarding metrics are computed from records, later arms faster', async () => {
  const r = (await c.query("select code, contract_days, irb_days, may_proceed_to_fsd_days from core.v_arm_onboarding order by arm_created_at")).rows;
  assert.equal(r.length, 3);
  for (const row of r) { assert.ok(row.contract_days !== null && row.irb_days !== null); }
  assert.ok(Number(r[2].contract_days) < Number(r[0].contract_days));
});

test('[M05-02] enrollment funnel is monotonic per site', async () => {
  const r = (await c.query('select * from core.v_enrollment_funnel')).rows;
  assert.equal(r.length, 6);
  for (const s of r) assert.ok(+s.identified >= +s.prescreened && +s.prescreened >= +s.consented && +s.consented >= +s.randomized);
});

test('[AI-06] AI ledger requires model version and input hash', async () => {
  await tx(c, async () => {
    await c.query('savepoint s');
    await rejects(c.query("insert into core.ai_request(task_type, data_class, provider, model, input_sha256) values ('x','INTERNAL','anthropic','claude','h')"), /model_version/);
    await c.query('rollback to savepoint s');
    await rejects(c.query("insert into core.ai_request(task_type, data_class, provider, model, model_version, input_sha256) values ('x','SECRET','anthropic','claude','v','h')"), /check/);
  });
});

test('[DM-05] demo data is synthetic and complete', async () => {
  const r = (await c.query(`select (select count(*) from core.subject) s, (select count(*) from core.site) si,
     (select count(*) from core.arm where intervention_type <> 'control') a,
     (select count(*) from core.organization where org_type='sponsor' and is_small_business) small`)).rows[0];
  assert.equal(r.s, '240'); assert.equal(r.si, '6'); assert.equal(r.a, '3'); assert.equal(r.small, '1');
});
