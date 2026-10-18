import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { db } from './_helpers.mjs';
let c;
before(async () => { c = await db(); });
after(async () => c.end());

// Migrations must be safe to run again on a database that already has them (remote apply after a partial failure).
// Checked for the migrations of the GCP v1 controls; each re-run is rolled back.
for (const f of ['0021_data_access_log.sql', '0022_audit_seal_ddl_roles.sql']) {
  test(`[CMP-12][CMP-13] migration ${f} can be applied again without error or change`, async () => {
    const sql = readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
    await c.query('begin');
    try {
      for (let i = 0; i < 2; i++) await c.query(sql);
      assert.equal((await c.query('select core.ddl_audit_active() a')).rows[0].a, true);
    } finally { await c.query('rollback'); }
  });
}
