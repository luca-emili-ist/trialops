// AI-10 task type state (migration 0023): changed only through core.ai_task_type_set_mode by a platform admin, audited,
// evaluation only falls back to suggestion-only; AI-04 reason of a refused output kept in the immutable ledger.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

const person = (sub, roles, extra = {}) => ({ sub, roles, platform_ids: [I.platform], arm_scopes: '*', site_scopes: '*', actor_type: 'user', ...extra });
const admin = () => person('demo|admin', ['platform_admin']);
async function refuse(run, re) {
  await c.query('savepoint refuse');
  try { await rejects(run(), re); } finally { await c.query('rollback to savepoint refuse'); }
}
const as = async (claims, sql, args = []) => {
  await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await c.query('set local role authenticated');
  const r = await c.query(sql, args);
  await c.query('reset role');
  return r;
};
const setMode = (claims, mode, reason, source = 'manual', taskType = 'arm.onboarding.plan') =>
  as(claims, 'select (core.ai_task_type_set_mode($1, $2, $3, $4, $5, $6)).*', [I.platform, taskType, mode, reason, JSON.stringify({ x: 1 }), source]);

test('[AI-10] a platform admin switches a task type to suggestion-only with a reason; the change is audited', async () => {
  await tx(c, async () => {
    const r = (await setMode(admin(), 'suggestion_only', 'cancelled rate 0.4 > 0.3', 'evaluation')).rows[0];
    assert.deepEqual([r.mode, r.source, r.changed_by, r.reason], ['suggestion_only', 'evaluation', 'demo|admin', 'cancelled rate 0.4 > 0.3']);
    assert.ok(Math.abs(Date.now() - r.changed_at.getTime()) < 60_000, 'server time');
    const again = (await setMode(admin(), 'suggestion_only', 'still above', 'evaluation')).rows[0];
    assert.equal(again.reason, 'cancelled rate 0.4 > 0.3', 'same mode: nothing recorded');
    const back = (await setMode(admin(), 'normal', 'planner prompt reviewed, tasks reassigned by mistake', 'manual')).rows[0];
    assert.equal(back.mode, 'normal');
    const audit = (await c.query("select action, reason, actor_sub from core.audit_event where table_name = 'ai_task_type_state' and record_id = $1 order by seq",
      [r.id])).rows;
    assert.deepEqual(audit.map(a => [a.action, a.actor_sub]), [['INSERT', 'demo|admin'], ['UPDATE', 'demo|admin']]);
    assert.equal(audit[1].reason, 'planner prompt reviewed, tasks reassigned by mistake');
  });
});

test('[AI-10] only a person with platform_admin changes the mode; never directly, never back to normal by the evaluation', async () => {
  await tx(c, async () => {
    await refuse(() => setMode(person('demo|qa', ['qa_auditor']), 'suggestion_only', 'x'), /only a platform admin/);
    await refuse(() => setMode({ ...admin(), sub: 'agent:onboarding-planner', actor_type: 'agent' }, 'normal', 'x'), /only a platform admin/);
    await refuse(() => setMode(admin(), 'suggestion_only', '  '), /needs a reason/);
    await refuse(() => setMode(admin(), 'off', 'x'), /normal or suggestion_only/);
    await refuse(() => setMode(admin(), 'normal', 'looks fine', 'evaluation'), /back to normal is an explicit decision/);
    await refuse(() => setMode({ ...admin(), platform_ids: ['00000000-0000-0000-0000-000000000000'] }, 'suggestion_only', 'x'), /outside the token/);
    await refuse(() => as(admin(), `insert into core.ai_task_type_state(platform_id, task_type, mode, reason, source) values ($1, 'x', 'normal', 'x', 'manual')`,
      [I.platform]), /permission denied/);
    const r = (await setMode(admin(), 'suggestion_only', 'edit rate 0.6 > 0.5')).rows[0];
    await refuse(() => as(admin(), "update core.ai_task_type_state set mode = 'normal' where id = $1", [r.id]), /permission denied/);
    await refuse(() => c.query('delete from core.ai_task_type_state where id = $1', [r.id]), /physical delete not allowed/);
    const seen = (await as(person('demo|qa', ['qa_auditor']), 'select mode from core.ai_task_type_state where id = $1', [r.id])).rows;
    assert.deepEqual(seen, [{ mode: 'suggestion_only' }]);
    const other = (await as(person('demo|x', ['qa_auditor'], { platform_ids: ['00000000-0000-0000-0000-000000000000'] }),
      'select mode from core.ai_task_type_state where id = $1', [r.id])).rows;
    assert.deepEqual(other, [], 'another platform does not see the state');
  });
});

test('[AI-04][AI-06] the reason of a refused output is part of the immutable ledger row', async () => {
  await tx(c, async () => {
    const ins = `insert into core.ai_request(platform_id, task_type, data_class, provider, model, model_version, input_sha256, outcome, validation_error)
      values ($1, 'protocol.appendix.draft', 'INTERNAL', 'replay', 'm', 'm', repeat('0', 64), $2, $3) returning id`;
    const id = (await c.query(ins, [I.platform, 'validation_failed', 'citation: OBJ1: no source'])).rows[0].id;
    await refuse(() => c.query(ins, [I.platform, 'success', 'schema: x']), /validation_error_check/);
    await refuse(() => c.query("update core.ai_request set validation_error = 'other' where id = $1", [id]), /immutable/);
  });
});

test('[AI-10] migration 0023 can be applied again without error or change', async () => {
  const sql = readFileSync(new URL('../migrations/0023_ai_monitoring.sql', import.meta.url), 'utf8');
  await c.query('begin');
  try {
    for (let i = 0; i < 2; i++) await c.query(sql);
    const t = (await c.query(`select count(*)::int n from pg_trigger where tgrelid = 'core.ai_task_type_state'::regclass and not tgisinternal`)).rows[0].n;
    assert.equal(t, 4, 'touch, audit, no_delete, guard: once each');
  } finally { await c.query('rollback'); }
});
