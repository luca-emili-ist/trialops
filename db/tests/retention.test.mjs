import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, tx, ids, rejects } from './_helpers.mjs';
let c, I;
before(async () => { c = await db(); I = await ids(c); });
after(async () => c.end());

test('[NFR-04] every platform has a retention policy of at least 25 years by default', async () => {
  const r = await c.query('select retention_years, retention_basis from core.platform where id = $1', [I.platform]);
  assert.equal(r.rows[0].retention_years, 25);
  assert.match(r.rows[0].retention_basis, /CTR art\. 58/);
});

test('[NFR-04] retention cannot be set below 25 years and every change is audited with a reason', async () => {
  await tx(c, async () => {
    await rejects(c.query('update core.platform set retention_years = 10 where id = $1', [I.platform]), /check constraint|retention_years/);
  }, { reason: 'attempt to shorten retention' });
  await tx(c, async () => {
    await c.query('update core.platform set retention_years = 30 where id = $1', [I.platform]);
    const a = (await c.query("select reason, old_row->>'retention_years' o, new_row->>'retention_years' n from core.audit_event where table_name = 'platform' and record_id = $1 order by seq desc limit 1", [I.platform])).rows[0];
    assert.deepEqual([a.reason, a.o, a.n], ['sponsor requires 30 years', '25', '30']);
  }, { reason: 'sponsor requires 30 years' });
});

test('[NFR-04] a passing restore test is on record and not older than one quarter (+10 days)', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../../docs/compliance/evidence/', import.meta.url);
  const files = readdirSync(dir).filter(f => /^restore-test-.*\.json$/.test(f)).sort();
  assert.ok(files.length, 'no restore test evidence in docs/compliance/evidence (run scripts/restore-test.mjs)');
  const last = JSON.parse(readFileSync(new URL(files.at(-1), dir), 'utf8'));
  assert.equal(last.result, 'PASS', `last restore test ${files.at(-1)} did not pass`);
  const ageDays = (Date.now() - Date.parse(last.started_at)) / 86_400_000;
  assert.ok(ageDays <= 100, `last restore test is ${Math.round(ageDays)} days old: repeat it (docs/compliance/BACKUP_RESTORE.md)`);
});
