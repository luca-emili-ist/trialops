import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());
const sac = () => ({ sub: 'demo|sac', email: 'SAC@demo.trialops.example', blinding: 'unblinded' });
const qa = () => ({ sub: 'demo|qa', roles: ['qa_auditor'], platform_ids: [I.platform] });
const lastLog = async () => (await c.query('select * from core.data_access_log order by seq desc limit 1')).rows[0];

test('[CMP-13] every unblinded read is logged with actor, server time, reason and row count', async () => {
  await tx(c, async () => {
    const before = (await c.query('select clock_timestamp() t')).rows[0].t;
    await c.query('set local role unblinded');
    const rows = (await c.query("select * from sac_enclave.read_allocation($1, 'DSMB interim look')", [I.platform])).rows;
    await c.query('reset role');
    const l = await lastLog();
    assert.deepEqual([l.kind, l.object, l.actor_sub, l.actor_email, l.platform_id, l.row_count, l.reason],
      ['unblinded_read', 'sac_enclave.subject_allocation', 'demo|sac', 'sac@demo.trialops.example', I.platform, rows.length, 'DSMB interim look']);
    assert.ok(l.occurred_at >= before);
  }, { claims: sac() });
});

test('[CMP-13][IAM-07] no reason, a blinded person or an agent: no unblinded rows', async () => {
  for (const [claims, reason, re] of [[sac(), ' ', /needs a reason/], [{ sub: 'demo|ctm' }, 'look', /SAC members only/],
    [{ ...sac(), sub: 'agent:x', actor_type: 'agent' }, 'look', /SAC members only/]]) {
    await tx(c, async () => {
      await rejects(c.query('select * from sac_enclave.read_allocation($1, $2)', [I.platform, reason]), re);
    }, { role: 'unblinded', claims });
  }
  await tx(c, async () => {
    await rejects(c.query("select * from sac_enclave.read_allocation($1, 'x')", [I.platform]), /permission denied/);
  }, { role: 'authenticated', claims: { ...sac(), platform_ids: '*' } });
});

test('[CMP-13] exports are logged with format and file hash; the log is append-only and not readable directly', async () => {
  await tx(c, async () => {
    const seq = (await c.query("select core.log_export('core.audit_event', $1, null, '{\"table\":\"arm\"}', 12, 'csv', $2) s",
      [I.platform, 'a'.repeat(64)])).rows[0].s;
    assert.ok(Number(seq) > 0);
    await c.query('savepoint s');
    await rejects(c.query('select * from core.data_access_log'), /permission denied/);
    await c.query('rollback to savepoint s');
    await rejects(c.query("select core.log_export('core.audit_event', $1, null, '{}', 1, 'csv', $2)",
      ['00000000-0000-0000-0000-000000000001', 'b'.repeat(64)]), /outside the platforms/);
  }, { role: 'authenticated', claims: qa() });
  await tx(c, async () => {
    await c.query("select core.log_export('core.audit_event', null, null, '{}', 1, 'csv', $1)", ['c'.repeat(64)]);
    await c.query('savepoint s');
    await rejects(c.query('update core.data_access_log set row_count = 0'), /append-only/);
    await c.query('rollback to savepoint s');
    await rejects(c.query('delete from core.data_access_log'), /append-only/);
  });
});

test('[CMP-13] the access log is reportable to QA and admins only', async () => {
  await tx(c, async () => {
    await c.query("select core.log_export('core.audit_event', $1, null, '{}', 3, 'csv', $2)", [I.platform, 'd'.repeat(64)]);
    const r = (await c.query("select * from core.access_log_search($1, 'export')", [I.platform])).rows;
    assert.ok(r.length >= 1);
    assert.equal(r[0].actor_sub, 'demo|qa');
  }, { role: 'authenticated', claims: qa() });
  await tx(c, async () => {
    await rejects(c.query('select * from core.access_log_search()'), /qa_auditor or platform_admin/);
  }, { role: 'authenticated', claims: { sub: 'demo|ctm', platform_ids: [I.platform] } });
});
