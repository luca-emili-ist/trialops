import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

test('[CMP-01] audit trail hash chain verifies end to end', async () => {
  const r = await c.query('select core.audit_verify() as broken, count(*) n from core.audit_event');
  assert.equal(r.rows[0].broken, null);
});

test('[CMP-01] audit_event cannot be updated, deleted or truncated', async () => {
  await tx(c, async () => { await rejects(c.query("update core.audit_event set reason='x' where seq=1"), /append-only/); });
  await tx(c, async () => { await rejects(c.query('delete from core.audit_event where seq=1'), /append-only/); });
  await tx(c, async () => { await rejects(c.query('truncate core.audit_event'), /append-only/); });
});

test('[CMP-01] tampering is detected by audit_verify', async () => {
  await tx(c, async () => {
    await c.query('alter table core.audit_event disable trigger audit_no_update');
    await c.query("update core.audit_event set reason = 'tampered' where seq = 5");
    const r = await c.query('select core.audit_verify() as broken');
    assert.equal(Number(r.rows[0].broken), 5);
  });
});

test('[DM-03] update of a GxP record without a change reason is refused', async () => {
  await tx(c, async () => {
    await rejects(c.query("update core.site set declared_capacity_per_month = 9 where id = $1", [I.sites[0]]), /change reason required/);
  });
});

test('[DM-03][CMP-04] update with reason writes who, when, old, new and reason', async () => {
  await tx(c, async () => {
    await c.query("update core.site set declared_capacity_per_month = 9 where id = $1", [I.sites[0]]);
    const a = (await c.query("select * from core.audit_event where table_name='site' and record_id=$1 order by seq desc limit 1", [I.sites[0]])).rows[0];
    assert.equal(a.action, 'UPDATE');
    assert.equal(a.reason, 'capacity re-assessed');
    assert.equal(a.actor_sub, 'demo|ops');
    assert.equal(Number(a.old_row.declared_capacity_per_month), 6);
    assert.equal(Number(a.new_row.declared_capacity_per_month), 9);
  }, { reason: 'capacity re-assessed', claims: { sub: 'demo|ops' } });
});

test('[DM-03] physical delete is refused; void is audited as VOID', async () => {
  await tx(c, async () => { await rejects(c.query('delete from core.deviation where id = (select id from core.deviation limit 1)'), /physical delete not allowed/); });
  await tx(c, async () => {
    const d = (await c.query("select id from core.deviation where status<>'void' order by id limit 1")).rows[0].id;
    await c.query("update core.deviation set status='void' where id=$1", [d]);
    const a = (await c.query("select action from core.audit_event where record_id=$1 order by seq desc limit 1", [d])).rows[0];
    assert.equal(a.action, 'VOID');
  }, { reason: 'duplicate entry' });
});

test('[CMP-02] signatures are immutable', async () => {
  await tx(c, async () => { await rejects(c.query("update core.signature set meaning='review'"), /append-only/); });
});
