import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

test('[DM-02] an approved Master Protocol version cannot be edited', async () => {
  await tx(c, async () => {
    await rejects(c.query(`update core.master_protocol_version set usdm = '{"x":1}' where platform_id=$1 and status='approved'`, [I.platform]), /immutable/);
  }, { reason: 'try edit' });
});

test('[DM-02][CMP-02] approval without an approval signature is refused', async () => {
  await tx(c, async () => {
    const v = (await c.query("insert into core.master_protocol_version(platform_id, version_label) values ($1,'2.0-draft') returning id", [I.platform])).rows[0].id;
    await rejects(c.query("update core.master_protocol_version set status='approved' where id=$1", [v]), /approval signature/);
  }, { reason: 'approve' });
});

test('[M01-04][APP-DT-04] new arm emits arm.created as a CloudEvent', async () => {
  await tx(c, async () => {
    const a = (await c.query("insert into core.arm(platform_id, code, name, intervention_type) values ($1,'ARM-D','New arm','drug') returning id", [I.platform])).rows[0].id;
    const e = (await c.query("select * from core.event_outbox where type='arm.created' and arm_id=$1", [a])).rows[0];
    assert.equal(e.specversion, '1.0');
    assert.equal(e.subject, 'arm/' + a);
    assert.equal(e.published_at, null);
  });
});

test('[M01-04] arm lifecycle rejects draft -> active and accepts draft -> approved -> active', async () => {
  await tx(c, async () => {
    const a = (await c.query("insert into core.arm(platform_id, code, name, intervention_type) values ($1,'ARM-E','x','drug') returning id", [I.platform])).rows[0].id;
    await c.query('savepoint s');
    await rejects(c.query("update core.arm set status='active' where id=$1", [a]), /not allowed/);
    await c.query('rollback to savepoint s');
    await c.query("update core.arm set status='approved' where id=$1", [a]);
    await c.query("update core.arm set status='active' where id=$1", [a]);
    const n = (await c.query("select count(*) n from core.event_outbox where arm_id=$1 and type='arm.status.changed'", [a])).rows[0].n;
    assert.equal(Number(n), 2);
  }, { reason: 'lifecycle test' });
});

test('[M07-01] serious AE starts a 15-day expedited clock; fatal/life-threatening 7 days', async () => {
  await tx(c, async () => {
    const s = (await c.query("select id, site_id from core.subject where status='on_treatment' limit 1")).rows[0];
    const r = (await c.query(`insert into core.adverse_event(platform_id, site_id, subject_id, term_verbatim, serious, fatal_or_life_threatening, onset_date, aware_at)
      values ($1,$2,$3,'Test',true,false,'2026-10-01','2026-10-02T00:00:00Z'), ($1,$2,$3,'Test2',true,true,'2026-10-01','2026-10-02T00:00:00Z'),
             ($1,$2,$3,'Test3',false,false,'2026-10-01','2026-10-02T00:00:00Z') returning report_due_at`, [I.platform, s.site_id, s.id])).rows;
    assert.equal(r[0].report_due_at.toISOString(), '2026-10-17T00:00:00.000Z');
    assert.equal(r[1].report_due_at.toISOString(), '2026-10-09T00:00:00.000Z');
    assert.equal(r[2].report_due_at, null);
  });
});

test('[DM-01] every clinical table carries platform_id', async () => {
  const exempt = ['platform','organization','person','role_assignment','audit_event','event_outbox','signature','task_event',
    'document_version','app_installation','app_scope_grant','agent_decision_record','metric_definition','subject_status_history','ai_request',
    // identity and session security records (0018, CMP-03): an account works across platforms, they hold no clinical data
    'auth_event','account_lock','user_session',
    // ledger integrity records (0022, CMP-12): seals and DDL cover the whole database, not one platform
    'audit_seal','audit_anchor','ddl_event',
    // API replay cache (0024, APP-DT-02): keyed by caller, holds no clinical record of its own
    'idempotency_record'];
  const r = (await c.query(`select t.table_name from information_schema.tables t
     where t.table_schema='core' and t.table_type='BASE TABLE' and t.table_name <> all($1)
       and not exists (select 1 from information_schema.columns k where k.table_schema='core' and k.table_name=t.table_name and k.column_name='platform_id')`, [exempt])).rows;
  assert.deepEqual(r.map(x => x.table_name), []);
});
